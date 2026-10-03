import { afterEach, describe, expect, it, vi } from "vitest";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import type { PiSearchReranker, SearchRerankerOptions } from "../../src/server/search/rerank.js";
import { loadSearchConfig } from "../../src/server/search/config.js";
import { ConversationReadError, SearchQueryError, SearchRepositoryError } from "../../src/server/search/errors.js";
import { SearchSchemaError } from "../../src/server/search/migrations.js";
import { MAX_CONVERSATION_READ_TIMEOUT_MS, SearchService, type SearchServiceResources, type SearchServiceOptions } from "../../src/server/search/service.js";
import { assembleConversationReadPage } from "../../src/server/search/read-page.js";
import type { ConversationReadRepository } from "../../src/server/search/read-repository.js";
import { READ_DOCUMENT, readChunks } from "../fixtures/search-read.js";
import type { SearchIndexerRegistrations, SearchIndexerStatus } from "../../src/server/search/indexer.js";
import { workspaceSourceRevision } from "../../src/server/search/session-source.js";

const initialStatus: SearchIndexerStatus = { state: "idle", pending: false, workspaceId: null, startedAt: null, completedAt: null, lastSucceededAt: null,
  progress: { workspaces: 0, discovered: 0, published: 0, unchanged: 0, failed: 0, deleted: 0, removedWorkspaces: 0 }, errorCount: 0, errors: [] };
const registration = { id: "one", name: "Synthetic workspace", path: "/synthetic/workspace", sessionDirectory: "/synthetic/sessions" };
const services: SearchService[] = [];
const readRequest = { workspaceId: "one", sessionId: "synthetic-session" };
const readPage = assembleConversationReadPage({ document: { ...READ_DOCUMENT, workspaceId: "one" }, chunks: readChunks(["Cached evidence"]), hasMore: false }, readRequest);
function fixture(mode: "disabled" | "optional" = "optional", overrides: Pick<SearchServiceOptions, "getRerankContext" | "readTimeoutMs"> = {}) {
  const config = loadSearchConfig({ CHATWCA_SEARCH_MODE: mode, CHATWCA_SEARCH_DATABASE_URL: "postgresql://synthetic:private-credential@127.0.0.1:1/cache", CHATWCA_SEARCH_INDEX_INTERVAL_MS: "100" });
  const indexer = { status: vi.fn(() => initialStatus), requestRefresh: vi.fn(), close: vi.fn(async () => {}) };
  const queries = { search: vi.fn(async () => ({ cached: true as const, mode: "lexical" as const, warnings: [], results: [], rerank: { requested: true, applied: false, reason: "too_few_candidates" } })), close: vi.fn() };
  const reads = { read: vi.fn<ConversationReadRepository["read"]>(async () => readPage) };
  const resources: SearchServiceResources = { indexer, queries, reads, checkSchema: vi.fn(async () => {}), readCounts: vi.fn(async () => ({ documents: 3, chunks: 9 })), close: vi.fn(async () => {}) };
  const factory = vi.fn((_reranker?: PiSearchReranker) => resources); const registrations = { list: vi.fn<SearchIndexerRegistrations["list"]>(() => [registration]) };
  const service = new SearchService({ config, registrations, piAgentDirectory: "/synthetic/agent", createResources: factory, ...overrides }); services.push(service);
  return { service, resources, factory, indexer, queries, reads, registrations };
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
    expect(f.queries.search).toHaveBeenCalledWith({ query: "evidence", workspaceId: null, limit: 10, rerank: true }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("validates closed search requests before injected query IO", async () => {
    const f = fixture(); await ready(f);
    for (const input of [{ query: "evidence", path: "/private" }, { query: " " }, { query: "evidence", limit: 21 }]) {
      await expect(f.service.search(input)).rejects.toThrow("search_query_invalid");
    }
    expect(f.queries.search).not.toHaveBeenCalled();
  });
  it("forwards a captured internal read budget and rejects invalid budgets before IO", async () => {
    const f = fixture(); await ready(f);
    const options = { maximumPageBytes: 22 * 1024 };
    const pending = f.service.read(readRequest, options); options.maximumPageBytes = 1024;
    await pending;
    expect(f.reads.read).toHaveBeenCalledWith(expect.any(Object), readRequest, expect.objectContaining({ maximumPageBytes: 22 * 1024 }));
    f.reads.read.mockClear();
    for (const maximumPageBytes of [0, 1023, 1.5, 48 * 1024, NaN]) {
      await expect(f.service.read(readRequest, { maximumPageBytes })).rejects.toThrow("search_query_invalid");
    }
    expect(f.reads.read).not.toHaveBeenCalled();
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

describe("process-owned cached conversation reads", () => {
  it("disabled mode remains dependency-free, and initializing/closed reads fail without registration or reader IO", async () => {
    const disabled = fixture("disabled", { getRerankContext: vi.fn(() => { throw new Error("Unexpected Pi context"); }) });
    disabled.service.start();
    await expect(disabled.service.read(readRequest)).rejects.toThrow("search_disabled");
    expect(disabled.factory).not.toHaveBeenCalled(); expect(disabled.registrations.list).not.toHaveBeenCalled();
    expect(disabled.reads.read).not.toHaveBeenCalled();
    const f = fixture();
    await expect(f.service.read(readRequest)).rejects.toThrow("search_initializing");
    expect(f.factory).not.toHaveBeenCalled(); expect(f.registrations.list).not.toHaveBeenCalled();
    await f.service.close();
    await expect(f.service.read(readRequest)).rejects.toThrow("search_cancelled");
    expect(f.reads.read).not.toHaveBeenCalled();
  });

  it.each([new SearchSchemaError(), new Error("private PostgreSQL initialization diagnostic"), new SearchRepositoryError("search_timeout")])("returns safe initialization failures and reads after compatibility recovers (%#)", async (error) => {
    const f = fixture(); vi.mocked(f.resources.checkSchema).mockRejectedValueOnce(error); f.service.start();
    await vi.waitFor(() => expect(f.service.capability().state).toBe("unavailable"));
    await expect(f.service.read(readRequest)).rejects.toThrow(error instanceof SearchRepositoryError ? error.code : "search_database_unavailable");
    expect(f.registrations.list).not.toHaveBeenCalled(); expect(f.reads.read).not.toHaveBeenCalled();
    f.service.requestRefresh(); await vi.waitFor(() => expect(f.service.capability().state).toBe("ready"));
    await expect(f.service.read(readRequest)).resolves.toHaveProperty("cached", true);
  });

  it("resolves current registration revisions and returns freshness without embeddings, reranking, source-usability checks or refresh work", async () => {
    const f = fixture(); const requireUsable = vi.fn(() => { throw new Error("Source policy unavailable"); });
    Object.assign(f.registrations, { requireUsable }); await ready(f);
    f.indexer.status.mockReturnValue({ ...initialStatus, state: "indexing", lastSucceededAt: 123, errorCount: 1,
      errors: [{ workspaceId: "one", code: "search_scope_unavailable" }] });
    const page = await f.service.read(readRequest);
    expect(page).toMatchObject({ ...readPage, freshness: { state: "ready", indexing: true, lastSucceededAt: 123,
      errorCode: "search_scope_unavailable", errorCount: 1 } });
    expect(f.reads.read).toHaveBeenCalledWith({ workspaceId: "one", sourceRevision: workspaceSourceRevision(registration, "/synthetic/agent") },
      readRequest, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(f.queries.search).not.toHaveBeenCalled(); expect(requireUsable).not.toHaveBeenCalled();
    expect(f.indexer.requestRefresh).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(page)).not.toMatch(/private-credential|sourceRevision|sourcePath|synthetic\/sessions|synthetic\/agent/u);
  });

  it("reads cache during a worker/provider outage, preserving unknown startup freshness", async () => {
    const f = fixture(); await ready(f);
    f.indexer.status.mockReturnValue({ ...initialStatus, state: "unavailable", errors: [{ workspaceId: "one", code: "search_embedding_unavailable" }], errorCount: 1 });
    expect(f.service.capability().available).toBe(false);
    const page = await f.service.read(readRequest);
    expect(page.freshness).toEqual({ state: "unavailable", indexing: false, lastSucceededAt: null, errorCode: "search_embedding_unavailable", errorCount: 1 });
    expect(f.queries.search).not.toHaveBeenCalled();
  });

  it("re-resolves changed source revisions and excludes removed registrations on subsequent calls", async () => {
    const f = fixture(); await ready(f); await f.service.read(readRequest);
    const changed = { ...registration, path: "/synthetic/relocated", sessionDirectory: null };
    f.registrations.list.mockReturnValue([changed]);
    await f.service.read(readRequest);
    expect(f.reads.read.mock.calls[1]?.[0]).toEqual({ workspaceId: "one", sourceRevision: workspaceSourceRevision(changed, "/synthetic/agent") });
    expect(f.reads.read.mock.calls[1]?.[0].sourceRevision).not.toBe(f.reads.read.mock.calls[0]?.[0].sourceRevision);
    f.registrations.list.mockReturnValue([]);
    await expect(f.service.read(readRequest)).rejects.toThrow("search_scope_unavailable");
    expect(f.reads.read).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed requests/cursors and unknown scopes before reader IO", async () => {
    const f = fixture(); await ready(f);
    await expect(f.service.read({ ...readRequest, workspaceId: "../invalid" })).rejects.toThrow("search_query_invalid");
    await expect(f.service.read({ ...readRequest, cursor: "@@@" })).rejects.toThrow("conversation_cursor_invalid");
    await expect(f.service.read({ ...readRequest, limit: 21 })).rejects.toThrow("search_query_invalid");
    expect(f.registrations.list).not.toHaveBeenCalled();
    await expect(f.service.read({ ...readRequest, workspaceId: "missing" })).rejects.toThrow("search_scope_unavailable");
    f.registrations.list.mockImplementation(() => { throw new Error("private registration path diagnostic"); });
    await expect(f.service.read(readRequest)).rejects.toThrow("search_scope_unavailable");
    expect(f.reads.read).not.toHaveBeenCalled(); expect(f.service.capability().state).toBe("ready");
  });

  it("captures the validated request before asynchronously dispatching reader IO", async () => {
    const f = fixture(); await ready(f);
    const request = { ...readRequest, aroundEntryId: "entry-0", limit: 1 };
    const pending = f.service.read(request); request.workspaceId = "other"; request.aroundEntryId = "other-entry"; request.limit = 20;
    await pending;
    expect(f.reads.read.mock.calls[0]?.[1]).toEqual({ ...readRequest, aroundEntryId: "entry-0", limit: 1 });
    expect(Object.isFrozen(f.reads.read.mock.calls[0]?.[1])).toBe(true);
  });

  it.each(["conversation_not_indexed", "conversation_entry_not_indexed", "conversation_cursor_invalid", "conversation_cursor_stale", "conversation_cache_invalid"] as const)("preserves %s without marking the search service unavailable", async (code) => {
    const f = fixture(); await ready(f); const error = new ConversationReadError(code); f.reads.read.mockRejectedValueOnce(error);
    await expect(f.service.read(readRequest)).rejects.toBe(error);
    expect(f.service.freshness()).toMatchObject({ state: "ready", errorCode: null });
    await expect(f.service.read(readRequest)).resolves.toHaveProperty("cached", true);
  });

  it("masks dependency failures, records database unavailability, and recovers with a subsequent cached read", async () => {
    const f = fixture(); await ready(f); f.reads.read.mockRejectedValueOnce(new Error("SQL source paths private credentials"));
    await expect(f.service.read(readRequest)).rejects.toEqual(new SearchQueryError("search_database_unavailable"));
    expect(f.service.freshness()).toMatchObject({ state: "unavailable", errorCode: "search_database_unavailable", errorCount: 1 });
    const page = await f.service.read(readRequest);
    expect(page.freshness).toMatchObject({ state: "ready", errorCode: null, errorCount: 0 });
    expect(f.factory).toHaveBeenCalledTimes(1);
    await expect(f.service.search({ query: "Independent chat search" })).resolves.toHaveProperty("cached", true);
  });

  it.each(["search_busy", "search_timeout", "search_cancelled"] as const)("preserves native %s without presenting an empty successful page", async (code) => {
    const f = fixture(); await ready(f); f.reads.read.mockRejectedValueOnce(new SearchRepositoryError(code));
    await expect(f.service.read(readRequest)).rejects.toEqual(new SearchQueryError(code));
    expect(f.service.freshness()).toMatchObject({ state: "ready", errorCode: null });
  });

  it("admits exactly two reads, rejects excess work without queueing, and leaves ordinary search independent", async () => {
    const f = fixture(); await ready(f); let release!: (value: typeof readPage) => void;
    const stalled = new Promise<typeof readPage>((resolve) => { release = resolve; }); f.reads.read.mockReturnValue(stalled);
    const first = f.service.read(readRequest); const second = f.service.read(readRequest);
    await expect(f.service.read(readRequest)).rejects.toThrow("search_busy");
    expect(f.reads.read).toHaveBeenCalledTimes(2);
    await expect(f.service.search({ query: "Independent search admission" })).resolves.toHaveProperty("cached", true);
    release(readPage); await Promise.all([first, second]);
    f.reads.read.mockResolvedValue(readPage);
    await expect(f.service.read(readRequest)).resolves.toHaveProperty("cached", true);
  });

  it("handles pre-aborted calls without IO and cancels a non-cooperative reader immediately", async () => {
    const f = fixture(); await ready(f);
    await expect(f.service.read(readRequest, { signal: AbortSignal.abort() })).rejects.toThrow("search_cancelled");
    expect(f.reads.read).not.toHaveBeenCalled(); expect(f.registrations.list).not.toHaveBeenCalled();
    f.reads.read.mockReturnValueOnce(new Promise(() => {})); const controller = new AbortController();
    const pending = expect(f.service.read(readRequest, { signal: controller.signal })).rejects.toThrow("search_cancelled");
    await vi.waitFor(() => expect(f.reads.read).toHaveBeenCalled()); controller.abort();
    expect(f.reads.read.mock.calls[0]?.[2]?.signal?.aborted).toBe(true); await pending;
    await expect(f.service.read(readRequest)).resolves.toHaveProperty("cached", true);
  });

  it("never dispatches reader IO after an abort in the same turn", async () => {
    const f = fixture(); await ready(f); const controller = new AbortController();
    const pending = expect(f.service.read(readRequest, { signal: controller.signal })).rejects.toThrow("search_cancelled");
    controller.abort(); await pending; expect(f.reads.read).not.toHaveBeenCalled();
  });

  it("bounds a stalled injected reader to the fixed aggregate deadline and ignores its late result", async () => {
    vi.useFakeTimers(); const f = fixture(); f.service.start(); await vi.advanceTimersByTimeAsync(0);
    let resolve!: (value: typeof readPage) => void;
    f.reads.read.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    let settled = false;
    const pending = expect(f.service.read(readRequest).finally(() => { settled = true; })).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(MAX_CONVERSATION_READ_TIMEOUT_MS - 1); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await pending;
    expect(f.reads.read.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    f.queries.search.mockRejectedValueOnce(new SearchQueryError("search_database_unavailable"));
    await expect(f.service.search({ query: "Record a later outage" })).rejects.toThrow("search_database_unavailable");
    resolve(readPage); await vi.advanceTimersByTimeAsync(0);
    expect(f.service.capability().state).toBe("unavailable"); // Late success cannot clear a subsequent failure.
    await expect(f.service.read(readRequest)).resolves.toHaveProperty("freshness.state", "ready");
  });

  it("releases read admission after late dependency rejection without leaking diagnostics or unhandled failures", async () => {
    const f = fixture(); await ready(f); let reject!: (error: Error) => void;
    f.reads.read.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
    const controller = new AbortController();
    const pending = expect(f.service.read(readRequest, { signal: controller.signal })).rejects.toThrow("search_cancelled");
    await vi.waitFor(() => expect(f.reads.read).toHaveBeenCalled()); controller.abort(); await pending;
    reject(new Error("private late diagnostic")); await Promise.resolve(); await Promise.resolve();
    expect(f.service.capability().state).toBe("ready");
    await expect(f.service.read(readRequest)).resolves.toHaveProperty("cached", true);
  });

  it("seals read admission and aborts both calls synchronously, before pool closure can finish", async () => {
    const f = fixture(); await ready(f); let finishClose!: () => void;
    vi.mocked(f.resources.close).mockReturnValueOnce(new Promise((resolve) => { finishClose = resolve; }));
    f.reads.read.mockReturnValue(new Promise(() => {}));
    const first = expect(f.service.read(readRequest)).rejects.toThrow("search_cancelled");
    const second = expect(f.service.read(readRequest)).rejects.toThrow("search_cancelled");
    await vi.waitFor(() => expect(f.reads.read).toHaveBeenCalledTimes(2));
    const closing = f.service.close(); expect(f.service.close()).toBe(closing);
    expect(f.reads.read.mock.calls.every((call) => call[2]?.signal?.aborted)).toBe(true);
    await Promise.all([first, second]);
    await expect(f.service.read(readRequest)).rejects.toThrow("search_cancelled");
    expect(f.reads.read).toHaveBeenCalledTimes(2); finishClose(); await closing;
  });

  it.each([0, -1, 10_001, Infinity, 1.5])("rejects an invalid internal deadline override (%s)", (readTimeoutMs) => {
    expect(() => fixture("disabled", { readTimeoutMs })).toThrow("search_query_invalid");
  });
});
