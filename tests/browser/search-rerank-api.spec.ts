import type { AddressInfo } from "node:net";
import { expect, test, type Page } from "@playwright/test";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/server/config.js";
import { createChatWcaServer, type ChatWcaServer } from "../../src/server/index.js";
import type { ProtocolRegistry, ProtocolHistory, ProtocolWorkspaceRepository } from "../../src/server/protocol.js";
import { SearchQueryService } from "../../src/server/search/query.js";
import { SearchService } from "../../src/server/search/service.js";
import type { SearchIndexerStatus } from "../../src/server/search/indexer.js";
import type { ConversationState, ConversationSummary, WorkspaceSummary } from "../../src/shared/protocol.js";
import { fakeSearchVector } from "../fixtures/search-ollama.js";
import { REPOSITORY_SPACE } from "../fixtures/search-repository.js";
import { searchCandidate } from "../fixtures/search-retrieval.js";

// No browser HTTP mocking/proxy: the built app, HTTP search/config/status routes,
// service/query/reranker, pinned Pi runtime and WebSocket navigation compose on one
// ephemeral loopback server. Only storage, embeddings, history and inference are
// synthetic in-memory boundaries. Never read real auth, sessions or search stores.
const servers: ChatWcaServer[] = [];
const idle: SearchIndexerStatus = { state: "idle", pending: false, workspaceId: null, startedAt: null, completedAt: null, lastSucceededAt: 123,
  progress: { workspaces: 0, discovered: 0, published: 0, unchanged: 0, failed: 0, deleted: 0, removedWorkspaces: 0 }, errorCount: 0, errors: [] };
function workspace(id: string): WorkspaceSummary {
  return { id, name: `Synthetic ${id}`, path: `/synthetic/${id}`, sessionStorage: "workspace", sessionDirectory: `/synthetic/${id}/sessions`,
    securityProfile: "unrestricted", effectiveSecurityProfile: "unrestricted", mounts: [], networkPolicy: "isolated", effectiveNetworkPolicy: null,
    networkPolicySetId: "default", effectiveNetworkPolicySetId: null, networkPolicyIssue: null, enabledHttpTools: [], effectiveHttpTools: [], conversationToolsEnabled: false, effectiveConversationTools: [],
    createdAt: 1, updatedAt: 1, available: true, usable: true, policyIssue: null };
}
async function fixture(page: Page, provider: "openai" | "openai-codex" = "openai", timeout = 2_000) {
  const faux = fauxProvider({ provider, api: provider === "openai" ? "openai-responses" : "openai-codex-responses", tokensPerSecond: 100_000 });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider); await runtime.refresh({ allowNetwork: false }); await runtime.getAvailable();
  const rows = [workspace("one"), workspace("two")];
  const candidates = rows.map((row, i) => searchCandidate(i + 1, { workspaceId: row.id, workspaceName: row.name,
    text: i === 0 ? "Synthetic alpha <script>plain text</script>" : "Synthetic beta", title: i === 0 ? "Alpha conversation" : "Beta conversation" }));
  const states: ConversationState[] = candidates.map((candidate, i) => ({ id: candidate.sessionId, workspaceId: candidate.workspaceId,
    sessionFile: `${rows[i]!.sessionDirectory}/${candidate.sessionId}.jsonl`, title: candidate.title, cwd: rows[i]!.path,
    model: { id: "synthetic", provider: "browser-fixture", name: "Synthetic model", supportsImages: false }, status: "idle",
    createdAt: 1, lastActiveAt: 2, revision: 1, durable: true, contextUsage: null, queue: { steering: [], followUp: [] }, securityProfile: "unrestricted",
    networkPolicy: null, networkPolicySetId: "default", effectiveNetworkPolicySetId: null, effectiveHttpTools: [], effectiveConversationTools: [],
    messages: [{ entryId: candidate.entryId, role: "user", forkEligible: true, timestamp: 1, blocks: [{ type: "text", text: candidate.text }] }] }));
  const unavailable = (): never => { throw new Error("Unsupported synthetic fixture operation"); };
  const requireWorkspace = (id: string) => rows.find((row) => row.id === id) ?? unavailable();
  const requireState = (id: string) => states.find((state) => state.id === id) ?? unavailable();
  const workspaces: ProtocolWorkspaceRepository = {
    list: () => rows, requireAvailable: requireWorkspace,
    requireUsable: (id) => { const row = requireWorkspace(id); return { workspaceId: id, cwd: row.path, sessionDirectory: row.sessionDirectory,
      securityProfile: "unrestricted", networkPolicy: null, networkPolicySetId: "default", effectiveNetworkPolicySetId: null, networkPolicySet: null, effectiveHttpTools: [], effectiveConversationTools: [] }; },
    create: unavailable, update: unavailable, delete: unavailable,
  };
  const opened = new Set<string>();
  const registry: ProtocolRegistry = {
    subscribe: () => () => {}, hasLiveWorkspace: () => false, create: unavailable, rename: unavailable, close: unavailable,
    fork: unavailable, prompt: unavailable, abort: unavailable,
    open: async (_policy, file) => { const id = states.find((state) => state.sessionFile === file)?.id ?? unavailable(); opened.add(id); return { id }; },
    getState: async (id) => requireState(id),
  };
  const summaries: ConversationSummary[] = states.map((state) => ({ id: state.id, workspaceId: state.workspaceId, sessionFile: state.sessionFile,
    title: state.title, cwd: state.cwd, createdAt: 1, modifiedAt: 2, messageCount: 1, status: "closed", runnable: true }));
  const history: ProtocolHistory = { list: async (row) => summaries.filter((summary) => summary.workspaceId === row.id)
    .map((summary) => ({ ...summary, status: opened.has(summary.id) ? "idle" : "closed" })),
    resolve: async (row, id) => { const state = requireState(id); if (state.workspaceId !== row.id) unavailable(); return { summary: { sessionFile: state.sessionFile } }; }, delete: unavailable };
  const config = loadConfig({ CHATWCA_DATA_DIR: "/synthetic/browser-rerank", CHATWCA_SHUTDOWN_GRACE_MS: "100",
    CHATWCA_SEARCH_MODE: "optional", CHATWCA_SEARCH_DATABASE_URL: "postgresql://synthetic:private@127.0.0.1:1/cache",
    CHATWCA_SEARCH_RERANK_TIMEOUT_MS: String(timeout) });
  const registrations = { list: () => rows };
  const search = new SearchService({ config: config.search, registrations, piAgentDirectory: "/synthetic/agent",
    getRerankContext: () => ({ runtime, globalDefaults: { defaultProvider: provider, defaultModel: faux.getModel().id } }),
    createResources: (reranker) => {
      const queries = new SearchQueryService({ registrations, piAgentDirectory: "/synthetic/agent",
        repository: { retrieve: async (request) => {
          const scoped = candidates.filter((candidate) => request.scopes.some((scope) => scope.workspaceId === candidate.workspaceId));
          return { lexical: scoped, vector: request.vector ? scoped : [] };
        } },
        embeddings: { embedSearchQuery: async () => ({ space: REPOSITORY_SPACE, embedding: fakeSearchVector() }) }, ...(reranker ? { reranker } : {}) });
      return { queries, reads: { read: async () => { throw new Error("Unexpected cached read"); } }, indexer: { status: () => idle, requestRefresh: () => {}, close: async () => {} }, checkSchema: async () => {},
        readCounts: async () => ({ documents: 2, chunks: 2 }), close: async () => { queries.close(); } };
    } });
  const server = createChatWcaServer(config, "synthetic-browser", { search, registry, history, workspaces });
  servers.push(server);
  await new Promise<void>((resolve) => server.httpServer.listen(0, "127.0.0.1", resolve));
  search.start(); await expect.poll(() => search.capability().state).toBe("ready");
  const base = `http://127.0.0.1:${(server.httpServer.address() as AddressInfo).port}`;
  await page.goto(base);
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Global Search", exact: true }).click();
  await expect(page.getByText("Local search ready", { exact: true })).toBeVisible();
  return { faux, runtime, base };
}
async function submit(page: Page, query = "synthetic evidence") {
  await page.getByLabel("Query", { exact: true }).fill(query);
  await page.getByLabel("Query", { exact: true }).press("Enter");
}
test.afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.shutdown())); });

for (const provider of ["openai", "openai-codex"] as const) {
  test(`real API/${provider} applies reranking, opts out, filters scope and opens the exact message`, async ({ page }) => {
    const f = await fixture(page, provider);
    f.faux.setResponses([(context) => {
      expect(context.tools).toBeUndefined();
      expect(JSON.parse(context.messages[0]!.content as string)).toEqual({ query: "synthetic evidence", candidates: [
        { id: "c0", role: "user", text: "Synthetic alpha <script>plain text</script>" }, { id: "c1", role: "user", text: "Synthetic beta" },
      ] });
      return fauxAssistantMessage('["c1","c0"]');
    }]);
    const toggle = page.getByRole("checkbox", { name: "Pi reranking", exact: true });
    await expect(toggle).toBeChecked();
    await submit(page);
    const results = page.getByRole("region", { name: "Search results" });
    await expect(results).toContainText("Pi reranking applied");
    await expect(results).toContainText("Local hybrid search");
    await expect(page.locator(".search-result h3")).toHaveText(["Beta conversation", "Alpha conversation"]);
    expect(f.faux.state.callCount).toBe(1);
    await page.getByRole("button", { name: "Open matching message" }).first().click();
    await expect(page.locator('[data-entry-id="entry-2"]')).toBeFocused();
    await expect(page.locator('[data-entry-id="entry-2"]')).toHaveClass(/is-search-match/);
    await page.getByRole("button", { name: "Back to search results" }).click();
    await expect(results).toContainText("Pi reranking applied");
    await toggle.uncheck(); await submit(page);
    await expect(results).toContainText("Local ordering — Pi reranking off");
    await expect(page.locator(".search-result h3")).toHaveText(["Alpha conversation", "Beta conversation"]);
    await expect(results.locator("script")).toHaveCount(0);
    expect(f.faux.state.callCount).toBe(1);
    await page.getByLabel("Workspace", { exact: true }).selectOption("two");
    await toggle.check(); await submit(page);
    await expect(results).toContainText("Local ordering — too few matches to rerank");
    await expect(page.locator(".search-result h3")).toHaveText(["Beta conversation"]);
    expect(f.faux.state.callCount).toBe(1);
  });
}

test("real API malformed ordering, own timeout and unavailable auth visibly retain local results", async ({ page }) => {
  const f = await fixture(page, "openai", 200);
  const results = page.getByRole("region", { name: "Search results" });
  f.faux.setResponses([fauxAssistantMessage("private malformed diagnostic")]);
  await submit(page);
  await expect(results).toContainText("Local fallback — Pi returned an invalid ordering");
  await expect(page.locator(".search-result h3")).toHaveText(["Alpha conversation", "Beta conversation"]);
  await expect(page.getByText("private malformed diagnostic")).toHaveCount(0);
  let signal: AbortSignal | undefined;
  f.faux.setResponses([(_context, options) => { signal = options?.signal; return new Promise(() => {}); }]);
  await submit(page, "timeout evidence");
  await expect(results).toContainText("Local fallback — Pi reranking timed out");
  expect(signal?.aborted).toBe(true);
  // Availability is only a local snapshot. Simulate losing auth without touching
  // auth files; the real request must still return cached local ordering.
  f.runtime.hasConfiguredAuth = () => false;
  await page.reload();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Global Search", exact: true }).click();
  await expect(page.getByText(/Currently unavailable; local results remain usable/)).toBeVisible();
  await submit(page);
  await expect(results).toContainText("Local fallback — Pi reranking is unavailable");
  await expect(page.locator(".search-result h3")).toHaveText(["Alpha conversation", "Beta conversation"]);
  expect(f.faux.state.callCount).toBe(2);
  expect((await page.request.get(`${f.base}/api/health`)).status()).toBe(200);
});

test("real browser cancellation, supersession and navigation abort Pi IO without relabeling retained results", async ({ page }) => {
  const f = await fixture(page);
  f.faux.setResponses([fauxAssistantMessage('["c1","c0"]')]);
  await submit(page, "retained evidence");
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results).toContainText("Pi reranking applied");
  const signals: (AbortSignal | undefined)[] = [];
  const replies: ((message: ReturnType<typeof fauxAssistantMessage>) => void)[] = [];
  const blocked = (_context: unknown, options: { signal?: AbortSignal } | undefined) => {
    signals.push(options?.signal);
    return new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => replies.push(resolve));
  };
  f.faux.setResponses([blocked, blocked, blocked]);
  await submit(page, "cancel evidence");
  await expect.poll(() => signals.length).toBe(1);
  await page.getByRole("button", { name: "Cancel search" }).click();
  await expect.poll(() => signals[0]?.aborted).toBe(true);
  await submit(page, "superseded evidence");
  await expect.poll(() => signals.length).toBe(2);
  await page.getByRole("checkbox", { name: "Pi reranking", exact: true }).uncheck();
  await submit(page, "local evidence");
  await expect.poll(() => signals[1]?.aborted).toBe(true);
  await expect(results).toContainText("Local ordering — Pi reranking off");
  await page.getByRole("checkbox", { name: "Pi reranking", exact: true }).check();
  await submit(page, "navigation evidence");
  await expect.poll(() => signals.length).toBe(3);
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await expect.poll(() => signals[2]?.aborted).toBe(true);
  for (const reply of replies) reply(fauxAssistantMessage('["c1","c0"]'));
  await page.getByRole("button", { name: "Global Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Results for “local evidence”" })).toBeVisible();
  await expect(results).toContainText("Local ordering — Pi reranking off");
  await expect(page.getByRole("checkbox", { name: "Pi reranking", exact: true })).toBeChecked();
  expect(f.faux.state.callCount).toBe(4);
});
