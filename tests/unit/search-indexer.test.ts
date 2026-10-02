import { randomUUID } from "node:crypto";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionWorkspaceScope } from "../../src/server/session-scope.js";
import { SearchIndexer, MAX_SEARCH_INDEXER_ERRORS, type SearchRegisteredWorkspace } from "../../src/server/search/indexer.js";
import { SearchEmbeddingError, SearchRepositoryError, SearchSourceError } from "../../src/server/search/errors.js";
import type { SearchDocumentIndexRequest, SearchDocumentIndexResult } from "../../src/server/search/document-indexer.js";
import type { SearchCheckpointPageRequest, SearchDocumentCheckpoint, SearchIndexRepository, SearchRepositoryScope, SearchRepositoryWorkspace, SearchWorkspacePageRequest } from "../../src/server/search/repository.js";
import { workspaceSourceRevision, type SessionDiscovery, type SessionFileCandidate } from "../../src/server/search/session-source.js";
import { REPOSITORY_SPACE, searchPublication } from "../fixtures/search-repository.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const agent = "/synthetic/agent";
const fingerprint = { device: "1", inode: "2", size: "1000", mtimeNs: "1000", ctimeNs: "1000" };
function discovery(workspace: SessionWorkspaceScope, names = ["conversation"]): SessionDiscovery {
  const storePath = workspace.sessionDirectory!;
  return { storePath, storeFingerprint: fingerprint, complete: true, errors: [],
    seenPaths: new Set(names.map((name) => path.join(storePath, `${name}.jsonl`))),
    candidates: names.map((name): SessionFileCandidate => ({ workspaceId: workspace.id, workspacePath: workspace.path, piAgentDirectory: agent,
      path: path.join(storePath, `${name}.jsonl`), canonicalPath: path.join(storePath, `${name}.jsonl`), storePath,
      storeDevice: "1", storeInode: "2", fingerprint })) };
}
function fixture() {
  const w1 = { id: "workspace-1", name: "First Workspace", path: "/synthetic/w1", sessionDirectory: "/synthetic/w1/sessions" };
  const w2 = { id: "workspace-2", name: "Second Workspace", path: "/synthetic/w2", sessionDirectory: "/synthetic/w2/sessions" };
  const state = { registered: [w1, w2] as SearchRegisteredWorkspace[], now: 100 };
  const workspaces = new Map<string, SearchRepositoryWorkspace>();
  const checkpoints = new Map<string, SearchDocumentCheckpoint>();
  const key = (scope: SearchRepositoryScope, sessionId: string) => `${scope.workspaceId}:${sessionId}`;
  const scope = (workspace: SearchRegisteredWorkspace) => ({ workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, agent) });
  function save(workspace: SearchRegisteredWorkspace, sessionId: string, sourcePath = path.join(workspace.sessionDirectory!, `${sessionId}.jsonl`)) {
    const publication = searchPublication([], { ...scope(workspace), sessionId, sourcePath, fingerprint });
    const saved: SearchDocumentCheckpoint = { ...publication, documentId: randomUUID(), generation: "1", lastSeenScanId: publication.scanId };
    checkpoints.set(key(saved, sessionId), saved);
    return saved;
  }
  const repository = {
    readWorkspace: vi.fn(async (id: string) => workspaces.get(id) ?? null),
    readWorkspacePage: vi.fn(async (request: SearchWorkspacePageRequest = {}) => {
      const all = [...workspaces.values()].filter((w) => w.workspaceId > (request.afterWorkspaceId ?? "")).sort((a, b) => a.workspaceId.localeCompare(b.workspaceId));
      const rows = all.slice(0, request.limit ?? 64);
      return { workspaces: rows, nextAfterWorkspaceId: rows.length < all.length ? rows.at(-1)!.workspaceId : null };
    }),
    synchronizeWorkspace: vi.fn(async (workspace: SearchRepositoryWorkspace, _expected: string | null) => { workspaces.set(workspace.workspaceId, workspace); }),
    readCheckpointPage: vi.fn(async (scope: SearchRepositoryScope, request: SearchCheckpointPageRequest = {}) => {
      const all = [...checkpoints.values()].filter((s) => s.workspaceId === scope.workspaceId && s.sourceRevision === scope.sourceRevision &&
        s.sessionId > (request.afterSessionId ?? "") && (request.sourcePath === undefined || s.sourcePath === request.sourcePath)).sort((a, b) => a.sessionId < b.sessionId ? -1 : 1);
      const rows = all.slice(0, request.limit ?? 64);
      return { checkpoints: rows, nextAfterSessionId: rows.length < all.length ? rows.at(-1)!.sessionId : null };
    }),
    deleteDocumentVersion: vi.fn(async (saved: SearchDocumentCheckpoint) => checkpoints.delete(key(saved, saved.sessionId))),
    deleteWorkspace: vi.fn(async (scope: SearchRepositoryScope) => {
      for (const [id, saved] of checkpoints) if (saved.workspaceId === scope.workspaceId) checkpoints.delete(id);
      return workspaces.delete(scope.workspaceId);
    }),
    readCheckpoint: vi.fn(async () => null), readReusableEmbeddings: vi.fn(async () => new Map<string, readonly number[]>()),
    markDocumentSeen: vi.fn(async () => {}), publishDocument: vi.fn(async () => ({ documentId: randomUUID(), generation: "1" })), deleteDocument: vi.fn(async () => false),
  } satisfies SearchIndexRepository;
  const registrations = { list: vi.fn(() => state.registered) };
  const sources = { discover: vi.fn(async (w: SessionWorkspaceScope) => discovery(w)), assertDiscoveryCurrent: vi.fn(async () => {}) };
  const embeddings = { resolveSpace: vi.fn(async () => REPOSITORY_SPACE), embedDocuments: vi.fn(async () => []), assertSpaceCurrent: vi.fn(async () => {}) };
  const documents = {
    index: vi.fn(async (request: SearchDocumentIndexRequest): Promise<SearchDocumentIndexResult> => {
      const id = path.basename(request.candidate.canonicalPath, ".jsonl");
      const saved = save(request.workspace as SearchRegisteredWorkspace, id, request.candidate.canonicalPath);
      return { status: "published", sessionId: id, version: saved, reusedInputs: 0, embeddedInputs: 1 };
    }),
    close: vi.fn(),
  };
  const indexer = new SearchIndexer({ repository, registrations, embeddings, sources, documents, piAgentDirectory: agent, clock: () => state.now++ });
  return { indexer, repository, registrations, embeddings, sources, documents, checkpoints, workspaces, state, w1, w2, save, scope };
}

async function refresh(f: ReturnType<typeof fixture>, request = {}) { f.indexer.requestRefresh(request); await f.indexer.idle(); }

describe("serialized search indexer", () => {
  it("is lazy, syncs ordinary registrations and processes sequentially with one pass space/scan ID", async () => {
    const f = fixture();
    expect(f.registrations.list).not.toHaveBeenCalled(); expect(f.embeddings.resolveSpace).not.toHaveBeenCalled();
    await refresh(f);
    expect(f.repository.synchronizeWorkspace).toHaveBeenCalledTimes(2);
    expect(f.embeddings.resolveSpace).toHaveBeenCalledOnce();
    const requests = f.documents.index.mock.calls.map(([request]) => request);
    expect(requests.map((r) => r.workspace.id)).toEqual([f.w1.id, f.w2.id]);
    expect(requests[0]!.scanId).toBe(requests[1]!.scanId);
    expect(requests[0]).not.toHaveProperty("authority");
    expect(f.indexer.status()).toMatchObject({ state: "idle", pending: false, errorCount: 0, lastSucceededAt: 101,
      progress: { workspaces: 2, discovered: 2, published: 2, deleted: 0 } });
    expect(Object.isFrozen(f.indexer.status().progress)).toBe(true);
  });

  it("filters selected workspace but removes persisted orphan caches, including after restart", async () => {
    const f = fixture();
    f.workspaces.set("orphan", { workspaceId: "orphan", sourceRevision: f.scope(f.w1).sourceRevision, displayName: "Old", canonicalPath: "/old", sessionDirectory: "/old/sessions" });
    await refresh(f, { workspaceId: f.w2.id });
    expect(f.sources.discover.mock.calls.map(([w]) => w.id)).toEqual([f.w2.id]);
    expect(f.workspaces.has("orphan")).toBe(false);
    expect(f.indexer.status().progress.removedWorkspaces).toBe(1);
  });

  it("pages orphan removal and absent checkpoints in batches <=64 without treating checkpoint pages as enumeration", async () => {
    const f = fixture(); f.state.registered = [f.w1];
    for (let i = 0; i < 70; i++) {
      f.save(f.w1, `absent-${String(i).padStart(3, "0")}`);
      f.workspaces.set(`orphan-${String(i).padStart(3, "0")}`, { workspaceId: `orphan-${String(i).padStart(3, "0")}`, sourceRevision: f.scope(f.w1).sourceRevision,
        displayName: "Old", canonicalPath: "/old", sessionDirectory: "/old/sessions" });
    }
    await refresh(f);
    expect(f.indexer.status().progress).toMatchObject({ deleted: 70, removedWorkspaces: 70 });
    expect(f.checkpoints.size).toBe(1);
    expect(f.repository.readCheckpointPage.mock.calls.every(([, request]) => request?.limit === 64)).toBe(true);
    expect(f.repository.readWorkspacePage.mock.calls).toHaveLength(2);
  });

  it("preserves encountered malformed paths and canonical targets, deduplicating successful aliases", async () => {
    const f = fixture(); f.state.registered = [f.w1];
    const seen = f.save(f.w1, "malformed"); const absent = f.save(f.w1, "absent");
    const d = discovery(f.w1, ["alias-a", "alias-b"]);
    const target = path.join(f.w1.sessionDirectory, "target.data");
    const candidates = d.candidates.map((candidate) => ({ ...candidate, canonicalPath: target }));
    f.sources.discover.mockResolvedValueOnce({ ...d, candidates, seenPaths: new Set([...d.seenPaths, seen.sourcePath]) });
    await refresh(f);
    expect(f.documents.index).toHaveBeenCalledOnce();
    expect([...f.checkpoints.values()].map((s) => s.sessionId)).toEqual(["malformed", "target.data"]);
    expect(f.repository.deleteDocumentVersion).toHaveBeenCalledWith(absent, expect.anything());
  });

  it.each(["missing", "incomplete", "witness"] as const)("never absence-prunes a %s store", async (mode) => {
    const f = fixture(); f.state.registered = [f.w1]; const cached = f.save(f.w1, "cached");
    if (mode === "missing") f.sources.discover.mockRejectedValueOnce(new SearchSourceError("search_scope_unavailable"));
    else f.sources.discover.mockResolvedValueOnce({ ...discovery(f.w1, []), complete: mode !== "incomplete" });
    if (mode === "witness") f.sources.assertDiscoveryCurrent.mockRejectedValueOnce(new SearchSourceError("search_source_changed"));
    await refresh(f);
    expect(f.checkpoints.has(`${f.w1.id}:${cached.sessionId}`)).toBe(true);
    expect(f.repository.deleteDocumentVersion).not.toHaveBeenCalled();
    expect(f.indexer.status().errorCount).toBe(1);
    expect(f.indexer.status().lastSucceededAt).toBeNull();
    if (mode !== "witness") expect(f.sources.assertDiscoveryCurrent).not.toHaveBeenCalled();
  });

  it("removes prior IDs at a source path only after successful publication, even with incomplete enumeration", async () => {
    const f = fixture(); f.state.registered = [f.w1];
    const shared = path.join(f.w1.sessionDirectory, "conversation.jsonl");
    const old = f.save(f.w1, "old", shared); f.save(f.w1, "other-old", shared); f.save(f.w1, "absent");
    f.sources.discover.mockResolvedValueOnce({ ...discovery(f.w1), complete: false });
    await refresh(f);
    expect([...f.checkpoints.values()].map((s) => s.sessionId)).toEqual(["absent", "conversation"]);
    expect(f.repository.deleteDocumentVersion).toHaveBeenCalledWith(old, expect.anything());
    expect(f.sources.assertDiscoveryCurrent).not.toHaveBeenCalled();
  });

  it.each([new SearchSourceError("search_session_invalid"), new SearchEmbeddingError("search_embedding_unavailable")])("retains failed encountered documents and continues later work (%s)", async (error) => {
    const f = fixture(); const shared = path.join(f.w1.sessionDirectory, "conversation.jsonl"); const old = f.save(f.w1, "old", shared);
    f.documents.index.mockRejectedValueOnce(error);
    await refresh(f);
    expect(f.checkpoints.get(`${f.w1.id}:old`)).toBe(old);
    expect(f.documents.index).toHaveBeenCalledTimes(2);
    expect(f.indexer.status().progress).toMatchObject({ failed: 1, published: 1 });
    expect(f.repository.deleteDocumentVersion).not.toHaveBeenCalled();
  });

  it("still reconciles safe deletions when model resolution fails; no repeated provider calls within a pass", async () => {
    const f = fixture(); f.save(f.w1, "absent");
    f.embeddings.resolveSpace.mockRejectedValueOnce(new SearchEmbeddingError("search_embedding_unavailable"));
    await refresh(f);
    expect(f.documents.index).not.toHaveBeenCalled(); expect(f.embeddings.resolveSpace).toHaveBeenCalledOnce();
    expect(f.indexer.status().progress.deleted).toBe(1);
    expect(f.indexer.status().errors).toEqual([{ workspaceId: null, code: "search_embedding_unavailable" }]);
  });

  it("coalesces busy refreshes into one scope union and promotes the pending pass to rebuild", async () => {
    const f = fixture(); const gate = deferred<SearchDocumentIndexResult>(); const reached = deferred<void>();
    const original = f.documents.index.getMockImplementation()!;
    f.documents.index.mockImplementationOnce(async (request) => { reached.resolve(); const result = await original(request); await gate.promise; return result; });
    f.indexer.requestRefresh({ workspaceId: f.w1.id }); await reached.promise;
    for (let i = 0; i < 20; i++) f.indexer.requestRefresh({ workspaceId: f.w2.id });
    f.indexer.requestRefresh({ workspaceId: f.w1.id, rebuild: true });
    expect(f.indexer.status()).toMatchObject({ state: "indexing", pending: true });
    gate.resolve({} as SearchDocumentIndexResult); await f.indexer.idle();
    expect(f.documents.index.mock.calls.map(([r]) => [r.workspace.id, r.force])).toEqual([[f.w1.id, false], [f.w1.id, true], [f.w2.id, true]]);
    expect(f.embeddings.resolveSpace).toHaveBeenCalledTimes(2);
  });

  it("compares registrations at workspace boundaries and schedules a fresh pass on change", async () => {
    const f = fixture(); f.state.registered = [f.w1]; const original = f.documents.index.getMockImplementation()!;
    f.documents.index.mockImplementationOnce(async (request) => {
      f.state.registered = [{ ...f.w1, name: "Renamed" }]; return original(request);
    });
    await refresh(f);
    expect(f.documents.index).toHaveBeenCalledTimes(2);
    expect(f.workspaces.get(f.w1.id)?.displayName).toBe("Renamed");
    expect(f.repository.synchronizeWorkspace).toHaveBeenCalledTimes(2);
  });

  it("stops a pass on PostgreSQL failure, does not retry, and reconciles ambiguous writes from fresh metadata", async () => {
    const f = fixture(); const original = f.repository.synchronizeWorkspace.getMockImplementation()!;
    f.repository.synchronizeWorkspace.mockImplementationOnce(async (target, expected) => { await original(target, expected); throw new Error("private lost commit password /path"); });
    await refresh(f);
    expect(f.indexer.status()).toMatchObject({ state: "unavailable", errors: [{ workspaceId: f.w1.id, code: "search_database_unavailable" }] });
    expect(f.sources.discover).not.toHaveBeenCalled(); expect(f.repository.synchronizeWorkspace).toHaveBeenCalledOnce();
    await refresh(f);
    expect(f.repository.synchronizeWorkspace).toHaveBeenCalledTimes(2); // second workspace only, not a blind retry of first
    expect(f.indexer.status().lastSucceededAt).not.toBeNull();
  });

  it("stops on document publication database failures rather than continuing or pruning", async () => {
    const f = fixture();
    f.documents.index.mockRejectedValueOnce(new SearchRepositoryError("search_database_unavailable"));
    await refresh(f);
    expect(f.indexer.status()).toMatchObject({ state: "unavailable", errors: [{ workspaceId: f.w1.id, code: "search_database_unavailable" }] });
    expect(f.documents.index).toHaveBeenCalledOnce();
    expect(f.sources.assertDiscoveryCurrent).not.toHaveBeenCalled();
    expect(f.repository.readWorkspacePage).not.toHaveBeenCalled();
  });

  it("bounds/redacts errors and preserves last-success time when a later pass is degraded", async () => {
    const f = fixture(); await refresh(f); const succeeded = f.indexer.status().lastSucceededAt;
    f.sources.discover.mockResolvedValueOnce({ ...discovery(f.w1, []), complete: false,
      errors: Array.from({ length: 120 }, () => ({ path: "/private/transcript", code: "search_source_changed" as const })) });
    await refresh(f);
    expect(f.indexer.status().errorCount).toBe(120); expect(f.indexer.status().errors).toHaveLength(MAX_SEARCH_INDEXER_ERRORS);
    expect(JSON.stringify(f.indexer.status())).not.toContain("/private");
    expect(f.indexer.status().lastSucceededAt).toBe(succeeded);
  });

  it.each(["discover", "model", "document", "repository"] as const)("shutdown cancels uncooperative %s work, clears pending and prevents late continuation", async (phase) => {
    const f = fixture(); const reached = deferred<void>();
    const wait = async (): Promise<never> => { reached.resolve(); return new Promise(() => {}); };
    if (phase === "discover") f.sources.discover.mockImplementationOnce(wait);
    if (phase === "model") f.embeddings.resolveSpace.mockImplementationOnce(wait);
    if (phase === "document") f.documents.index.mockImplementationOnce(wait);
    if (phase === "repository") f.repository.readWorkspace.mockImplementationOnce(wait);
    f.indexer.requestRefresh(); await reached.promise; f.indexer.requestRefresh({ rebuild: true });
    await f.indexer.close();
    expect(f.indexer.status()).toMatchObject({ state: "closed", pending: false }); expect(f.documents.close).toHaveBeenCalledOnce();
    expect(() => f.indexer.requestRefresh()).toThrow("search_cancelled");
    expect(f.repository.deleteDocumentVersion).not.toHaveBeenCalled();
  });

  it("discards discovery completion arriving after shutdown", async () => {
    const f = fixture(); const reached = deferred<void>(); const late = deferred<SessionDiscovery>();
    f.sources.discover.mockImplementationOnce(async () => { reached.resolve(); return late.promise; });
    f.indexer.requestRefresh(); await reached.promise;
    await f.indexer.close(); late.resolve(discovery(f.w1));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.documents.index).not.toHaveBeenCalled();
    expect(f.embeddings.resolveSpace).not.toHaveBeenCalled();
    expect(f.indexer.status().state).toBe("closed");
  });

  it("does not probe a model for empty stores and rejects invalid manual scopes before IO", async () => {
    const f = fixture();
    expect(() => f.indexer.requestRefresh({ workspaceId: "bad id" })).toThrow("search_index_invalid");
    expect(f.registrations.list).not.toHaveBeenCalled();
    f.sources.discover.mockImplementation(async (workspace) => discovery(workspace, []));
    await refresh(f); expect(f.embeddings.resolveSpace).not.toHaveBeenCalled();
    f.registrations.list.mockImplementationOnce(() => { throw new Error("private sqlite diagnostic"); });
    await refresh(f); expect(f.indexer.status().errors).toEqual([{ workspaceId: null, code: "search_scope_unavailable" }]);
  });
});
