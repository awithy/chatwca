import { describe, expect, it, vi } from "vitest";

import {
  WEB_SEARCH_TOOL_NAME,
  createWebSearchTool,
  loadWebSearchConfig,
} from "../../src/server/web-search.js";

function responseFor(query: string): Response {
  return Response.json({
    web: {
      results: [{
        title: `Title for ${query}`,
        url: `https://example.com/${encodeURIComponent(query)}`,
        age: "2 hours ago",
        description: `Snippet for ${query}`,
      }],
    },
  });
}

describe("Brave web_search tool", () => {
  it("is disabled without a key and keeps configuration server-side", () => {
    expect(loadWebSearchConfig({})).toEqual({ apiKey: null, timeoutMs: 10_000 });
    expect(() => loadWebSearchConfig({ BRAVE_SEARCH_API_KEY: " " })).toThrow(
      /BRAVE_SEARCH_API_KEY must not be empty/,
    );
  });

  it("searches one or several queries through the fixed Brave endpoint", async () => {
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://api.search.brave.com");
      expect(url.pathname).toBe("/res/v1/web/search");
      expect(url.searchParams.get("count")).toBe("3");
      expect(new Headers(init?.headers).get("X-Subscription-Token")).toBe("server-secret");
      expect(init?.redirect).toBe("error");
      return responseFor(url.searchParams.get("q")!);
    });
    const tool = createWebSearchTool({
      apiKey: "server-secret",
      timeoutMs: 1_000,
      fetch: fetch as typeof globalThis.fetch,
    });

    expect(tool.name).toBe(WEB_SEARCH_TOOL_NAME);
    expect(tool).not.toHaveProperty("renderCall");
    const result = await tool.execute(
      "search-1",
      { queries: ["first query", "second query"], count: 3 },
      undefined,
      undefined,
      {} as never,
    );

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(
      /Results for: first query[\s\S]*Title for first query[\s\S]*Results for: second query/,
    ) }]);
    expect(result.details).toEqual({ queryCount: 2 });
  });

  it("rejects ambiguous input and redacts transport failures", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("request included server-secret");
    });
    const tool = createWebSearchTool({
      apiKey: "server-secret",
      timeoutMs: 1_000,
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(tool.execute(
      "ambiguous",
      { query: "one", queries: ["two"] },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("Provide exactly one of query or queries");
    await expect(tool.execute(
      "failed",
      { query: "one" },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow(/^Web search failed$/);
  });

  it("reports HTTP status without exposing the response body", async () => {
    const fetch = vi.fn(async () => new Response("credential detail", { status: 401 }));
    const tool = createWebSearchTool({
      apiKey: "server-secret",
      timeoutMs: 1_000,
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(tool.execute(
      "http-error",
      { query: "one" },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("Brave Search request failed with HTTP 401");
  });
});
