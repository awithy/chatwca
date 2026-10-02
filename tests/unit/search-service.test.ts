import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { PiSearchReranker, SearchRerankerOptions } from "../../src/server/search/rerank.js";
import { loadSearchConfig } from "../../src/server/search/config.js";
import { SearchQueryError, SearchRepositoryError } from "../../src/server/search/errors.js";
import { SearchSchemaError } from "../../src/server/search/migrations.js";
import { SearchService, type SearchServiceResources, type SearchServiceOptions } from "../../src/server/search/service.js";
import type { SearchIndexerStatus } from "../../src/server/search/indexer.js";
import { workspaceSourceRevision } from "../../src/server/search/session-source.js";

const initialStatus: SearchIndexerStatus = { state: "idle", pending: false, workspaceId: null, startedAt: null, completedAt: null, lastSucceededAt: null,
  progress: { workspaces: 0, discovered: 0, published: 0, unchanged: 0, failed: 0, deleted: 0, removedWorkspaces: 0 }, errorCount: 0, errors: [] };
const registration = { id: "one", name: "Synthetic workspace", path: "/synthetic/workspace", sessionDirectory: "/synthetic/sessions" };
const services: SearchService[] = [];
function fixture(mode: "disabled" | "optional" = "optional", overrides: Pick<SearchServiceOptions, "getRerankContext"> = {}) {
  const config = loadSearchConfig({ CHATWCA_SEARCH_MODE: mode, CHATWCA_SEARCH_DATABASE_URL: "postgresql://synthetic:private-credential@127.0.0.1:1/cache", CHATWCA_SEARCH_INDEX_INTERVAL_MS: "100" });
  const indexer = { status: vi.fn(() => initialStatus), requestRefresh: vi.fn(), close: vi.fn(async () => {}) };
  const queries = { search: vi.fn(async () => ({ cached: true as const, mode: "lexical" as const, warnings: [], results: [], rerank: { requested: true, applied: false, reason: "too_few_candidates" } })), close: vi.fn() };
  const resources: SearchServiceResources = { indexer, queries, checkSchema: vi.fn(async () => {}), readCounts: vi.fn(async () => ({ documents: 3, chunks: 9 })), close: vi.fn(async () => {}) };
  const factory = vi.fn((_reranker?: PiSearchReranker) => resources); const registrations = { list: vi.fn(() => [registration]) };
  const service = new SearchService({ config, registrations, piAgentDirectory: "/synthetic/agent", createResources: factory, ...overrides }); services.push(service);
  return { service, resources, factory, indexer, queries, registrations };
}
async function ready(f: ReturnType<typeof fixture>) { f.service.start(); await vi.waitFor(() => expect(f.service.capability().state).toBe("ready")); }
afterEach(async () => { await Promise.all(services.splice(0).map((s) => s.close())); vi.useRealTimers(); });

describe("optional search lifecycle and failure isolation", () => {
  function context() {
    const model = fauxProvider({ provider: "openai", api: "openai-responses" }).getModel();
    const runtime = { getModel: vi.fn<SearchRerankerOptions["runtime"]["getModel"]>(() => model), hasConfiguredAuth: vi.fn(() => true),
      completeSimple: vi.fn<SearchRerankerOptions["runtime"]["completeSimple"]>() };
    const getRerankContext = vi.fn(() => ({ runtime, globalDefaults: { defaultProvider: "openai", defaultModel: model.id } }));
    return { runtime, getRerankContext };
  }
  it("disabled lifecycle never reads the Pi context or probes its local catalog/auth", async () => {
    const c = context(); const f = fixture("disabled", c); f.service.start(); await f.service.status(); f.service.capability(); await f.service.close();
    expect(c.getRerankContext).not.toHaveBeenCalled(); expect(c.runtime.getModel).not.toHaveBeenCalled();
  });
  it("supplies one adapter asynchronously, reports local capability and closes it synchronously", async () => {
    const c = context(); const f = fixture("optional", c); f.service.capability(); f.service.start();
    expect(c.getRerankContext).not.toHaveBeenCalled(); expect(c.runtime.getModel).not.toHaveBeenCalled();
    await ready(f); expect(c.getRerankContext).toHaveBeenCalledTimes(1);
    const adapter = f.factory.mock.calls[0]?.[0]; expect(adapter).toBeDefined();
    expect(f.service.capability().rerankAvailable).toBe(true);
    c.runtime.hasConfiguredAuth.mockReturnValue(false); expect(f.service.capability().rerankAvailable).toBe(false);
    c.runtime.hasConfiguredAuth.mockReturnValue(true); expect(f.service.capability().rerankAvailable).toBe(true);
    const closing = f.service.close(); expect(adapter?.available()).toBe(false); expect(f.service.capability().rerankAvailable).toBe(false); await closing;
    expect(c.runtime.completeSimple).not.toHaveBeenCalled();
  });
  it("failed optional Pi context setup leaves schema startup/local queries usable without exposing errors", async () => {
    const getRerankContext = vi.fn(() => { throw new Error("private Pi credentials diagnostic"); });
    const f = fixture("optional", { getRerankContext }); await ready(f);
    expect(f.service.capability().rerankAvailable).toBe(false);
    await expect(f.service.search({ query: "evidence" })).resolves.toHaveProperty("cached", true);
    expect(JSON.stringify(await f.service.status())).not.toContain("private Pi");
  });
  it("close before asynchronous initialization never requests a Pi context", async () => {
    const c = context(); const f = fixture("optional", c); f.service.start(); await f.service.close(); await Promise.resolve();
    expect(c.getRerankContext).not.toHaveBeenCalled();
  });
  it("disabled construction/start/status/close never constructs a pool, scans registrations or probes dependencies", async () => {
    const f = fixture("disabled"); f.service.start(); f.service.start();
    expect(f.service.capability()).toEqual({ mode: "disabled", available: false, state: "disabled", rerankAvailable: false });
    expect(await f.service.status()).toMatchObject({ state: "disabled", counts: null, indexer: null });
    await expect(f.service.search({ query: "evidence" })).rejects.toThrow("search_disabled");
    expect(() => f.service.requestRefresh()).toThrow("search_disabled"); await f.service.close();
    expect(f.factory).not.toHaveBeenCalled(); expect(f.registrations.list).not.toHaveBeenCalled();
  });
  it("starts optional dependencies asynchronously, checks schema before indexing and permits cached queries without waiting for a pass", async () => {
    const f = fixture(); expect(f.factory).not.toHaveBeenCalled();
    f.service.start(); expect(f.factory).not.toHaveBeenCalled();
    await ready(f);
    expect(f.factory).toHaveBeenCalledTimes(1); expect(f.resources.checkSchema).toHaveBeenCalledTimes(1);
    expect(f.indexer.requestRefresh).toHaveBeenCalledWith({ rebuild: false });
    expect(f.service.capability()).toEqual({ mode: "optional", state: "ready", available: true, rerankAvailable: false });
    await expect(f.service.search({ query: "evidence" })).resolves.toHaveProperty("cached", true);
    expect(f.queries.search).toHaveBeenCalledWith({ query: "evidence" }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("reports initializing before compatibility is known and coalesces refresh/rebuild while initialization is busy", async () => {
    const f = fixture(); let resolve!: () => void;
    vi.mocked(f.resources.checkSchema).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    f.service.start(); f.service.requestRefresh({ workspaceId: "one", rebuild: true });
    await expect(f.service.search({ query: "evidence" })).rejects.toThrow("search_initializing");
    expect(await f.service.status()).toMatchObject({ state: "initializing", available: false, counts: null });
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalled()); expect(f.indexer.requestRefresh).not.toHaveBeenCalled();
    resolve(); await vi.waitFor(() => expect(f.indexer.requestRefresh).toHaveBeenCalledWith({ rebuild: true }));
    expect(f.indexer.requestRefresh).toHaveBeenCalledTimes(1);
  });
  it("coalesces selected workspace scopes without creating a second initializer", async () => {
    const f = fixture(); f.registrations.list.mockReturnValue([registration, { ...registration, id: "two" }]);
    let resolve!: () => void; vi.mocked(f.resources.checkSchema).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    f.service.requestRefresh({ workspaceId: "one" }); f.service.requestRefresh({ workspaceId: "two", rebuild: true });
    await vi.waitFor(() => expect(f.factory).toHaveBeenCalled()); resolve();
    await vi.waitFor(() => expect(f.indexer.requestRefresh).toHaveBeenCalledTimes(2));
    expect(f.indexer.requestRefresh.mock.calls).toEqual([[{ workspaceId: "one", rebuild: true }], [{ workspaceId: "two", rebuild: true }]]);
    expect(f.factory).toHaveBeenCalledTimes(1);
  });
  it.each([new SearchSchemaError(), new Error("private database diagnostic"), new SearchRepositoryError("search_timeout")])("isolates initialization failure and retries explicitly without DDL (%#)", async (error) => {
    const f = fixture(); vi.mocked(f.resources.checkSchema).mockRejectedValueOnce(error); f.service.start();
    await vi.waitFor(() => expect(f.service.capability().state).toBe("unavailable"));
    const code = error instanceof SearchRepositoryError ? error.code : "search_database_unavailable";
    await expect(f.service.search({ query: "evidence" })).rejects.toThrow(code);
    expect(f.indexer.requestRefresh).not.toHaveBeenCalled();
    f.service.requestRefresh({ rebuild: true });
    await vi.waitFor(() => expect(f.service.capability().state).toBe("ready"));
    expect(f.resources.checkSchema).toHaveBeenCalledTimes(2); expect(f.factory).toHaveBeenCalledTimes(1);
    expect(f.indexer.requestRefresh).toHaveBeenCalledWith({ rebuild: true });
  });
  it("contains factory failures and retries after a subsequent refresh", async () => {
    const f = fixture(); f.factory.mockImplementationOnce(() => { throw new Error("private config diagnostic"); });
    f.service.start(); await vi.waitFor(() => expect(f.service.capability().state).toBe("unavailable"));
    expect((await f.service.status()).errorCode).toBe("search_database_unavailable");
    f.service.requestRefresh(); await vi.waitFor(() => expect(f.service.capability().state).toBe("ready"));
  });
  it("uses one unref'd periodic trigger, forwards refresh/rebuild to the one worker, and clears the timer at shutdown", async () => {
    vi.useFakeTimers(); const f = fixture(); f.service.start(); f.service.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.indexer.requestRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300); expect(f.indexer.requestRefresh).toHaveBeenCalledTimes(4);
    f.service.requestRefresh({ workspaceId: "one", rebuild: true }); expect(f.indexer.requestRefresh).toHaveBeenLastCalledWith({ workspaceId: "one", rebuild: true });
    await f.service.close(); await vi.advanceTimersByTimeAsync(1000); expect(f.indexer.requestRefresh).toHaveBeenCalledTimes(5);
  });
  it("timer retries compatibility failures and remains independent of startup readiness", async () => {
    vi.useFakeTimers(); const f = fixture(); vi.mocked(f.resources.checkSchema).mockRejectedValueOnce(new SearchSchemaError());
    f.service.start(); await vi.advanceTimersByTimeAsync(0); expect(f.service.capability().state).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(100); expect(f.service.capability().state).toBe("ready");
    expect(f.indexer.requestRefresh).toHaveBeenCalledTimes(1);
  });
  it("status filters persisted total counts by current registered IDs/revisions and retains per-pass progress separately", async () => {
    const f = fixture(); await ready(f);
    f.indexer.status.mockReturnValue({ ...initialStatus, state: "indexing", lastSucceededAt: 123, errorCount: 1, errors: [{ workspaceId: "one", code: "search_scope_unavailable" }] });
    const status = await f.service.status();
    expect(status).toMatchObject({ state: "ready", available: true, indexing: true, lastSucceededAt: 123, counts: { documents: 3, chunks: 9 }, indexer: { errorCount: 1 } });
    expect(f.resources.readCounts).toHaveBeenCalledWith([{ workspaceId: "one", sourceRevision: workspaceSourceRevision(registration, "/synthetic/agent") }], expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(JSON.stringify(status)).not.toMatch(/private-credential|sourceRevision|sourcePath|synthetic\/sessions/u);
  });
  it("isolates count/database outage and allows a subsequent cached query to recover", async () => {
    const f = fixture(); await ready(f);
    vi.mocked(f.resources.readCounts).mockRejectedValue(new Error("private count failure"));
    expect(await f.service.status()).toMatchObject({ state: "unavailable", counts: null, errorCode: "search_database_unavailable" });
    f.queries.search.mockRejectedValueOnce(new SearchQueryError("search_database_unavailable"));
    await expect(f.service.search({ query: "evidence" })).rejects.toThrow("search_database_unavailable");
    expect(f.service.capability().state).toBe("unavailable");
    vi.mocked(f.resources.readCounts).mockResolvedValue({ documents: 3, chunks: 9 });
    expect(await f.service.status()).toMatchObject({ state: "ready", available: true, errorCode: null });
    await f.service.search({ query: "evidence" }); expect(f.service.capability().state).toBe("ready");
  });
  it("worker failure updates status without introducing a membership/freshness query barrier", async () => {
    const f = fixture(); await ready(f); f.indexer.status.mockReturnValue({ ...initialStatus, state: "unavailable" });
    expect(f.service.capability()).toMatchObject({ state: "unavailable", available: false });
    await expect(f.service.search({ query: "evidence" })).resolves.toHaveProperty("cached", true);
  });
  it("validates refresh scope without source IO and never admits unknown workspace work", async () => {
    const f = fixture(); await ready(f);
    expect(() => f.service.requestRefresh({ workspaceId: "../invalid" })).toThrow("search_query_invalid");
    expect(() => f.service.requestRefresh({ workspaceId: "missing" })).toThrow("search_scope_unavailable");
    expect(f.indexer.requestRefresh).toHaveBeenCalledTimes(1);
  });
  it("close cancels initialization synchronously, seals all admission, and cannot resume indexing from a late schema result", async () => {
    const f = fixture(); let resolve!: () => void;
    vi.mocked(f.resources.checkSchema).mockReturnValue(new Promise<void>((done) => { resolve = done; }));
    f.service.start(); await vi.waitFor(() => expect(f.resources.checkSchema).toHaveBeenCalled());
    const first = f.service.close(); expect(f.service.close()).toBe(first);
    expect(vi.mocked(f.resources.checkSchema).mock.calls[0]?.[0].signal?.aborted).toBe(true);
    await first; resolve(); await Promise.resolve();
    expect(f.service.capability()).toMatchObject({ state: "closed", available: false }); expect(f.indexer.requestRefresh).not.toHaveBeenCalled();
    await expect(f.service.search({ query: "evidence" })).rejects.toThrow("search_cancelled"); expect(() => f.service.requestRefresh()).toThrow("search_cancelled");
    expect(f.resources.close).toHaveBeenCalledTimes(1);
  });
  it("closing immediately after start never constructs resources", async () => {
    const f = fixture(); f.service.start(); await f.service.close(); await Promise.resolve(); expect(f.factory).not.toHaveBeenCalled();
  });
});
