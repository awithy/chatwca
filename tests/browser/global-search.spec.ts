import { expect, test, type Page } from "@playwright/test";
import type { SearchResponse, SearchStatus } from "../../src/shared/search.js";

const now = 1_790_870_400_000;
function status(overrides: Partial<SearchStatus> = {}): SearchStatus {
  return { mode: "optional", state: "ready", available: true, indexing: false, lastSucceededAt: now,
    errorCode: null, errorCount: 0, counts: { documents: 2, chunks: 4 }, indexer: null, ...overrides };
}
function response(text = "<script>alert('not html')</script>\n**plain text**", sessionId = "browser-rich-conversation", entryId = "rich-user-1"): SearchResponse {
  return { cached: true, mode: "lexical", warnings: ["search_embedding_unavailable"], freshness: status(),
    rerank: { requested: true, applied: false, reason: "unavailable" },
    results: [{ workspaceId: "browser-workspace", workspaceName: "Browser workspace", sessionId, title: "Synthetic search title", modifiedAt: now,
      excerpts: [{ entryId, text, role: "user", timestamp: now, indexedAt: now, truncated: false }] }] };
}
async function enable(page: Page, readStatus: () => SearchStatus = () => status(), rerankAvailable = false): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const actual = await route.fetch();
    const config = await actual.json() as Record<string, unknown>;
    await route.fulfill({ json: { ...config, search: { mode: "optional", state: "initializing", available: false, rerankAvailable } } });
  });
  await page.route("**/api/search/status", (route) => route.fulfill({ json: readStatus() }));
}
async function openSearch(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Global Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Global Search", exact: true })).toBeVisible();
}
async function submit(page: Page, query = "fixture query"): Promise<void> {
  await page.getByLabel("Query", { exact: true }).fill(query);
  await page.getByLabel("Query", { exact: true }).press("Enter");
}

test("disabled configuration hides search without probing its endpoints", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/search")) requests.push(request.url()); });
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Global Search", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scheduled jobs" })).toBeVisible();
  expect(requests).toEqual([]);
});

test("polls through initialization and permits cached queries during worker failure", async ({ page }) => {
  let polls = 0;
  await enable(page, () => ++polls === 1 ? status({ state: "initializing", available: false, counts: null, lastSucceededAt: null }) : status({ state: "unavailable", available: false, errorCount: 1, errorCode: "search_scope_unavailable" }));
  await page.route("**/api/search", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ query: "fixture query", workspaceId: null, rerank: true });
    await route.fulfill({ json: response() });
  });
  await openSearch(page);
  await expect(page.getByText("Search initializing…", { exact: true })).toBeVisible();
  await expect(page.getByText("Search unavailable — cached queries may still work")).toBeVisible({ timeout: 8_000 });
  await submit(page);
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results.getByRole("heading", { name: "Synthetic search title" })).toBeVisible();
  await expect(results).toContainText("Lexical search only");
  await expect(results).toContainText("Semantic search unavailable");
  await expect(results.locator(".search-excerpt-text")).toHaveText("<script>alert('not html')</script>\n**plain text**");
  await expect(results.locator("script, strong")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Pi reranking", exact: true })).toBeChecked();
  await expect(page.getByText(/Currently unavailable; local results remain usable/)).toBeVisible();
  await expect(results).toContainText("Local fallback — Pi reranking is unavailable");
  await expect(page.getByRole("region", { name: "Search index status" })).toContainText("2 conversations · 4 chunks");
});

test("reranking defaults on, honors opt-out, and retains only App-memory selection", async ({ page }) => {
  await enable(page, () => status(), true);
  const flags: boolean[] = [];
  await page.route("**/api/search", async (route) => {
    const { rerank } = route.request().postDataJSON() as { rerank: boolean };
    flags.push(rerank);
    await route.fulfill({ json: { ...response("reranked result"), rerank: rerank
      ? { requested: true, applied: true, reason: "applied" }
      : { requested: false, applied: false, reason: "not_requested" } } });
  });
  await openSearch(page);
  const toggle = page.getByRole("checkbox", { name: "Pi reranking", exact: true });
  await expect(toggle).toBeChecked();
  await expect(page.getByText("When on, sends the query and selected excerpts to the configured Pi provider.")).toBeVisible();
  await submit(page);
  const results = page.getByRole("region", { name: "Search results" });
  await expect(results).toContainText("Pi reranking applied");
  await toggle.uncheck();
  // Changing the next request's preference must not relabel previous results.
  await expect(results).toContainText("Pi reranking applied");
  await submit(page);
  await expect(results).toContainText("Local ordering — Pi reranking off");
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("button", { name: "Global Search", exact: true }).click();
  await expect(toggle).not.toBeChecked();
  await expect(results).toContainText("Local ordering — Pi reranking off");
  await submit(page);
  expect(flags).toEqual([true, false, false]);
  await page.reload();
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Global Search", exact: true }).click();
  await expect(toggle).toBeChecked();
  await expect(results).toHaveCount(0);
});

test("safe fallback reasons retain results and an unavailable capability does not gate opt-out", async ({ page }) => {
  await enable(page);
  let reason = "timeout";
  await page.route("**/api/search", async (route) => {
    const { rerank } = route.request().postDataJSON() as { rerank: boolean };
    await route.fulfill({ json: { ...response("local fallback result"), rerank: { requested: rerank, applied: false, reason: rerank ? reason : "not_requested" } } });
  });
  await openSearch(page);
  const results = page.getByRole("region", { name: "Search results" });
  for (const [code, label] of [
    ["timeout", "Pi reranking timed out"],
    ["invalid_response", "Pi returned an invalid ordering"],
    ["unsupported_model", "configured model is unsupported"],
    ["input_limit", "excerpts exceed reranking limits"],
    ["unavailable", "Pi reranking is unavailable"],
    ["private diagnostic <script>", "Pi reranking was not applied"],
  ]) {
    reason = code!;
    await submit(page, code!);
    await expect(results.getByRole("status").first()).toHaveText(`Local fallback — ${label}`);
    await expect(results.getByText("local fallback result", { exact: true })).toBeVisible();
  }
  await expect(results.getByRole("status").first()).not.toContainText("private diagnostic");
  reason = "too_few_candidates";
  await submit(page);
  await expect(results).toContainText("Local ordering — too few matches to rerank");
  await page.getByRole("checkbox", { name: "Pi reranking", exact: true }).uncheck();
  await submit(page);
  await expect(results).toContainText("Local ordering — Pi reranking off");
});

test("scopes refresh/rebuild, confirms rebuild, and retains query/results across navigation", async ({ page }) => {
  await enable(page);
  const actions: Array<{ path: string; workspaceId: string | null }> = [];
  await page.route("**/api/search/*", async (route) => {
    if (route.request().url().endsWith("/status")) { await route.fallback(); return; }
    const input = route.request().postDataJSON() as { workspaceId: string | null };
    actions.push({ path: new URL(route.request().url()).pathname, workspaceId: input.workspaceId });
    await route.fulfill({ status: 202, json: { accepted: true } });
  });
  await page.route("**/api/search", async (route) => {
    expect(route.request().postDataJSON()).toMatchObject({ workspaceId: "browser-workspace" });
    await route.fulfill({ json: response("retained result") });
  });
  await openSearch(page);
  await page.getByLabel("Workspace", { exact: true }).selectOption("browser-workspace");
  await submit(page, "retained query");
  await expect(page.getByText("retained result", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh index" }).click();
  await expect(page.getByText(/Refresh queued/)).toBeVisible();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Rebuild index" }).click();
  expect(actions).toHaveLength(1);
  page.once("dialog", async (dialog) => { expect(dialog.message()).toContain("Browser workspace"); await dialog.accept(); });
  await page.getByRole("button", { name: "Rebuild index" }).click();
  await expect(page.getByText(/Rebuild queued/)).toBeVisible();
  expect(actions).toEqual([{ path: "/api/search/refresh", workspaceId: "browser-workspace" }, { path: "/api/search/rebuild", workspaceId: "browser-workspace" }]);
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("button", { name: "Global Search", exact: true }).click();
  await expect(page.getByLabel("Query", { exact: true })).toHaveValue("retained query");
  await expect(page.getByLabel("Workspace", { exact: true })).toHaveValue("browser-workspace");
  await expect(page.getByText("retained result", { exact: true })).toBeVisible();
});

test("superseded, cancelled, and navigated-away searches cannot overwrite retained results", async ({ page }) => {
  await enable(page);
  const pending: Array<import("@playwright/test").Route> = [];
  await page.route("**/api/search", async (route) => {
    const input = route.request().postDataJSON() as { query: string };
    if (input.query === "latest") await route.fulfill({ json: response("latest result") });
    else pending.push(route);
  });
  await openSearch(page);
  await submit(page, "old");
  await expect.poll(() => pending.length).toBe(1);
  await submit(page, "latest");
  await expect(page.getByText("latest result", { exact: true })).toBeVisible();
  await pending[0]!.fulfill({ json: response("obsolete result") }).catch(() => undefined);
  await submit(page, "cancel me");
  await expect.poll(() => pending.length).toBe(2);
  await page.getByRole("button", { name: "Cancel search" }).click();
  await expect(page.getByRole("button", { name: "Cancel search" })).toHaveCount(0);
  await pending[1]!.fulfill({ json: response("cancelled result") }).catch(() => undefined);
  await submit(page, "leave me");
  await expect.poll(() => pending.length).toBe(3);
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await pending[2]!.fulfill({ json: response("navigated result") }).catch(() => undefined);
  await page.getByRole("button", { name: "Global Search", exact: true }).click();
  await expect(page.getByText("latest result", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Results for “latest”" })).toBeVisible();
  await expect(page.getByText(/obsolete result|cancelled result|navigated result/)).toHaveCount(0);
});

test("opens the matching entry, returns to results, and handles missing messages and sessions", async ({ page }) => {
  await enable(page);
  let match = response("focus this message");
  await page.route("**/api/search", (route) => route.fulfill({ json: match }));
  await openSearch(page);
  await submit(page);
  await page.getByRole("button", { name: "Open matching message" }).click();
  const message = page.locator('[data-entry-id="rich-user-1"]');
  await expect(message).toBeFocused();
  await expect(message).toHaveClass(/is-search-match/);
  await expect(page.getByText("Opened a cached search match.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back to search results" }).click();
  await expect(page.getByText("focus this message", { exact: true })).toBeVisible();
  match = response("missing entry", "browser-rich-conversation", "not-on-saved-branch");
  await submit(page);
  await page.getByRole("button", { name: "Open matching message" }).click();
  await expect(page.getByText(/This cached message is no longer on the saved branch/)).toBeVisible();
  await expect(page.locator(".is-search-match")).toHaveCount(0);
  await page.getByRole("button", { name: "Back to search results" }).click();
  match = response("missing session", "deleted-search-session");
  await submit(page);
  await page.getByRole("button", { name: "Open matching message" }).click();
  await expect(page.getByRole("alert")).toContainText("Conversation unavailable. This cached result may be stale or deleted.");
  await expect(page.getByRole("heading", { name: "Global Search", exact: true })).toBeVisible();
});

test("mobile navigation reaches search from conversations and jobs without horizontal overflow", async ({ page }) => {
  await enable(page);
  await page.route("**/api/search", (route) => route.fulfill({ json: response("unbroken".repeat(150)) }));
  await page.setViewportSize({ width: 390, height: 760 });
  await page.goto("/");
  await expect(page.getByText("Connected", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open workspaces and conversations" }).click();
  await page.getByRole("navigation", { name: "Mobile application sections" }).getByRole("button", { name: "Global Search" }).click();
  await expect(page.getByRole("heading", { name: "Global Search", exact: true })).toBeVisible();
  await submit(page);
  await expect(page.getByRole("heading", { name: "Synthetic search title" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("navigation", { name: "Mobile application sections" }).getByRole("button", { name: "Jobs" }).click();
  await page.getByRole("button", { name: "Open application navigation" }).click();
  await page.getByRole("navigation", { name: "Mobile application sections" }).getByRole("button", { name: "Global Search" }).click();
  await expect(page.getByRole("heading", { name: "Global Search", exact: true })).toBeVisible();
});

test("safe errors and status outages leave cached results and search admission usable", async ({ page }) => {
  await enable(page);
  let fail = false;
  await page.route("**/api/search", (route) => route.fulfill(fail
    ? { status: 503, json: { error: { code: "unknown", message: "private provider diagnostic" } } }
    : { json: response("cached before outage") }));
  await openSearch(page);
  await submit(page);
  await expect(page.getByText("cached before outage", { exact: true })).toBeVisible();
  fail = true;
  await submit(page);
  await expect(page.getByRole("alert")).toHaveText("Search is unavailable. Conversations and jobs are unaffected.");
  await expect(page.getByText("cached before outage", { exact: true })).toBeVisible();
  await expect(page.getByText("private provider diagnostic")).toHaveCount(0);
  await page.route("**/api/search/status", (route) => route.fulfill({ status: 503, json: { error: { code: "search_database_unavailable" } } }));
  await page.getByRole("button", { name: "Jobs", exact: true }).click();
  await page.getByRole("button", { name: "Global Search", exact: true }).click();
  await expect(page.getByText("Freshness status is unavailable. You can still try cached search.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeEnabled();
  await page.getByLabel("Query", { exact: true }).fill("x".repeat(2_049));
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("at most 2,048 characters");
});

test("renders conversation groups and handles empty local hybrid results", async ({ page }) => {
  await enable(page);
  const first = response("first excerpt");
  const group = first.results[0]!;
  let next: SearchResponse = { ...first, mode: "hybrid", warnings: [], results: [
    { ...group, excerpts: [...group.excerpts, { ...group.excerpts[0]!, entryId: "rich-assistant-1", role: "assistant", text: "second excerpt", truncated: true }] },
    { ...group, sessionId: "another-synthetic-session", title: "Another conversation", excerpts: [{ ...group.excerpts[0]!, text: "third excerpt" }] },
  ] };
  await page.route("**/api/search", (route) => route.fulfill({ json: next }));
  await openSearch(page);
  await submit(page);
  await expect(page.locator(".search-result")).toHaveCount(2);
  await expect(page.locator(".search-result").first().locator(".search-excerpt")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Open matching message" })).toHaveCount(3);
  await expect(page.getByLabel("Excerpt truncated")).toBeVisible();
  await expect(page.getByRole("region", { name: "Search results" })).toContainText("Local hybrid search");
  next = { ...next, results: [] };
  await submit(page, "no match");
  await expect(page.getByText(/No matching saved conversations/)).toBeVisible();
  await expect(page.locator(".search-result")).toHaveCount(0);
});
