import { describe, expect, it, vi } from "vitest";
import { SearchQueryError, SearchRepositoryError } from "../../src/server/search/errors.js";
import { PostgresSearchRetrieval, type SearchRetrievalRequest } from "../../src/server/search/retrieval.js";
import { fakeSearchVector } from "../fixtures/search-ollama.js";
import { REPOSITORY_SPACE, REPOSITORY_WORKSPACE } from "../fixtures/search-repository.js";
import { searchCandidate, searchCandidateRow } from "../fixtures/search-retrieval.js";

const request: SearchRetrievalRequest = { query: "private query !' ; DROP TABLE search_chunks; --", scopes: [REPOSITORY_WORKSPACE], candidateLimit: 30,
  vector: { spaceSignature: REPOSITORY_SPACE.signature, embedding: fakeSearchVector(0.6, 0.8) } };
function fixture(override?: (sql: string) => Promise<{ rows: Record<string, unknown>[] }> | { rows: Record<string, unknown>[] } | undefined) {
  const client = { query: vi.fn(async (sql: string, _values?: unknown[]) => override?.(sql) ?? { rows: sql.includes("AS chunk_id") ? [searchCandidateRow()] : [] }), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) }; const repository = new PostgresSearchRetrieval(pool);
  return { repository, pool, client };
}
describe("parameterized read-only lexical and exact vector retrieval", () => {
  it("reads persisted total counts with ordinary current registration/revision filters", async () => {
    const f = fixture((sql) => sql.includes("sum(w.document_count)") ? { rows: [{ documents: "3", chunks: "12" }] } : undefined);
    expect(await f.repository.readCounts([REPOSITORY_WORKSPACE])).toEqual({ documents: 3, chunks: 12 });
    const query = f.client.query.mock.calls.find(([sql]) => sql.includes("sum(w.document_count)"))!;
    expect(query[0]).toContain("s.source_revision = w.source_revision");
    expect(JSON.parse(query[1]![0] as string)).toEqual([{ workspace_id: REPOSITORY_WORKSPACE.workspaceId, source_revision: REPOSITORY_WORKSPACE.sourceRevision }]);
    f.pool.connect.mockClear(); expect(await f.repository.readCounts([])).toEqual({ documents: 0, chunks: 0 }); expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each(["-1", "bad", "9007199254740993"])("rejects malformed or unsafe stored counts (%s)", async (documents) => {
    const f = fixture((sql) => sql.includes("sum(w.document_count)") ? { rows: [{ documents, chunks: "1" }] } : undefined);
    await expect(f.repository.readCounts([REPOSITORY_WORKSPACE])).rejects.toThrow("search_database_unavailable");
  });

  it("constructs lazily; scopes both channels by IDs/revisions and vectors by both digest signatures", async () => {
    const f = fixture(); expect(f.pool.connect).not.toHaveBeenCalled();
    expect(await f.repository.retrieve(request)).toEqual({ lexical: [searchCandidate()], vector: [searchCandidate()] });
    const queries = f.client.query.mock.calls.filter(([sql]) => sql.includes("AS chunk_id"));
    expect(queries).toHaveLength(2);
    for (const [sql, values] of queries) {
      expect(sql).not.toContain(request.query);
      expect(sql).toContain("s.source_revision = d.source_revision AND s.source_revision = w.source_revision");
      expect(JSON.parse(values![0] as string)).toEqual([{ workspace_id: REPOSITORY_WORKSPACE.workspaceId, source_revision: REPOSITORY_WORKSPACE.sourceRevision }]);
      expect(sql).toContain("c.id ASC LIMIT");
    }
    expect(queries[0]?.[0]).toContain("plainto_tsquery('english', $2)"); expect(queries[0]?.[0]).toContain("plainto_tsquery('simple', $2)");
    expect(queries[0]?.[1]?.slice(1)).toEqual([request.query, 30]);
    expect(queries[1]?.[0]).toContain("c.embedding_space_signature = $2 AND d.embedding_space_signature = $2");
    expect(queries[1]?.[0]).toContain("c.embedding <=> $3::vector");
    expect(queries[1]?.[1]?.slice(1)).toEqual([REPOSITORY_SPACE.signature, `[${fakeSearchVector(0.6, 0.8).join(",")}]`, 30]);
    expect(f.client.query.mock.calls[0]?.[0]).toBe("BEGIN READ ONLY"); expect(f.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("lexical-only skips vector SQL and empty scopes skip all database IO", async () => {
    const f = fixture(); const lexical = { query: "evidence", scopes: request.scopes, candidateLimit: 30 };
    expect(await f.repository.retrieve(lexical)).toEqual({ lexical: [searchCandidate()], vector: [] });
    expect(f.client.query.mock.calls.filter(([sql]) => sql.includes("AS chunk_id"))).toHaveLength(1);
    f.pool.connect.mockClear(); expect(await f.repository.retrieve({ ...lexical, scopes: [] })).toEqual({ lexical: [], vector: [] });
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each([
    { candidateLimit: 0 }, { candidateLimit: 101 }, { candidateLimit: 1.5 }, { query: "\0" },
    { scopes: [{ ...REPOSITORY_WORKSPACE, sourceRevision: "bad" }] }, { scopes: [REPOSITORY_WORKSPACE, REPOSITORY_WORKSPACE] },
    { vector: { spaceSignature: "bad", embedding: fakeSearchVector() } },
    { vector: { spaceSignature: REPOSITORY_SPACE.signature, embedding: [1] } },
    { vector: { spaceSignature: REPOSITORY_SPACE.signature, embedding: Array<number>(1024).fill(0) } },
    { vector: { spaceSignature: REPOSITORY_SPACE.signature, embedding: Array<number>(1024).fill(NaN) } },
  ])("rejects invalid direct retrieval before database admission (%#)", async (override) => {
    const f = fixture(); await expect(f.repository.retrieve({ ...request, ...override })).rejects.toEqual(new SearchQueryError("search_query_invalid"));
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
  it.each([
    { chunk_id: "bad" }, { workspace_id: "unselected" }, { source_revision: "a".repeat(64) }, { role: "tool" },
    { entry_id: "../path" }, { entry_timestamp: "bad" }, { modified_at: new Date(NaN) }, { original_text: "\ud800" },
    { original_text: "x".repeat(3201) }, { source_byte_start: -1 }, { source_byte_end: 0 }, { source_byte_end: 100 }, { title: "\0" },
  ])("sanitizes malformed/out-of-scope cached rows (%#)", async (override) => {
    const f = fixture((sql) => sql.includes("AS chunk_id") ? { rows: [{ ...searchCandidateRow(), ...override }] } : undefined);
    await expect(f.repository.retrieve(request)).rejects.toEqual(new SearchRepositoryError("search_database_unavailable"));
    expect(f.client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("rejects duplicate/excess rows and sanitizes database diagnostics", async () => {
    for (const rows of [[searchCandidateRow(), searchCandidateRow()], Array.from({ length: 31 }, (_, index) => searchCandidateRow(searchCandidate(index + 1)))]) {
      const f = fixture((sql) => sql.includes("AS chunk_id") ? { rows } : undefined);
      await expect(f.repository.retrieve(request)).rejects.toThrow("search_database_unavailable");
    }
    const f = fixture(() => { throw new Error("private password/source excerpt"); });
    await expect(f.repository.retrieve(request)).rejects.toEqual(new SearchRepositoryError("search_database_unavailable"));
  });
  it("snapshots caller-owned scopes, query and limits before asynchronous IO", async () => {
    let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve; });
    const f = fixture((sql) => sql === "BEGIN READ ONLY" ? gate.then(() => ({ rows: [] })) : undefined);
    const scopes = [{ workspaceId: REPOSITORY_WORKSPACE.workspaceId, sourceRevision: REPOSITORY_WORKSPACE.sourceRevision }];
    const mutable = { ...request, scopes }; const result = f.repository.retrieve(mutable);
    mutable.query = "mutated"; mutable.candidateLimit = 1; scopes[0]!.sourceRevision = "b".repeat(64); resume();
    await expect(result).resolves.toHaveProperty("lexical");
    const queries = f.client.query.mock.calls.filter(([sql]) => sql.includes("AS chunk_id"));
    expect(queries[0]?.[1]?.slice(1)).toEqual([request.query, 30]); expect(queries[1]?.[1]?.at(-1)).toBe(30);
  });
  it("admits only two concurrent readers without queueing and close cancels active IO", async () => {
    const f = fixture((sql) => sql === "BEGIN READ ONLY" ? new Promise(() => {}) : undefined);
    const one = f.repository.retrieve(request); const two = f.repository.retrieve(request); const outcomes = Promise.allSettled([one, two]);
    await expect(f.repository.retrieve(request)).rejects.toThrow("search_busy");
    f.repository.close(); const results = await outcomes;
    expect(results.every((result) => result.status === "rejected" && (result.reason as SearchRepositoryError).code === "search_cancelled")).toBe(true);
    await expect(f.repository.retrieve(request)).rejects.toThrow("search_cancelled");
  });
  it("respects already cancelled signals without constructing a connection", async () => {
    const f = fixture(); await expect(f.repository.retrieve(request, { signal: AbortSignal.abort() })).rejects.toThrow("search_cancelled");
    expect(f.pool.connect).not.toHaveBeenCalled();
  });
});
