import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/server/config.js";
import { validateBwrapAndToolchain } from "../../src/server/sandbox/bwrap.js";
import { loadSandboxWorkerArtifact } from "../../src/server/sandbox/probe.js";
import {
  SandboxWorkerOperationError,
  startSandboxWorkerClient,
  type SandboxWorkerClient,
} from "../../src/server/sandbox/worker-client.js";

const temporaryDirectories: string[] = [];
const clients: SandboxWorkerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly unrelated: string;
  readonly data: string;
  readonly agent: string;
  readonly toolchain: string;
  readonly client: SandboxWorkerClient;
  readonly fatal: ReturnType<typeof vi.fn>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-sandbox-attacks-"));
  const toolchain = await mkdtemp(path.join(homedir(), ".chatwca-sandbox-ro-"));
  temporaryDirectories.push(root, toolchain);
  const workspace = path.join(root, "workspace");
  const unrelated = path.join(root, "unrelated");
  const data = path.join(root, "data");
  const agent = path.join(root, "agent");
  await Promise.all([
    mkdir(path.join(workspace, ".chatwca", "sessions"), { recursive: true }),
    mkdir(unrelated), mkdir(data), mkdir(path.join(agent, "sessions"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(workspace, "source.txt"), "original\n"),
    writeFile(path.join(workspace, ".chatwca", "sessions", "local.jsonl"), "local-session-secret"),
    writeFile(path.join(unrelated, "secret.txt"), "unrelated-secret"),
    writeFile(path.join(data, "chatwca.sqlite"), "sqlite-secret"),
    writeFile(path.join(data, "chatwca.sqlite-wal"), "wal-secret"),
    writeFile(path.join(data, "chatwca.sqlite-shm"), "shm-secret"),
    writeFile(path.join(agent, "auth.json"), "pi-credential-secret"),
    writeFile(path.join(agent, "sessions", "global.jsonl"), "global-session-secret"),
    writeFile(path.join(root, "parent-canary"), "parent-canary-secret"),
    writeFile(path.join(toolchain, "runtime.txt"), "read-only-runtime"),
  ]);
  await symlink(unrelated, path.join(workspace, "host-escape"));

  const config = loadConfig({
    CHATWCA_SANDBOX_MODE: "optional",
    CHATWCA_WORKSPACE_ROOTS: JSON.stringify([root]),
    CHATWCA_SANDBOX_RO_MOUNTS: JSON.stringify([toolchain]),
    CHATWCA_DATA_DIR: data,
    PI_CODING_AGENT_DIR: agent,
  }).sandbox;
  const fatal = vi.fn();
  const client = await startSandboxWorkerClient({
    config,
    host: validateBwrapAndToolchain(config),
    worker: await loadSandboxWorkerArtifact(),
    workspace,
    hiddenPaths: [path.join(root, "parent-canary"), data, agent, unrelated],
    onFatal: fatal,
  });
  clients.push(client);
  return { root, workspace, unrelated, data, agent, toolchain, client, fatal };
}

async function expectUnreadable(client: SandboxWorkerClient, target: string): Promise<void> {
  await expect(client.readFile({ path: target, maxBytes: 1024, detectMime: false }))
    .rejects.toBeInstanceOf(SandboxWorkerOperationError);
}

async function execute(client: SandboxWorkerClient, command: string): Promise<{ result: Awaited<ReturnType<SandboxWorkerClient["exec"]>>; output: string }> {
  const chunks: string[] = [];
  const result = await client.exec({ command, timeoutMs: 10_000 }, {
    onOutput: ({ stream, data }) => { chunks.push(`${stream}:${data}`); },
  });
  return { result, output: chunks.join("") };
}

const realSandbox = describe.skipIf(process.env.CHATWCA_SANDBOX_CAPABLE !== "1");

realSandbox("Bubblewrap attack and concurrency matrix", () => {
  it("blocks traversal, absolute, symlink, rename, protected-store, environment, and proc escapes", async () => {
    const { client, root, workspace, unrelated, data, agent, fatal } = await fixture();
    const forbidden = [
      "../unrelated/secret.txt",
      "../../unrelated/secret.txt",
      path.join(unrelated, "secret.txt"),
      "host-escape/secret.txt",
      path.join(root, "parent-canary"),
      path.join(data, "chatwca.sqlite"),
      path.join(data, "chatwca.sqlite-wal"),
      path.join(data, "chatwca.sqlite-shm"),
      path.join(agent, "auth.json"),
      path.join(agent, "sessions", "global.jsonl"),
      ".chatwca/sessions/local.jsonl",
    ];
    for (const target of forbidden) await expectUnreadable(client, target);

    await mkdir(path.join(workspace, "rename-target"));
    await writeFile(path.join(workspace, "rename-target", "safe.txt"), "safe");
    await rename(path.join(workspace, "rename-target"), path.join(workspace, "renamed-away"));
    await symlink(unrelated, path.join(workspace, "rename-target"));
    await expectUnreadable(client, "rename-target/secret.txt");

    const sentinelName = "CHATWCA_ATTACK_PARENT_SECRET";
    const previous = process.env[sentinelName];
    process.env[sentinelName] = "must-not-enter-worker";
    try {
      const environment = await execute(client, `env; for f in /proc/[0-9]*/environ; do tr '\\0' '\\n' < "$f" 2>/dev/null || true; done`);
      expect(environment.result).toMatchObject({ exitCode: 0, timedOut: false });
      expect(environment.output).not.toContain(sentinelName);
      expect(environment.output).not.toContain("must-not-enter-worker");
      expect(environment.output).not.toContain("pi-credential-secret");
      expect(environment.output).not.toContain("parent-canary-secret");
    } finally {
      if (previous === undefined) delete process.env[sentinelName];
      else process.env[sentinelName] = previous;
    }

    const maskedEntries = await client.listDirectory({ path: ".chatwca", includeHidden: true, limit: 20 });
    expect(maskedEntries.entries.map((entry) => entry.name)).not.toContain("sessions");
    expect(maskedEntries.entries.map((entry) => entry.name)).not.toContain("local.jsonl");
    expect(fatal).not.toHaveBeenCalled();
  }, 30_000);

  it("keeps source and git writable while runtime mounts stay read-only and aliases serialize", async () => {
    const { client, workspace, toolchain, fatal } = await fixture();
    await client.writeFile("source.txt", "changed by sandbox\n");
    expect(await readFile(path.join(workspace, "source.txt"), "utf8")).toBe("changed by sandbox\n");

    const git = await execute(client, [
      "git init -q",
      "git config user.email sandbox@example.invalid",
      "git config user.name Sandbox",
      "git add source.txt",
      "git commit -qm initial",
      "git status --porcelain",
    ].join(" && "));
    expect(git.result).toMatchObject({ exitCode: 0, timedOut: false });
    await expect(stat(path.join(workspace, ".git", "HEAD"))).resolves.toMatchObject({});

    expect((await client.readFile({ path: path.join(toolchain, "runtime.txt"), maxBytes: 1024, detectMime: false })).data.toString())
      .toBe("read-only-runtime");
    await expect(client.writeFile(path.join(toolchain, "runtime.txt"), "tamper"))
      .rejects.toMatchObject({ code: "permission_denied" });
    const node = await execute(client, "node --version && rg --version | head -1");
    expect(node.result.exitCode).toBe(0);
    expect(node.output).toMatch(/v\d+\.\d+\.\d+/);
    expect(node.output).toContain("ripgrep");

    await writeFile(path.join(workspace, "alias.txt"), "one\n");
    await symlink("alias.txt", path.join(workspace, "alias-link.txt"));
    const first = client.editFile({ path: "alias-link.txt", edits: [{ oldText: "one", newText: "two" }] });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = client.editFile({ path: "alias.txt", edits: [{ oldText: "two", newText: "three" }] });
    await Promise.all([first, second]);
    expect(await readFile(path.join(workspace, "alias.txt"), "utf8")).toBe("three\n");
    expect(fatal).not.toHaveBeenCalled();
  }, 30_000);

  it("isolates multiple workers while unrestricted parent work proceeds concurrently", async () => {
    const fixtures = await Promise.all([fixture(), fixture(), fixture()]);
    const unrestricted = path.join(fixtures[0]!.root, "unrestricted-parent.txt");
    await Promise.all([
      writeFile(unrestricted, "parent-only"),
      ...fixtures.map(({ client }, index) => client.writeFile("owner.txt", `worker-${String(index)}`)),
      ...fixtures.map(({ client }, index) => execute(client, `printf worker-${String(index)}; sleep 0.05`)),
    ]);
    for (const [index, current] of fixtures.entries()) {
      expect(await readFile(path.join(current.workspace, "owner.txt"), "utf8")).toBe(`worker-${String(index)}`);
      await expectUnreadable(current.client, unrestricted);
      for (const other of fixtures) {
        if (other !== current) await expectUnreadable(current.client, path.join(other.workspace, "owner.txt"));
      }
      expect(current.fatal).not.toHaveBeenCalled();
    }
  }, 30_000);

  it.skipIf(process.env.CHATWCA_SANDBOX_RESOURCE_STRESS !== "1")(
    "cleans a finite descendant burst and large allocation in isolated CI",
    async () => {
      const { client, fatal } = await fixture();
      const stress = await execute(client, [
        "node -e 'const allocation = Buffer.alloc(128 * 1024 * 1024, 1); console.log(allocation.length)'",
        "for i in $(seq 1 64); do sleep 30 & done",
        "printf descendants-started",
      ].join("; "));
      expect(stress.result).toMatchObject({ exitCode: 0, timedOut: false });
      expect(stress.output).toContain("134217728");
      expect(await client.health()).toEqual({ healthy: true });
      expect(fatal).not.toHaveBeenCalled();
    },
    30_000,
  );
});
