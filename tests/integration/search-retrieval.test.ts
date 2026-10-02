import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSearchMigrations, migrateSearchDatabase } from "../../src/server/search/migrations.js";
import { createSearchPool } from "../../src/server/search/postgres.js";
import { PostgresSearchRepository } from "../../src/server/search/repository.js";
import { PostgresSearchRetrieval } from "../../src/server/search/retrieval.js";
import { searchHash } from "../../src/server/search/extract.js";
import { fakeSearchVector } from "../fixtures/search-ollama.js";
import { REPOSITORY_SPACE, REPOSITORY_WORKSPACE, searchPublication } from "../fixtures/search-repository.js";

const testUrl = process.env.CHATWCA_SEARCH_TEST_DATABASE_URL;
describe.skipIf(testUrl === undefined)("local lexical/exact-vector retrieval on disposable PostgreSQL", () => {
  const schema = `chatwca_search_retrieval_${randomUUID().replaceAll("-", "")}`;
  const other = { ...REPOSITORY_WORKSPACE, workspaceId: "other-workspace", displayName: "Other workspace", sourceRevision: searchHash("other source") };
  let admin: Pool; let pool: Pool; let writer: PostgresSearchRepository; let reader: PostgresSearchRetrieval; let created = false;
  beforeAll(async () => {
    admin = createSearchPool(testUrl!); await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    const url = new URL(testUrl!); url.searchParams.set("options", `-c search_path=${schema},public`);
    pool = createSearchPool(url.toString()); await migrateSearchDatabase(pool, await loadSearchMigrations());
    writer = new PostgresSearchRepository(pool); reader = new PostgresSearchRetrieval(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE search_workspaces CASCADE");
    await writer.synchronizeWorkspace(REPOSITORY_WORKSPACE, null); await writer.synchronizeWorkspace(other, null);
  });
  afterAll(async () => { writer?.close(); reader?.close(); await pool?.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); });
  const retrieve = (query: string, scopes = [REPOSITORY_WORKSPACE, other], vector = true, signature = REPOSITORY_SPACE.signature) => reader.retrieve({ query, scopes, candidateLimit: 30,
    ...(vector ? { vector: { spaceSignature: signature, embedding: fakeSearchVector(1, 0) } } : {}) });
  async function publish(sessionId: string, text: string, options: { other?: boolean; title?: string; space?: string; vector?: number[] } = {}) {
    const workspace = options.other ? other : REPOSITORY_WORKSPACE;
    const base = searchPublication([text], { workspaceId: workspace.workspaceId, sourceRevision: workspace.sourceRevision, sessionId,
      title: options.title ?? "Conversation", embeddingSpaceSignature: options.space ?? REPOSITORY_SPACE.signature });
    await writer.publishDocument({ ...base, chunks: base.chunks.map((chunk) => ({ ...chunk, embedding: options.vector ?? fakeSearchVector(1, 0) })) });
  }
  it("combines English stemming and simple identifiers into ONE deterministic lexical channel", async () => {
    await publish("stem", "We were running deployment experiments"); await publish("identifier", "File Preserve_Identifier.ts has changed");
    expect((await retrieve("run", undefined, false)).lexical.map((c) => c.sessionId)).toEqual(["stem"]);
    expect((await retrieve("Preserve_Identifier.ts", undefined, false)).lexical.map((c) => c.sessionId)).toEqual(["identifier"]);
    const result = await retrieve("deployment", undefined, false);
    expect(result.lexical).toHaveLength(1); expect(result.vector).toEqual([]);
    expect(result.lexical[0]).toMatchObject({ role: "user", entryId: "entry-0", text: "We were running deployment experiments", indexedAt: expect.any(Number) });
  });
  it("finds title and workspace lexical metadata without embedding it", async () => {
    await publish("metadata", "Content has no metadata keyword", { title: "RareTitleEvidence" });
    expect((await retrieve("RareTitleEvidence", undefined, false)).lexical.map((c) => c.sessionId)).toEqual(["metadata"]);
    expect((await retrieve("Synthetic Workspace", undefined, false)).lexical.map((c) => c.sessionId)).toEqual(["metadata"]);
    await writer.synchronizeWorkspace({ ...REPOSITORY_WORKSPACE, displayName: "RenamedWorkspaceEvidence" }, REPOSITORY_WORKSPACE.sourceRevision);
    const renamed = await retrieve("RenamedWorkspaceEvidence", undefined, false);
    expect(renamed.lexical[0]?.workspaceName).toBe("RenamedWorkspaceEvidence");
  });
  it("orders exact cosine candidates and breaks equal distances deterministically by chunk UUID", async () => {
    await publish("near", "Near evidence", { vector: fakeSearchVector(1, 0) });
    await publish("middle", "Middle evidence", { vector: fakeSearchVector(0.6, 0.8) });
    await publish("far", "Far evidence", { vector: fakeSearchVector(0, 1) });
    expect((await retrieve("no lexical match")).vector.map((c) => c.sessionId)).toEqual(["near", "middle", "far"]);
    await publish("near-tie", "Tie evidence", { vector: fakeSearchVector(1, 0) });
    const result = (await retrieve("no lexical match")).vector;
    expect(result.slice(0, 2).map((c) => c.chunkId)).toEqual(result.slice(0, 2).map((c) => c.chunkId).sort());
  });
  it("filters BOTH channels by current workspace IDs and exact source revisions", async () => {
    await publish("first", "Needle evidence"); await publish("second", "Needle evidence", { other: true });
    const selected = await retrieve("needle", [REPOSITORY_WORKSPACE]);
    expect(selected.lexical.map((c) => c.sessionId)).toEqual(["first"]); expect(selected.vector.map((c) => c.sessionId)).toEqual(["first"]);
    const wrong = await retrieve("needle", [{ ...REPOSITORY_WORKSPACE, sourceRevision: searchHash("changed registration") }]);
    expect(wrong).toEqual({ lexical: [], vector: [] });
    expect((await retrieve("needle")).lexical).toHaveLength(2);
    await pool.query("UPDATE search_documents SET source_revision=$1 WHERE workspace_id=$2", [searchHash("old doc"), other.workspaceId]);
    const inconsistent = await retrieve("needle", [other]); expect(inconsistent).toEqual({ lexical: [], vector: [] });
  });
  it("never mixes model digest spaces; old-space documents remain lexical while vectors catch up", async () => {
    const changed = searchHash("changed model digest");
    await publish("old-space", "Needle lexical cache", { space: changed });
    const result = await retrieve("needle"); expect(result.lexical.map((c) => c.sessionId)).toEqual(["old-space"]); expect(result.vector).toEqual([]);
    expect((await retrieve("needle", undefined, true, changed)).vector.map((c) => c.sessionId)).toEqual(["old-space"]);
    await pool.query("UPDATE search_chunks SET embedding_space_signature=$1", [REPOSITORY_SPACE.signature]);
    expect((await retrieve("needle")).vector).toEqual([]); // document signature must agree too
  });
  it("handles punctuation/operator-like queries as parameterized plain text, not SQL or tsquery syntax", async () => {
    await publish("safe", "Needle evidence");
    for (const query of ["' ! : & | ( )", "needle'; DROP TABLE search_chunks; --", "😀"] ) await expect(retrieve(query)).resolves.toHaveProperty("lexical");
    expect((await retrieve("needle")).lexical).toHaveLength(1);
  });
  it("bounds both expanded channels and reads restored caches before any reconciliation", async () => {
    for (let index = 0; index < 35; index++) await publish(`session-${index}`, "Needle cached excerpt");
    const result = await retrieve("needle"); expect(result.lexical).toHaveLength(30); expect(result.vector).toHaveLength(30);
    const restored = new PostgresSearchRetrieval(pool);
    try { expect((await restored.retrieve({ query: "needle", scopes: [REPOSITORY_WORKSPACE], candidateLimit: 10 })).lexical).toHaveLength(10); }
    finally { restored.close(); }
    // No source path in this suite exists; no source availability checks are needed for retrieval.
  });
});
