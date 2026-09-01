import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createFindToolDefinition, createGrepToolDefinition } from "@earendil-works/pi-coding-agent";

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

    await Promise.all([
      writeFile(path.join(workspace, "nested", "other.ts"), "zero\nTWO here\n"),
      writeFile(path.join(workspace, "nested", ".hidden.ts"), "TWO hidden\n"),
      writeFile(path.join(workspace, "nested", "ignored.ts"), "TWO ignored\n"),
      writeFile(path.join(workspace, ".gitignore"), "nested/ignored.ts\n"),
      import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(workspace, ".git"))),
    ]);
    const grep = await client.grep({
      path: "nested", pattern: "TWO", literal: true, caseSensitive: true,
      includeHidden: true, glob: "*.ts", context: 0, limit: 100,
    });
    expect(grep.text.split("\n").sort()).toEqual([".hidden.ts:1: TWO hidden", "other.ts:2: TWO here"]);
    expect(grep).toMatchObject({ matches: 2, truncated: false });
    // Pi's positive rg glob can re-include ignored files; remove that regression
    // fixture before comparing the remaining 0.84.3 text/details contract.
    await rm(path.join(workspace, "nested", "ignored.ts"));
    const piGrep = await createGrepToolDefinition(workspace).execute(
      "grep", { pattern: "TWO", path: "nested", glob: "*.ts", literal: true, limit: 100 },
      undefined, undefined, undefined,
    );
    const piGrepText = piGrep.content[0]?.type === "text" ? piGrep.content[0].text : "";
    expect(grep.text.split("\n").sort()).toEqual(piGrepText.split("\n").sort());
    expect(piGrep.details).toBeUndefined();

    await writeFile(path.join(workspace, "long.ts"), `MATCH ${"x".repeat(600)}\n`);
    const limitedGrep = await client.grep({
      path: "long.ts", pattern: "MATCH", literal: true, caseSensitive: true,
      includeHidden: false, context: 0, limit: 1,
    });
    expect(limitedGrep).toMatchObject({ matches: 1, truncated: true, matchLimitReached: 1, linesTruncated: true });
    const piLimitedGrep = await createGrepToolDefinition(workspace).execute(
      "limited", { pattern: "MATCH", path: "long.ts", literal: true, limit: 1 },
      undefined, undefined, undefined,
    );
    expect(limitedGrep.text).toBe(piLimitedGrep.content[0]?.type === "text" ? piLimitedGrep.content[0].text : undefined);
    expect(piLimitedGrep.details).toMatchObject({ matchLimitReached: 1, linesTruncated: true });

    const find = await client.find({ path: ".", glob: "nested/*.ts", includeHidden: true, limit: 100 });
    expect(find.paths).toHaveLength(2);
    expect(find.paths).toEqual(expect.arrayContaining(["nested/.hidden.ts", "nested/other.ts"]));
    const piFind = await createFindToolDefinition(workspace, {
      operations: { exists: () => true, glob: () => [...find.paths] },
    }).execute("find", { pattern: "nested/*.ts", path: ".", limit: 100 }, undefined, undefined, undefined);
    expect(find.text).toBe(piFind.content[0]?.type === "text" ? piFind.content[0].text : undefined);
    const limitedFind = await client.find({ path: ".", glob: "**/*.ts", includeHidden: true, limit: 1 });
    expect(limitedFind).toMatchObject({ truncated: true, resultLimitReached: 1 });
    expect(limitedFind.text).toContain("1 results limit reached");

    const streamed: string[] = [];
    const exec = await client.exec({ command: "printf out; printf err >&2", timeoutMs: 5_000 }, {
      onOutput: ({ stream, data }) => { streamed.push(`${stream}:${data}`); },
    });
    expect(exec).toEqual({ exitCode: 0, signal: null, timedOut: false, fullOutputPath: null });
    expect(streamed.join("")).toContain("stdout:out");
    expect(streamed.join("")).toContain("stderr:err");

    const descendantStarted = Date.now();
    expect(await client.exec({ command: "sleep 30 & echo descendant-started", timeoutMs: 5_000 })).toMatchObject({ exitCode: 0 });
    expect(Date.now() - descendantStarted).toBeLessThan(3_000);
    expect(await client.health()).toEqual({ healthy: true });

    const large = await client.exec({ command: "printf 'x%.0s' {1..60000}", timeoutMs: 5_000 });
    expect(large.fullOutputPath).toMatch(/^\/tmp\/chatwca-command-/);
    const full = await client.readFile({ path: large.fullOutputPath!, maxBytes: 70_000, detectMime: false });
    expect(full.data).toHaveLength(60_000);

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

    const outputFatal = vi.fn();
    const cappedClient = await startSandboxWorkerClient({
      config: { ...config, maxCommandOutputBytes: 1_024 },
      host: validateBwrapAndToolchain(config), worker: await loadSandboxWorkerArtifact(),
      workspace, hiddenPaths: [canary, data, agent], onFatal: outputFatal,
    });
    await expect(cappedClient.exec({ command: "printf 'x%.0s' {1..2048}", timeoutMs: 5_000 }))
      .rejects.toMatchObject({ code: "sandbox_worker_failed" });
    await vi.waitFor(() => expect(outputFatal).toHaveBeenCalledTimes(1));
    await cappedClient.close();
  }, 20_000);
});
