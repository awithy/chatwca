import { appendFile, chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, symlink, truncate, utimes, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { scopedSessionStorePath, type SessionWorkspaceScope } from "../../src/server/session-scope.js";
import { assertSessionDiscoveryCurrent, assertSessionSourceCurrent, discoverSessionFiles, readSessionSnapshot, sameSourceFingerprint, sourceFingerprint, workspaceSourceRevision, type SnapshotFileSystem } from "../../src/server/search/session-source.js";
import { searchAssistantEntry as assistant, searchJsonl as jsonl, searchSessionHeader as header, searchUserEntry as user } from "../fixtures/search-session.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-search-source-"));
  roots.push(root);
  const workspacePath = path.join(root, "workspace");
  const agentDirectory = path.join(root, "agent");
  const store = path.join(workspacePath, ".chatwca", "sessions");
  await mkdir(store, { recursive: true });
  await mkdir(agentDirectory);
  const workspace: SessionWorkspaceScope = { id: "workspace", path: workspacePath, sessionDirectory: store };
  const file = path.join(store, "session.jsonl");
  const records = [header(workspacePath), user("u", null), assistant("a", "u")];
  await writeFile(file, jsonl(records));
  const discover = () => discoverSessionFiles(workspace, agentDirectory);
  const candidate = (await discover()).candidates[0]!;
  return { root, workspace, agentDirectory, store, file, records, candidate, discover };
}

function raceFileSystem(onRead: () => Promise<void>) {
  const close = vi.fn();
  const fileSystem: SnapshotFileSystem = {
    realpath, stat: (target) => stat(target, { bigint: true }),
    async open(target) {
      const handle = await open(target, "r");
      let called = false;
      return {
        stat: () => handle.stat({ bigint: true }),
        async read(buffer) {
          if (!called) { called = true; await onRead(); }
          return handle.read(buffer, 0, buffer.length, null);
        },
        async close() { close(); await handle.close(); },
      };
    },
  };
  return { fileSystem, close };
}

describe("scoped search discovery and stable snapshots", () => {
  it("enumerates only exact-store regular JSONL candidates, without parsing content or recursing", async () => {
    const f = await fixture();
    await writeFile(path.join(f.store, "malformed.jsonl"), "malformed but seen");
    await writeFile(path.join(f.store, "ignore.txt"), "ignore");
    await mkdir(path.join(f.store, "nested"));
    await writeFile(path.join(f.store, "nested", "hidden.jsonl"), "hidden");
    await symlink(path.join(f.store, "nested"), path.join(f.store, "directory-link"));
    const result = await f.discover();
    expect(result.complete).toBe(true);
    expect(result.candidates.map(({ path: file }) => path.basename(file))).toEqual(["malformed.jsonl", "session.jsonl"]);
    expect(result.seenPaths).toEqual(new Set(result.candidates.map(({ path }) => path)));
    expect(result.errors).toEqual([]);
    await expect(readSessionSnapshot(f.workspace, result.candidates[0]!)).rejects.toMatchObject({ code: "search_source_changed" });
  });

  it("accepts contained file symlinks but rejects escaping/broken links without authorizing pruning", async () => {
    const f = await fixture();
    const outside = path.join(f.root, "outside.jsonl");
    await writeFile(outside, jsonl(f.records));
    await symlink(f.file, path.join(f.store, "contained.jsonl"));
    await symlink(outside, path.join(f.store, "escape.jsonl"));
    await symlink(path.join(f.root, "absent"), path.join(f.store, "broken.jsonl"));
    const result = await f.discover();
    expect(result.complete).toBe(false);
    expect(result.seenPaths.size).toBe(4);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0]?.canonicalPath).toBe(f.file);
    expect(result.errors).toHaveLength(2);
    expect(result.errors.find(({ path: file }) => file.endsWith("escape.jsonl"))?.code).toBe("search_session_invalid");
    await expect(readSessionSnapshot(f.workspace, result.candidates[0]!)).resolves.toMatchObject({ session: { header: { id: "synthetic-session" } } });
  });

  it("preserves bytes/metadata, records exact hashes, and admits a complete final object without a newline", async () => {
    const f = await fixture();
    await writeFile(f.file, jsonl(f.records, false));
    const candidate = (await f.discover()).candidates[0]!;
    const before = await stat(f.file, { bigint: true });
    const bytes = await readFile(f.file);
    const first = await readSessionSnapshot(f.workspace, candidate);
    const second = await readSessionSnapshot(f.workspace, candidate);
    expect(first.snapshotHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(first).toEqual(second);
    expect(first.session.savedLeafId).toBe("a");
    expect(await readFile(f.file)).toEqual(bytes);
    expect(sourceFingerprint(await stat(f.file, { bigint: true }))).toEqual(sourceFingerprint(before));
  });

  it("rejects foreign header ownership, including legacy files", async () => {
    const f = await fixture();
    const foreign = path.join(f.root, "foreign");
    await mkdir(foreign);
    for (const version of [3, 2]) {
      await writeFile(f.file, jsonl([header(foreign, { version }), ...f.records.slice(1)]));
      const candidate = (await f.discover()).candidates[0]!;
      await expect(readSessionSnapshot(f.workspace, candidate)).rejects.toMatchObject({ code: "search_session_invalid" });
    }
    await writeFile(f.file, jsonl([header(f.workspace.path, { version: 2 })]));
    const candidate = (await f.discover()).candidates[0]!;
    await expect(readSessionSnapshot(f.workspace, candidate)).rejects.toMatchObject({ code: "search_session_version_unsupported" });
  });

  it("rejects unavailable stored-CWD aliases", async () => {
    const f = await fixture();
    await writeFile(f.file, jsonl([header(path.join(f.root, "missing-alias")), ...f.records.slice(1)]));
    const candidate = (await f.discover()).candidates[0]!;
    await expect(readSessionSnapshot(f.workspace, candidate)).rejects.toMatchObject({ code: "search_session_invalid" });
  });

  it("accepts canonical CWD aliases but rejects a different candidate scope or session ID", async () => {
    const f = await fixture();
    const alias = path.join(f.root, "workspace-alias");
    await symlink(f.workspace.path, alias);
    await writeFile(f.file, jsonl([header(alias), ...f.records.slice(1)]));
    const candidate = (await f.discover()).candidates[0]!;
    await expect(readSessionSnapshot(f.workspace, candidate)).resolves.toBeDefined();
    await expect(readSessionSnapshot({ ...f.workspace, id: "other" }, candidate)).rejects.toMatchObject({ code: "search_source_changed" });
    await expect(readSessionSnapshot(f.workspace, candidate, { expectedSessionId: "other-session" })).rejects.toMatchObject({ code: "search_session_invalid" });
  });

  it("never mistakes unavailable, missing, or aliased stores/workspaces for empty history", async () => {
    const f = await fixture();
    await rm(f.store, { recursive: true });
    await expect(f.discover()).rejects.toMatchObject({ code: "search_scope_unavailable" });
    expect(await stat(f.store).catch(() => undefined)).toBeUndefined();
    const target = path.join(f.root, "aliased-store");
    await mkdir(target);
    await symlink(target, f.store);
    await expect(f.discover()).rejects.toMatchObject({ code: "search_scope_unavailable" });
    await rm(f.workspace.path, { recursive: true });
    await expect(f.discover()).rejects.toMatchObject({ code: "search_scope_unavailable" });
  });

  it.skipIf(process.getuid?.() === 0)("keeps unreadable sources seen and does not prune an unreadable store", async () => {
    const f = await fixture();
    try {
      await chmod(f.file, 0);
      const discovery = await f.discover();
      expect(discovery.seenPaths.has(f.file)).toBe(true);
      await expect(readSessionSnapshot(f.workspace, discovery.candidates[0]!)).rejects.toMatchObject({ code: "search_source_changed" });
      await chmod(f.store, 0);
      await expect(f.discover()).rejects.toMatchObject({ code: "search_scope_unavailable" });
    } finally {
      await chmod(f.store, 0o700);
      await chmod(f.file, 0o600);
    }
  });

  it("rejects malformed complete records, partial trailing records, and invalid UTF-8 rather than shortening history", async () => {
    const f = await fixture();
    for (const [suffix, code] of [["\nnot-json\n", "search_session_invalid"], ["\n{\"type\":", "search_source_changed"]]) {
      await writeFile(f.file, jsonl(f.records) + suffix);
      const candidate = (await f.discover()).candidates[0]!;
      await expect(readSessionSnapshot(f.workspace, candidate)).rejects.toMatchObject({ code });
    }
    await writeFile(f.file, Buffer.concat([Buffer.from(jsonl(f.records)), Buffer.from([0xff, 0x0a])]));
    await expect(readSessionSnapshot(f.workspace, (await f.discover()).candidates[0]!)).rejects.toMatchObject({ code: "search_session_invalid" });
  });

  it("handles multi-buffer image-bearing records, excluding their payload", async () => {
    const f = await fixture();
    await writeFile(f.file, jsonl([header(f.workspace.path), user("u", null, [{ type: "image", data: "X".repeat(256 * 1024), mimeType: "image/png" }, { type: "text", text: "Readable 😀 text" }]), assistant("a", "u")]));
    const snapshot = await readSessionSnapshot(f.workspace, (await f.discover()).candidates[0]!);
    expect(snapshot.session.messages[0]?.text).toBe("Readable 😀 text");
    expect(JSON.stringify(snapshot).length).toBeLessThan(5_000);
  });

  it("enforces snapshot and per-record bounds incrementally, with no silent truncation", async () => {
    const f = await fixture();
    await expect(readSessionSnapshot(f.workspace, f.candidate, { maximumBytes: 1 })).rejects.toMatchObject({ code: "search_session_limit" });
    await expect(readSessionSnapshot(f.workspace, f.candidate, { maximumRecordBytes: 16 })).rejects.toMatchObject({ code: "search_session_limit" });
    await expect(readSessionSnapshot(f.workspace, f.candidate, { maximumBytes: 129 * 1024 * 1024 })).rejects.toThrow(RangeError);
    await truncate(f.file, 128 * 1024 * 1024 + 1);
    const candidate = (await f.discover()).candidates[0]!;
    await expect(readSessionSnapshot(f.workspace, candidate)).rejects.toMatchObject({ code: "search_session_limit" });
  });

  it.each(["append", "replacement", "rewind-time", "unlink"])("defers publication when source identity/fingerprint changes (%s)", async (race) => {
    const f = await fixture();
    const before = await stat(f.file);
    const injected = raceFileSystem(async () => {
      if (race === "append") await appendFile(f.file, jsonl([user("u2", "a")]));
      if (race === "replacement") { await rename(f.file, path.join(f.store, "old.jsonl")); await writeFile(f.file, jsonl(f.records)); }
      if (race === "rewind-time") await utimes(f.file, before.atime, new Date(before.mtime.getTime() - 60_000));
      if (race === "unlink") await rm(f.file);
    });
    await expect(readSessionSnapshot(f.workspace, f.candidate, injected)).rejects.toMatchObject({ code: "search_source_changed" });
    expect(injected.close).toHaveBeenCalledOnce();
  });

  it("requires an unchanged complete enumeration witness before absence pruning", async () => {
    const f = await fixture();
    const discovery = await f.discover();
    await expect(assertSessionDiscoveryCurrent(discovery)).resolves.toBeUndefined();
    await writeFile(path.join(f.store, "new-session.jsonl"), jsonl(f.records));
    await expect(assertSessionDiscoveryCurrent(discovery)).rejects.toMatchObject({ code: "search_source_changed" });
    const fresh = await f.discover();
    await expect(assertSessionDiscoveryCurrent({ ...fresh, complete: false })).rejects.toMatchObject({ code: "search_source_changed" });
  });

  it("supports pre-publication revalidation after a successful snapshot", async () => {
    const f = await fixture();
    await readSessionSnapshot(f.workspace, f.candidate);
    await appendFile(f.file, jsonl([user("u2", "a")]));
    await expect(assertSessionSourceCurrent(f.candidate)).rejects.toMatchObject({ code: "search_source_changed" });
    const fresh = (await f.discover()).candidates[0]!;
    expect(sameSourceFingerprint(f.candidate.fingerprint, fresh.fingerprint)).toBe(false);
  });

  it("cancels during reading and always closes descriptors", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const injected = raceFileSystem(async () => controller.abort(new Error("synthetic cancellation")));
    await expect(readSessionSnapshot(f.workspace, f.candidate, { ...injected, signal: controller.signal })).rejects.toThrow("synthetic cancellation");
    expect(injected.close).toHaveBeenCalledOnce();
    await expect(readSessionSnapshot(f.workspace, f.candidate, { signal: controller.signal })).rejects.toThrow("synthetic cancellation");
  });

  it("revisions change only with source identity/storage/universe, not display/policy metadata", async () => {
    const f = await fixture();
    const original = workspaceSourceRevision(f.workspace, f.agentDirectory);
    const renamed = { ...f.workspace, name: "Renamed", securityProfile: "sandboxed", networkPolicy: "isolated", mounts: [] };
    expect(workspaceSourceRevision(renamed, f.agentDirectory)).toBe(original);
    expect(workspaceSourceRevision({ ...f.workspace, id: "other" }, f.agentDirectory)).not.toBe(original);
    expect(workspaceSourceRevision({ ...f.workspace, path: "/changed" }, f.agentDirectory)).not.toBe(original);
    expect(workspaceSourceRevision({ ...f.workspace, sessionDirectory: null }, f.agentDirectory)).not.toBe(original);
    expect(workspaceSourceRevision(f.workspace, "/other-agent")).not.toBe(original);
    expect(scopedSessionStorePath({ ...f.workspace, sessionDirectory: null }, f.agentDirectory)).toContain(path.join(f.agentDirectory, "sessions"));
  });
});
