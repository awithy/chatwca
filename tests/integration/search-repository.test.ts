import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchRepositoryDatabase } from "../../src/server/search/database.js";
import { searchHash } from "../../src/server/search/extract.js";
import { SearchRepositoryError } from "../../src/server/search/errors.js";
import { loadSearchMigrations, migrateSearchDatabase, type SearchDatabasePool } from "../../src/server/search/migrations.js";
import { createSearchPool } from "../../src/server/search/postgres.js";
import { PostgresSearchRepository } from "../../src/server/search/repository.js";
import { createEmbeddingSpace } from "../../src/server/search/signatures.js";
import { FAKE_CHANGED_DIGEST, FAKE_EMBEDDING_MODEL } from "../fixtures/search-ollama.js";
import { REPOSITORY_SPACE, REPOSITORY_WORKSPACE, searchPublication } from "../fixtures/search-repository.js";

const testUrl = process.env.CHATWCA_SEARCH_TEST_DATABASE_URL;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Explicit disposable database opt-in, private random schema, synthetic evidence only. */
describe.skipIf(testUrl === undefined)("PostgreSQL atomic search repository", () => {
  const schema = `chatwca_search_repository_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let repository: PostgresSearchRepository;
  let created = false;
  beforeAll(async () => {
    admin = createSearchPool(testUrl!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    const url = new URL(testUrl!);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    pool = createSearchPool(url.toString());
    await migrateSearchDatabase(pool, await loadSearchMigrations());
    repository = new PostgresSearchRepository(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE search_workspaces CASCADE");
    await repository.synchronizeWorkspace(REPOSITORY_WORKSPACE, null);
  });
  afterAll(async () => {
    repository?.close();
    await pool?.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  function injected(hook: (sql: string, values: unknown[] | undefined, query: () => Promise<{ rows: Record<string, unknown>[] }>) => Promise<{ rows: Record<string, unknown>[] }>): SearchDatabasePool {
    return { connect: async () => {
      const client = await pool.connect();
      return { query: (sql, values) => hook(sql, values, () => client.query(sql, values)), release: (destroy) => client.release(destroy) };
    } };
  }
  async function counts() {
    const result = await pool.query("SELECT document_count, chunk_count FROM search_workspaces WHERE workspace_id = $1", [REPOSITORY_WORKSPACE.workspaceId]);
    return result.rows[0] as { document_count: number; chunk_count: number };
  }

  it("publishes normalized vectors, exact nanosecond checkpoints, scope and counters", async () => {
    expect(await repository.readWorkspace(REPOSITORY_WORKSPACE.workspaceId)).toEqual(REPOSITORY_WORKSPACE);
    expect(await repository.readWorkspace("unregistered-workspace")).toBeNull();
    const candidate = searchPublication(["Code_Name.ts contains the chosen isolation approach"], { title: "ConversationHeadingWord" });
    const first = await repository.publishDocument(candidate);
    const checkpoint = await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId);
    expect(checkpoint).toMatchObject({ ...first, workspaceId: candidate.workspaceId, sourceRevision: candidate.sourceRevision,
      title: candidate.title, savedLeafId: candidate.savedLeafId, fingerprint: candidate.fingerprint,
      snapshotHash: candidate.snapshotHash, extractedContentHash: candidate.extractedContentHash,
      processingSignature: candidate.processingSignature, embeddingSpaceSignature: REPOSITORY_SPACE.signature, lastSeenScanId: candidate.scanId,
      createdAt: candidate.createdAt, modifiedAt: candidate.modifiedAt });
    const result = await pool.query(`SELECT vector_dims(embedding) AS dimensions, lexical_title, lexical_workspace_name,
      search_english @@ plainto_tsquery('english', 'ConversationHeadingWord') AS title_match,
      search_simple @@ plainto_tsquery('simple', 'isolation') AS body_match FROM search_chunks`);
    expect(result.rows).toEqual([{ dimensions: 1024, lexical_title: candidate.title, lexical_workspace_name: REPOSITORY_WORKSPACE.displayName, title_match: true, body_match: true }]);
    expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
  });

  it("pages derived workspace registrations in C order while removing each observed page", async () => {
    const ids = ["w-z", "w_0", "w.0", "w-Z", "w-A", "w-0"];
    for (const workspaceId of ids) await repository.synchronizeWorkspace({ ...REPOSITORY_WORKSPACE, workspaceId }, null);
    const seen: string[] = []; let afterWorkspaceId: string | null = null;
    do {
      const page = await repository.readWorkspacePage({ afterWorkspaceId, limit: 2 });
      for (const workspace of page.workspaces) { seen.push(workspace.workspaceId); await repository.deleteWorkspace(workspace); }
      afterWorkspaceId = page.nextAfterWorkspaceId;
    } while (afterWorkspaceId !== null);
    expect(seen).toEqual([...ids, REPOSITORY_WORKSPACE.workspaceId].sort());
    expect(await repository.readWorkspacePage()).toEqual({ workspaces: [], nextAfterWorkspaceId: null });
  });

  it("pages all checkpoints and duplicate source-path identities with deterministic keyset ordering", async () => {
    const ids = ["s-a", "s_0", "s.0", "s-Z", "s-A", "s-0"];
    const commonPath = "/synthetic/sessions/shared.jsonl";
    for (const sessionId of ids) await repository.publishDocument(searchPublication([], { sessionId, sourcePath: sessionId === "s_0" ? "/synthetic/sessions/other.jsonl" : commonPath }));
    const seen: string[] = [];
    let afterSessionId: string | null = null;
    do {
      const page = await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { afterSessionId, limit: 2 });
      seen.push(...page.checkpoints.map((saved) => saved.sessionId));
      afterSessionId = page.nextAfterSessionId;
    } while (afterSessionId !== null);
    expect(seen).toEqual([...ids].sort());
    const matches: string[] = [];
    afterSessionId = null;
    do {
      const page = await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { sourcePath: commonPath, afterSessionId, limit: 2 });
      matches.push(...page.checkpoints.map((saved) => saved.sessionId));
      expect(page.checkpoints.every((saved) => saved.sourcePath === commonPath)).toBe(true);
      afterSessionId = page.nextAfterSessionId;
    } while (afterSessionId !== null);
    expect(matches).toEqual(ids.filter((id) => id !== "s_0").sort());
    expect(await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { sourcePath: "/synthetic/sessions/missing.jsonl" })).toEqual({ checkpoints: [], nextAfterSessionId: null });
    expect((await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { afterSessionId: "s_0" })).checkpoints).toEqual([]);
    expect(await counts()).toEqual({ document_count: 6, chunk_count: 0 });
  });

  it("intersects every page with the current derived revision and requested workspace", async () => {
    const candidate = searchPublication([]);
    await repository.publishDocument(candidate);
    const other = { ...REPOSITORY_WORKSPACE, workspaceId: "other-workspace" };
    await repository.synchronizeWorkspace(other, null);
    await repository.publishDocument({ ...candidate, ...other });
    expect((await repository.readCheckpointPage(REPOSITORY_WORKSPACE)).checkpoints).toHaveLength(1);
    expect((await repository.readCheckpointPage(other)).checkpoints.map((saved) => saved.workspaceId)).toEqual([other.workspaceId]);
    expect((await repository.readCheckpointPage({ ...REPOSITORY_WORKSPACE, sourceRevision: searchHash("obsolete") })).checkpoints).toEqual([]);
    // Deliberately stale derived rows cannot bypass the workspace revision join.
    await pool.query("UPDATE search_workspaces SET source_revision = $2 WHERE workspace_id = $1", [candidate.workspaceId, searchHash("replaced")]);
    expect((await repository.readCheckpointPage(REPOSITORY_WORKSPACE)).checkpoints).toEqual([]);
    expect((await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { sourcePath: candidate.sourcePath })).checkpoints).toEqual([]);
  });

  it("looks up long paths beyond the raw btree key limit using exact equality", async () => {
    // Incompressible ASCII near the repository's 4 KiB path cap.
    const longPath = `/synthetic/${Array.from({ length: 120 }, () => randomUUID().replaceAll("-", "")).join("")}.jsonl`;
    await repository.publishDocument(searchPublication([], { sourcePath: longPath }));
    const page = await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { sourcePath: longPath });
    expect(page.checkpoints).toHaveLength(1);
    expect(page.checkpoints[0]?.sourcePath).toBe(longPath);
    expect((await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { sourcePath: `${longPath.slice(0, -6)}x.jsonl` })).checkpoints).toEqual([]);
  });

  it("treats paging as fresh derived metadata rather than a consistent cross-page snapshot", async () => {
    for (const sessionId of ["session-A", "session-C"]) await repository.publishDocument(searchPublication([], { sessionId }));
    const first = await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { limit: 1 });
    expect(first.nextAfterSessionId).toBe("session-A");
    await repository.deleteDocument(REPOSITORY_WORKSPACE, "session-C");
    await repository.publishDocument(searchPublication([], { sessionId: "session-B" }));
    const next = await repository.readCheckpointPage(REPOSITORY_WORKSPACE, { afterSessionId: first.nextAfterSessionId, limit: 1 });
    expect(next.checkpoints.map((saved) => saved.sessionId)).toEqual(["session-B"]);
    expect(next.nextAfterSessionId).toBeNull();
    const replacement = { ...REPOSITORY_WORKSPACE, sourceRevision: searchHash("replacement") };
    await repository.synchronizeWorkspace(replacement, REPOSITORY_WORKSPACE.sourceRevision);
    expect((await repository.readCheckpointPage(REPOSITORY_WORKSPACE)).checkpoints).toEqual([]);
  });

  it("reuses exact input/space matches when ordinals/keys change, not stale generations or other scopes", async () => {
    const original = searchPublication(["Stable evidence", "Stable evidence"], { title: "OriginalTitleWord" });
    await repository.publishDocument(original);
    const saved = (await repository.readCheckpoint(REPOSITORY_WORKSPACE, original.sessionId))!;
    const inputs = original.chunks.map((chunk) => chunk.embeddingInputHash);
    const reuse = await repository.readReusableEmbeddings(saved, REPOSITORY_SPACE.signature, inputs);
    expect(reuse.size).toBe(1); // duplicated input across entries is one reusable vector
    expect(reuse.get(inputs[0]!)?.slice(0, 2)).toEqual([0.6, 0.8]);
    const different = createEmbeddingSpace(FAKE_EMBEDDING_MODEL, FAKE_CHANGED_DIGEST);
    expect((await repository.readReusableEmbeddings(saved, different.signature, inputs)).size).toBe(0);
    expect((await repository.readReusableEmbeddings({ ...saved, workspaceId: "other-workspace" }, REPOSITORY_SPACE.signature, inputs)).size).toBe(0);
    const updated = searchPublication(["New prefix", "Stable evidence", "Stable evidence"], {
      expected: saved, title: "RenamedTitleWord", fingerprint: { ...original.fingerprint, mtimeNs: "1699999999999999999", ctimeNs: "1700000000000000003" },
    });
    const chunks = updated.chunks.map((chunk) => ({ ...chunk, embedding: reuse.get(chunk.embeddingInputHash) ?? chunk.embedding }));
    const next = await repository.publishDocument({ ...updated, chunks });
    expect(next).toEqual({ documentId: saved.documentId, generation: "2" });
    expect((await repository.readReusableEmbeddings(saved, REPOSITORY_SPACE.signature, inputs)).size).toBe(0);
    const current = (await repository.readCheckpoint(REPOSITORY_WORKSPACE, original.sessionId))!;
    expect(current.fingerprint.mtimeNs).toBe("1699999999999999999");
    expect((await repository.readReusableEmbeddings(current, REPOSITORY_SPACE.signature, inputs)).size).toBe(1);
    expect(await counts()).toEqual({ document_count: 1, chunk_count: 3 });
  });

  it("updates title/workspace lexical metadata transactionally without changing vectors or stable chunk IDs", async () => {
    const candidate = searchPublication(["Persistent body evidence"], { title: "OldTitleWord" });
    const first = await repository.publishDocument(candidate);
    const before = (await pool.query("SELECT id, embedding::text, embedding_input_hash FROM search_chunks")).rows;
    const renamed = { ...candidate, expected: first, title: "NewTitleWord", scanId: randomUUID() };
    await repository.publishDocument(renamed);
    await repository.synchronizeWorkspace({ ...REPOSITORY_WORKSPACE, displayName: "RenamedWorkspaceWord" }, REPOSITORY_WORKSPACE.sourceRevision);
    const after = (await pool.query("SELECT id, embedding::text, embedding_input_hash FROM search_chunks")).rows;
    expect(after).toEqual(before);
    const lexical = await pool.query(`SELECT search_english @@ plainto_tsquery('english', 'NewTitleWord') AS new_title,
      search_english @@ plainto_tsquery('english', 'OldTitleWord') AS old_title,
      search_simple @@ plainto_tsquery('simple', 'RenamedWorkspaceWord') AS new_workspace FROM search_chunks`);
    expect(lexical.rows).toEqual([{ new_title: true, old_title: false, new_workspace: true }]);
    expect((await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId))?.generation).toBe("2");
    expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
  });

  it("rolls back every chunk, metadata, generation and checkpoint when a later batch fails", async () => {
    const initial = searchPublication(["Committed old evidence"], { title: "OldTitleWord" });
    await repository.publishDocument(initial);
    const saved = (await repository.readCheckpoint(REPOSITORY_WORKSPACE, initial.sessionId))!;
    const before = (await pool.query("SELECT id, stable_key, original_text, embedding::text FROM search_chunks")).rows;
    let batches = 0;
    const failing = new PostgresSearchRepository(injected(async (sql, _values, query) => {
      if (sql.startsWith("INSERT INTO search_chunks") && ++batches === 2) throw new Error("synthetic failing provider diagnostic");
      return query();
    }));
    try {
      await expect(failing.publishDocument(searchPublication(Array<string>(65).fill("New uncommitted evidence"), {
        expected: saved, title: "UncommittedTitleWord", snapshotHash: searchHash("uncommitted"), fingerprint: { ...initial.fingerprint, size: "2000" },
      }))).rejects.toThrow("search_database_unavailable");
      expect(batches).toBe(2);
      expect(await repository.readCheckpoint(REPOSITORY_WORKSPACE, initial.sessionId)).toEqual(saved);
      expect((await pool.query("SELECT id, stable_key, original_text, embedding::text FROM search_chunks")).rows).toEqual(before);
      expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
    } finally { failing.close(); }
  });

  it("readers see the previous complete generation until the entire replacement commits", async () => {
    const initial = searchPublication(["Old committed evidence"], { title: "OldTitleWord" });
    const saved = await repository.publishDocument(initial);
    const reached = deferred(); const proceed = deferred();
    let batches = 0;
    const paused = new PostgresSearchRepository(injected(async (sql, _values, query) => {
      const result = await query();
      if (sql.startsWith("INSERT INTO search_chunks") && ++batches === 1) { reached.resolve(); await proceed.promise; }
      return result;
    }));
    const pending = paused.publishDocument(searchPublication(Array<string>(65).fill("Replacement evidence"), { expected: saved, title: "NewTitleWord" }));
    try {
      await reached.promise;
      expect((await repository.readCheckpoint(REPOSITORY_WORKSPACE, initial.sessionId))?.generation).toBe("1");
      expect((await pool.query("SELECT original_text, lexical_title FROM search_chunks")).rows).toEqual([{ original_text: initial.chunks[0]!.text, lexical_title: initial.title }]);
      expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
      proceed.resolve();
      expect(await pending).toEqual({ documentId: saved.documentId, generation: "2" });
      expect((await pool.query("SELECT count(*)::integer AS count FROM search_chunks")).rows).toEqual([{ count: 65 }]);
      expect(await counts()).toEqual({ document_count: 1, chunk_count: 65 });
    } finally { proceed.resolve(); await pending.catch(() => undefined); paused.close(); }
  });

  it("rejects stale generation/duplicate creation and drops obsolete keys in a successful replacement", async () => {
    const initial = searchPublication(["First evidence", "Obsolete evidence"]);
    const first = await repository.publishDocument(initial);
    await expect(repository.publishDocument(initial)).rejects.toThrow("search_source_changed");
    const next = await repository.publishDocument(searchPublication(["Only current evidence"], { expected: first }));
    await expect(repository.publishDocument(searchPublication(undefined, { expected: first }))).rejects.toThrow("search_source_changed");
    expect((await pool.query("SELECT stable_key, original_text FROM search_chunks")).rows).toEqual([{ stable_key: initial.chunks[0]!.stableKey, original_text: "Only current evidence" }]);
    expect(next.generation).toBe("2");
    expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
  });

  it("marks discovered documents seen without advancing successful source or generation checkpoints", async () => {
    const candidate = searchPublication();
    await repository.publishDocument(candidate);
    const saved = (await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId))!;
    const indexedBefore = (await pool.query("SELECT indexed_at FROM search_documents")).rows[0].indexed_at;
    const scan = randomUUID();
    await repository.markDocumentSeen(saved, scan);
    expect(await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId)).toEqual({ ...saved, lastSeenScanId: scan });
    expect((await pool.query("SELECT indexed_at FROM search_documents")).rows[0].indexed_at).toEqual(indexedBefore);
    await expect(repository.markDocumentSeen({ ...saved, generation: "2" }, randomUUID())).rejects.toThrow("search_source_changed");
  });

  it("known deletion cascades and cannot be resurrected by an old candidate", async () => {
    const candidate = searchPublication();
    const saved = await repository.publishDocument(candidate);
    expect(await repository.deleteDocument(REPOSITORY_WORKSPACE, candidate.sessionId)).toBe(true);
    expect(await repository.deleteDocument(REPOSITORY_WORKSPACE, candidate.sessionId)).toBe(false);
    expect(await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId)).toBeNull();
    expect((await pool.query("SELECT count(*)::integer AS count FROM search_chunks")).rows[0].count).toBe(0);
    expect(await counts()).toEqual({ document_count: 0, chunk_count: 0 });
    await expect(repository.publishDocument({ ...candidate, expected: saved })).rejects.toThrow("search_source_changed");
  });

  it("source-revision replacement is atomic; delayed old-revision cleanup cannot delete the new workspace", async () => {
    const candidate = searchPublication();
    await repository.publishDocument(candidate);
    const changed = { ...REPOSITORY_WORKSPACE, sourceRevision: searchHash("different source"), canonicalPath: "/synthetic/new-workspace", sessionDirectory: "/synthetic/new-sessions" };
    await repository.synchronizeWorkspace(changed, REPOSITORY_WORKSPACE.sourceRevision);
    expect(await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId)).toBeNull();
    expect(await counts()).toEqual({ document_count: 0, chunk_count: 0 });
    await expect(repository.publishDocument(candidate)).rejects.toThrow("search_source_changed");
    await expect(repository.synchronizeWorkspace(REPOSITORY_WORKSPACE, REPOSITORY_WORKSPACE.sourceRevision)).rejects.toThrow("search_source_changed");
    expect(await repository.deleteWorkspace(REPOSITORY_WORKSPACE)).toBe(false);
    await repository.publishDocument({ ...candidate, ...changed, sourcePath: "/synthetic/new-sessions/session.jsonl" });
    expect((await repository.readCheckpoint(changed, candidate.sessionId))?.generation).toBe("1");
    expect(await repository.deleteWorkspace(changed)).toBe(true);
    expect((await pool.query("SELECT count(*)::integer AS count FROM search_documents")).rows[0].count).toBe(0);
  });

  it("keeps workspace rename lexical metadata and workspace registration atomic on failure", async () => {
    await repository.publishDocument(searchPublication());
    const failing = new PostgresSearchRepository(injected(async (sql, _values, query) => {
      if (sql.startsWith("UPDATE search_workspaces SET source_revision")) throw new Error("synthetic failure after lexical update");
      return query();
    }));
    try {
      await expect(failing.synchronizeWorkspace({ ...REPOSITORY_WORKSPACE, displayName: "UncommittedWorkspaceName" }, REPOSITORY_WORKSPACE.sourceRevision)).rejects.toThrow("search_database_unavailable");
      expect((await pool.query("SELECT display_name FROM search_workspaces")).rows).toEqual([{ display_name: REPOSITORY_WORKSPACE.displayName }]);
      expect((await pool.query("SELECT lexical_workspace_name FROM search_chunks")).rows).toEqual([{ lexical_workspace_name: REPOSITORY_WORKSPACE.displayName }]);
    } finally { failing.close(); }
  });

  it("cancels an in-flight replacement without late publication or a successful checkpoint advance", async () => {
    const initial = searchPublication(["Committed evidence"]);
    const saved = await repository.publishDocument(initial);
    const reached = deferred(); const proceed = deferred();
    const paused = new PostgresSearchRepository(injected(async (sql, _values, query) => {
      const result = await query();
      if (sql.startsWith("INSERT INTO search_chunks")) { reached.resolve(); await proceed.promise; }
      return result;
    }));
    const controller = new AbortController();
    const pending = expect(paused.publishDocument(searchPublication(["Cancelled evidence"], { expected: saved }), { signal: controller.signal })).rejects.toThrow("search_cancelled");
    try {
      await reached.promise;
      controller.abort(new Error("private reason"));
      await pending;
      proceed.resolve();
      expect((await repository.readCheckpoint(REPOSITORY_WORKSPACE, initial.sessionId))?.generation).toBe("1");
      expect((await pool.query("SELECT original_text FROM search_chunks")).rows).toEqual([{ original_text: "Committed evidence" }]);
      expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
    } finally { controller.abort(); proceed.resolve(); await pending; paused.close(); }
  });

  it("rejects an authoritative registration/invalidation change immediately before commit", async () => {
    const candidate = searchPublication();
    const saved = await repository.publishDocument(candidate);
    let current = true;
    const guarded = new PostgresSearchRepository(injected(async (sql, _values, query) => {
      const result = await query();
      if (sql.startsWith("INSERT INTO search_chunks")) current = false;
      return result;
    }));
    try {
      await expect(guarded.publishDocument({ ...candidate, expected: saved, title: "Stale title" }, {
        assertCurrent: () => { if (!current) throw new SearchRepositoryError("search_source_changed"); },
      })).rejects.toThrow("search_source_changed");
      expect((await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId))?.title).toBe(candidate.title);
      expect((await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId))?.generation).toBe("1");
    } finally { guarded.close(); }
  });

  it("bounds lock contention and aggregate database work, retaining committed content", async () => {
    const candidate = searchPublication();
    const saved = await repository.publishDocument(candidate);
    const blocker = await pool.connect();
    const bounded = new PostgresSearchRepository(pool, 200);
    try {
      await blocker.query("BEGIN");
      await blocker.query("SELECT workspace_id FROM search_workspaces WHERE workspace_id = $1 FOR UPDATE", [candidate.workspaceId]);
      await expect(bounded.publishDocument({ ...candidate, expected: saved })).rejects.toThrow("search_timeout");
      expect((await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId))?.generation).toBe("1");
    } finally { await blocker.query("ROLLBACK"); blocker.release(); bounded.close(); }
    const database = new SearchRepositoryDatabase(pool, 200);
    try {
      await expect(database.transaction(async (tx) => {
        await tx.query("SELECT pg_sleep(0.15)");
        await tx.query("SELECT pg_sleep(0.15)");
        await tx.query("DELETE FROM search_documents");
      })).rejects.toThrow("search_timeout");
      expect((await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId))?.generation).toBe("1");
    } finally { database.close(); }
  });

  it("stores empty branches and atomically replaces a document with no searchable evidence", async () => {
    const candidate = searchPublication();
    const saved = await repository.publishDocument(candidate);
    await repository.publishDocument(searchPublication([], { expected: saved }));
    const empty = await repository.readCheckpoint(REPOSITORY_WORKSPACE, candidate.sessionId);
    expect(empty?.savedLeafId).toBeNull();
    expect(empty?.generation).toBe("2");
    expect(await counts()).toEqual({ document_count: 1, chunk_count: 0 });
  });
});
