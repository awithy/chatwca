import { appendFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Message } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scopedSessionStorePath, type SessionWorkspaceScope } from "../../src/server/session-scope.js";
import { serializeActiveBranch } from "../../src/server/serialize.js";
import { discoverSessionFiles, readSessionSnapshot, sourceFingerprint } from "../../src/server/search/session-source.js";
import { searchAssistantEntry, searchJsonl, searchSessionHeader, searchUserEntry } from "../fixtures/search-session.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function isolated(storage: "pi-default" | "workspace" = "workspace") {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-search-sdk-"));
  roots.push(root);
  const agentDirectory = path.join(root, "agent");
  const workspacePath = path.join(root, "workspace:with_identifiers");
  await mkdir(workspacePath);
  await mkdir(agentDirectory);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDirectory);
  const workspace: SessionWorkspaceScope = {
    id: "workspace", path: workspacePath,
    sessionDirectory: storage === "workspace" ? path.join(workspacePath, ".chatwca", "sessions") : null,
  };
  const manager = SessionManager.create(workspacePath, workspace.sessionDirectory ?? undefined);
  const userMessage = (text: string): Message => searchUserEntry("ignored", null, text).message as Message;
  const assistantMessage = (text: string): Message => searchAssistantEntry("ignored", null, [{ type: "text", text }]).message as Message;
  return { root, agentDirectory, workspace, manager, userMessage, assistantMessage };
}

async function snapshot(f: Awaited<ReturnType<typeof isolated>>) {
  const discovery = await discoverSessionFiles(f.workspace, f.agentDirectory);
  return readSessionSnapshot(f.workspace, discovery.candidates[0]!);
}

describe("Pi 0.84.3 search source contracts", () => {
  it.each(["pi-default", "workspace"] as const)("matches the scoped SDK store/list fixtures (%s), never global listing or runtime creation", async (storage) => {
    const f = await isolated(storage);
    expect(scopedSessionStorePath(f.workspace, f.agentDirectory)).toBe(f.manager.getSessionDir());
    f.manager.appendMessage(f.userMessage("Saved prompt"));
    expect((await discoverSessionFiles(f.workspace, f.agentDirectory)).candidates).toHaveLength(0);
    f.manager.appendMessage(f.assistantMessage("Saved reply"));
    const listing = await SessionManager.list(f.workspace.path, f.workspace.sessionDirectory ?? undefined);
    const global = vi.spyOn(SessionManager, "listAll").mockRejectedValue(new Error("must never scan global history"));
    const source = await discoverSessionFiles(f.workspace, f.agentDirectory);
    const result = await readSessionSnapshot(f.workspace, source.candidates[0]!);
    expect(source.complete).toBe(true);
    expect(source.candidates.map(({ path }) => path)).toEqual(listing.map(({ path }) => path));
    expect(result.session.header.id).toBe(listing[0]?.id);
    expect(result.session.modifiedAt).toBe(listing[0]?.modified.getTime());
    expect(result.session.messages.map(({ text }) => text)).toEqual(["Saved prompt", "Saved reply"]);
    expect(global).not.toHaveBeenCalled();
  });

  it("matches reopened full saved branches through forks/compaction and preserves exact bytes/metadata", async () => {
    const f = await isolated();
    f.manager.appendMessage(f.userMessage("Pre-compaction prompt"));
    const a1 = f.manager.appendMessage(f.assistantMessage("First reply"));
    f.manager.appendMessage(f.userMessage("Abandoned prompt"));
    f.manager.appendMessage(f.assistantMessage("Abandoned reply"));
    f.manager.branchWithSummary(a1, "Do not index branch summary");
    f.manager.appendMessage(f.userMessage("New branch prompt"));
    const a2 = f.manager.appendMessage(f.assistantMessage("New branch reply"));
    f.manager.appendCompaction("Do not index compaction summary", a2, 1000);
    f.manager.appendMessage(f.userMessage("After compaction prompt"));
    f.manager.appendMessage(f.assistantMessage("After compaction reply"));
    f.manager.appendSessionInfo("Named conversation");
    const file = f.manager.getSessionFile()!;
    const oracle = SessionManager.open(file);
    const expected = serializeActiveBranch(oracle).map((message) => ({ entryId: message.entryId, role: message.role, text: message.blocks.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") }));
    const before = sourceFingerprint(await stat(file, { bigint: true }));
    const bytes = await readFile(file);
    const writableOpen = vi.spyOn(SessionManager, "open").mockImplementation(() => { throw new Error("indexing must never open writable session manager"); });
    const result = await snapshot(f);
    expect(result.session.messages.map(({ entryId, role, text }) => ({ entryId, role, text }))).toEqual(expected);
    expect(result.session.title).toBe(oracle.getSessionName());
    expect(result.session.savedLeafId).toBe(oracle.getLeafId());
    expect(result.session.messages.map(({ text }) => text)).toContain("Pre-compaction prompt");
    expect(result.session.messages.map(({ text }) => text)).not.toContain("Abandoned prompt");
    expect(sourceFingerprint(await stat(file, { bigint: true }))).toEqual(before);
    expect(await readFile(file)).toEqual(bytes);
    expect(writableOpen).not.toHaveBeenCalled();
  });

  it("indexes persisted reopen semantics, not a transient live navigation cursor", async () => {
    const f = await isolated();
    const u = f.manager.appendMessage(f.userMessage("Prompt"));
    const a = f.manager.appendMessage(f.assistantMessage("Reply"));
    f.manager.branch(u);
    expect(f.manager.getLeafId()).toBe(u);
    expect((await snapshot(f)).session.savedLeafId).toBe(a);
    f.manager.appendMessage(f.assistantMessage("Persisted fork"));
    expect((await snapshot(f)).session.messages.map(({ text }) => text)).toEqual(["Prompt", "Persisted fork"]);
    f.manager.resetLeaf();
    f.manager.appendMessage(f.userMessage("New root"));
    f.manager.appendMessage(f.assistantMessage("New root reply"));
    expect((await snapshot(f)).session.messages.map(({ text }) => text)).toEqual(["New root", "New root reply"]);
  });

  it("reads SDK-generated fork files independently without rewriting either source", async () => {
    const f = await isolated();
    const u = f.manager.appendMessage(f.userMessage("Fork target"));
    f.manager.appendMessage(f.assistantMessage("Not in the fork"));
    const originalFile = f.manager.getSessionFile()!;
    const originalBytes = await readFile(originalFile);
    const originalId = f.manager.getSessionId();
    const fork = f.manager.createBranchedSession(u)!;
    // User-only forks are prospective paths too; they become discoverable only
    // after the SDK persists their first assistant response.
    expect((await discoverSessionFiles(f.workspace, f.agentDirectory)).candidates).toHaveLength(1);
    f.manager.appendMessage(f.assistantMessage("Fork reply"));
    const discovery = await discoverSessionFiles(f.workspace, f.agentDirectory);
    const forkSnapshot = await readSessionSnapshot(f.workspace, discovery.candidates.find(({ path }) => path === fork)!);
    expect(forkSnapshot.session.header.id).not.toBe(originalId);
    expect(forkSnapshot.session.messages.map(({ text }) => text)).toEqual(["Fork target", "Fork reply"]);
    expect(await readFile(originalFile)).toEqual(originalBytes);
    expect(discovery.candidates).toHaveLength(2);
  });

  it("validates ownership even for a foreign header inside the correct Pi-default directory", async () => {
    const f = await isolated("pi-default");
    f.manager.appendMessage(f.userMessage("Prompt"));
    f.manager.appendMessage(f.assistantMessage("Reply"));
    const foreign = path.join(f.root, "foreign-workspace");
    await mkdir(foreign);
    const injected = path.join(f.manager.getSessionDir(), "foreign.jsonl");
    await writeFile(injected, searchJsonl([searchSessionHeader(foreign), searchUserEntry("u", null), searchAssistantEntry("a", "u")]));
    const discovery = await discoverSessionFiles(f.workspace, f.agentDirectory);
    expect(discovery.candidates).toHaveLength(2);
    await expect(readSessionSnapshot(f.workspace, discovery.candidates.find(({ path }) => path === injected)!)).rejects.toMatchObject({ code: "search_session_invalid" });
  });

  it("accepts a 40 MiB image-bearing record within the 48 MiB limit without retaining its image", async () => {
    const f = await isolated();
    const file = path.join(f.manager.getSessionDir(), "large-image.jsonl");
    const handle = await open(file, "w");
    try {
      await handle.writeFile(searchJsonl([searchSessionHeader(f.workspace.path)]));
      await handle.writeFile('{"type":"message","id":"u","parentId":null,"timestamp":"2025-01-01T00:00:00.000Z","message":{"role":"user","timestamp":1735689600000,"content":[{"type":"image","mimeType":"image/png","data":"');
      const payload = Buffer.alloc(1024 * 1024, 65);
      for (let count = 0; count < 40; count += 1) await handle.writeFile(payload);
      await handle.writeFile('"},{"type":"text","text":"Visible image caption"}]}}\n');
    } finally { await handle.close(); }
    const result = await snapshot(f);
    expect(result.session.messages.map(({ text }) => text)).toEqual(["Visible image caption"]);
    expect(JSON.stringify(result).length).toBeLessThan(5_000);
    // A subsequent incomplete append is deferred; the previous projection is
    // never replaced with a silently shortened transcript by this adapter.
    await appendFile(file, '{"type":');
    await expect(snapshot(f)).rejects.toMatchObject({ code: "search_source_changed" });
  });
});
