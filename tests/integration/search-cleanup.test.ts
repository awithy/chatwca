import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SearchIndexAuthority, type SearchInvalidation } from "../../src/server/search/authority.js";
import { SearchIndexCleanup } from "../../src/server/search/cleanup.js";
import { loadSearchMigrations, migrateSearchDatabase, type SearchDatabasePool } from "../../src/server/search/migrations.js";
import { createSearchPool } from "../../src/server/search/postgres.js";
import { PostgresSearchRepository } from "../../src/server/search/repository.js";
import { workspaceSourceRevision, type SessionFileCandidate } from "../../src/server/search/session-source.js";
import type { SessionWorkspaceScope } from "../../src/server/session-scope.js";
import { searchPublication } from "../fixtures/search-repository.js";

const testUrl = process.env.CHATWCA_SEARCH_TEST_DATABASE_URL;
function deferred() {
  let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve };
}
/** New disposable random schema, synthetic registrations/evidence, no source or provider IO. */
describe.skipIf(testUrl === undefined)("known-invalidation cleanup with PostgreSQL and process-owned tickets", () => {
  const schema = `chatwca_search_cleanup_${randomUUID().replaceAll("-", "")}`;
  const workspace: SessionWorkspaceScope = { id: "synthetic-workspace", path: "/synthetic/workspace", sessionDirectory: "/synthetic/sessions" };
  const piAgentDirectory = "/synthetic/agent";
  const scope = { workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, piAgentDirectory) };
  const targetPath = "/synthetic/sessions/target.jsonl";
  const aliasPath = "/synthetic/sessions/alias.jsonl";
  const candidate: SessionFileCandidate = { workspaceId: workspace.id, workspacePath: workspace.path, piAgentDirectory,
    path: aliasPath, canonicalPath: targetPath, storePath: workspace.sessionDirectory!, storeDevice: "1", storeInode: "2",
    fingerprint: { device: "1", inode: "3", size: "100", mtimeNs: "1", ctimeNs: "1" } };
  let admin: Pool; let pool: Pool; let repository: PostgresSearchRepository; let cleanup: SearchIndexCleanup;
  let ledger: SearchIndexAuthority; let current: SessionWorkspaceScope | null; let intents: SearchInvalidation[];
  let created = false;
  beforeAll(async () => {
    admin = createSearchPool(testUrl!); await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    const url = new URL(testUrl!); url.searchParams.set("options", `-c search_path=${schema},public`);
    pool = createSearchPool(url.toString()); await migrateSearchDatabase(pool, await loadSearchMigrations());
    repository = new PostgresSearchRepository(pool);
  });
  beforeEach(async () => {
    cleanup?.close(); ledger?.close(); await pool.query("TRUNCATE search_workspaces CASCADE");
    current = workspace; intents = [];
    ledger = new SearchIndexAuthority({ read: () => current }, piAgentDirectory, {
      admitSource: async (source) => source, onInvalidate: (intent): undefined => { intents.push(intent); },
    });
    ledger.admitWorkspace(workspace.id); cleanup = new SearchIndexCleanup(repository);
    await repository.synchronizeWorkspace({ ...scope, displayName: "Synthetic cleanup workspace", canonicalPath: workspace.path, sessionDirectory: workspace.sessionDirectory! }, null);
  });
  afterAll(async () => {
    cleanup?.close(); ledger?.close(); repository?.close(); await pool?.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end();
  });
  async function publish(sessionId = "session", sourcePath = targetPath, texts = ["Synthetic committed evidence"]) {
    const previous = await repository.readCheckpoint(scope, sessionId);
    return repository.publishDocument(searchPublication(texts, { ...scope, sessionId, sourcePath, expected: previous }));
  }
  async function counts() {
    const result = await pool.query("SELECT document_count, chunk_count FROM search_workspaces WHERE workspace_id = $1", [workspace.id]);
    return result.rows[0] as { document_count: number; chunk_count: number } | undefined;
  }
  function injected(hook: (sql: string, query: () => Promise<{ rows: Record<string, unknown>[] }>) => Promise<{ rows: Record<string, unknown>[] }>): SearchDatabasePool {
    return { connect: async () => {
      const client = await pool.connect(); return { query: (sql, values) => hook(sql, () => client.query(sql, values)), release: (destroy) => client.release(destroy) };
    } };
  }

  it("cleans every prior target/alias identity atomically per conversation, preserving unrelated rows and suppression", async () => {
    await publish("old-target"); await publish("new-target", targetPath, ["First chunk", "Second chunk"]);
    await publish("old-alias", aliasPath); await publish("other", "/synthetic/sessions/other.jsonl");
    ledger.invalidatePaths(scope, [targetPath, aliasPath]);
    expect(await cleanup.clean(intents[0]!)).toEqual({ deleted: 3, skipped: 0, next: null });
    expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
    expect((await repository.readCheckpointPage(scope)).checkpoints.map((row) => row.sessionId)).toEqual(["other"]);
    expect(ledger.isSuppressed(scope, "old-target", targetPath)).toBe(true);
  });

  it("bounds large duplicate-path cleanup and continues with the same live ticket", async () => {
    for (let index = 0; index < 66; index++) await publish(`session-${String(index).padStart(3, "0")}`, targetPath, []);
    ledger.invalidatePaths(scope, [targetPath]); const intent = intents[0]!;
    const first = await cleanup.clean(intent); expect(first.deleted).toBe(64); expect(first.next).not.toBeNull();
    expect(await counts()).toEqual({ document_count: 2, chunk_count: 0 });
    expect(await cleanup.clean(intent, { cursor: first.next! })).toEqual({ deleted: 2, skipped: 0, next: null });
    expect(await counts()).toEqual({ document_count: 0, chunk_count: 0 });
  });

  it.each(["generation", "move", "recreate"] as const)("exact observed deletion cannot remove a newer %s", async (change) => {
    await publish(); const observed = (await repository.readCheckpoint(scope, "session"))!;
    if (change === "recreate") { await repository.deleteDocument(scope, "session"); await publish(); }
    else await publish("session", change === "move" ? aliasPath : targetPath, ["Fresh evidence"]);
    const before = (await repository.readCheckpoint(scope, "session"))!;
    expect(await repository.deleteDocumentVersion(observed)).toBe(false);
    expect(await repository.readCheckpoint(scope, "session")).toEqual(before);
    expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
    expect(await repository.deleteDocumentVersion(before)).toBe(true);
    expect(await counts()).toEqual({ document_count: 0, chunk_count: 0 });
  });

  it("new attempt capture revokes a delayed ticket before reads can select a fresh generation", async () => {
    await publish(); ledger.invalidateSession(scope, "session"); const intent = intents[0]!;
    const fresh = ledger.capture(workspace, candidate); await publish(); fresh.assertCurrent("session");
    await expect(cleanup.clean(intent)).rejects.toThrow("search_source_changed");
    expect((await repository.readCheckpoint(scope, "session"))?.generation).toBe("2");
    expect(ledger.isSuppressed(scope, "session", targetPath)).toBe(true);
  });

  it("rolls back last-moment cleanup when a new attempt starts after DELETE but before COMMIT", async () => {
    await publish(); ledger.invalidatePaths(scope, [targetPath]); const intent = intents[0]!;
    const guardedRepository = new PostgresSearchRepository(injected(async (sql, query) => {
      const result = await query(); if (sql.startsWith("DELETE FROM search_documents")) ledger.capture(workspace, candidate); return result;
    }));
    const guarded = new SearchIndexCleanup(guardedRepository);
    try {
      await expect(guarded.clean(intent)).rejects.toThrow("search_source_changed");
      expect((await repository.readCheckpoint(scope, "session"))?.generation).toBe("1");
      expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
      await publish(); expect((await repository.readCheckpoint(scope, "session"))?.generation).toBe("2");
      await expect(cleanup.clean(intent)).rejects.toThrow("search_source_changed");
    } finally { guarded.close(); guardedRepository.close(); }
  });

  it("retired workspace cleanup rejects unadmitted same-revision registration ABA, then allows known removal", async () => {
    await publish(); current = null; ledger.invalidateWorkspace(workspace.id); const intent = intents[0]!;
    current = { ...workspace }; await expect(cleanup.clean(intent)).rejects.toThrow("search_source_changed");
    expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
    current = null; expect(await cleanup.clean(intent)).toEqual({ deleted: 1, skipped: 0, next: null });
    expect(await counts()).toBeUndefined();
    expect((await pool.query("SELECT count(*)::integer AS count FROM search_chunks")).rows[0].count).toBe(0);
  });

  it("conditional document deletion is a no-op for a replaced or missing derived workspace revision", async () => {
    await publish(); const observed = (await repository.readCheckpoint(scope, "session"))!;
    await repository.synchronizeWorkspace({ ...scope, sourceRevision: "b".repeat(64), displayName: "Replacement", canonicalPath: workspace.path, sessionDirectory: workspace.sessionDirectory! }, scope.sourceRevision);
    expect(await repository.deleteDocumentVersion(observed)).toBe(false);
    await repository.deleteWorkspace({ ...scope, sourceRevision: "b".repeat(64) });
    expect(await repository.deleteDocumentVersion(observed)).toBe(false);
  });

  it("cancellation of an in-flight delete cannot leak late destructive work or counters", async () => {
    await publish(); ledger.invalidateSession(scope, "session"); const reached = deferred(); const proceed = deferred();
    const pausedRepository = new PostgresSearchRepository(injected(async (sql, query) => {
      const result = await query(); if (sql.startsWith("DELETE FROM search_documents")) { reached.resolve(); await proceed.promise; } return result;
    }));
    const paused = new SearchIndexCleanup(pausedRepository); const controller = new AbortController();
    const attempt = expect(paused.clean(intents[0]!, { signal: controller.signal })).rejects.toThrow("search_cancelled");
    try {
      await reached.promise; controller.abort("private reason"); await attempt; proceed.resolve();
      expect((await repository.readCheckpoint(scope, "session"))?.generation).toBe("1");
      expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
    } finally { controller.abort(); proceed.resolve(); await attempt; paused.close(); pausedRepository.close(); }
  });

  it("never retries an ambiguous deletion COMMIT; the next explicit call re-reads committed metadata", async () => {
    await publish(); ledger.invalidateSession(scope, "session"); let commits = 0;
    const ambiguousRepository = new PostgresSearchRepository(injected(async (sql, query) => {
      const result = await query(); if (sql === "COMMIT") { commits++; throw new Error("synthetic lost acknowledgement"); } return result;
    }));
    const ambiguous = new SearchIndexCleanup(ambiguousRepository);
    try {
      await expect(ambiguous.clean(intents[0]!)).rejects.toThrow("search_database_unavailable");
      // The read transaction's COMMIT lost its ack, so no destructive call followed.
      expect(commits).toBe(1); expect(await counts()).toEqual({ document_count: 1, chunk_count: 1 });
    } finally { ambiguous.close(); ambiguousRepository.close(); }
    let deleting = false; let deleteCommits = 0;
    const lostDeleteRepository = new PostgresSearchRepository(injected(async (sql, query) => {
      if (sql.startsWith("DELETE FROM search_documents")) deleting = true;
      const result = await query(); if (sql === "COMMIT" && deleting) { deleteCommits++; throw new Error("lost deletion COMMIT acknowledgement"); } return result;
    }));
    const lostDelete = new SearchIndexCleanup(lostDeleteRepository);
    try {
      await expect(lostDelete.clean(intents[0]!)).rejects.toThrow("search_database_unavailable");
      expect(deleteCommits).toBe(1); expect(await counts()).toEqual({ document_count: 0, chunk_count: 0 });
      expect(await cleanup.clean(intents[0]!)).toEqual({ deleted: 0, skipped: 1, next: null });
      expect(ledger.isSuppressed(scope, "session", targetPath)).toBe(true);
    } finally { lostDelete.close(); lostDeleteRepository.close(); }
  });
});
