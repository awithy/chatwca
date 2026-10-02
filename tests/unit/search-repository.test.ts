import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MAX_SEARCH_CHECKPOINT_PAGE, MAX_SEARCH_CHUNK_WRITE_BATCH, MAX_SEARCH_CHUNK_WRITE_BYTES, MAX_SEARCH_REUSE_HASHES, MAX_SEARCH_TITLE_BYTES, PostgresSearchRepository, type SearchDocumentCheckpoint, type SearchDocumentVersion } from "../../src/server/search/repository.js";
import { SearchRepositoryError } from "../../src/server/search/errors.js";
import { searchHash } from "../../src/server/search/extract.js";
import { REPOSITORY_SPACE, REPOSITORY_WORKSPACE, searchPublication } from "../fixtures/search-repository.js";

const documentId = randomUUID();
function fixture(override?: (sql: string, values?: unknown[]) => { rows: Record<string, unknown>[] } | undefined) {
  const state = { previous: null as SearchDocumentVersion | null, chunks: 0 };
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      const custom = override?.(sql, values);
      if (custom !== undefined) return custom;
      if (sql.startsWith("SELECT source_revision")) return { rows: [{ source_revision: REPOSITORY_WORKSPACE.sourceRevision, display_name: "Current Workspace Name", canonical_path: REPOSITORY_WORKSPACE.canonicalPath, session_directory: REPOSITORY_WORKSPACE.sessionDirectory }] };
      if (sql.startsWith("SELECT id AS document_id")) return { rows: state.previous ? [{ document_id: state.previous.documentId, generation: state.previous.generation }] : [] };
      if (sql.startsWith("SELECT count(*)")) return { rows: [{ count: String(state.chunks) }] };
      if (sql.startsWith("INSERT INTO search_documents")) return { rows: [{ document_id: state.previous?.documentId ?? values?.[0], generation: String(BigInt(state.previous?.generation ?? "0") + 1n) }] };
      if (sql.startsWith("INSERT INTO search_workspaces")) return { rows: [{ workspace_id: REPOSITORY_WORKSPACE.workspaceId }] };
      if (sql.startsWith("UPDATE search_documents SET last_seen")) return { rows: [{ id: documentId }] };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  const repository = new PostgresSearchRepository(pool);
  return { repository, client, pool, state };
}
function checkpointRow(sessionId = "session-A", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const candidate = searchPublication();
  return {
    document_id: documentId, generation: "9007199254740993", workspace_id: candidate.workspaceId, source_revision: candidate.sourceRevision,
    session_id: sessionId, source_path: candidate.sourcePath, source_device: candidate.fingerprint.device, source_inode: candidate.fingerprint.inode,
    source_size: candidate.fingerprint.size, source_mtime_ns: candidate.fingerprint.mtimeNs, source_ctime_ns: candidate.fingerprint.ctimeNs,
    title: candidate.title, created_at: new Date(candidate.createdAt), modified_at: new Date(candidate.modifiedAt), saved_leaf_id: candidate.savedLeafId,
    snapshot_hash: candidate.snapshotHash, extracted_content_hash: candidate.extractedContentHash, processing_signature: candidate.processingSignature,
    embedding_space_signature: candidate.embeddingSpaceSignature, last_seen_scan_id: candidate.scanId, ...overrides,
  };
}
function previous(): SearchDocumentCheckpoint {
  const candidate = searchPublication();
  return { ...candidate, documentId, generation: "1", lastSeenScanId: candidate.scanId };
}

describe("atomic search repository boundary", () => {
  it("constructs lazily and publishes a complete generation with checkpoint/lexical metadata in one transaction", async () => {
    const { repository, client, pool } = fixture();
    expect(pool.connect).not.toHaveBeenCalled();
    const candidate = searchPublication();
    const published = await repository.publishDocument(candidate);
    expect(published.generation).toBe("1");
    expect(published.documentId).toMatch(/^[a-f0-9-]{36}$/u);
    const calls = client.query.mock.calls;
    const document = calls.find(([sql]) => sql.startsWith("INSERT INTO search_documents"))!;
    expect(document[1]?.slice(7, 10)).toEqual(["1234", "1700000000000000001", "1700000000000000002"]);
    expect(document[1]?.slice(14, 19)).toEqual([candidate.snapshotHash, candidate.extractedContentHash, candidate.processingSignature, candidate.embeddingSpaceSignature, candidate.scanId]);
    const chunks = calls.find(([sql]) => sql.startsWith("INSERT INTO search_chunks"))!;
    expect(chunks[1]?.slice(2)).toEqual([candidate.embeddingSpaceSignature, candidate.title, "Current Workspace Name"]);
    expect(JSON.parse(chunks[1]![1] as string)[0]).toMatchObject({ stable_key: candidate.chunks[0]?.stableKey, original_text: candidate.chunks[0]?.text, embedding_input_hash: candidate.chunks[0]?.embeddingInputHash });
    const remove = calls.find(([sql]) => sql.startsWith("DELETE FROM search_chunks"))!;
    expect(remove[1]).toEqual([published.documentId, candidate.chunks.map((chunk) => chunk.stableKey)]);
    const counts = calls.find(([sql]) => sql.startsWith("UPDATE search_workspaces SET document_count"))!;
    expect(counts[1]).toEqual([candidate.workspaceId, 1, 1]);
    expect(calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("checks optimistic document identity/generation and preserves bigint precision", async () => {
    const { repository, state, client } = fixture();
    state.previous = { documentId, generation: "9007199254740993" };
    state.chunks = 2;
    const published = await repository.publishDocument(searchPublication(["Updated evidence"], { expected: state.previous }));
    expect(published).toEqual({ documentId, generation: "9007199254740994" });
    expect(client.query.mock.calls.find(([sql]) => sql.startsWith("UPDATE search_workspaces SET document_count"))?.[1]).toEqual([REPOSITORY_WORKSPACE.workspaceId, 0, -1]);
  });

  it.each([null, { documentId, generation: "2" }, { documentId: randomUUID(), generation: "1" }])("rejects stale expected generation (%#) before any document/chunk write", async (expected) => {
    const { repository, state, client } = fixture();
    state.previous = { documentId, generation: "1" };
    await expect(repository.publishDocument(searchPublication(undefined, { expected }))).rejects.toThrow("search_source_changed");
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO search_documents") || sql.startsWith("INSERT INTO search_chunks"))).toBe(false);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("cannot resurrect a deleted committed document using its previous generation", async () => {
    const { repository, client } = fixture();
    await expect(repository.publishDocument(searchPublication(undefined, { expected: { documentId, generation: "1" } }))).rejects.toThrow("search_source_changed");
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO search_documents"))).toBe(false);
  });

  it("rolls back document/checkpoint writes if any chunk batch fails", async () => {
    const { repository, client } = fixture((sql) => {
      if (sql.startsWith("INSERT INTO search_chunks")) throw new Error("raw failing transcript/SQL");
      return undefined;
    });
    await expect(repository.publishDocument(searchPublication())).rejects.toEqual(new SearchRepositoryError("search_database_unavailable"));
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO search_documents"))).toBe(true);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });

  it("bounds chunk upserts by count and actual serialized bytes", async () => {
    const { repository, client } = fixture();
    const raw = Array.from({ length: 1024 }, (_, index) => Math.sin(index + 1));
    const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0));
    const vector = raw.map((value) => value / norm);
    const candidate = searchPublication(Array<string>(65).fill("😀".repeat(3000)), { title: "Bounded title" });
    const chunks = candidate.chunks.map((chunk) => ({ ...chunk, embedding: vector }));
    await repository.publishDocument({ ...candidate, chunks });
    const batches = client.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT INTO search_chunks"));
    expect(batches.length).toBeGreaterThan(2);
    let total = 0;
    for (const [, values] of batches) {
      const body = values![1] as string;
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_SEARCH_CHUNK_WRITE_BYTES);
      const rows = JSON.parse(body) as unknown[];
      expect(rows.length).toBeLessThanOrEqual(MAX_SEARCH_CHUNK_WRITE_BATCH);
      total += rows.length;
    }
    expect(total).toBe(65);
  });

  it("snapshots mutable publication vectors and fingerprints before its first await", async () => {
    const { repository, client } = fixture();
    const candidate = searchPublication();
    const publication = repository.publishDocument(candidate);
    (candidate.chunks[0]!.embedding as number[])[0] = 999;
    (candidate.fingerprint as { mtimeNs: string }).mtimeNs = "0";
    await publication;
    expect(client.query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO search_documents"))?.[1]?.[8]).toBe("1700000000000000001");
    const body = client.query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO search_chunks"))?.[1]?.[1] as string;
    expect(JSON.parse(JSON.parse(body)[0].embedding)[0]).toBe(0.6);
  });

  it("stores empty saved branches without creating synthetic evidence", async () => {
    const { repository, client } = fixture();
    await repository.publishDocument(searchPublication([]));
    expect(client.query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO search_documents"))?.[1]?.[13]).toBe("");
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO search_chunks"))).toBe(false);
    expect(client.query.mock.calls.find(([sql]) => sql.startsWith("DELETE FROM search_chunks"))?.[1]?.[1]).toEqual([]);
  });

  it.each([
    { title: "\ud800" }, { title: "bad\0text" }, { createdAt: NaN }, { snapshotHash: "short" },
    { fingerprint: { device: "1", inode: "2", size: "1234", mtimeNs: "1.5", ctimeNs: "2" } },
    { sourcePath: "/synthetic/../escaping.jsonl" },
  ])("rejects invalid metadata before borrowing a connection (%#)", async (overrides) => {
    const { repository, pool } = fixture();
    await expect(repository.publishDocument(searchPublication(undefined, overrides))).rejects.toThrow("search_index_invalid");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects oversized titles and chunk sets before IO", async () => {
    const { repository, pool } = fixture();
    await expect(repository.publishDocument(searchPublication(undefined, { title: "x".repeat(MAX_SEARCH_TITLE_BYTES + 1) }))).rejects.toThrow("search_session_limit");
    const candidate = searchPublication();
    await expect(repository.publishDocument({ ...candidate, chunks: Array(20_001).fill(candidate.chunks[0]) })).rejects.toThrow("search_session_limit");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    { sourceByteEnd: 999 }, { textHash: "a".repeat(64) }, { embeddingInputHash: "b".repeat(64) },
    { ordinal: 10 }, { role: "system" }, { embedding: Array<number>(1024).fill(0) },
    { embedding: Array<number>(1024).fill(1) }, { embedding: [1] },
  ])("rejects invalid spans/hashes/roles/unit vectors before IO (%#)", async (override) => {
    const { repository, pool } = fixture();
    const candidate = searchPublication();
    const chunks = [{ ...candidate.chunks[0]!, ...override }] as typeof candidate.chunks;
    await expect(repository.publishDocument({ ...candidate, chunks })).rejects.toThrow("search_index_invalid");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("bounds the total publication including copied lexical title metadata", async () => {
    const { repository, pool } = fixture();
    const candidate = searchPublication();
    await expect(repository.publishDocument({ ...candidate, title: "x".repeat(MAX_SEARCH_TITLE_BYTES), chunks: Array(20_000).fill(candidate.chunks[0]) })).rejects.toThrow("search_session_limit");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects sparse/malformed candidate shapes with safe diagnostics before IO", async () => {
    const { repository, pool } = fixture();
    const candidate = searchPublication();
    await expect(repository.publishDocument({ ...candidate, chunks: Array(1) })).rejects.toThrow("search_index_invalid");
    await expect(repository.publishDocument({ ...candidate, fingerprint: null as unknown as typeof candidate.fingerprint })).rejects.toThrow("search_index_invalid");
    await expect(repository.readReusableEmbeddings(previous(), REPOSITORY_SPACE.signature, Array(1))).rejects.toThrow("search_index_invalid");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects title/workspace context disguised as a valid embedding-input hash", async () => {
    const { repository, pool } = fixture();
    const candidate = searchPublication();
    const input = `${candidate.title}\n${candidate.chunks[0]!.embeddingInput}`;
    await expect(repository.publishDocument({ ...candidate, chunks: [{ ...candidate.chunks[0]!, embeddingInput: input, embeddingInputHash: searchHash(input) }] })).rejects.toThrow("search_index_invalid");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects duplicate stable keys", async () => {
    const { repository, pool } = fixture();
    const candidate = searchPublication(["First", "Second"]);
    const chunks = candidate.chunks.map((chunk) => ({ ...chunk, stableKey: candidate.chunks[0]!.stableKey }));
    await expect(repository.publishDocument({ ...candidate, chunks })).rejects.toThrow("search_index_invalid");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("checks current workspace revision under a row lock before any publication", async () => {
    const { repository, client } = fixture((sql) => sql.startsWith("SELECT source_revision") ? { rows: [{ source_revision: "changed" }] } : undefined);
    await expect(repository.publishDocument(searchPublication())).rejects.toThrow("search_source_changed");
    expect(client.query.mock.calls.find(([sql]) => sql.startsWith("SELECT source_revision"))?.[0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("INSERT INTO search_documents"))).toBe(false);
  });

  it("uses conditional workspace registration and synchronizes rename lexical metadata transactionally", async () => {
    const { repository, client } = fixture();
    await repository.synchronizeWorkspace(REPOSITORY_WORKSPACE, null);
    expect(client.query.mock.calls.find(([sql]) => sql.startsWith("INSERT INTO search_workspaces"))?.[0]).toContain("ON CONFLICT (workspace_id) DO NOTHING");
    client.query.mockClear();
    await repository.synchronizeWorkspace(REPOSITORY_WORKSPACE, REPOSITORY_WORKSPACE.sourceRevision);
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE search_chunks c SET lexical_workspace_name"))).toBe(true);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(client.query.mock.calls.some(([sql]) => sql.startsWith("DELETE FROM search_documents"))).toBe(false);
  });

  it("reads frozen workspace keyset pages with one-row lookahead and snapshotted cursor/bound", async () => {
    const row = (id: string) => ({ workspace_id: id, source_revision: REPOSITORY_WORKSPACE.sourceRevision, display_name: "Name",
      canonical_path: REPOSITORY_WORKSPACE.canonicalPath, session_directory: REPOSITORY_WORKSPACE.sessionDirectory });
    const { repository, client } = fixture((sql) => sql.includes("ORDER BY workspace_id") ? { rows: [row("workspace-B"), row("workspace-C"), row("workspace-D")] } : undefined);
    const request = { afterWorkspaceId: "workspace-A", limit: 2 };
    const pending = repository.readWorkspacePage(request); request.afterWorkspaceId = "workspace-Z"; request.limit = 1;
    const page = await pending;
    expect(page.workspaces.map((w) => w.workspaceId)).toEqual(["workspace-B", "workspace-C"]);
    expect(page.nextAfterWorkspaceId).toBe("workspace-C");
    expect(Object.isFrozen(page.workspaces[0])).toBe(true);
    const query = client.query.mock.calls.find(([sql]) => sql.includes("ORDER BY workspace_id"))!;
    expect(query[1]).toEqual(["workspace-A", 3]);
    expect(query[0]).toContain('workspace_id COLLATE "C" > $1::text COLLATE "C"');
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN READ ONLY");
  });

  it("bounds default workspace pages and terminates an empty derived corpus", async () => {
    const { repository, client } = fixture();
    expect(await repository.readWorkspacePage()).toEqual({ workspaces: [], nextAfterWorkspaceId: null });
    expect(client.query.mock.calls.find(([sql]) => sql.includes("ORDER BY workspace_id"))?.[1]).toEqual(["", MAX_SEARCH_CHECKPOINT_PAGE + 1]);
  });

  it.each([{ limit: 0 }, { limit: -1 }, { limit: 65 }, { limit: NaN }, { limit: 1.5 }, { afterWorkspaceId: "" }, { afterWorkspaceId: "private/path" }])("rejects invalid workspace-page requests before IO (%#)", async (request) => {
    const { repository, pool } = fixture();
    await expect(repository.readWorkspacePage(request)).rejects.toThrow("search_index_invalid");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each(["unordered", "duplicate", "cursor", "corrupt", "overflow"])("rejects %s workspace pages with redacted errors", async (mode) => {
    const row = (id: string) => ({ workspace_id: id, source_revision: REPOSITORY_WORKSPACE.sourceRevision, display_name: "Name",
      canonical_path: REPOSITORY_WORKSPACE.canonicalPath, session_directory: REPOSITORY_WORKSPACE.sessionDirectory });
    const rows = mode === "unordered" ? [row("w-C"), row("w-B")] : mode === "duplicate" ? [row("w-B"), row("w-B")] :
      mode === "cursor" ? [row("w-A")] : mode === "corrupt" ? [{ ...row("w-B"), display_name: "\ud800" }] : [row("w-B"), row("w-C"), row("w-D"), row("w-E")];
    const { repository } = fixture((sql) => sql.includes("ORDER BY workspace_id") ? { rows } : undefined);
    await expect(repository.readWorkspacePage({ afterWorkspaceId: "w-A", limit: 2 })).rejects.toEqual(new SearchRepositoryError("search_database_unavailable"));
  });

  it("rejects path changes without a new source revision", async () => {
    const { repository } = fixture();
    await expect(repository.synchronizeWorkspace({ ...REPOSITORY_WORKSPACE, canonicalPath: "/different/workspace" }, REPOSITORY_WORKSPACE.sourceRevision)).rejects.toThrow("search_index_invalid");
  });

  it("limits reuse to exact hashes, space, document generation, current workspace and source revision", async () => {
    const candidate = searchPublication();
    const key = candidate.chunks[0]!.embeddingInputHash;
    const { repository, client } = fixture((sql) => sql.startsWith("SELECT DISTINCT ON") ? { rows: [{ embedding_input_hash: key, embedding: JSON.stringify(candidate.chunks[0]!.embedding) }] } : undefined);
    const saved = previous();
    const vectors = await repository.readReusableEmbeddings(saved, REPOSITORY_SPACE.signature, [key, key]);
    expect(vectors.get(key)).toEqual(candidate.chunks[0]!.embedding);
    expect(Object.isFrozen(vectors.get(key))).toBe(true);
    const query = client.query.mock.calls.find(([sql]) => sql.startsWith("SELECT DISTINCT ON"))!;
    expect(query[1]).toEqual([saved.workspaceId, saved.sourceRevision, saved.documentId, saved.generation, REPOSITORY_SPACE.signature, [key], 1]);
    expect(query[0]).toContain("w.source_revision = $2");
    expect(query[0]).toContain("c.embedding_space_signature = $5 AND d.embedding_space_signature = $5");
    expect(query[0]).toContain("d.generation = $4::bigint");
    expect(query[0]).not.toContain("ordinal =");
  });

  it("bounds reuse queries and rejects malformed stored vectors without leaking their contents", async () => {
    const { repository, pool } = fixture();
    await expect(repository.readReusableEmbeddings(previous(), REPOSITORY_SPACE.signature, Array<string>(MAX_SEARCH_REUSE_HASHES + 1).fill("a".repeat(64)))).rejects.toThrow("search_session_limit");
    expect(pool.connect).not.toHaveBeenCalled();
    const key = searchPublication().chunks[0]!.embeddingInputHash;
    const corrupt = fixture((sql) => sql.startsWith("SELECT DISTINCT ON") ? { rows: [{ embedding_input_hash: key, embedding: "private corrupt transcript" }] } : undefined);
    await expect(corrupt.repository.readReusableEmbeddings(previous(), REPOSITORY_SPACE.signature, [key])).rejects.toEqual(new SearchRepositoryError("search_database_unavailable"));
  });

  it("reads bounded current-scope checkpoint pages with stable keyset ordering and lookahead", async () => {
    const { repository, client } = fixture((sql) => sql.includes("ORDER BY d.session_id") ? { rows: [checkpointRow("session-A"), checkpointRow("session-B"), checkpointRow("session-C")] } : undefined);
    const page = await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { limit: 2 });
    expect(page.checkpoints.map((saved) => saved.sessionId)).toEqual(["session-A", "session-B"]);
    expect(page.nextAfterSessionId).toBe("session-B");
    expect(page.checkpoints[0]?.generation).toBe("9007199254740993");
    expect(page.checkpoints[0]?.fingerprint.mtimeNs).toBe("1700000000000000001");
    expect(Object.isFrozen(page.checkpoints)).toBe(true);
    const query = client.query.mock.calls.find(([sql]) => sql.includes("ORDER BY d.session_id"))!;
    expect(query[1]).toEqual([REPOSITORY_WORKSPACE.workspaceId, REPOSITORY_WORKSPACE.sourceRevision, "", 3]);
    expect(query[0]).toContain('d.session_id COLLATE "C" > $3::text COLLATE "C"');
    expect(query[0]).toContain("w.source_revision = $2");
    expect(query[0]).not.toMatch(/OFFSET|FOR UPDATE/u);
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN READ ONLY");
  });

  it("snapshots exact path/cursor/scope filters before IO and does not pick an arbitrary duplicate identity", async () => {
    const exactPath = "/synthetic/sessions/'quoted'.jsonl";
    const { repository, client } = fixture((sql) => sql.includes("ORDER BY d.session_id") ? { rows: [checkpointRow("session-B", { source_path: exactPath }), checkpointRow("session-C", { source_path: exactPath })] } : undefined);
    const target = { ...REPOSITORY_WORKSPACE };
    const request = { sourcePath: exactPath, afterSessionId: "session-A", limit: 2 };
    const pending = repository.readCheckpointPage(target, request);
    request.sourcePath = "/different.jsonl"; request.afterSessionId = "session-Z"; request.limit = 1; target.sourceRevision = "a".repeat(64);
    const page = await pending;
    expect(page.checkpoints.map((saved) => saved.sessionId)).toEqual(["session-B", "session-C"]);
    expect(page.nextAfterSessionId).toBeNull();
    const query = client.query.mock.calls.find(([sql]) => sql.includes("ORDER BY d.session_id"))!;
    expect(query[1]).toEqual([REPOSITORY_WORKSPACE.workspaceId, REPOSITORY_WORKSPACE.sourceRevision, "session-A", 3, exactPath]);
    expect(query[0]).toContain("md5(d.source_path) = md5($5::text) AND d.source_path = $5");
    expect(query[0]).not.toContain(exactPath);
  });

  it("defaults to a fixed page bound and terminates an empty page", async () => {
    const { repository, client } = fixture();
    expect(await repository.readCheckpointPage(REPOSITORY_WORKSPACE)).toEqual({ checkpoints: [], nextAfterSessionId: null });
    expect(client.query.mock.calls.find(([sql]) => sql.includes("ORDER BY d.session_id"))?.[1]).toEqual([REPOSITORY_WORKSPACE.workspaceId, REPOSITORY_WORKSPACE.sourceRevision, "", MAX_SEARCH_CHECKPOINT_PAGE + 1]);
  });

  it.each([
    { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: NaN }, { limit: MAX_SEARCH_CHECKPOINT_PAGE + 1 },
    { afterSessionId: "" }, { afterSessionId: "private/invalid" }, { sourcePath: "relative.jsonl" }, { sourcePath: "/synthetic/../invalid.jsonl" },
  ])("rejects invalid page requests before IO (%#)", async (request) => {
    const { repository, pool } = fixture();
    await expect(repository.readCheckpointPage(REPOSITORY_WORKSPACE, request)).rejects.toThrow("search_index_invalid");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    [checkpointRow("session-A", { title: "\ud800" })],
    [checkpointRow("session-A", { workspace_id: "other-workspace" })],
    [checkpointRow("session-A", { source_revision: "b".repeat(64) })],
    [checkpointRow("session-A", { source_path: "/different.jsonl" })],
    [checkpointRow("session-B"), checkpointRow("session-A")],
    [checkpointRow("session-A"), checkpointRow("session-A")],
    [checkpointRow("session-A"), checkpointRow("session-B"), checkpointRow("session-C")],
  ].map((rows) => ({ rows })))("rejects corrupt/out-of-scope/unordered/over-limit pages with safe errors (%#)", async ({ rows }) => {
    const { repository } = fixture((sql) => sql.includes("ORDER BY d.session_id") ? { rows } : undefined);
    await expect(repository.readCheckpointPage(REPOSITORY_WORKSPACE, { limit: 1, sourcePath: "/synthetic/sessions/conversation.jsonl" })).rejects.toEqual(new SearchRepositoryError("search_database_unavailable"));
  });

  it("rejects rows at or before the requested cursor", async () => {
    const { repository } = fixture((sql) => sql.includes("ORDER BY d.session_id") ? { rows: [checkpointRow("session-A")] } : undefined);
    await expect(repository.readCheckpointPage(REPOSITORY_WORKSPACE, { afterSessionId: "session-A" })).rejects.toThrow("search_database_unavailable");
  });

  it("applies cancellation and synchronous authority seals to page reads", async () => {
    const { repository, client, pool } = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(repository.readCheckpointPage(REPOSITORY_WORKSPACE, {}, { signal: controller.signal })).rejects.toThrow("search_cancelled");
    expect(pool.connect).not.toHaveBeenCalled();
    let checks = 0;
    await expect(repository.readCheckpointPage(REPOSITORY_WORKSPACE, {}, { assertCurrent: () => {
      if (++checks === 2) throw new SearchRepositoryError("search_source_changed");
    } })).rejects.toThrow("search_source_changed");
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });

  it("marks seen without advancing content/fingerprint/generation and conditions on the previous version", async () => {
    const { repository, client } = fixture();
    const saved = previous(); const scanId = randomUUID();
    await repository.markDocumentSeen(saved, scanId);
    const update = client.query.mock.calls.find(([sql]) => sql.startsWith("UPDATE search_documents SET last_seen"))!;
    expect(update[1]).toEqual([saved.workspaceId, saved.sourceRevision, saved.documentId, saved.generation, scanId]);
    expect(update[0]).not.toContain("generation = generation");
    expect(update[0]).not.toContain("source_size =");
  });

  it("conditions workspace cleanup on source revision and never exposes pruning-by-absence", async () => {
    const { repository, client } = fixture();
    expect(await repository.deleteWorkspace(REPOSITORY_WORKSPACE)).toBe(false);
    expect(client.query.mock.calls.find(([sql]) => sql.startsWith("DELETE FROM search_workspaces"))?.[1]).toEqual([REPOSITORY_WORKSPACE.workspaceId, REPOSITORY_WORKSPACE.sourceRevision]);
    expect("prune" in repository).toBe(false);
  });
});
