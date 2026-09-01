import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../../src/server/config.js";
import { validateBwrapAndToolchain } from "../../src/server/sandbox/bwrap.js";
import { loadSandboxWorkerArtifact } from "../../src/server/sandbox/probe.js";
import {
  SandboxWorkerOperationError,
  startSandboxWorkerClient,
} from "../../src/server/sandbox/worker-client.js";

const temporaryDirectories: string[] = [];
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map((directory) =>
  rm(directory, { recursive: true, force: true })
)));

describe("real sandbox worker client", () => {
  it("handshakes through production Bubblewrap, exposes typed APIs, and closes cleanly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatwca-worker-client-"));
    temporaryDirectories.push(root);
    const workspace = path.join(root, "workspace");
    const data = path.join(root, "data");
    const agent = path.join(root, "agent");
    await Promise.all([
      import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(workspace, ".chatwca"), { recursive: true })),
      import("node:fs/promises").then(({ mkdir }) => mkdir(data)),
      import("node:fs/promises").then(({ mkdir }) => mkdir(agent)),
    ]);
    const canary = path.join(root, "canary");
    await writeFile(canary, "host only");
    const config = loadConfig({
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_WORKSPACE_ROOTS: JSON.stringify([root]),
      CHATWCA_DATA_DIR: data,
      PI_CODING_AGENT_DIR: agent,
    }).sandbox;
    const fatal = vi.fn();
    const client = await startSandboxWorkerClient({
      config,
      host: validateBwrapAndToolchain(config),
      worker: await loadSandboxWorkerArtifact(),
      workspace,
      hiddenPaths: [canary, data, agent],
      onFatal: fatal,
    });
    expect(await client.health()).toEqual({ healthy: true });
    await expect(client.writeFile("file.txt", "not implemented until phase 4"))
      .rejects.toEqual(new SandboxWorkerOperationError("operation_not_implemented"));
    expect(fatal).not.toHaveBeenCalled();
    await client.close();
    expect(fatal).not.toHaveBeenCalled();
  }, 20_000);
});
