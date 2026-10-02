import { randomUUID } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SessionWorkspaceScope } from "../../src/server/session-scope.js";
import { SearchDocumentIndexer, type SearchDocumentIndexRequest } from "../../src/server/search/document-indexer.js";
import { OllamaSearchEmbeddings } from "../../src/server/search/embeddings.js";
import { loadSearchMigrations, migrateSearchDatabase, type SearchDatabasePool } from "../../src/server/search/migrations.js";
import { createSearchPool } from "../../src/server/search/postgres.js";
import { MAX_SEARCH_TITLE_BYTES, PostgresSearchRepository } from "../../src/server/search/repository.js";
import { discoverSessionFiles, sourceFingerprint, workspaceSourceRevision } from "../../src/server/search/session-source.js";
import type { SearchEmbeddingSpace } from "../../src/server/search/signatures.js";
import { FAKE_CHANGED_DIGEST, startFakeSearchOllama } from "../fixtures/search-ollama.js";
import { searchAssistantEntry, searchEntry, searchJsonl, searchSessionHeader, searchUserEntry } from "../fixtures/search-session.js";

const testUrl = process.env.CHATWCA_SEARCH_TEST_DATABASE_URL;

/** Actual read-only source + local HTTP + disposable derived DB; no production hooks. */
describe.skipIf(testUrl === undefined)("per-document search indexing composition", () => {
  const schema = `chatwca_search_indexer_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let repository: PostgresSearchRepository;
  let fake: Awaited<ReturnType<typeof startFakeSearchOllama>>;
  let embeddings: OllamaSearchEmbeddings;
  let indexer: SearchDocumentIndexer;
  let root: string;
  let workspace: SessionWorkspaceScope;
  let file: string;
  let space: SearchEmbeddingSpace;
  let afterEmbedding: (() => Promise<void> | void) | undefined;
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
    root = await mkdtemp(path.join(tmpdir(), "chatwca-document-indexer-"));
    const workspacePath = path.join(root, "workspace");
    const sessionDirectory = path.join(workspacePath, ".chatwca", "sessions");
    await mkdir(sessionDirectory, { recursive: true });
    workspace = { id: "synthetic-workspace", path: workspacePath, sessionDirectory };
    file = path.join(sessionDirectory, "conversation.jsonl");
    await writeFile(file, searchJsonl([
      searchSessionHeader(workspace.path), searchUserEntry("u1", null, "Initial searchable prompt"), searchAssistantEntry("a1", "u1", [{ type: "text", text: "Initial assistant answer" }]),
    ]));
    fake = await startFakeSearchOllama();
    embeddings = new OllamaSearchEmbeddings({ ollamaUrl: fake.url, embeddingModel: "fake-conversation", embeddingTimeoutMs: 2000 });
    space = await embeddings.resolveSpace();
    afterEmbedding = undefined;
    indexer = new SearchDocumentIndexer(repository, {
      assertSpaceCurrent: (identity, options) => embeddings.assertSpaceCurrent(identity, options),
      embedDocuments: async (inputs, identity, options) => {
        const result = await embeddings.embedDocuments(inputs, identity, options);
        await afterEmbedding?.();
        return result;
      },
    });
    await repository.synchronizeWorkspace({
      workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, root), displayName: "Synthetic Indexer Workspace",
      canonicalPath: workspace.path, sessionDirectory,
    }, null);
  });
  afterEach(async () => {
    indexer?.close(); embeddings?.close();
    await fake?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });
  afterAll(async () => {
    repository?.close(); await pool?.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });
  const scope = () => ({ workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, root) });
  async function request(overrides: Partial<SearchDocumentIndexRequest> = {}): Promise<SearchDocumentIndexRequest> {
    const discovery = await discoverSessionFiles(workspace, root);
    return { workspace, candidate: discovery.candidates[0]!, space, scanId: randomUUID(), ...overrides };
  }
  const checkpoint = () => repository.readCheckpoint(scope(), "synthetic-session");
  const embedRequests = () => fake.requests.filter((entry) => entry.path === "/api/embed");

  it("indexes durable visible dialogue, skips unchanged bytes, and never changes the source", async () => {
    const bytes = await readFile(file);
    const fingerprint = sourceFingerprint(await stat(file, { bigint: true }));
    expect(await indexer.index(await request())).toMatchObject({ status: "published", embeddedInputs: 2, reusedInputs: 0 });
    const saved = await checkpoint();
    expect(saved?.fingerprint).toEqual(fingerprint);
    expect((await pool.query("SELECT role, original_text FROM search_chunks ORDER BY ordinal")).rows).toEqual([
      { role: "user", original_text: "Initial searchable prompt" }, { role: "assistant", original_text: "Initial assistant answer" },
    ]);
    expect(await indexer.index(await request())).toMatchObject({ status: "unchanged", version: { generation: "1" } });
    expect(embedRequests()).toHaveLength(1);
    expect(await readFile(file)).toEqual(bytes);
    expect(sourceFingerprint(await stat(file, { bigint: true }))).toEqual(fingerprint);
  });

  it("reuses old exact inputs on append and updates title lexical metadata without embedding", async () => {
    await indexer.index(await request());
    await appendFile(file, searchJsonl([searchUserEntry("u2", "a1", "New unique follow-up")]));
    expect(await indexer.index(await request())).toMatchObject({ status: "published", reusedInputs: 2, embeddedInputs: 1 });
    expect(embedRequests().at(-1)?.body?.input).toEqual(["User message:\nNew unique follow-up"]);
    const ids = (await pool.query("SELECT id FROM search_chunks ORDER BY ordinal")).rows;
    await appendFile(file, searchJsonl([searchEntry("title", "u2", { type: "session_info", name: "RenamedTitleEvidence" })]));
    expect(await indexer.index(await request())).toMatchObject({ status: "published", reusedInputs: 3, embeddedInputs: 0 });
    expect(embedRequests()).toHaveLength(2);
    expect((await pool.query("SELECT id FROM search_chunks ORDER BY ordinal")).rows).toEqual(ids);
    expect((await pool.query("SELECT bool_and(search_simple @@ plainto_tsquery('simple', 'RenamedTitleEvidence')) AS matches FROM search_chunks")).rows).toEqual([{ matches: true }]);
    expect((await checkpoint())?.generation).toBe("3");
  });

  it("projects huge fallback titles without truncating the quoted dialogue evidence", async () => {
    const body = "😀".repeat(6000);
    await writeFile(file, searchJsonl([searchSessionHeader(workspace.path), searchUserEntry("u1", null, body)]));
    await indexer.index(await request());
    expect(Buffer.byteLength((await checkpoint())!.title)).toBe(MAX_SEARCH_TITLE_BYTES);
    const chunks = (await pool.query("SELECT original_text, source_byte_start, source_byte_end FROM search_chunks ORDER BY ordinal")).rows;
    expect(chunks[0].source_byte_start).toBe(0);
    expect(chunks.at(-1).source_byte_end).toBe(Buffer.byteLength(body));
    for (const row of chunks) expect(Buffer.from(body).subarray(row.source_byte_start, row.source_byte_end).toString()).toBe(row.original_text);
  });

  it.each(["append", "delete"] as const)("rejects source %s during embedding and preserves the prior complete generation", async (change) => {
    await indexer.index(await request());
    const saved = await checkpoint();
    await appendFile(file, searchJsonl([searchUserEntry("u2", "a1", "Candidate follow-up")]));
    const candidate = await request();
    afterEmbedding = async () => {
      if (change === "append") await appendFile(file, searchJsonl([searchUserEntry("u3", "u2", "Racing follow-up")]));
      else await unlink(file);
    };
    await expect(indexer.index(candidate)).rejects.toThrow("search_source_changed");
    expect(await checkpoint()).toEqual(saved);
    expect((await pool.query("SELECT count(*)::integer AS count FROM search_chunks")).rows).toEqual([{ count: 2 }]);
  });

  it("rejects first publication when its source disappears during embedding", async () => {
    afterEmbedding = () => unlink(file);
    await expect(indexer.index(await request())).rejects.toThrow("search_source_changed");
    expect(await checkpoint()).toBeNull();
    expect((await pool.query("SELECT count(*)::integer AS count FROM search_chunks")).rows).toEqual([{ count: 0 }]);
  });

  it("rejects a model digest change after embeddings and only publishes in the newly resolved space", async () => {
    afterEmbedding = () => { fake.state.digest = FAKE_CHANGED_DIGEST; };
    await expect(indexer.index(await request())).rejects.toThrow("search_embedding_space_changed");
    expect(await checkpoint()).toBeNull();
    afterEmbedding = undefined;
    space = await embeddings.resolveSpace();
    expect(await indexer.index(await request())).toMatchObject({ status: "published", embeddedInputs: 2 });
    expect((await checkpoint())?.embeddingSpaceSignature).toBe(space.signature);
  });

  it("retains successful cached content on malformed or wrong-owner sources", async () => {
    await indexer.index(await request());
    const saved = await checkpoint();
    await appendFile(file, "{\"incomplete\":\n");
    await expect(indexer.index(await request())).rejects.toThrow("search_session_invalid");
    expect(await checkpoint()).toEqual(saved);
    const otherWorkspace = path.join(root, "other-workspace");
    await mkdir(otherWorkspace);
    await writeFile(file, searchJsonl([searchSessionHeader(otherWorkspace), searchUserEntry("u1", null, "Other owner's dialogue")]));
    await expect(indexer.index(await request())).rejects.toThrow("search_session_invalid");
    expect(await checkpoint()).toEqual(saved);
  });

  it("preserves old generations on local embedding failure and safely retries from freshly read metadata", async () => {
    await indexer.index(await request());
    const saved = await checkpoint();
    await appendFile(file, searchJsonl([searchUserEntry("u2", "a1", "New input needing a vector")]));
    fake.state.handler = (_request, response) => { response.writeHead(503).end("private provider response"); };
    await expect(indexer.index(await request())).rejects.toThrow("search_embedding_unavailable");
    expect(await checkpoint()).toEqual(saved);
    fake.state.handler = undefined;
    expect(await indexer.index(await request())).toMatchObject({ status: "published", reusedInputs: 2, embeddedInputs: 1 });
    expect((await checkpoint())?.generation).toBe("2");
  });

  it.each([false, true])("rolls back publication when cancelled before COMMIT (existing=%s)", async (existing) => {
    if (existing) await indexer.index(await request());
    const saved = await checkpoint();
    await appendFile(file, searchJsonl([searchUserEntry("u2", "a1", "New pre-commit candidate")]));
    const controller = new AbortController();
    const injected: SearchDatabasePool = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (sql.startsWith("INSERT INTO search_chunks")) controller.abort();
        return result;
      }, release: (destroy) => client.release(destroy) };
    } };
    const guarded = new PostgresSearchRepository(injected);
    const worker = new SearchDocumentIndexer({
      readCheckpointPage: repository.readCheckpointPage.bind(repository), readCheckpoint: repository.readCheckpoint.bind(repository),
      readReusableEmbeddings: repository.readReusableEmbeddings.bind(repository), markDocumentSeen: repository.markDocumentSeen.bind(repository),
      publishDocument: guarded.publishDocument.bind(guarded),
    }, embeddings);
    try {
      await expect(worker.index(await request({ signal: controller.signal }))).rejects.toThrow("search_cancelled");
      expect(await checkpoint()).toEqual(saved);
      expect((await pool.query("SELECT count(*)::integer AS count FROM search_chunks")).rows).toEqual([{ count: existing ? 2 : 0 }]);
    } finally { worker.close(); guarded.close(); }
  });

  it("accepts stale cached content when the source is deleted after the final witness check", async () => {
    const injected: SearchDatabasePool = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (sql.startsWith("INSERT INTO search_chunks")) await unlink(file);
        return result;
      }, release: (destroy) => client.release(destroy) };
    } };
    const derived = new PostgresSearchRepository(injected);
    const worker = new SearchDocumentIndexer({
      readCheckpointPage: repository.readCheckpointPage.bind(repository), readCheckpoint: repository.readCheckpoint.bind(repository),
      readReusableEmbeddings: repository.readReusableEmbeddings.bind(repository), markDocumentSeen: repository.markDocumentSeen.bind(repository),
      publishDocument: derived.publishDocument.bind(derived),
    }, embeddings);
    try {
      expect(await worker.index(await request())).toMatchObject({ status: "published" });
      expect((await checkpoint())?.generation).toBe("1");
      expect((await pool.query("SELECT count(*)::integer AS count FROM search_chunks")).rows).toEqual([{ count: 2 }]);
      expect((await discoverSessionFiles(workspace, root)).candidates).toEqual([]);
      // The next complete worker pass will prune this path, not an authority seal.
    } finally { worker.close(); derived.close(); }
  });

  it("reconciles a lost COMMIT acknowledgement from committed metadata without blind retry", async () => {
    let lost = false;
    const injected: SearchDatabasePool = { connect: async () => {
      const client = await pool.connect();
      return { query: async (sql, values) => {
        const result = await client.query(sql, values);
        if (!lost && sql === "COMMIT" && values === undefined) { lost = true; throw new Error("synthetic lost acknowledgement"); }
        return result;
      }, release: (destroy) => client.release(destroy) };
    } };
    const failing = new PostgresSearchRepository(injected);
    // Only publication uses the failing pool; metadata reads remain ordinary.
    const boundary = {
      readCheckpointPage: repository.readCheckpointPage.bind(repository), readCheckpoint: repository.readCheckpoint.bind(repository),
      readReusableEmbeddings: repository.readReusableEmbeddings.bind(repository), markDocumentSeen: repository.markDocumentSeen.bind(repository),
      publishDocument: failing.publishDocument.bind(failing),
    };
    const worker = new SearchDocumentIndexer(boundary, embeddings);
    try {
      await expect(worker.index(await request())).rejects.toThrow("search_database_unavailable");
      expect(lost).toBe(true);
      expect((await checkpoint())?.generation).toBe("1");
      expect(await indexer.index(await request())).toMatchObject({ status: "unchanged", version: { generation: "1" } });
      expect(embedRequests()).toHaveLength(1);
    } finally { worker.close(); failing.close(); }
  });
});
