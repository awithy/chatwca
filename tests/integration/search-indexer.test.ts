import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type ChatWcaDatabase } from "../../src/server/database.js";
import { WorkspaceRepository } from "../../src/server/workspace-repository.js";
import { scopedSessionStorePath } from "../../src/server/session-scope.js";
import { SearchIndexer, type SearchRegisteredWorkspace } from "../../src/server/search/indexer.js";
import { OllamaSearchEmbeddings } from "../../src/server/search/embeddings.js";
import { loadSearchMigrations, migrateSearchDatabase } from "../../src/server/search/migrations.js";
import { createSearchPool } from "../../src/server/search/postgres.js";
import { PostgresSearchRepository } from "../../src/server/search/repository.js";
import { PostgresSearchRetrieval } from "../../src/server/search/retrieval.js";
import { SearchQueryService } from "../../src/server/search/query.js";
import { assertSessionDiscoveryCurrent, discoverSessionFiles, sourceFingerprint, workspaceSourceRevision } from "../../src/server/search/session-source.js";
import { startFakeSearchOllama } from "../fixtures/search-ollama.js";
import { searchAssistantEntry, searchJsonl, searchSessionHeader, searchUserEntry } from "../fixtures/search-session.js";

const testUrl = process.env.CHATWCA_SEARCH_TEST_DATABASE_URL;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe.skipIf(testUrl === undefined)("single-writer search loop with SQLite, synthetic stores, fake Ollama and PostgreSQL", () => {
  const schema = `chatwca_search_worker_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool; let pool: Pool; let repository: PostgresSearchRepository; let created = false;
  let root: string; let database: ChatWcaDatabase; let registry: WorkspaceRepository;
  let fake: Awaited<ReturnType<typeof startFakeSearchOllama>>; let embeddings: OllamaSearchEmbeddings; let worker: SearchIndexer;
  let w1: SearchRegisteredWorkspace; let w2: SearchRegisteredWorkspace; let file1: string; let file2: string; let agent: string;
  beforeAll(async () => {
    admin = createSearchPool(testUrl!); await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    const url = new URL(testUrl!); url.searchParams.set("options", `-c search_path=${schema},public`);
    pool = createSearchPool(url.toString()); await migrateSearchDatabase(pool, await loadSearchMigrations()); repository = new PostgresSearchRepository(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE search_workspaces CASCADE");
    root = await mkdtemp(path.join(tmpdir(), "chatwca-search-worker-")); agent = path.join(root, "agent");
    database = openDatabase(root, ":memory:"); registry = new WorkspaceRepository(database.connection);
    for (const name of ["first", "second"]) await mkdir(path.join(root, name));
    w1 = registry.create({ name: "First workspace", path: path.join(root, "first"), sessionStorage: "workspace" });
    w2 = registry.create({ name: "Second workspace", path: path.join(root, "second"), sessionStorage: "pi-default" });
    for (const workspace of [w1, w2]) await mkdir(scopedSessionStorePath(workspace, agent), { recursive: true });
    file1 = path.join(scopedSessionStorePath(w1, agent), "first.jsonl"); file2 = path.join(scopedSessionStorePath(w2, agent), "second.jsonl");
    await writeFile(file1, searchJsonl([searchSessionHeader(w1.path, { id: "session-first" }), searchUserEntry("u1", null, "Chosen worker isolation approach"),
      searchAssistantEntry("a1", "u1", [{ type: "thinking", thinking: "Hidden reasoning" }, { type: "text", text: "Visible durable assistant answer" }])]));
    await writeFile(file2, searchJsonl([searchSessionHeader(w2.path, { id: "session-second" }), searchUserEntry("other", null, "Distinct second workspace evidence")]));
    fake = await startFakeSearchOllama();
    embeddings = new OllamaSearchEmbeddings({ ollamaUrl: fake.url, embeddingModel: "fake-conversation", embeddingTimeoutMs: 2000 });
    worker = new SearchIndexer({ repository, registrations: registry, embeddings, piAgentDirectory: agent });
  });
  afterEach(async () => { await worker?.close(); embeddings?.close(); await fake?.close(); database?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  afterAll(async () => { repository?.close(); await pool?.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); });
  const scope = (w: SearchRegisteredWorkspace) => ({ workspaceId: w.id, sourceRevision: workspaceSourceRevision(w, agent) });
  async function refresh(request = {}) { worker.requestRefresh(request); await worker.idle(); }
  const embedRequests = () => fake.requests.filter((request) => request.path === "/api/embed");

  it("indexes both configured store kinds, saved visible dialogue and lexical metadata without changing source bytes/stat", async () => {
    const before = await Promise.all([file1, file2].map(async (file) => ({ bytes: await readFile(file), fingerprint: sourceFingerprint(await stat(file, { bigint: true })) })));
    await refresh();
    expect(worker.status()).toMatchObject({ state: "idle", errorCount: 0, progress: { workspaces: 2, published: 2, discovered: 2 } });
    expect((await pool.query("SELECT original_text FROM search_chunks ORDER BY original_text")).rows.map((row) => row.original_text)).toEqual([
      "Chosen worker isolation approach", "Distinct second workspace evidence", "Visible durable assistant answer",
    ]);
    expect((await pool.query("SELECT display_name, document_count, chunk_count FROM search_workspaces ORDER BY display_name")).rows).toEqual([
      { display_name: "First workspace", document_count: 1, chunk_count: 2 }, { display_name: "Second workspace", document_count: 1, chunk_count: 1 },
    ]);
    await refresh(); expect(worker.status().progress.unchanged).toBe(2); expect(embedRequests()).toHaveLength(2);
    for (const [index, file] of [file1, file2].entries()) {
      expect(await readFile(file)).toEqual(before[index]!.bytes);
      expect(sourceFingerprint(await stat(file, { bigint: true }))).toEqual(before[index]!.fingerprint);
    }
  });

  it("incrementally reuses vectors, rebuild rereads without truncation, and scoped refresh ignores other registered stores", async () => {
    await refresh(); const oldSecond = await repository.readCheckpoint(scope(w2), "session-second");
    await appendFile(file1, searchJsonl([searchUserEntry("u2", "a1", "New exact input")]));
    await refresh({ workspaceId: w1.id });
    expect(worker.status().progress).toMatchObject({ workspaces: 1, published: 1 });
    expect(embedRequests().at(-1)?.body?.input).toEqual(["User message:\nNew exact input"]);
    expect(await repository.readCheckpoint(scope(w2), "session-second")).toEqual(oldSecond);
    await refresh({ rebuild: true });
    expect(worker.status().progress.published).toBe(2); expect(embedRequests()).toHaveLength(3);
    expect((await repository.readCheckpoint(scope(w1), "session-first"))?.generation).toBe("3");
    expect((await pool.query("SELECT count(*)::integer AS count FROM search_chunks")).rows).toEqual([{ count: 4 }]);
  });

  it("updates renamed lexical metadata without embeddings and resets only a changed source revision", async () => {
    await refresh();
    const checkpoint = await repository.readCheckpoint(scope(w1), "session-first");
    const other = await repository.readCheckpoint(scope(w2), "session-second");
    const originalBytes = await readFile(file1);
    w1 = registry.update(w1.id, { name: "RenamedWorkspaceLexicalEvidence" });
    await refresh();
    expect(await repository.readCheckpoint(scope(w1), "session-first")).toEqual({ ...checkpoint, lastSeenScanId: expect.any(String) });
    expect(embedRequests()).toHaveLength(2);
    expect((await pool.query(`SELECT bool_and(search_simple @@ plainto_tsquery('simple', 'RenamedWorkspaceLexicalEvidence')) AS matches
      FROM search_chunks c JOIN search_documents d ON d.id=c.document_id WHERE d.workspace_id=$1`, [w1.id])).rows).toEqual([{ matches: true }]);
    const oldScope = scope(w1); const moved = path.join(root, "moved"); await mkdir(moved);
    w1 = registry.update(w1.id, { path: moved }); await refresh();
    expect(await repository.readCheckpoint(oldScope, "session-first")).toBeNull();
    expect((await repository.readWorkspace(w1.id))?.sourceRevision).toBe(scope(w1).sourceRevision);
    expect(await repository.readCheckpoint(scope(w2), "session-second")).toMatchObject({ generation: other!.generation, documentId: other!.documentId });
    expect(await readFile(file1)).toEqual(originalBytes);
  });

  it("successfully replaces a file's session identity, but a later malformed read retains cached content", async () => {
    await refresh();
    await writeFile(file1, searchJsonl([searchSessionHeader(w1.path, { id: "replacement-session" }), searchUserEntry("new", null, "Replacement dialogue")]));
    await refresh();
    expect(await repository.readCheckpoint(scope(w1), "session-first")).toBeNull();
    const replacement = await repository.readCheckpoint(scope(w1), "replacement-session"); expect(replacement).not.toBeNull();
    await appendFile(file1, "{malformed}\n"); await refresh();
    expect(await repository.readCheckpoint(scope(w1), "replacement-session")).toEqual(replacement);
    expect(worker.status().progress.failed).toBe(1);
    expect((await pool.query("SELECT document_count, chunk_count FROM search_workspaces WHERE workspace_id=$1", [w1.id])).rows).toEqual([{ document_count: 1, chunk_count: 1 }]);
  });

  it("never treats incomplete or missing stores as empty, then prunes absent paths on the next complete pass", async () => {
    await refresh(); await unlink(file1);
    const broken = path.join(scopedSessionStorePath(w1, agent), "broken.jsonl"); await symlink("nonexistent.data", broken);
    await refresh(); expect(await repository.readCheckpoint(scope(w1), "session-first")).not.toBeNull();
    expect(worker.status().errors.some((error) => error.workspaceId === w1.id)).toBe(true);
    await unlink(broken);
    const store = scopedSessionStorePath(w1, agent); await rename(store, `${store}-unavailable`);
    await refresh(); expect(await repository.readCheckpoint(scope(w1), "session-first")).not.toBeNull();
    await rename(`${store}-unavailable`, store); await refresh();
    expect(await repository.readCheckpoint(scope(w1), "session-first")).toBeNull(); expect(worker.status().progress.deleted).toBe(1);
    expect((await pool.query("SELECT document_count, chunk_count FROM search_workspaces WHERE workspace_id=$1", [w1.id])).rows).toEqual([{ document_count: 0, chunk_count: 0 }]);
  });

  it("rechecks the final directory witness and preserves canonical aliases to non-JSONL targets", async () => {
    await refresh(); await unlink(file1); await worker.close();
    worker = new SearchIndexer({ repository, registrations: registry, embeddings, piAgentDirectory: agent, sources: {
      discover: async (workspace, directory, signal) => {
        const discovered = await discoverSessionFiles(workspace, directory, signal);
        if (workspace.id === w1.id) await writeFile(path.join(discovered.storePath, "witness-change.txt"), "synthetic marker");
        return discovered;
      }, assertDiscoveryCurrent: assertSessionDiscoveryCurrent,
    } });
    await refresh(); expect(await repository.readCheckpoint(scope(w1), "session-first")).not.toBeNull();
    expect(worker.status().errors).toContainEqual({ workspaceId: w1.id, code: "search_source_changed" });
    await worker.close(); worker = new SearchIndexer({ repository, registrations: registry, embeddings, piAgentDirectory: agent });
    const target = path.join(scopedSessionStorePath(w1, agent), "target.data");
    await writeFile(target, searchJsonl([searchSessionHeader(w1.path, { id: "alias-session" }), searchUserEntry("entry", null, "Canonical alias evidence")]));
    await symlink("target.data", file1); await symlink("target.data", path.join(scopedSessionStorePath(w1, agent), "alias.jsonl"));
    await refresh();
    expect(worker.status().progress.published).toBe(1); // alias target only once, second workspace unchanged
    expect((await repository.readCheckpoint(scope(w1), "alias-session"))?.sourcePath).toBe(target);
    await refresh(); expect(await repository.readCheckpoint(scope(w1), "alias-session")).not.toBeNull();
  });

  it("uses persisted workspace pages to remove SQLite unregistrations after worker restart while cached content is immediately readable", async () => {
    await refresh(); await worker.close(); registry.delete(w1.id);
    // The derived cache is readable before any new pass; no membership recovery barrier.
    expect(await repository.readCheckpoint(scope(w1), "session-first")).not.toBeNull();
    worker = new SearchIndexer({ repository, registrations: registry, embeddings, piAgentDirectory: agent });
    await refresh(); expect(await repository.readWorkspace(w1.id)).toBeNull();
    expect(worker.status().progress.removedWorkspaces).toBe(1);
    expect(await readFile(file1, "utf8")).toContain("Chosen worker isolation approach");
    expect(await repository.readCheckpoint(scope(w2), "session-second")).not.toBeNull();
  });

  it("isolates provider failure, retains changed cached content and recovers on a later refresh", async () => {
    await refresh(); const before = await repository.readCheckpoint(scope(w1), "session-first");
    await appendFile(file1, searchJsonl([searchUserEntry("u2", "a1", "Input awaiting provider recovery")]));
    fake.state.handler = (_request, response) => { response.writeHead(503).end("private diagnostic"); };
    await refresh(); expect(await repository.readCheckpoint(scope(w1), "session-first")).toEqual(before);
    expect(worker.status().errors).toContainEqual({ workspaceId: null, code: "search_embedding_unavailable" });
    expect(registry.list()).toHaveLength(2); // SQLite app metadata still works
    fake.state.handler = undefined; await refresh();
    expect((await repository.readCheckpoint(scope(w1), "session-first"))?.generation).toBe("2");
    expect(embedRequests().at(-1)?.body?.input).toEqual(["User message:\nInput awaiting provider recovery"]);
  });

  it("coalesces real document IO with refresh/rebuild into one forced follow-up pass", async () => {
    await worker.close(); const gate = deferred(); const reached = deferred(); let first = true;
    worker = new SearchIndexer({ repository, registrations: registry, piAgentDirectory: agent, embeddings: {
      resolveSpace: (options) => embeddings.resolveSpace(options), assertSpaceCurrent: (space, options) => embeddings.assertSpaceCurrent(space, options),
      embedDocuments: async (inputs, space, options) => {
        const result = await embeddings.embedDocuments(inputs, space, options);
        if (first) { first = false; reached.resolve(); await gate.promise; }
        return result;
      },
    } });
    worker.requestRefresh(); await reached.promise;
    for (let i = 0; i < 20; i++) worker.requestRefresh(); worker.requestRefresh({ rebuild: true });
    expect(worker.status().pending).toBe(true); gate.resolve(); await worker.idle();
    expect((await repository.readCheckpoint(scope(w1), "session-first"))?.generation).toBe("2");
    expect((await repository.readCheckpoint(scope(w2), "session-second"))?.generation).toBe("2");
    expect(embedRequests()).toHaveLength(2); // follow-up force rereads but reuses exact vectors
  });

  it("searches the indexed saved branch locally across both configured stores without source mutation", async () => {
    await refresh(); const reader = new PostgresSearchRetrieval(pool);
    const query = new SearchQueryService({ repository: reader, registrations: registry, embeddings, piAgentDirectory: agent });
    const before = await readFile(file1);
    try {
      const all = await query.search({ query: "durable assistant" });
      expect(all.mode).toBe("hybrid"); expect(all.results).toHaveLength(2);
      expect(all.results[0]).toMatchObject({ workspaceId: w1.id, sessionId: "session-first" });
      expect(all.results[0]?.excerpts[0]).toMatchObject({ entryId: "a1", role: "assistant", text: "Visible durable assistant answer" });
      const selected = await query.search({ query: "evidence", workspaceId: w2.id });
      expect(selected.results).toHaveLength(1); expect(selected.results[0]?.sessionId).toBe("session-second");
      fake.state.handler = (_request, response) => { response.writeHead(503).end("private provider diagnostic"); };
      expect((await query.search({ query: "Hidden reasoning" })).results).toEqual([]);
      expect(await readFile(file1)).toEqual(before);
      expect(JSON.stringify(all)).not.toMatch(/sourcePath|sourceRevision|canonicalPath|embedding|Hidden reasoning/u);
    } finally { query.close(); reader.close(); }
  });

  it("serves cached lexical hits after restart/missing stores, and registration changes filter without waiting for a pass", async () => {
    await refresh(); await worker.close();
    const reader = new PostgresSearchRetrieval(pool);
    const query = new SearchQueryService({ repository: reader, registrations: registry, embeddings, piAgentDirectory: agent });
    await rename(scopedSessionStorePath(w1, agent), `${scopedSessionStorePath(w1, agent)}-missing`);
    fake.state.handler = (_request, response) => { response.writeHead(503).end("private diagnostic"); };
    try {
      const stale = await query.search({ query: "durable assistant", workspaceId: w1.id });
      expect(stale).toMatchObject({ cached: true, mode: "lexical", warnings: ["search_embedding_unavailable"], results: [{ sessionId: "session-first" }] });
      const moved = path.join(root, "moved-registration"); await mkdir(moved); registry.update(w1.id, { path: moved });
      expect((await query.search({ query: "durable assistant" })).results).toEqual([]);
      registry.delete(w2.id);
      expect((await query.search({ query: "second workspace" })).results).toEqual([]);
      expect(await repository.readWorkspace(w2.id)).not.toBeNull(); // cache remains until the writer's next pass
    } finally { query.close(); reader.close(); }
  });

  it("stops on database outage without probing providers or breaking SQLite registrations", async () => {
    await worker.close(); const unavailable = new PostgresSearchRepository({ connect: async () => { throw new Error("private DB credential diagnostic"); } });
    worker = new SearchIndexer({ repository: unavailable, registrations: registry, embeddings, piAgentDirectory: agent });
    try {
      await refresh(); expect(worker.status()).toMatchObject({ state: "unavailable", errorCount: 1 });
      expect(fake.requests).toEqual([]); expect(registry.list()).toHaveLength(2);
      expect(JSON.stringify(worker.status())).not.toMatch(/credential|diagnostic|private/u);
    } finally { await worker.close(); unavailable.close(); }
  });
});
