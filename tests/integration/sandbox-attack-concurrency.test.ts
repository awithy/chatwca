import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/server/config.js";
import { validateNetworkHelper } from "../../src/server/network/helper.js";
import { ManagedNetworkRuntime } from "../../src/server/network/managed-runtime.js";
import { validateBwrapAndToolchain } from "../../src/server/sandbox/bwrap.js";
import { loadSandboxWorkerArtifact } from "../../src/server/sandbox/probe.js";
import {
  SandboxWorkerOperationError,
  startSandboxWorkerClient,
  type SandboxWorkerClient,
} from "../../src/server/sandbox/worker-client.js";

const temporaryDirectories: string[] = [];
const clients: SandboxWorkerClient[] = [];
const managedRuntimes: ManagedNetworkRuntime[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(managedRuntimes.splice(0).map((runtime) => runtime.close()));
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

  it("runs isolated, independently managed, and unrestricted profiles concurrently without shared routes or policy", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatwca-profile-concurrency-"));
    temporaryDirectories.push(root);
    const workspaces = ["isolated", "managed-a", "managed-b"].map((name) => path.join(root, name));
    const data = path.join(root, "data");
    const agent = path.join(root, "agent");
    await Promise.all([...workspaces.map((workspace) => mkdir(workspace)), mkdir(data), mkdir(agent)]);

    const environment = {
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_WORKSPACE_ROOTS: JSON.stringify(workspaces),
      CHATWCA_DATA_DIR: data,
      PI_CODING_AGENT_DIR: agent,
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["127.0.0.1"]',
      CHATWCA_NETWORK_ALLOWED_PORTS: "[80]",
    };
    const loadedA = loadConfig(environment);
    const loadedB = loadConfig({ ...environment, CHATWCA_NETWORK_ALLOWED_DOMAINS: '["127.0.0.2"]' });
    const host = validateBwrapAndToolchain(loadedA.sandbox);
    const worker = await loadSandboxWorkerArtifact();
    const helper = validateNetworkHelper({
      helperPath: loadedA.managedNetwork.helperPath,
      manifestPath: loadedA.managedNetwork.helperManifestPath,
      protectedPaths: [await realpath(data), await realpath(agent), ...await Promise.all(workspaces.map((workspace) => realpath(workspace)))],
    });
    const runtimeA = await ManagedNetworkRuntime.start({
      dataDir: path.join(data, "network"), workspaceId: "managed-a", conversationId: "managed-a",
      policySetId: "default", policySet: loadedA.managedNetwork.policySets.get("default")!,
      config: loadedA.managedNetwork, diagnosticSink: () => undefined,
    });
    const runtimeB = await ManagedNetworkRuntime.start({
      dataDir: path.join(data, "network"), workspaceId: "managed-b", conversationId: "managed-b",
      policySetId: "default", policySet: loadedB.managedNetwork.policySets.get("default")!,
      config: loadedB.managedNetwork, diagnosticSink: () => undefined,
    });
    managedRuntimes.push(runtimeA, runtimeB);
    expect(runtimeA.httpSocketPath).not.toBe(runtimeB.httpSocketPath);
    expect(runtimeA.socksSocketPath).not.toBe(runtimeB.socksSocketPath);

    const fatal = vi.fn();
    const [isolated, managedA, managedB] = await Promise.all([
      startSandboxWorkerClient({
        config: loadedA.sandbox, host, worker, workspace: workspaces[0]!, hiddenPaths: [data, agent], onFatal: fatal,
      }),
      startSandboxWorkerClient({
        config: loadedA.sandbox, host, worker, workspace: workspaces[1]!, hiddenPaths: [data, agent], onFatal: fatal,
        networkProfile: { kind: "managed-egress", helper, httpSocketPath: runtimeA.httpSocketPath, socksSocketPath: runtimeA.socksSocketPath },
      }),
      startSandboxWorkerClient({
        config: loadedA.sandbox, host, worker, workspace: workspaces[2]!, hiddenPaths: [data, agent], onFatal: fatal,
        networkProfile: { kind: "managed-egress", helper, httpSocketPath: runtimeB.httpSocketPath, socksSocketPath: runtimeB.socksSocketPath },
      }),
    ]);
    clients.push(isolated, managedA, managedB);

    const proxyDecisionScript = [
      "const net=require('node:net')",
      "const proxy=new URL(process.env.HTTP_PROXY)",
      "const socket=net.createConnection({host:proxy.hostname,port:Number(proxy.port)})",
      "let data=''",
      "socket.on('connect',()=>socket.end('CONNECT 127.0.0.1:80 HTTP/1.1\\r\\nHost: 127.0.0.1:80\\r\\n\\r\\n'))",
      "socket.on('data',chunk=>data+=chunk)",
      "socket.on('close',()=>console.log(data.match(/x-chatwca-proxy-error: ([^\\r]+)/i)?.[1]||'missing'))",
      "socket.setTimeout(2000,()=>socket.destroy())",
    ].join(";");
    const profileCommand = (managed: boolean) => [
      "printf 'namespace=%s\\nproxy=%s\\n' \"$(readlink /proc/self/ns/net)\" \"${HTTP_PROXY-unset}\"",
      ...(managed ? [`node -e ${JSON.stringify(proxyDecisionScript)}`] : []),
    ].join("; ");
    const hostNamespace = await readlink("/proc/self/ns/net");
    const [[isolatedResult, managedAResult, managedBResult]] = await Promise.all([
      Promise.all([
        execute(isolated, profileCommand(false)),
        execute(managedA, profileCommand(true)),
        execute(managedB, profileCommand(true)),
      ]),
      writeFile(path.join(root, "unrestricted-parent.txt"), hostNamespace),
    ]);

    const namespace = (output: string) => /net:\[[0-9]+\]/.exec(output)?.[0];
    const namespaces = [isolatedResult, managedAResult, managedBResult].map(({ output }) => namespace(output));
    expect(namespaces.every((value) => value !== undefined && value !== hostNamespace)).toBe(true);
    expect(new Set(namespaces).size).toBe(3);
    expect(isolatedResult.output).toContain("proxy=unset");
    expect(managedAResult.output).toContain("proxy=http://127.0.0.1:");
    expect(managedBResult.output).toContain("proxy=http://127.0.0.1:");
    expect(managedAResult.output).toContain("blocked-local-address");
    expect(managedBResult.output).toContain("blocked-by-allowlist");
    expect(fatal).not.toHaveBeenCalled();
  }, 30_000);

  it("fails closed and tears down a managed helper tree when the worker process crashes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatwca-managed-crash-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const data = path.join(root, "data");
    const agent = path.join(root, "agent");
    await Promise.all([mkdir(workspace), mkdir(data), mkdir(agent)]);
    const loaded = loadConfig({
      CHATWCA_SANDBOX_MODE: "optional", CHATWCA_WORKSPACE_ROOTS: JSON.stringify([workspace]),
      CHATWCA_DATA_DIR: data, PI_CODING_AGENT_DIR: agent,
      CHATWCA_MANAGED_EGRESS_MODE: "optional", CHATWCA_NETWORK_ALLOWED_DOMAINS: '["127.0.0.1"]',
    });
    const helper = validateNetworkHelper({
      helperPath: loaded.managedNetwork.helperPath, manifestPath: loaded.managedNetwork.helperManifestPath,
      protectedPaths: [await realpath(workspace), await realpath(data), await realpath(agent)],
    });
    const runtime = await ManagedNetworkRuntime.start({
      dataDir: path.join(data, "network"), workspaceId: "crash", conversationId: "crash",
      policySetId: "default", policySet: loaded.managedNetwork.policySets.get("default")!,
      config: loaded.managedNetwork, diagnosticSink: () => undefined,
    });
    managedRuntimes.push(runtime);
    const fatal = vi.fn();
    const client = await startSandboxWorkerClient({
      config: loaded.sandbox, host: validateBwrapAndToolchain(loaded.sandbox), worker: await loadSandboxWorkerArtifact(),
      workspace, hiddenPaths: [data, agent], onFatal: fatal,
      networkProfile: { kind: "managed-egress", helper, httpSocketPath: runtime.httpSocketPath, socksSocketPath: runtime.socksSocketPath },
    });
    clients.push(client);
    await expect(client.exec({ command: "kill -KILL $PPID", timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: "sandbox_worker_failed" });
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledOnce());
    await client.close();
    await runtime.close();
    expect(existsSync(runtime.httpSocketPath)).toBe(false);
    expect(existsSync(runtime.socksSocketPath)).toBe(false);
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
