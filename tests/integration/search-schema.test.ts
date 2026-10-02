import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { checkSearchSchema, loadSearchMigrations, migrateSearchDatabase, SearchSchemaError } from "../../src/server/search/migrations.js";
import { createSearchPool } from "../../src/server/search/postgres.js";

// Explicit opt-in only. Provision pgvector in a disposable test database first.
// Each invocation owns a random schema; no source sessions or paid providers.
const testUrl = process.env.CHATWCA_SEARCH_TEST_DATABASE_URL;

describe.skipIf(testUrl === undefined)("PostgreSQL search schema", () => {
  const schema = `chatwca_search_test_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool;
  let pool: Pool;
  let created = false;

  beforeAll(async () => {
    admin = createSearchPool(testUrl!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    created = true;
    const url = new URL(testUrl!);
    url.searchParams.set("options", `-c search_path=${schema},public`);
    pool = createSearchPool(url.toString());
  });

  afterAll(async () => {
    await pool?.end();
    if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it("applies independently and idempotently, checks compatibility without DDL", async () => {
    const migrations = await loadSearchMigrations();
    expect(await migrateSearchDatabase(pool, migrations.slice(0, 1))).toEqual(["001_initial.sql"]);
    await expect(checkSearchSchema(pool, migrations)).rejects.toBeInstanceOf(SearchSchemaError);
    expect(await migrateSearchDatabase(pool, migrations)).toEqual(["002_checkpoint_lookup.sql"]);
    expect(await migrateSearchDatabase(pool, migrations)).toEqual([]);
    await expect(checkSearchSchema(pool, migrations)).resolves.toBeUndefined();
    const indexes = await pool.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname IN ('search_documents_checkpoint_page_idx', 'search_documents_source_path_idx') ORDER BY indexname", [schema]);
    expect(indexes.rows.map((row) => row.indexname)).toEqual(["search_documents_checkpoint_page_idx", "search_documents_source_path_idx"]);
    expect(indexes.rows[1].indexdef).toContain("md5(source_path)");
    const result = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = $1 ORDER BY tablename", [schema]);
    expect(result.rows.map((row) => row.tablename)).toEqual([
      "search_chunks", "search_documents", "search_index_runs", "search_schema_migrations", "search_workspaces",
    ]);
  });

  it("stores exact vectors, generated lexical metadata, nanosecond fingerprints, and cascade ownership", async () => {
    await pool.query(`INSERT INTO search_workspaces
      (workspace_id, source_revision, display_name, canonical_path, session_directory)
      VALUES ('workspace', 'revision', 'Example', '/synthetic/workspace', '/synthetic/sessions')`);
    const result = await pool.query(`INSERT INTO search_documents (
      workspace_id, session_id, source_revision, source_path, source_device, source_inode,
      source_size, source_mtime_ns, source_ctime_ns, title, created_at, modified_at, saved_leaf_id,
      snapshot_hash, extracted_content_hash, processing_signature, embedding_space_signature, last_seen_scan_id, generation
    ) VALUES ('workspace', 'session', 'revision', '/synthetic/session.jsonl', '1', '2',
      1234, 1700000000000000001, 1700000000000000002, 'Bubblewrap design', now(), now(), 'entry',
      'snapshot', 'content', 'processing', 'space', gen_random_uuid(), 1) RETURNING id, source_mtime_ns`);
    const documentId = result.rows[0].id;
    expect(result.rows[0].source_mtime_ns).toBe("1700000000000000001");
    const vector = `[${[1, ...Array(1023).fill(0)].join(",")}]`;
    await pool.query(`INSERT INTO search_chunks (
      document_id, stable_key, ordinal, entry_id, role, entry_timestamp, source_byte_start, source_byte_end,
      original_text, text_hash, embedding_input_hash, embedding, embedding_space_signature, lexical_title, lexical_workspace_name
    ) VALUES ($1, 'entry:0:v1', 0, 'entry', 'assistant', now(), 0, 25,
      'Chosen for tool isolation', 'text', 'input', $2, 'space', 'Bubblewrap design', 'Example')`, [documentId, vector]);
    const lexical = await pool.query(`SELECT vector_dims(embedding) AS dimensions,
      search_english @@ plainto_tsquery('english', 'bubblewrap') AS title_match,
      search_simple @@ plainto_tsquery('simple', 'isolation') AS body_match FROM search_chunks`);
    expect(lexical.rows).toEqual([{ dimensions: 1024, title_match: true, body_match: true }]);

    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("DELETE FROM search_chunks WHERE document_id = $1", [documentId]);
      await expect(connection.query("UPDATE search_documents SET generation = 0 WHERE id = $1", [documentId])).rejects.toThrow();
      await connection.query("ROLLBACK");
    } finally { connection.release(); }
    expect((await pool.query("SELECT count(*) FROM search_chunks")).rows[0].count).toBe("1");
    await pool.query("DELETE FROM search_workspaces WHERE workspace_id = 'workspace'");
    expect((await pool.query("SELECT count(*) FROM search_chunks")).rows[0].count).toBe("0");
    expect((await pool.query("SELECT count(*) FROM search_documents")).rows[0].count).toBe("0");
  });

  it("rejects wrong vector dimensions and keeps migration failures atomic", async () => {
    const migrations = await loadSearchMigrations();
    await expect(pool.query("SELECT '[1,2,3]'::vector(1024)")).rejects.toThrow();
    await expect(migrateSearchDatabase(pool, [
      ...migrations,
      { name: "003_synthetic.sql", checksum: "synthetic", sql: "CREATE TABLE synthetic_rollback (id integer); SELECT 1 / 0" },
    ])).rejects.toThrow();
    expect((await pool.query("SELECT to_regclass('synthetic_rollback') AS value")).rows[0].value).toBeNull();
    expect((await pool.query("SELECT count(*) FROM search_schema_migrations")).rows[0].count).toBe(String(migrations.length));
    await expect(checkSearchSchema(pool, migrations)).resolves.toBeUndefined();
  });
});
