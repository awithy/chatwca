import type { AddressInfo } from "node:net";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/server/config.js";
import { createChatWcaServer, type ChatWcaProtocolServices, type ChatWcaServer } from "../../src/server/index.js";
import { SearchQueryService } from "../../src/server/search/query.js";
import { SearchService } from "../../src/server/search/service.js";
import type { SearchIndexerStatus } from "../../src/server/search/indexer.js";
import { fakeSearchVector } from "../fixtures/search-ollama.js";
import { REPOSITORY_SPACE } from "../fixtures/search-repository.js";
import { searchCandidate } from "../fixtures/search-retrieval.js";

// Real HTTP/service/query/adapter and pinned ModelRuntime; synthetic retrieval,
// in-memory auth and faux inference only. No PG, history, shared Ollama or paid IO.
const servers: ChatWcaServer[] = [];
const idle: SearchIndexerStatus = { state: "idle", pending: false, workspaceId: null, startedAt: null, completedAt: null, lastSucceededAt: 123,
  progress: { workspaces: 0, discovered: 0, published: 0, unchanged: 0, failed: 0, deleted: 0, removedWorkspaces: 0 }, errorCount: 0, errors: [] };
async function fixture(provider: "openai" | "openai-codex" = "openai", rerankTimeoutMs = 1000) {
  const faux = fauxProvider({ provider, api: provider === "openai" ? "openai-responses" : "openai-codex-responses", tokensPerSecond: 100_000 });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false }); await runtime.getAvailable();
  const config = loadConfig({ CHATWCA_DATA_DIR: "/tmp/synthetic-rerank-api", CHATWCA_SHUTDOWN_GRACE_MS: "100",
    CHATWCA_SEARCH_MODE: "optional", CHATWCA_SEARCH_DATABASE_URL: "postgresql://synthetic:private@127.0.0.1:1/cache",
    CHATWCA_SEARCH_RERANK_TIMEOUT_MS: String(rerankTimeoutMs) });
  const registrations = { list: () => [{ id: "one", name: "Synthetic", path: "/synthetic/workspace", sessionDirectory: "/synthetic/sessions" }] };
  const a = searchCandidate(1, { workspaceId: "one", text: "Synthetic alpha" });
  const b = searchCandidate(2, { workspaceId: "one", text: "Synthetic beta", role: "assistant" });
  const repository = { retrieve: vi.fn(async () => ({ lexical: [a, b], vector: [] })) };
  const getRerankContext = vi.fn(() => ({ runtime, globalDefaults: { defaultProvider: provider, defaultModel: faux.getModel().id } }));
  const search = new SearchService({ config: config.search, registrations, piAgentDirectory: "/synthetic/agent", getRerankContext,
    createResources: (reranker) => {
      const queries = new SearchQueryService({ repository, registrations, piAgentDirectory: "/synthetic/agent",
        embeddings: { embedSearchQuery: async () => ({ space: REPOSITORY_SPACE, embedding: fakeSearchVector() }) },
        ...(reranker ? { reranker } : {}) });
      return { queries, indexer: { status: () => idle, requestRefresh: () => {}, close: async () => {} }, checkSchema: async () => {},
        readCounts: async () => ({ documents: 2, chunks: 2 }), close: async () => { queries.close(); } };
    } });
  const server = createChatWcaServer(config, "synthetic-test", { search, registry: { subscribe: () => () => {} }, history: {}, workspaces: {} } as unknown as ChatWcaProtocolServices);
  servers.push(server);
  expect(getRerankContext).not.toHaveBeenCalled();
  await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  search.start(); await vi.waitFor(() => expect(search.capability().state).toBe("ready"));
  const base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  const post = (body: object, signal?: AbortSignal) => fetch(`${base}/api/search`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
  return { faux, runtime, repository, server, search, base, post, getRerankContext };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.shutdown())); });

describe("synthetic Pi reranking HTTP composition", () => {
  it.each(["openai", "openai-codex"] as const)("defaults on with %s, advertises safe capability and honors explicit opt-out", async (provider) => {
    const f = await fixture(provider);
    f.faux.setResponses([(context) => {
      expect(JSON.parse(context.messages[0]!.content as string)).toEqual({ query: "evidence", candidates: [
        { id: "c0", role: "user", text: "Synthetic alpha" }, { id: "c1", role: "assistant", text: "Synthetic beta" },
      ] });
      return fauxAssistantMessage('["c1","c0"]');
    }]);
    const capability = (await (await fetch(`${f.base}/api/config`)).json()).search;
    expect(capability).toEqual({ mode: "optional", state: "ready", available: true, rerankAvailable: true });
    const result = await (await f.post({ query: "evidence", limit: 1 })).json();
    expect(result.rerank).toEqual({ requested: true, applied: true, reason: "applied" });
    expect(result.results.map((g: { sessionId: string }) => g.sessionId)).toEqual(["session-2"]);
    const local = await (await f.post({ query: "evidence", rerank: false })).json();
    expect(local.rerank).toEqual({ requested: false, applied: false, reason: "not_requested" });
    expect(local.results.map((g: { sessionId: string }) => g.sessionId)).toEqual(["session-1", "session-2"]);
    expect(f.faux.state.callCount).toBe(1); expect(f.getRerankContext).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result) + JSON.stringify(capability)).not.toMatch(/sourceRevision|chunkId|private|defaultProvider|defaultModel|apiKey/u);
  });
  it("invalid completion and lost auth preserve local results and do not fail chat health", async () => {
    const f = await fixture(); f.faux.setResponses([fauxAssistantMessage('private malformed response')]);
    const result = await (await f.post({ query: "evidence", rerank: true })).json();
    expect(result.rerank).toEqual({ requested: true, applied: false, reason: "invalid_response" });
    expect(result.results[0].sessionId).toBe("session-1"); expect(JSON.stringify(result)).not.toContain("private");
    const auth = vi.spyOn(f.runtime, "hasConfiguredAuth").mockReturnValue(false);
    try {
      expect((await (await fetch(`${f.base}/api/config`)).json()).search.rerankAvailable).toBe(false);
      const unavailable = await (await f.post({ query: "evidence" })).json();
      expect(unavailable.rerank).toEqual({ requested: true, applied: false, reason: "unavailable" });
      expect(unavailable.results[0].sessionId).toBe("session-1"); expect(f.faux.state.callCount).toBe(1);
      expect((await fetch(`${f.base}/api/health`)).status).toBe(200);
    } finally { auth.mockRestore(); }
  });
  it("own rerank timeout remains a successful local response", async () => {
    const f = await fixture("openai", 50); let signal: AbortSignal | undefined;
    f.faux.setResponses([(_context, options) => { signal = options?.signal; return new Promise(() => {}); }]);
    const response = await f.post({ query: "evidence" }); expect(response.status).toBe(200);
    const result = await response.json(); expect(result.rerank).toEqual({ requested: true, applied: false, reason: "timeout" });
    expect(result.results[0].sessionId).toBe("session-1"); expect(signal?.aborted).toBe(true); expect(f.faux.state.callCount).toBe(1);
  });
  it("disconnect and server shutdown cancel actual Pi completions, not successful fallback", async () => {
    const f = await fixture(); const signals: (AbortSignal | undefined)[] = [];
    const blocked = (_context: unknown, options: { signal?: AbortSignal } | undefined) => { signals.push(options?.signal); return new Promise<ReturnType<typeof fauxAssistantMessage>>(() => {}); };
    f.faux.setResponses([blocked, blocked]);
    const controller = new AbortController(); const first = f.post({ query: "first" }, controller.signal).catch(() => null);
    await vi.waitFor(() => expect(signals).toHaveLength(1)); controller.abort(); await first;
    await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
    const second = f.post({ query: "second" }).catch(() => null);
    await vi.waitFor(() => expect(signals).toHaveLength(2));
    const closing = f.server.shutdown(); expect(signals[1]?.aborted).toBe(true); expect(f.search.capability().rerankAvailable).toBe(false);
    const response = await second;
    if (response) { expect(response.status).toBe(503); expect((await response.json()).error.code).toBe("search_cancelled"); }
    await closing; expect(f.faux.state.callCount).toBe(2);
  });
});
