import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEmbeddingError, SearchQueryError, SearchRepositoryError } from "../../src/server/search/errors.js";
import { fuseSearchCandidates, groupSearchCandidates, MAX_SEARCH_RESPONSE_BYTES, SearchQueryService, type SearchQueryReranker } from "../../src/server/search/query.js";
import { validateSearchQuery, type SearchRetrievalRequest } from "../../src/server/search/retrieval.js";
import { workspaceSourceRevision } from "../../src/server/search/session-source.js";
import { fakeSearchVector } from "../fixtures/search-ollama.js";
import { REPOSITORY_SPACE } from "../fixtures/search-repository.js";
import { searchCandidate } from "../fixtures/search-retrieval.js";

const registration = { id: "workspace-one", name: "Workspace one", path: "/synthetic/workspace", sessionDirectory: "/synthetic/sessions" };
function fixture(overrides: { timeoutMs?: number; reranker?: SearchQueryReranker } = {}) {
  const registrations = { list: vi.fn(() => [registration, { ...registration, id: "workspace-two" }]) };
  const repository = { retrieve: vi.fn(async (_request: SearchRetrievalRequest) => ({ lexical: [searchCandidate()], vector: [searchCandidate()] })) };
  const embeddings = { embedSearchQuery: vi.fn(async () => ({ space: REPOSITORY_SPACE, embedding: fakeSearchVector() })) };
  const service = new SearchQueryService({ repository, registrations, embeddings, piAgentDirectory: "/synthetic/agent", ...overrides });
  return { service, repository, registrations, embeddings };
}
afterEach(() => vi.useRealTimers());

describe("local query validation and orchestration", () => {
  it.each([null, undefined, 42, "", " \n", "\0", "bad\ud800", "x".repeat(2049), "😀".repeat(2049)])("rejects invalid query (%#)", (query) => {
    expect(() => validateSearchQuery(query)).toThrow("search_query_invalid");
  });
  it("accepts the exact Unicode/codepoint/UTF-8 bound without trimming", () => {
    expect(validateSearchQuery("😀".repeat(2048))).toBe("😀".repeat(2048));
    expect(validateSearchQuery("  query \n")).toBe("  query \n");
  });
  it.each([{ limit: 0 }, { limit: 21 }, { limit: 1.5 }, { workspaceId: "../private" }])("validates requests before dependency IO (%#)", async (override) => {
    const f = fixture(); await expect(f.service.search({ query: "evidence", ...override })).rejects.toThrow("search_query_invalid");
    expect(f.registrations.list).not.toHaveBeenCalled(); expect(f.embeddings.embedSearchQuery).not.toHaveBeenCalled();
  });
  it.each([1, 6, 10, 20])("snapshots registered IDs/revisions for All and expands candidates (limit %i)", async (limit) => {
    const f = fixture(); const result = await f.service.search({ query: "evidence", limit });
    expect(f.repository.retrieve).toHaveBeenCalledWith({ query: "evidence", candidateLimit: Math.min(100, Math.max(30, limit * 5)),
      scopes: f.registrations.list().map((w) => ({ workspaceId: w.id, sourceRevision: workspaceSourceRevision(w, "/synthetic/agent") })),
      vector: { spaceSignature: REPOSITORY_SPACE.signature, embedding: fakeSearchVector() } }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(result).toMatchObject({ cached: true, mode: "hybrid", warnings: [], results: [{ sessionId: "session-1" }] });
    expect(f.registrations.list).toHaveBeenCalledTimes(2); // one query snapshot, plus test's own expected-value call
    expect(JSON.stringify(result)).not.toMatch(/sourceRevision|sourcePath|embedding|chunkId|score/u);
  });
  it("filters one workspace and rejects unknown selection without probing providers", async () => {
    const f = fixture(); await f.service.search({ query: "evidence", workspaceId: registration.id });
    expect(f.repository.retrieve.mock.calls[0]?.[0].scopes).toHaveLength(1);
    await expect(f.service.search({ query: "evidence", workspaceId: "missing" })).rejects.toThrow("search_scope_unavailable");
    expect(f.embeddings.embedSearchQuery).toHaveBeenCalledTimes(1);
  });
  it("serves an empty registered corpus without dependencies", async () => {
    const f = fixture(); f.registrations.list.mockReturnValue([]);
    expect(await f.service.search({ query: "evidence" })).toEqual({ cached: true, mode: "lexical", warnings: [], results: [], rerank: { requested: true, applied: false, reason: "too_few_candidates" } });
    expect(f.repository.retrieve).not.toHaveBeenCalled(); expect(f.embeddings.embedSearchQuery).not.toHaveBeenCalled();
  });
  it.each(["search_embedding_unavailable", "search_embedding_space_changed", "search_embedding_invalid", "search_timeout", "search_busy"] as const)("falls back to cached lexical hits on %s", async (code) => {
    const f = fixture(); f.embeddings.embedSearchQuery.mockRejectedValue(new SearchEmbeddingError(code));
    f.repository.retrieve.mockResolvedValue({ lexical: [searchCandidate()], vector: [] });
    expect(await f.service.search({ query: "evidence" })).toMatchObject({ mode: "lexical", warnings: [code], results: [{ sessionId: "session-1" }] });
    expect(f.repository.retrieve.mock.calls[0]?.[0]).not.toHaveProperty("vector");
  });
  it("reports lexical mode when current digest has no vector coverage", async () => {
    const f = fixture(); f.repository.retrieve.mockResolvedValue({ lexical: [searchCandidate()], vector: [] });
    expect(await f.service.search({ query: "evidence" })).toMatchObject({ mode: "lexical", results: [{ sessionId: "session-1" }] });
  });
  it("sanitizes unexpected embedding, registration and database errors", async () => {
    const f = fixture(); f.embeddings.embedSearchQuery.mockRejectedValue(new Error("private provider diagnostic"));
    expect((await f.service.search({ query: "evidence" })).warnings).toEqual(["search_embedding_unavailable"]);
    f.repository.retrieve.mockRejectedValue(new Error("postgres://secret private excerpt"));
    await expect(f.service.search({ query: "evidence" })).rejects.toEqual(new SearchQueryError("search_database_unavailable"));
    f.registrations.list.mockImplementation(() => { throw new Error("private registration path"); });
    await expect(f.service.search({ query: "evidence" })).rejects.toEqual(new SearchQueryError("search_scope_unavailable"));
  });
  it.each(["search_busy", "search_timeout", "search_cancelled"] as const)("preserves stable database failure %s", async (code) => {
    const f = fixture(); f.repository.retrieve.mockRejectedValue(new SearchRepositoryError(code));
    await expect(f.service.search({ query: "evidence" })).rejects.toEqual(new SearchQueryError(code));
  });
  it("bounds active searches, releases admission on cancellation, and never launches late database work", async () => {
    const f = fixture(); f.embeddings.embedSearchQuery.mockImplementation(() => new Promise(() => {}));
    const a = new AbortController(); const b = new AbortController();
    const first = f.service.search({ query: "a" }, { signal: a.signal });
    const second = f.service.search({ query: "b" }, { signal: b.signal });
    const observed = Promise.allSettled([first, second]);
    await expect(f.service.search({ query: "excess" })).rejects.toThrow("search_busy");
    a.abort(); b.abort(); expect((await observed).every((result) => result.status === "rejected")).toBe(true);
    expect(f.repository.retrieve).not.toHaveBeenCalled();
    f.embeddings.embedSearchQuery.mockResolvedValue({ space: REPOSITORY_SPACE, embedding: fakeSearchVector() });
    await expect(f.service.search({ query: "recovered" })).resolves.toHaveProperty("cached", true);
  });
  it("bounds a non-cooperative provider with the full-search deadline", async () => {
    vi.useFakeTimers(); const f = fixture({ timeoutMs: 100 });
    f.embeddings.embedSearchQuery.mockImplementation(() => new Promise(() => {}));
    const outcome = f.service.search({ query: "evidence" }).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    expect(await outcome).toEqual(new SearchQueryError("search_timeout")); expect(f.repository.retrieve).not.toHaveBeenCalled();
  });
  it("bounds non-cooperative database work and propagates cancellation to adapters", async () => {
    const f = fixture(); f.repository.retrieve.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController(); const outcome = f.service.search({ query: "evidence" }, { signal: controller.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.repository.retrieve).toHaveBeenCalled()); controller.abort();
    expect(await outcome).toEqual(new SearchQueryError("search_cancelled"));
    expect(f.embeddings.embedSearchQuery.mock.calls[0]).toBeDefined();
  });
  it("shutdown aborts active requests, seals admission and never returns a cancellation fallback", async () => {
    const f = fixture(); f.embeddings.embedSearchQuery.mockImplementation(() => new Promise(() => {}));
    const outcome = f.service.search({ query: "evidence" }).catch((error: unknown) => error); f.service.close();
    expect(await outcome).toEqual(new SearchQueryError("search_cancelled"));
    await expect(f.service.search({ query: "evidence" })).rejects.toThrow("search_cancelled");
    expect(f.repository.retrieve).not.toHaveBeenCalled();
  });
  it("provider cancellation is not disguised as lexical success", async () => {
    const f = fixture(); f.embeddings.embedSearchQuery.mockRejectedValue(new SearchEmbeddingError("search_cancelled"));
    await expect(f.service.search({ query: "evidence" })).rejects.toThrow("search_cancelled");
    expect(f.repository.retrieve).not.toHaveBeenCalled();
  });
});

describe("optional reranking within query orchestration", () => {
  function rankedFixture(timeoutMs?: number) {
    const rerank = vi.fn<SearchQueryReranker["rerank"]>(async (_query, candidates) =>
      ({ candidates: [...candidates].reverse(), applied: true, reason: "applied" }));
    const f = fixture({ reranker: { rerank }, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
    const a = searchCandidate(1); const overlap = searchCandidate(2, { sessionId: a.sessionId, entryId: a.entryId });
    const b = searchCandidate(3); const c = searchCandidate(4, { sessionId: b.sessionId });
    f.repository.retrieve.mockResolvedValue({ lexical: [a, overlap, b, c], vector: [b] });
    return { ...f, rerank, a, b, c };
  }
  it("defaults on, reranks the collapsed RRF pool before limiting groups and orders excerpts by reranked chunks", async () => {
    const f = rankedFixture(); const result = await f.service.search({ query: "evidence", limit: 1 });
    expect(f.rerank).toHaveBeenCalledTimes(1);
    expect(f.rerank.mock.calls[0]?.[1]).toEqual([f.b, f.a, f.c]);
    expect(result.rerank).toEqual({ requested: true, applied: true, reason: "applied" });
    expect(result.results.map((group) => group.sessionId)).toEqual([f.b.sessionId]);
    expect(result.results[0]?.excerpts.map((e) => e.entryId)).toEqual([f.c.entryId, f.b.entryId]);
    expect(JSON.stringify(result)).not.toMatch(/chunkId|score|sourceRevision/u);
  });
  it("explicit opt-out skips reranking and preserves local grouping", async () => {
    const f = rankedFixture(); const result = await f.service.search({ query: "evidence", rerank: false });
    expect(f.rerank).not.toHaveBeenCalled();
    expect(result.rerank).toEqual({ requested: false, applied: false, reason: "not_requested" });
    expect(result.results.map((g) => g.sessionId)).toEqual([f.b.sessionId, f.a.sessionId]);
  });
  it.each([0, 1])("skips the adapter for %i collapsed candidates", async (count) => {
    const f = rankedFixture(); f.repository.retrieve.mockResolvedValue({ lexical: count ? [f.a, { ...f.a }] : [], vector: [] });
    expect((await f.service.search({ query: "evidence" })).rerank.reason).toBe("too_few_candidates");
    expect(f.rerank).not.toHaveBeenCalled();
  });
  it("missing reranker returns useful local results with a stable unavailable reason", async () => {
    const f = fixture(); f.repository.retrieve.mockResolvedValue({ lexical: [searchCandidate(1), searchCandidate(2)], vector: [] });
    expect((await f.service.search({ query: "evidence" })).rerank).toEqual({ requested: true, applied: false, reason: "unavailable" });
  });
  it.each(["unsupported_model", "unavailable", "input_limit", "invalid_response", "timeout"] as const)("retains local order on adapter fallback %s", async (reason) => {
    const f = rankedFixture(); f.rerank.mockImplementation(async (_query, candidates) => ({ candidates, applied: false, reason }));
    const result = await f.service.search({ query: "evidence" });
    expect(result.rerank).toEqual({ requested: true, applied: false, reason });
    expect(result.results.map((g) => g.sessionId)).toEqual([f.b.sessionId, f.a.sessionId]);
  });
  it("unexpected optional errors remain safe local fallback, not database failure", async () => {
    const f = rankedFixture(); f.rerank.mockRejectedValue(new Error("private provider diagnostic"));
    const result = await f.service.search({ query: "evidence" });
    expect(result.rerank.reason).toBe("unavailable"); expect(result.results).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it.each(["search_cancelled", "search_timeout"] as const)("propagates adapter %s rather than returning fallback", async (code) => {
    const f = rankedFixture(); f.rerank.mockRejectedValue(new SearchQueryError(code));
    await expect(f.service.search({ query: "evidence" })).rejects.toThrow(code);
  });
  it("holds the same two-reader admission through non-cooperative reranking and releases it after cancellation", async () => {
    const f = rankedFixture(); f.rerank.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const first = f.service.search({ query: "first" }, { signal: controller.signal }).catch((e: unknown) => e);
    const second = f.service.search({ query: "second" }).catch((e: unknown) => e);
    await vi.waitFor(() => expect(f.rerank).toHaveBeenCalledTimes(2));
    await expect(f.service.search({ query: "third" })).rejects.toThrow("search_busy");
    controller.abort(); expect(await first).toMatchObject({ code: "search_cancelled" });
    expect(f.rerank.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    await expect(f.service.search({ query: "local", rerank: false })).resolves.toHaveProperty("cached", true);
    f.service.close(); expect(await second).toMatchObject({ code: "search_cancelled" });
  });
  it("aggregate deadline bounds stuck reranking; late ordering cannot become success", async () => {
    vi.useFakeTimers(); const f = rankedFixture(100); let resolve!: () => void;
    f.rerank.mockImplementation(async (_query, candidates) => {
      await new Promise<void>((done) => { resolve = done; });
      return { candidates: [...candidates].reverse(), applied: true, reason: "applied" };
    });
    const outcome = f.service.search({ query: "evidence" }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(0); expect(f.rerank).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); expect(await outcome).toMatchObject({ code: "search_timeout" });
    expect(f.rerank.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    resolve();
    await vi.advanceTimersByTimeAsync(0);
    await expect(f.service.search({ query: "next", rerank: false })).resolves.toHaveProperty("cached", true);
  });
  it("rejects malformed reranking flags before dependency IO", async () => {
    const f = rankedFixture();
    await expect(f.service.search({ query: "evidence", rerank: "yes" as unknown as boolean })).rejects.toThrow("search_query_invalid");
    expect(f.registrations.list).not.toHaveBeenCalled(); expect(f.rerank).not.toHaveBeenCalled();
  });
});

describe("RRF, overlap collapse and conversation grouping", () => {
  it("adds reciprocal ranks across channels, not raw distance/lexical scores", () => {
    const a = searchCandidate(1); const b = searchCandidate(2); const c = searchCandidate(3);
    const result = fuseSearchCandidates({ lexical: [a, b], vector: [c, b] });
    expect(result.map((item) => item.candidate.chunkId)).toEqual([b.chunkId, a.chunkId, c.chunkId]);
    expect(result[0]?.score).toBe(2 / 62); expect(result[1]?.score).toBe(1 / 61);
  });
  it("breaks ties by chunk ID independent of channel ordering, without duplicate-channel credit", () => {
    const a = searchCandidate(1); const b = searchCandidate(2);
    expect(fuseSearchCandidates({ lexical: [b, a, b], vector: [a, b] }).map((item) => item.candidate.chunkId)).toEqual([a.chunkId, b.chunkId]);
  });
  it("collapses overlapping spans in the same entry, retains touching spans and other entries/workspaces", () => {
    const a = searchCandidate(1, { sessionId: "same", entryId: "same", sourceByteStart: 0, sourceByteEnd: 100 });
    const b = searchCandidate(2, { ...a, chunkId: searchCandidate(2).chunkId, sourceByteStart: 90, sourceByteEnd: 190 });
    const c = searchCandidate(3, { ...a, chunkId: searchCandidate(3).chunkId, sourceByteStart: 100, sourceByteEnd: 200 });
    const d = searchCandidate(4, { ...a, chunkId: searchCandidate(4).chunkId, entryId: "other" });
    const e = searchCandidate(5, { ...a, chunkId: searchCandidate(5).chunkId, workspaceId: "other-workspace" });
    expect(fuseSearchCandidates({ lexical: [a, b, c, d, e], vector: [] }).map((item) => item.candidate.chunkId)).toEqual([a, c, d, e].map((item) => item.chunkId));
  });
  it("caps each conversation at five and the fused pool at 100", () => {
    const many = Array.from({ length: 120 }, (_, index) => searchCandidate(index + 1));
    expect(fuseSearchCandidates({ lexical: many, vector: [] })).toHaveLength(100);
    expect(fuseSearchCandidates({ lexical: many.map((c) => ({ ...c, sessionId: "same" })), vector: [] })).toHaveLength(5);
  });
  it("orders conversations by their best chunk, caps groups/excerpts and keeps identical session IDs in distinct workspaces", () => {
    const many = Array.from({ length: 7 }, (_, index) => searchCandidate(index + 1, { sessionId: "same" }));
    const other = searchCandidate(8, { sessionId: "same", workspaceId: "other" });
    const results = groupSearchCandidates({ lexical: [many[0]!, other, ...many.slice(1)], vector: [] }, "query", 2);
    expect(results).toHaveLength(2); expect(results[0]?.excerpts).toHaveLength(3); expect(results[1]?.workspaceId).toBe("other");
    expect(groupSearchCandidates({ lexical: [many[0]!, other], vector: [] }, "query", 1)).toHaveLength(1);
  });
  it("bounds Unicode excerpts/metadata and emits plain source text near an exact match", () => {
    const candidate = searchCandidate(1, { text: "😀".repeat(2000) + "<script>needle</script>" + "z".repeat(1000), title: "t".repeat(2000), workspaceName: "w".repeat(2000) });
    const result = groupSearchCandidates({ lexical: [candidate], vector: [] }, "needle", 10)[0]!;
    expect([...result.excerpts[0]!.text]).toHaveLength(1200); expect(result.excerpts[0]?.text).toContain("<script>needle</script>");
    expect(result.excerpts[0]?.truncated).toBe(true); expect(result.title).toHaveLength(512); expect(result.workspaceName).toHaveLength(512);
  });
  it("enforces the serialized response cap even with JSON escaping and maximum groups/excerpts", async () => {
    const f = fixture(); const many = Array.from({ length: 60 }, (_, index) => searchCandidate(index + 1, {
      sessionId: `session-${Math.floor(index / 3)}`, text: "\u0001".repeat(3200), title: "\u0001".repeat(4000), workspaceName: "\u0001".repeat(500),
    }));
    f.repository.retrieve.mockResolvedValue({ lexical: many, vector: [] });
    const result = await f.service.search({ query: "query", limit: 20 });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(MAX_SEARCH_RESPONSE_BYTES);
    expect(result.results.length).toBeGreaterThan(0); expect(result.results.length).toBeLessThan(20);
  });
});
