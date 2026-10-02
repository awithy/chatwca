import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { createChatWcaServer, type ChatWcaProtocolServices, type ChatWcaServer } from "../../src/server/index.js";
import { SearchQueryError } from "../../src/server/search/errors.js";
import { MAX_SEARCH_RESPONSE_BYTES } from "../../src/server/search/query.js";
import type { SearchServicePort } from "../../src/server/search/service.js";

const servers: ChatWcaServer[] = [];
async function fixture(enabled = true) {
  const config = loadConfig({ CHATWCA_DATA_DIR: "/tmp/synthetic-search-api", CHATWCA_SHUTDOWN_GRACE_MS: "100",
    ...(enabled ? { CHATWCA_SEARCH_MODE: "optional", CHATWCA_SEARCH_DATABASE_URL: "postgresql://synthetic:private-credential@127.0.0.1:1/cache" } : {}) });
  const search = {
    start: vi.fn(), capability: vi.fn(() => ({ mode: "optional" as const, state: "ready" as const, available: true, rerankAvailable: false })),
    freshness: vi.fn(() => ({ state: "ready" as const, indexing: false, lastSucceededAt: 123, errorCode: null })),
    status: vi.fn(async () => ({ mode: "optional" as const, state: "ready" as const, available: true, indexing: false, lastSucceededAt: 123,
      errorCode: null, counts: { documents: 1, chunks: 2 }, indexer: null })),
    search: vi.fn<SearchServicePort["search"]>(async (request) => ({ cached: true, mode: "lexical", warnings: [], rerank: { requested: request.rerank !== false, applied: false, reason: request.rerank === false ? "not_requested" : "unavailable" }, results: [{ workspaceId: "one", workspaceName: "Synthetic workspace",
      sessionId: "synthetic-session", title: "Synthetic title", modifiedAt: 123, excerpts: [{ entryId: "entry-one", role: "user", timestamp: 123, text: "<script>plain source</script>", truncated: false, indexedAt: 124 }] }] })),
    requestRefresh: vi.fn<SearchServicePort["requestRefresh"]>(), close: vi.fn(async () => {}),
  };
  const services = enabled ? { search, registry: { subscribe: () => () => {} }, history: {}, workspaces: {} } as unknown as ChatWcaProtocolServices : undefined;
  const server = createChatWcaServer(config, "synthetic-test", services); servers.push(server);
  await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}/api/search${route}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { server, search, base, post };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.shutdown())); });

describe("trusted local search HTTP routes", () => {
  it("advertises actual capability, cached grouped results, freshness and forwarded reranking fallback without credentials", async () => {
    const f = await fixture(); const config = await (await fetch(`${f.base}/api/config`)).json();
    expect(config.search).toEqual({ mode: "optional", state: "ready", available: true, rerankAvailable: false });
    const response = await f.post("", { query: "synthetic query", workspaceId: "one", limit: 2, rerank: true });
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = await response.json();
    expect(result).toMatchObject({ cached: true, mode: "lexical", freshness: { lastSucceededAt: 123 }, rerank: { requested: true, applied: false, reason: "unavailable" },
      results: [{ sessionId: "synthetic-session", excerpts: [{ entryId: "entry-one", text: "<script>plain source</script>" }] }] });
    expect(f.search.search).toHaveBeenCalledWith({ query: "synthetic query", workspaceId: "one", limit: 2, rerank: true }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(config) + JSON.stringify(result)).not.toMatch(/private-credential|databaseUrl|sourcePath|sourceRevision|ollamaUrl/u);
  });
  it("returns count/progress status without caching it", async () => {
    const f = await fixture(); const response = await fetch(`${f.base}/api/search/status`);
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toMatchObject({ counts: { documents: 1, chunks: 2 }, lastSucceededAt: 123 });
  });
  it.each(["refresh", "rebuild"])("accepts %s immediately with a coalescible worker request", async (action) => {
    const f = await fixture(); const response = await f.post(`/${action}`, { workspaceId: "one" });
    expect(response.status).toBe(202); expect(await response.json()).toEqual({ accepted: true });
    expect(f.search.requestRefresh).toHaveBeenCalledWith({ workspaceId: "one", rebuild: action === "rebuild" });
  });
  it("All/omitted selections map to null and reranking defaults on with explicit opt-out", async () => {
    const f = await fixture(); await f.post("", { query: "evidence" }); await f.post("/refresh", {});
    expect(f.search.search.mock.calls[0]?.[0]).toEqual({ query: "evidence", workspaceId: null, rerank: true });
    const response = await f.post("", { query: "evidence", rerank: false });
    expect(f.search.search.mock.calls[1]?.[0]).toEqual({ query: "evidence", workspaceId: null, rerank: false });
    expect((await response.json()).rerank).toEqual({ requested: false, applied: false, reason: "not_requested" });
    expect(f.search.requestRefresh).toHaveBeenCalledWith({ workspaceId: null, rebuild: false });
  });
  it("disabled routes/status are useful without constructing dependencies", async () => {
    const f = await fixture(false);
    expect((await (await fetch(`${f.base}/api/config`)).json()).search).toMatchObject({ mode: "disabled", available: false });
    expect(await (await fetch(`${f.base}/api/search/status`)).json()).toMatchObject({ state: "disabled", counts: null });
    for (const route of ["", "/refresh", "/rebuild"]) {
      const response = await f.post(route, route ? {} : { query: "evidence" }); expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "search_disabled" } });
    }
    expect(f.search.search).not.toHaveBeenCalled();
  });
  it.each([
    { query: "evidence", sourcePath: "/private" }, { query: "evidence", workspaceId: "../invalid" }, { query: "evidence", limit: null },
    { query: "evidence", limit: 21 }, { query: "evidence", rerank: "yes" }, { query: 42 }, ["evidence"],
  ])("rejects malformed/unknown query fields before search IO (%#)", async (input) => {
    const f = await fixture(); const response = await f.post("", input); expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "search_query_invalid" } }); expect(f.search.search).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON and oversized request bodies with safe errors", async () => {
    const f = await fixture();
    for (const body of ['{"query":"private input"', JSON.stringify({ query: "private input".repeat(4000) })]) {
      const response = await fetch(`${f.base}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body });
      expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: { code: "search_query_invalid" } });
    }
    expect(f.search.search).not.toHaveBeenCalled();
  });
  it("accepts same-authority and no-Origin trusted clients but rejects cross-site Origin/fetch metadata", async () => {
    const f = await fixture(); expect((await f.post("", { query: "evidence" }, { Origin: f.base })).status).toBe(200);
    for (const headers of [{ Origin: "https://untrusted.invalid" }, { Origin: "null" }, { "Sec-Fetch-Site": "cross-site" }]) {
      const response = await f.post("/rebuild", {}, headers); expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: { code: "search_origin_rejected" } });
    }
    expect(f.search.requestRefresh).not.toHaveBeenCalled();
  });
  it.each([
    ["search_query_invalid", 400], ["search_scope_unavailable", 404], ["search_busy", 429], ["search_timeout", 504],
    ["search_initializing", 503], ["search_schema_incompatible", 503], ["search_database_unavailable", 503],
  ] as const)("maps safe %s to %i without breaking chat health", async (code, status) => {
    const f = await fixture(); f.search.search.mockRejectedValue(new SearchQueryError(code));
    const response = await f.post("", { query: "evidence" }); expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } }); expect((await fetch(`${f.base}/api/health`)).status).toBe(200);
  });
  it("never exposes unexpected dependency diagnostics", async () => {
    const f = await fixture(); f.search.search.mockRejectedValue(new Error("private credential query excerpt"));
    const response = await f.post("", { query: "evidence" }); expect(await response.json()).toEqual({ error: { code: "search_database_unavailable" } });
    f.search.requestRefresh.mockImplementation(() => { throw new SearchQueryError("search_scope_unavailable"); });
    expect((await f.post("/refresh", { workspaceId: "missing" })).status).toBe(404);
  });
  it("accounts for freshness metadata in the hard serialized response cap", async () => {
    const f = await fixture(); const one = (await f.search.search({ query: "evidence" })).results[0]!;
    f.search.search.mockResolvedValue({ cached: true, mode: "lexical", warnings: [], rerank: { requested: true, applied: true, reason: "applied" }, results: Array.from({ length: 20 }, (_, index) => ({ ...one, sessionId: `session-${index}`,
      excerpts: Array.from({ length: 3 }, () => ({ ...one.excerpts[0]!, text: "\u0001".repeat(1200) })) })) });
    const response = await f.post("", { query: "evidence" }); const text = await response.text();
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(MAX_SEARCH_RESPONSE_BYTES); expect(JSON.parse(text).results.length).toBeGreaterThan(0);
  });
  it("request disconnect cancels search IO and shutdown seals search synchronously", async () => {
    const f = await fixture(); let signal: AbortSignal | undefined;
    f.search.search.mockImplementation((_request, options) => {
      signal = options?.signal;
      return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new SearchQueryError("search_cancelled")), { once: true }));
    });
    const controller = new AbortController();
    const result = fetch(`${f.base}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "evidence" }), signal: controller.signal }).catch(() => null);
    await vi.waitFor(() => expect(signal).toBeDefined()); controller.abort(); await result;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    await f.server.shutdown(); expect(f.search.close).toHaveBeenCalled();
  });
});
