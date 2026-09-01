import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    expect(await client.writeFile("@nested/file.txt", "one\r\ntwo\r\nthree\r\n")).toEqual({ bytesWritten: 17 });
    expect(await readFile(path.join(workspace, "nested", "file.txt"), "utf8")).toBe("one\r\ntwo\r\nthree\r\n");
    expect(await client.readFile({ path: "nested/file.txt", maxBytes: 100, detectMime: true })).toEqual({
      data: Buffer.from("one\r\ntwo\r\nthree\r\n"), mimeType: null,
    });
    const edit = await client.editFile({ path: "nested/file.txt", edits: [{ oldText: "two", newText: "TWO" }] });
    expect(edit.firstChangedLine).toBe(2);
    expect(edit.diff).toContain("-2 two\n+2 TWO");
    expect(await readFile(path.join(workspace, "nested", "file.txt"), "utf8")).toBe("one\r\nTWO\r\nthree\r\n");
    const listing = await client.listDirectory({ path: "nested", includeHidden: true, limit: 10 });
    expect(listing.entries.map(({ name, type }) => [name, type])).toEqual([["file.txt", "file"]]);

    // Absolute and parent-traversal paths remain inside the synthetic guest root.
    await expect(client.readFile({ path: canary, maxBytes: 100, detectMime: false }))
      .rejects.toEqual(new SandboxWorkerOperationError("not_found"));
    await expect(client.readFile({ path: "../../etc/shadow", maxBytes: 100, detectMime: false }))
      .rejects.toBeInstanceOf(SandboxWorkerOperationError);
    await client.writeFile(".chatwca/guest-only.txt", "ephemeral");
    await expect(stat(path.join(workspace, ".chatwca", "guest-only.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(fatal).not.toHaveBeenCalled();
    await client.close();
    expect(fatal).not.toHaveBeenCalled();
  }, 20_000);
});
