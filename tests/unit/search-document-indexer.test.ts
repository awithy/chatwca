import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SessionWorkspaceScope } from "../../src/server/session-scope.js";
import { SearchDocumentIndexer, projectSearchTitle, type SearchDocumentIndexRequest } from "../../src/server/search/document-indexer.js";
import { MAX_EMBEDDING_REQUEST_BYTES } from "../../src/server/search/embeddings.js";
import { SearchEmbeddingError, SearchRepositoryError, SearchSourceError } from "../../src/server/search/errors.js";
import { extractSession, searchHash } from "../../src/server/search/extract.js";
import { MAX_SEARCH_TITLE_BYTES, type SearchCheckpointPageRequest, type SearchDocumentCheckpoint, type SearchDocumentPublication, type SearchDocumentVersion, type SearchRepositoryScope } from "../../src/server/search/repository.js";
import type { SearchRepositoryOptions } from "../../src/server/search/database.js";
import { workspaceSourceRevision, type SessionFileCandidate } from "../../src/server/search/session-source.js";
import { createEmbeddingSpace } from "../../src/server/search/signatures.js";
import { REPOSITORY_SPACE } from "../fixtures/search-repository.js";
import { fakeSearchVector } from "../fixtures/search-ollama.js";
import { searchSessionHeader, searchUserEntry } from "../fixtures/search-session.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(texts = ["First searchable turn", "Second searchable turn"]) {
  const workspace = { id: "workspace", path: "/synthetic/workspace", sessionDirectory: "/synthetic/sessions" };
  const candidate: SessionFileCandidate = {
    workspaceId: workspace.id, workspacePath: workspace.path, piAgentDirectory: "/synthetic/agent",
    path: "/synthetic/sessions/conversation.jsonl", canonicalPath: "/synthetic/sessions/conversation.jsonl", storePath: workspace.sessionDirectory,
    storeDevice: "1", storeInode: "2", fingerprint: { device: "1", inode: "3", size: "1000", mtimeNs: "1700000000000000001", ctimeNs: "1700000000000000002" },
  };
  const records = [searchSessionHeader(workspace.path), ...texts.map((text, index) => searchUserEntry(`entry-${index}`, index ? `entry-${index - 1}` : null, text))];
  const state = { session: extractSession(records), snapshotHash: searchHash("snapshot"), publications: [] as SearchDocumentPublication[] };
  const checkpoints = new Map<string, SearchDocumentCheckpoint>();
  const storedVectors = new Map<string, readonly number[]>();
  const repository = {
    readCheckpointPage: vi.fn(async (_scope: SearchRepositoryScope, request: SearchCheckpointPageRequest = {}) => {
      const matches = [...checkpoints.values()].filter((saved) => saved.sourcePath === request.sourcePath);
      return { checkpoints: matches.slice(0, 1), nextAfterSessionId: matches.length > 1 ? matches[0]!.sessionId : null };
    }),
    readCheckpoint: vi.fn(async (_scope: SearchRepositoryScope, sessionId: string) => checkpoints.get(sessionId) ?? null),
    readReusableEmbeddings: vi.fn(async (saved: SearchDocumentCheckpoint, signature: string, hashes: readonly string[]) => new Map(hashes.flatMap((hash) => {
      const found = storedVectors.get(hash);
      return saved.embeddingSpaceSignature === signature && found ? [[hash, found] as const] : [];
    }))),
    markDocumentSeen: vi.fn(async (saved: SearchDocumentCheckpoint, scanId: string, options?: SearchRepositoryOptions) => {
      options?.assertCurrent?.();
      checkpoints.set(saved.sessionId, { ...saved, lastSeenScanId: scanId });
    }),
    publishDocument: vi.fn(async (publication: SearchDocumentPublication, options?: SearchRepositoryOptions): Promise<SearchDocumentVersion> => {
      options?.assertCurrent?.();
      const previous = checkpoints.get(publication.sessionId);
      if (previous?.documentId !== publication.expected?.documentId || previous?.generation !== publication.expected?.generation) throw new SearchRepositoryError("search_source_changed");
      options?.assertCurrent?.();
      const published = { documentId: previous?.documentId ?? randomUUID(), generation: String(BigInt(previous?.generation ?? "0") + 1n) };
      checkpoints.set(publication.sessionId, { ...publication, ...published, lastSeenScanId: publication.scanId });
      storedVectors.clear();
      for (const chunk of publication.chunks) storedVectors.set(chunk.embeddingInputHash, chunk.embedding);
      state.publications.push(publication);
      return published;
    }),
  };
  const sources = {
    read: vi.fn(async (_workspace: SessionWorkspaceScope, supplied: SessionFileCandidate, _options: { readonly signal: AbortSignal }) => ({ candidate: supplied, snapshotHash: state.snapshotHash, session: state.session })),
    assertCurrent: vi.fn(async () => {}),
  };
  const embeddings = {
    embedDocuments: vi.fn(async (inputs: readonly string[]) => inputs.map(() => fakeSearchVector(0.6, 0.8))),
    assertSpaceCurrent: vi.fn(async () => {}),
  };
  const request: SearchDocumentIndexRequest = { workspace, candidate, space: REPOSITORY_SPACE, scanId: randomUUID() };
  const indexer = new SearchDocumentIndexer(repository, embeddings, sources);
  return { indexer, repository, embeddings, sources, request, state, checkpoints, records };
}

// Typed fake arguments retain the same narrow dependency contract as production.
type F = ReturnType<typeof fixture>;
function saved(f: F): SearchDocumentCheckpoint { return f.checkpoints.get(f.state.session.header.id)!; }

describe("deterministic per-document reconciliation", () => {
  it("is lazy and publishes metadata, complete chunks and distinct local inputs without authority capabilities", async () => {
    const f = fixture(["Repeated evidence", "Repeated evidence", "Unique evidence"]);
    expect(f.sources.read).not.toHaveBeenCalled();
    expect(f.repository.readCheckpointPage).not.toHaveBeenCalled();
    const result = await f.indexer.index(f.request);
    expect(result).toMatchObject({ status: "published", sessionId: "synthetic-session", embeddedInputs: 2, reusedInputs: 0, version: { generation: "1" } });
    expect(f.embeddings.embedDocuments.mock.calls[0]?.[0]).toEqual(["User message:\nRepeated evidence", "User message:\nUnique evidence"]);
    const publication = f.state.publications[0]!;
    expect(publication.chunks).toHaveLength(3);
    expect(publication.sourceRevision).toBe(workspaceSourceRevision(f.request.workspace, f.request.candidate.piAgentDirectory));
    expect(publication.fingerprint).toEqual(f.request.candidate.fingerprint);
    expect(publication.chunks[0]?.embedding).toBe(publication.chunks[1]?.embedding);
    expect(Object.isFrozen(publication.chunks[0]?.embedding)).toBe(true);
    expect(f.sources.assertCurrent).toHaveBeenCalledOnce();
    expect(f.embeddings.assertSpaceCurrent).toHaveBeenCalledOnce();
  });

  it("skips unchanged files without extraction, reuse or embedding, marking only scan membership", async () => {
    const f = fixture();
    await f.indexer.index(f.request);
    const before = saved(f);
    f.sources.read.mockClear(); f.embeddings.embedDocuments.mockClear();
    const result = await f.indexer.index({ ...f.request, scanId: randomUUID() });
    expect(result).toMatchObject({ status: "unchanged", embeddedInputs: 0, reusedInputs: 0, version: { generation: "1" } });
    expect(f.sources.read).not.toHaveBeenCalled();
    expect(f.embeddings.embedDocuments).not.toHaveBeenCalled();
    expect(f.repository.readReusableEmbeddings).not.toHaveBeenCalled();
    expect(saved(f)).toEqual({ ...before, lastSeenScanId: f.repository.markDocumentSeen.mock.calls[0]?.[1] });
    expect(f.embeddings.assertSpaceCurrent).toHaveBeenCalledTimes(2);
  });

  it.each(["device", "inode", "size", "mtimeNs", "ctimeNs"] as const)("rereads when %s changes, including timestamps moving backward", async (part) => {
    const f = fixture();
    await f.indexer.index(f.request);
    const changed = { ...f.request.candidate, fingerprint: { ...f.request.candidate.fingerprint, [part]: "0" } };
    const result = await f.indexer.index({ ...f.request, candidate: changed });
    expect(result).toMatchObject({ status: "published", reusedInputs: 2, embeddedInputs: 0 });
    expect(f.sources.read).toHaveBeenCalledTimes(2);
    expect(saved(f).fingerprint[part]).toBe("0");
  });

  it("updates metadata-only title changes without embedding and projects oversized Unicode metadata only", async () => {
    const text = "😀".repeat(6000);
    const f = fixture([text]);
    await f.indexer.index(f.request);
    expect(Buffer.byteLength(saved(f).title)).toBeLessThanOrEqual(MAX_SEARCH_TITLE_BYTES);
    expect(f.state.publications[0]!.chunks.map((chunk) => chunk.text).join("")).toContain("😀");
    f.state.session = { ...f.state.session, title: "Explicitly renamed conversation" };
    f.state.snapshotHash = searchHash("title-only snapshot");
    f.embeddings.embedDocuments.mockClear();
    const result = await f.indexer.index({ ...f.request, force: true });
    expect(result.reusedInputs).toBeGreaterThan(0);
    expect(result.embeddedInputs).toBe(0);
    expect(f.embeddings.embedDocuments).not.toHaveBeenCalled();
    expect(saved(f).title).toBe("Explicitly renamed conversation");
    expect(saved(f).snapshotHash).toBe(f.state.snapshotHash);
  });

  it("force reads still reuse; recompute implies force and bypasses reuse", async () => {
    const f = fixture();
    await f.indexer.index(f.request);
    expect(await f.indexer.index({ ...f.request, force: true })).toMatchObject({ status: "published", reusedInputs: 2, embeddedInputs: 0 });
    f.repository.readReusableEmbeddings.mockClear();
    expect(await f.indexer.index({ ...f.request, recomputeEmbeddings: true })).toMatchObject({ status: "published", reusedInputs: 0, embeddedInputs: 2 });
    expect(f.repository.readReusableEmbeddings).not.toHaveBeenCalled();
  });

  it("never skips changed processing/space profiles and never reuses incompatible spaces", async () => {
    const f = fixture();
    await f.indexer.index(f.request);
    f.checkpoints.set(saved(f).sessionId, { ...saved(f), processingSignature: searchHash("older extractor") });
    expect(await f.indexer.index(f.request)).toMatchObject({ status: "published", reusedInputs: 2, embeddedInputs: 0 });
    const changed = createEmbeddingSpace(REPOSITORY_SPACE.model, "b".repeat(64));
    expect(await f.indexer.index({ ...f.request, space: changed })).toMatchObject({ status: "published", reusedInputs: 0, embeddedInputs: 2 });
    expect(saved(f).embeddingSpaceSignature).toBe(changed.signature);
  });

  it("reuses exact unchanged inputs after branch/ordinal changes and embeds only new inputs", async () => {
    const f = fixture();
    await f.indexer.index(f.request);
    f.state.session = extractSession([searchSessionHeader(), searchUserEntry("new-root", null, "Prefix evidence"), searchUserEntry("moved", "new-root", "Second searchable turn")]);
    const result = await f.indexer.index({ ...f.request, force: true });
    expect(result).toMatchObject({ reusedInputs: 1, embeddedInputs: 1 });
    expect(f.state.publications.at(-1)?.chunks.map((chunk) => chunk.entryId)).toEqual(["new-root", "moved"]);
    expect(f.embeddings.embedDocuments.mock.calls.at(-1)?.[0]).toEqual(["User message:\nPrefix evidence"]);
  });

  it("does not arbitrarily skip one of multiple prior identities at a path", async () => {
    const f = fixture();
    await f.indexer.index(f.request);
    f.checkpoints.set("obsolete-session", { ...saved(f), sessionId: "obsolete-session", documentId: randomUUID() });
    expect(await f.indexer.index(f.request)).toMatchObject({ status: "published" });
    expect(f.sources.read).toHaveBeenCalledTimes(2);
    expect(f.checkpoints.has("obsolete-session")).toBe(true); // path replacement cleanup belongs to the single worker
  });

  it("uses canonical targets for symlink alias lookup and reuses a moved session by ID", async () => {
    const f = fixture();
    await f.indexer.index(f.request);
    const alias = { ...f.request.candidate, path: "/synthetic/sessions/alias.jsonl" };
    expect(await f.indexer.index({ ...f.request, candidate: alias })).toMatchObject({ status: "unchanged" });
    const moved = { ...alias, canonicalPath: "/synthetic/sessions/moved.jsonl" };
    expect(await f.indexer.index({ ...f.request, candidate: moved })).toMatchObject({ status: "published", reusedInputs: 2 });
    expect(saved(f).sourcePath).toBe(moved.canonicalPath);
  });

  it("streams reuse hashes <=128 and document inputs <=16 with cross-batch deduplication", async () => {
    const f = fixture(Array.from({ length: 140 }, (_, index) => `Distinct ${index}`));
    await f.indexer.index(f.request);
    expect(f.embeddings.embedDocuments.mock.calls.map(([inputs]) => inputs.length)).toEqual([16, 16, 16, 16, 16, 16, 16, 16, 12]);
    const result = await f.indexer.index({ ...f.request, force: true });
    expect(result).toMatchObject({ reusedInputs: 140, embeddedInputs: 0 });
    expect(f.repository.readReusableEmbeddings.mock.calls.map((call) => call[2].length)).toEqual([128, 12]);
  });

  it("bounds serialized embedding requests when control-character escaping expands legal inputs", async () => {
    const f = fixture(Array.from({ length: 16 }, (_, index) => `${index}${"\u0001".repeat(3190)}`));
    await f.indexer.index(f.request);
    expect(f.embeddings.embedDocuments.mock.calls.length).toBeGreaterThan(1);
    for (const [input] of f.embeddings.embedDocuments.mock.calls) {
      expect(Buffer.byteLength(JSON.stringify({ model: REPOSITORY_SPACE.model, input, truncate: false, keep_alive: "10m" }))).toBeLessThanOrEqual(MAX_EMBEDDING_REQUEST_BYTES);
    }
  });

  it("publishes empty saved branches without synthetic chunks or embedding calls", async () => {
    const f = fixture([]);
    expect(await f.indexer.index(f.request)).toMatchObject({ status: "published", reusedInputs: 0, embeddedInputs: 0 });
    expect(f.state.publications[0]?.chunks).toEqual([]);
    expect(saved(f).savedLeafId).toBeNull();
    expect(f.embeddings.embedDocuments).not.toHaveBeenCalled();
  });

  it.each([[], [fakeSearchVector(0, 0)], [fakeSearchVector(NaN, 1)], [[1]], [fakeSearchVector(1, 1)]].map((response) => ({ response })))("rejects invalid injected vector responses before publication (%#)", async ({ response }) => {
    const f = fixture(["Only input"]);
    f.embeddings.embedDocuments.mockResolvedValue(response as number[][]);
    await expect(f.indexer.index(f.request)).rejects.toThrow("search_embedding_invalid");
    expect(f.repository.publishDocument).not.toHaveBeenCalled();
  });

  it.each(["source", "model"] as const)("discards a candidate after a late %s change without advancing checkpoint", async (dependency) => {
    const f = fixture();
    await f.indexer.index(f.request);
    const before = saved(f);
    f.repository.publishDocument.mockClear();
    if (dependency === "source") f.sources.assertCurrent.mockRejectedValueOnce(new SearchSourceError("search_source_changed"));
    if (dependency === "model") f.embeddings.assertSpaceCurrent.mockRejectedValueOnce(new SearchEmbeddingError("search_embedding_space_changed"));
    await expect(f.indexer.index({ ...f.request, force: true })).rejects.toThrow(/search_source_changed|search_embedding_space_changed/u);
    expect(f.repository.publishDocument).not.toHaveBeenCalled();
    expect(saved(f)).toBe(before);
  });

  it("rechecks source after model IO; skip paths receive the same checks", async () => {
    const f = fixture();
    await f.indexer.index(f.request);
    let sourceChanged = false;
    f.embeddings.assertSpaceCurrent.mockImplementationOnce(async () => { sourceChanged = true; });
    f.sources.assertCurrent.mockImplementationOnce(async () => { if (sourceChanged) throw new SearchSourceError("search_source_changed"); });
    await expect(f.indexer.index(f.request)).rejects.toThrow("search_source_changed");
    expect(f.repository.markDocumentSeen).not.toHaveBeenCalled();
  });

  it("supplies cancellation checks to the repository before commit", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.repository.publishDocument.mockImplementationOnce(async (_publication, options) => {
      controller.abort();
      options?.assertCurrent?.();
      return { documentId: randomUUID(), generation: "1" };
    });
    await expect(f.indexer.index({ ...f.request, signal: controller.signal })).rejects.toThrow("search_cancelled");
    expect(f.state.publications).toEqual([]);
  });

  it.each([true, false])("retains cached content on invalid ownership without suppression callbacks (%s)", async (confirmed) => {
    const f = fixture();
    await f.indexer.index(f.request);
    const before = saved(f);
    f.sources.read.mockRejectedValueOnce(new SearchSourceError("search_session_invalid", confirmed));
    await expect(f.indexer.index({ ...f.request, force: true })).rejects.toThrow("search_session_invalid");
    expect(f.repository.publishDocument).toHaveBeenCalledOnce();
    expect(saved(f)).toBe(before);
  });

  it("retains the previous complete generation when a later embedding batch fails", async () => {
    const f = fixture();
    await f.indexer.index(f.request);
    const before = saved(f);
    f.state.session = extractSession([searchSessionHeader(), ...Array.from({ length: 20 }, (_, index) => searchUserEntry(`new-${index}`, index ? `new-${index - 1}` : null, `Changed turn ${index}`))]);
    f.embeddings.embedDocuments.mockResolvedValueOnce(Array.from({ length: 16 }, () => fakeSearchVector(0.6, 0.8))).mockRejectedValueOnce(new SearchEmbeddingError("search_embedding_unavailable"));
    await expect(f.indexer.index({ ...f.request, force: true })).rejects.toThrow("search_embedding_unavailable");
    expect(saved(f)).toBe(before);
    expect(f.repository.publishDocument).toHaveBeenCalledOnce();
  });

  it("rejects an over-budget prepared title/chunk set before any embedding work", async () => {
    const f = fixture(Array.from({ length: 16_500 }, () => "x".repeat(100)));
    f.state.session = { ...f.state.session, title: "x".repeat(MAX_SEARCH_TITLE_BYTES) };
    await expect(f.indexer.index(f.request)).rejects.toThrow("search_session_limit");
    expect(f.embeddings.embedDocuments).not.toHaveBeenCalled();
    expect(f.repository.publishDocument).not.toHaveBeenCalled();
  });

  it("does not retry an ambiguous commit and reconciles from fresh checkpoint metadata on the next attempt", async () => {
    const f = fixture();
    const publish = f.repository.publishDocument.getMockImplementation()!;
    f.repository.publishDocument.mockImplementationOnce(async (publication, options) => {
      await publish(publication, options);
      throw new SearchRepositoryError("search_database_unavailable");
    });
    await expect(f.indexer.index(f.request)).rejects.toThrow("search_database_unavailable");
    expect(f.repository.publishDocument).toHaveBeenCalledOnce();
    expect(saved(f).generation).toBe("1");
    expect(await f.indexer.index(f.request)).toMatchObject({ status: "unchanged", version: { generation: "1" } });
    expect(f.repository.publishDocument).toHaveBeenCalledOnce();
  });

  it.each(["source", "embedding", "repository", "finalSource", "finalModel"] as const)("redacts unexpected %s diagnostics", async (dependency) => {
    const f = fixture();
    const privateError = new Error("secret credentials /path transcript");
    if (dependency === "source") f.sources.read.mockRejectedValueOnce(privateError);
    if (dependency === "embedding") f.embeddings.embedDocuments.mockRejectedValueOnce(privateError);
    if (dependency === "repository") f.repository.readCheckpointPage.mockRejectedValueOnce(privateError);
    if (dependency === "finalSource") f.sources.assertCurrent.mockRejectedValueOnce(privateError);
    if (dependency === "finalModel") f.embeddings.assertSpaceCurrent.mockRejectedValueOnce(privateError);
    const error = await f.indexer.index(f.request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/secret|credentials|transcript|\/path/u);
  });

  it("snapshots request scope, candidate, fingerprint, space and flags before its first await", async () => {
    const f = fixture();
    const request = { ...f.request, workspace: { ...f.request.workspace }, candidate: { ...f.request.candidate, fingerprint: { ...f.request.candidate.fingerprint } }, space: { ...f.request.space }, force: false };
    const pending = f.indexer.index(request);
    request.workspace.path = "/changed"; request.candidate.fingerprint.mtimeNs = "0"; request.space.signature = "changed"; request.scanId = randomUUID(); request.force = true;
    await pending;
    expect(f.state.publications[0]?.sourceRevision).toBe(workspaceSourceRevision(f.request.workspace, f.request.candidate.piAgentDirectory));
    expect(f.state.publications[0]?.fingerprint.mtimeNs).toBe(f.request.candidate.fingerprint.mtimeNs);
    expect(f.state.publications[0]?.scanId).toBe(f.request.scanId);
  });

  it("rejects forged spaces and wrong-workspace candidates before IO", async () => {
    const f = fixture();
    await expect(f.indexer.index({ ...f.request, space: { ...f.request.space, signature: searchHash("forged") } })).rejects.toThrow("search_embedding_space_changed");
    await expect(f.indexer.index({ ...f.request, candidate: { ...f.request.candidate, workspaceId: "other" } })).rejects.toThrow("search_source_changed");
    expect(f.repository.readCheckpointPage).not.toHaveBeenCalled();
  });

  it.each(["cancel", "close"] as const)("seals %s during uncooperative source IO, rejects overflow and prevents late publication", async (mode) => {
    const f = fixture();
    const stalled = deferred<Awaited<ReturnType<typeof f.sources.read>>>();
    const reached = deferred<void>();
    f.sources.read.mockImplementationOnce(async () => { reached.resolve(); return stalled.promise; });
    const controller = new AbortController();
    const pending = expect(f.indexer.index({ ...f.request, signal: controller.signal })).rejects.toThrow("search_cancelled");
    await reached.promise;
    await expect(f.indexer.index(f.request)).rejects.toThrow("search_busy");
    if (mode === "cancel") controller.abort(new Error("private reason")); else f.indexer.close();
    await pending;
    stalled.resolve({ candidate: f.request.candidate, session: f.state.session, snapshotHash: f.state.snapshotHash });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.repository.publishDocument).not.toHaveBeenCalled();
    if (mode === "close") await expect(f.indexer.index(f.request)).rejects.toThrow("search_cancelled");
    else expect(await f.indexer.index(f.request)).toMatchObject({ status: "published" });
  });

  it("removes cancellation listeners even when an injected source never settles", async () => {
    const f = fixture();
    const controller = new AbortController();
    const callerRemove = vi.spyOn(controller.signal, "removeEventListener");
    const reached = deferred<AbortSignal>();
    f.sources.read.mockImplementationOnce(async (_workspace, _candidate, options) => {
      reached.resolve(options.signal);
      return new Promise(() => {});
    });
    const pending = expect(f.indexer.index({ ...f.request, signal: controller.signal })).rejects.toThrow("search_cancelled");
    const internal = await reached.promise;
    const internalRemove = vi.spyOn(internal, "removeEventListener");
    controller.abort(); await pending;
    expect(internalRemove).toHaveBeenCalledOnce();
    expect(callerRemove).toHaveBeenCalledOnce();
    expect(f.repository.publishDocument).not.toHaveBeenCalled();
  });

  it.each(["model", "source"] as const)("cancels uncooperative final %s checks without late publication", async (dependency) => {
    const f = fixture();
    const reached = deferred<void>();
    const stalled = deferred<void>();
    const wait = async () => { reached.resolve(); return stalled.promise; };
    if (dependency === "model") f.embeddings.assertSpaceCurrent.mockImplementationOnce(wait);
    else f.sources.assertCurrent.mockImplementationOnce(wait);
    const controller = new AbortController();
    const pending = expect(f.indexer.index({ ...f.request, signal: controller.signal })).rejects.toThrow("search_cancelled");
    await reached.promise; controller.abort(); await pending;
    stalled.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.repository.publishDocument).not.toHaveBeenCalled();
  });

  it("cancels uncooperative embedding IO without retrying or publishing its late vectors", async () => {
    const f = fixture();
    const stalled = deferred<number[][]>(); const reached = deferred<void>();
    f.embeddings.embedDocuments.mockImplementationOnce(async () => { reached.resolve(); return stalled.promise; });
    const controller = new AbortController();
    const pending = expect(f.indexer.index({ ...f.request, signal: controller.signal })).rejects.toThrow("search_cancelled");
    await reached.promise; controller.abort(); await pending;
    stalled.resolve([fakeSearchVector(0.6, 0.8), fakeSearchVector(0.6, 0.8)]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.repository.publishDocument).not.toHaveBeenCalled();
  });
});

describe("bounded display title projection", () => {
  it("preserves exact fitting text, caps UTF-8 without splitting surrogate pairs and repairs metadata NUL only", () => {
    expect(projectSearchTitle("")).toBe("");
    expect(projectSearchTitle("Original Case\nIndent")).toBe("Original Case\nIndent");
    expect(projectSearchTitle("a\0b")).toBe("a\ufffdb");
    const projected = projectSearchTitle(`${"a".repeat(MAX_SEARCH_TITLE_BYTES - 1)}😀`);
    expect(Buffer.byteLength(projected)).toBe(MAX_SEARCH_TITLE_BYTES - 1);
    expect(projected).not.toMatch(/[\ud800-\udfff]/u);
    expect(() => projectSearchTitle("\ud800")).toThrow("search_index_invalid");
  });
});
