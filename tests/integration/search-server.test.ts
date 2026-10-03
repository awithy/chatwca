import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { loadConfig } from "../../src/server/config.js";
import { startChatWcaServer, type ChatWcaServer } from "../../src/server/index.js";
import type { PiRuntimeFactoryPort } from "../../src/server/pi-runtime.js";
import { WorkspaceRepository } from "../../src/server/workspace-repository.js";
import { scopedSessionStorePath } from "../../src/server/session-scope.js";
import { loadSearchMigrations, migrateSearchDatabase } from "../../src/server/search/migrations.js";
import { createSearchPool } from "../../src/server/search/postgres.js";
import { sourceFingerprint } from "../../src/server/search/session-source.js";
import { startFakeSearchOllama } from "../fixtures/search-ollama.js";
import { searchAssistantEntry, searchJsonl, searchSessionHeader, searchUserEntry } from "../fixtures/search-session.js";
import { SearchService, type SearchServiceStatus } from "../../src/server/search/service.js";
import { MAX_CONVERSATION_TOOL_BYTES } from "../../src/server/search/read-page.js";

const testUrl = process.env.CHATWCA_SEARCH_TEST_DATABASE_URL;
describe.skipIf(testUrl === undefined)("optional local search vertical slice with synthetic stores, SQLite, fake Ollama and disposable PostgreSQL", () => {
  const schema = `chatwca_search_server_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool; let pool: Pool; let scopedUrl: string; let created = false;
  let root: string; let agent: string; let fake: Awaited<ReturnType<typeof startFakeSearchOllama>>;
  let server: ChatWcaServer; let search: SearchService; let base: string; let workspaces: WorkspaceRepository; let file: string; let workspaceId: string;
  const runtimeFactory: PiRuntimeFactoryPort = { modelRuntime: {} as PiRuntimeFactoryPort["modelRuntime"], strictModelRuntime: {} as PiRuntimeFactoryPort["strictModelRuntime"],
    listAvailableModels: vi.fn(async () => []), createPersistent: vi.fn(async () => { throw new Error("Search must not create live conversations"); }),
    openPersistent: vi.fn(async () => { throw new Error("Search must not open live conversations"); }) };
  beforeAll(async () => {
    admin = createSearchPool(testUrl!); await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    const url = new URL(testUrl!); url.searchParams.set("options", `-c search_path=${schema},public`); scopedUrl = url.toString();
    pool = createSearchPool(scopedUrl); await migrateSearchDatabase(pool, await loadSearchMigrations());
  });
  async function start() {
    const config = loadConfig({ CHATWCA_DATA_DIR: path.join(root, "data"), PI_CODING_AGENT_DIR: agent, CHATWCA_SEARCH_MODE: "optional",
      CHATWCA_SEARCH_DATABASE_URL: scopedUrl, CHATWCA_SEARCH_OLLAMA_URL: fake.url, CHATWCA_SEARCH_EMBEDDING_MODEL: "fake-conversation",
      CHATWCA_SEARCH_EMBEDDING_TIMEOUT_MS: "2000", CHATWCA_SEARCH_INDEX_INTERVAL_MS: "900000", CHATWCA_SHUTDOWN_GRACE_MS: "1000" });
    server = await startChatWcaServer({ loadConfiguration: () => config, createRuntimeFactory: async () => runtimeFactory,
      createWorkspaceRepository: (connection) => { workspaces = new WorkspaceRepository(connection); return workspaces; },
      createSearchService: (settings) => { search = new SearchService(settings); return search; },
      listen: async (createdServer) => { await new Promise<void>((resolve) => createdServer.httpServer.listen(0, "127.0.0.1", resolve)); } });
    base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  }
  beforeEach(async () => {
    await pool.query("TRUNCATE search_workspaces CASCADE");
    root = await mkdtemp(path.join(tmpdir(), "chatwca-search-server-")); agent = path.join(root, "agent");
    await mkdir(path.join(root, "first")); await mkdir(path.join(root, "second"));
    fake = await startFakeSearchOllama(); await start();
    const first = workspaces.create({ name: "First workspace", path: path.join(root, "first"), sessionStorage: "workspace" });
    const second = workspaces.create({ name: "Second workspace", path: path.join(root, "second"), sessionStorage: "pi-default" });
    workspaceId = first.id;
    for (const workspace of [first, second]) await mkdir(scopedSessionStorePath(workspace, agent), { recursive: true });
    file = path.join(scopedSessionStorePath(first, agent), "first.jsonl");
    await writeFile(file, searchJsonl([searchSessionHeader(first.path, { id: "session-first" }), searchUserEntry("u1", null, "Chosen isolation approach"),
      searchAssistantEntry("a1", "u1", [{ type: "thinking", thinking: "Hidden reasoning" }, { type: "text", text: "Durable saved assistant evidence" }])]));
    await writeFile(path.join(scopedSessionStorePath(second, agent), "second.jsonl"), searchJsonl([searchSessionHeader(second.path, { id: "session-second" }), searchUserEntry("other", null, "Distinct second workspace decision")]));
    await refresh();
  });
  afterEach(async () => { await server?.shutdown(); await fake?.close(); if (root) await rm(root, { recursive: true, force: true }); });
  afterAll(async () => { await pool?.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); });
  const post = (route: string, input: unknown) => fetch(`${base}/api/search${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
  async function status(): Promise<SearchServiceStatus> { return (await (await fetch(`${base}/api/search/status`)).json()) as SearchServiceStatus; }
  async function refresh(route = "/refresh", input = {}) {
    const before = (await status()).indexer?.completedAt;
    expect((await post(route, input)).status).toBe(202);
    await vi.waitFor(async () => {
      const value = await status(); expect(value.state).toBe("ready"); expect(value.indexer?.pending).toBe(false); expect(value.indexer?.state).toBe("idle");
      expect(value.indexer?.completedAt).not.toBe(before); expect(value.counts?.documents).toBe(2);
    }, { timeout: 10_000 });
  }
  async function command(input: Record<string, unknown>) {
    const socket = new WebSocket(base.replace("http:", "ws:") + "/ws");
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        socket.on("error", reject);
        socket.on("message", (data) => {
          const message = JSON.parse(data.toString()) as Record<string, unknown>;
          if (message.type === "ready") socket.send(JSON.stringify({ ...input, requestId: "search-mutation" }));
          if (message.requestId === "search-mutation") resolve(message);
        });
      });
    } finally { socket.terminate(); }
  }
  it("starts real optional indexing/search asynchronously, exposes scoped results/status and leaves synthetic JSONL untouched", async () => {
    const before = { bytes: await readFile(file), fingerprint: sourceFingerprint(await stat(file, { bigint: true })) };
    const response = await post("", { query: "assistant evidence", workspaceId, rerank: false }); expect(response.status).toBe(200);
    const result = await response.json();
    expect(result).toMatchObject({ cached: true, mode: "hybrid", results: [{ workspaceId, sessionId: "session-first" }], freshness: { state: "ready", lastSucceededAt: expect.any(Number) } });
    expect(result.results[0].excerpts[0]).toMatchObject({ entryId: "a1", role: "assistant", text: "Durable saved assistant evidence" });
    expect((await (await post("", { query: "decision" })).json()).results).toHaveLength(2);
    expect(await status()).toMatchObject({ available: true, counts: { documents: 2, chunks: 3 } });
    expect((await (await fetch(`${base}/api/config`)).json()).search).toEqual({ mode: "optional", available: true, state: "ready", rerankAvailable: false });
    expect(await readFile(file)).toEqual(before.bytes); expect(sourceFingerprint(await stat(file, { bigint: true }))).toEqual(before.fingerprint);
    expect(JSON.stringify(result)).not.toMatch(/Hidden reasoning|sourcePath|sourceRevision|canonicalPath/u);
    expect(runtimeFactory.createPersistent).not.toHaveBeenCalled(); expect(runtimeFactory.openPersistent).not.toHaveBeenCalled();
  });
  it("serves paginated cached reads through the process service, with freshness and no inference/source mutation or public read route", async () => {
    const before = { bytes: await readFile(file), fingerprint: sourceFingerprint(await stat(file, { bigint: true })) };
    const requests = fake.requests.length;
    const first = await search.read({ workspaceId, sessionId: "session-first", limit: 1 });
    expect(first).toMatchObject({ cached: true, workspaceId, sessionId: "session-first", generation: "1", indexedAt: expect.any(Number),
      freshness: { state: "ready", indexing: false, lastSucceededAt: expect.any(Number) }, segments: [{ entryId: "u1", role: "user", text: "Chosen isolation approach" }] });
    expect(first.nextCursor).not.toBeNull();
    const next = await search.read({ workspaceId, sessionId: "session-first", cursor: first.nextCursor!, limit: 1 });
    expect(next.segments).toMatchObject([{ entryId: "a1", role: "assistant", text: "Durable saved assistant evidence" }]);
    expect(next.nextCursor).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(MAX_CONVERSATION_TOOL_BYTES);
    expect(JSON.stringify([first, next])).not.toMatch(/Hidden reasoning|sourcePath|sourceRevision|canonicalPath|databaseUrl/u);
    expect(fake.requests).toHaveLength(requests);
    expect(await readFile(file)).toEqual(before.bytes); expect(sourceFingerprint(await stat(file, { bigint: true }))).toEqual(before.fingerprint);
    expect((await post("/read", { workspaceId, sessionId: "session-first" })).status).toBe(404);
    expect(runtimeFactory.createPersistent).not.toHaveBeenCalled(); expect(runtimeFactory.openPersistent).not.toHaveBeenCalled();
  });

  it("reads retained cache with an unavailable directory/provider and never calls source workspace summary or tool-authority resolution", async () => {
    const workspace = workspaces.listRegistrations().find(({ id }) => id === workspaceId)!;
    await rename(workspace.path, `${workspace.path}-offline`);
    const summaries = vi.spyOn(workspaces, "list").mockImplementation(() => { throw new Error("Unexpected source availability probe"); });
    const usable = vi.spyOn(workspaces, "requireUsable").mockImplementation(async () => { throw new Error("Source sandbox policy unavailable"); });
    fake.state.handler = (_request, response) => { response.writeHead(503).end("private provider diagnostic"); };
    const requests = fake.requests.length;
    const page = await search.read({ workspaceId, sessionId: "session-first", aroundEntryId: "a1" });
    expect(page.segments.map(({ entryId }) => entryId)).toEqual(["u1", "a1"]);
    expect(page).toMatchObject({ aroundEntryId: "a1", precedingContextReduced: false, cached: true });
    expect(summaries).not.toHaveBeenCalled(); expect(usable).not.toHaveBeenCalled(); expect(fake.requests).toHaveLength(requests);
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it("filters removed registrations immediately, even before the retained PostgreSQL cache is pruned", async () => {
    const first = await search.read({ workspaceId, sessionId: "session-first", limit: 1 });
    workspaces.delete(workspaceId);
    expect((await pool.query("SELECT count(*)::integer AS count FROM search_documents WHERE session_id = 'session-first'")).rows[0]?.count).toBe(1);
    await expect(search.read({ workspaceId, sessionId: "session-first", cursor: first.nextCursor! })).rejects.toThrow("search_scope_unavailable");
    expect(await readFile(file, "utf8")).toContain("Durable saved assistant evidence");
    expect((await fetch(`${base}/api/health`)).status).toBe(200);
  });

  it("preserves stale cursor errors through the service after a normal indexing publication", async () => {
    const first = await search.read({ workspaceId, sessionId: "session-first", limit: 1 });
    await appendFile(file, searchJsonl([searchUserEntry("u2", "a1", "New read evidence")])); await refresh("/refresh", { workspaceId });
    await expect(search.read({ workspaceId, sessionId: "session-first", cursor: first.nextCursor! })).rejects.toThrow("conversation_cursor_stale");
    const page = await search.read({ workspaceId, sessionId: "session-first", aroundEntryId: "u2" });
    expect(page.generation).toBe("2"); expect(page.segments.map(({ entryId }) => entryId)).toEqual(["u1", "a1", "u2"]);
    expect(page.freshness.state).toBe("ready");
  });

  it("isolates read database failures from chat readiness and recovers without recreating the service", async () => {
    await pool.query("ALTER TABLE search_documents RENAME TO search_documents_offline");
    try {
      await expect(search.read({ workspaceId, sessionId: "session-first" })).rejects.toThrow("search_database_unavailable");
      expect(search.freshness()).toMatchObject({ state: "unavailable", errorCode: "search_database_unavailable" });
      expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ ready: true });
    } finally { await pool.query("ALTER TABLE search_documents_offline RENAME TO search_documents"); }
    const recovered = await search.read({ workspaceId, sessionId: "session-first" });
    expect(recovered.freshness).toMatchObject({ state: "ready", errorCode: null });
    expect(recovered.segments[1]?.text).toBe("Durable saved assistant evidence");
  });

  it("shutdown cancels a read waiting on a database lock without waiting for its native deadline", async () => {
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN"); await locker.query("LOCK TABLE search_chunks IN ACCESS EXCLUSIVE MODE");
      const pending = expect(search.read({ workspaceId, sessionId: "session-first" })).rejects.toThrow("search_cancelled");
      await vi.waitFor(async () => {
        const waiting = await pool.query("SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%coverage.last_ordinal%'");
        expect(waiting.rows[0]?.count).toBeGreaterThan(0);
      });
      await server.shutdown(); await pending;
      expect(search.capability().state).toBe("closed");
    } finally { await locker.query("ROLLBACK"); locker.release(); }
  });

  it("refresh skips unchanged documents, updates incremental input and rebuild forces rereading while reusing vectors", async () => {
    const embeds = () => fake.requests.filter((r) => r.path === "/api/embed"); const initial = embeds().length;
    await refresh(); expect(embeds()).toHaveLength(initial);
    await appendFile(file, searchJsonl([searchUserEntry("u2", "a1", "New refresh evidence")]));
    await refresh("/refresh", { workspaceId }); expect(embeds()).toHaveLength(initial + 1);
    expect(embeds().at(-1)?.body?.input).toEqual(["User message:\nNew refresh evidence"]);
    await refresh("/rebuild"); expect(embeds()).toHaveLength(initial + 1);
    expect((await status()).indexer?.progress.published).toBe(2);
    expect((await pool.query("SELECT generation::text FROM search_documents WHERE session_id='session-first'")).rows[0]?.generation).toBe("3");
  });
  it("restart with a missing store/provider still serves cached lexical results and honest worker freshness/errors", async () => {
    const old = await status(); await server.shutdown();
    const store = path.dirname(file); await rename(store, `${store}-missing`);
    fake.state.handler = (_request, response) => { response.writeHead(503).end("private provider diagnostic"); };
    await start();
    await vi.waitFor(async () => expect((await status()).state).toBe("ready")); // compatibility only; no successful pass is required
    const result = await (await post("", { query: "assistant evidence", workspaceId })).json();
    expect(result).toMatchObject({ cached: true, mode: "lexical", warnings: ["search_embedding_unavailable"], results: [{ sessionId: "session-first" }] });
    await vi.waitFor(async () => expect((await status()).indexer?.errorCount).toBeGreaterThan(0));
    const stale = await status(); expect(stale.counts?.documents).toBe(2); expect(stale.lastSucceededAt).toBeNull(); expect(old.lastSucceededAt).not.toBeNull();
  });
  it("successful websocket workspace mutations request writer refresh without waiting on search dependencies", async () => {
    const before = (await status()).indexer?.completedAt;
    expect(await command({ type: "workspace.update", workspaceId, name: "RenamedLexicalEvidence" })).toMatchObject({ type: "workspaces" });
    await vi.waitFor(async () => {
      const value = await status(); expect(value.indexer?.state).toBe("idle"); expect(value.indexer?.completedAt).not.toBe(before);
    });
    fake.state.handler = (_request, response) => { response.writeHead(503).end("private diagnostic"); };
    expect((await (await post("", { query: "RenamedLexicalEvidence", workspaceId })).json()).results[0]?.workspaceName).toBe("RenamedLexicalEvidence");
    expect(await command({ type: "workspace.delete", workspaceId })).toMatchObject({ type: "ack" });
    expect((await (await post("", { query: "assistant evidence" })).json()).results).toEqual([]);
    expect((await fetch(`${base}/api/health`)).status).toBe(200); expect(await readFile(file, "utf8")).toContain("Durable saved assistant evidence");
  });
  it("successful websocket conversation deletion asynchronously prunes its cache through the same worker", async () => {
    expect(await command({ type: "conversation.delete", workspaceId, conversationId: "session-first" })).toMatchObject({ type: "ack" });
    await vi.waitFor(async () => expect((await status()).counts?.documents).toBe(1));
    fake.state.handler = (_request, response) => { response.writeHead(503).end("private diagnostic"); };
    expect((await (await post("", { query: "assistant evidence" })).json()).results).toEqual([]);
  });
  it("shutdown cancels active query/indexing provider IO, closes the pool and preserves cached documents", async () => {
    const before = (await pool.query("SELECT count(*)::integer AS count FROM search_documents")).rows[0]?.count;
    const initial = fake.requests.length;
    fake.state.handler = () => {}; // intentionally leave fresh loopback provider requests unanswered
    const query = post("", { query: "blocked query" });
    expect((await post("/rebuild", {})).status).toBe(202);
    await vi.waitFor(() => expect(fake.requests.slice(initial).filter((r) => r.path === "/api/tags").length).toBeGreaterThanOrEqual(2));
    await server.shutdown();
    const response = await query; expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: { code: "search_cancelled" } });
    expect((await pool.query("SELECT count(*)::integer AS count FROM search_documents")).rows[0]?.count).toBe(before);
    expect(server.isShuttingDown).toBe(true);
  });

  it("schema incompatibility is search-only and manual refresh recovers after explicit administrator migrations", async () => {
    await server.shutdown();
    await pool.query("DROP TABLE search_chunks, search_documents, search_workspaces, search_index_runs, search_schema_migrations CASCADE");
    await start(); await vi.waitFor(async () => expect((await status()).errorCode).toBe("search_schema_incompatible"));
    const failed = await post("", { query: "evidence" }); expect(failed.status).toBe(503); expect(await failed.json()).toEqual({ error: { code: "search_schema_incompatible" } });
    expect(await (await fetch(`${base}/api/health`)).json()).toMatchObject({ ready: true });
    await migrateSearchDatabase(pool, await loadSearchMigrations()); await refresh();
    expect((await (await post("", { query: "assistant evidence" })).json()).results).toHaveLength(2);
  });
});
