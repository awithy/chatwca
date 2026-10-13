import { validateToolArguments } from "@earendil-works/pi-ai";
import { convertResponsesTools } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { describe, expect, it, vi } from "vitest";

import {
  WEB_SEARCH_TOOL_NAME,
  MAX_WEB_SEARCH_QUERIES,
  MAX_WEB_SEARCH_QUERY_LENGTH,
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

  it("declares only the required queries array, with clear single-search guidance", () => {
    const tool = createWebSearchTool({ apiKey: "server-secret", timeoutMs: 1_000 });
    expect(Object.keys(tool.parameters.properties)).toEqual(["queries", "count"]);
    expect(tool.parameters.required).toEqual(["queries"]);
    expect(tool.description).toContain('{"queries":["OpenAI official website"],"count":3}');
    expect(tool.promptGuidelines?.join(" ")).toContain("one-item array");
    expect(tool.parameters.properties.queries.description).toContain("Never include dummy or placeholder strings");
  });

  it("sends a required queries array and nullable count through the Codex tool converter", () => {
    const tool = createWebSearchTool({ apiKey: "server-secret", timeoutMs: 1_000 });
    // Codex defaults to strict: null; the tool must opt in so Pi, rather than the
    // remote API, converts optional properties to required nullable properties.
    const [converted] = convertResponsesTools([tool], { strict: null });
    expect(converted).toMatchObject({
      type: "function",
      strict: true,
      parameters: {
        additionalProperties: false,
        required: ["queries", "count"],
        properties: {
          queries: { type: "array", minItems: 1, maxItems: MAX_WEB_SEARCH_QUERIES },
          count: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
      },
    });
    expect(converted).not.toHaveProperty("parameters.properties.query");
    // Ordinary callers can still omit count, but never queries.
    expect(tool.parameters.required).toEqual(["queries"]);
    expect(convertResponsesTools([tool], { strict: null, supportsStrictMode: false })[0])
      .toMatchObject({ parameters: tool.parameters });
  });

  it.each([
    { queries: ["OpenAI official website"], count: 3 },
    { queries: ["OpenAI official website"], count: null },
    { queries: ["OpenAI official website", "second query"], count: null },
  ])("validates and executes single and batched searches (%j)", async (input) => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      return responseFor(url.searchParams.get("q")!);
    });
    const tool = createWebSearchTool({ apiKey: "server-secret", timeoutMs: 1_000, fetch });
    const args = validateToolArguments(tool, {
      type: "toolCall", id: "strict-search", name: tool.name, arguments: input,
    });
    expect(args.queries).toEqual(input.queries);
    if (input.count === null) expect(args).not.toHaveProperty("count");
    const result = await tool.execute("strict-search", args, undefined, undefined, {} as never);
    expect(result.details).toEqual({ queryCount: input.queries.length });
    expect(fetch).toHaveBeenCalledTimes(input.queries.length);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("q")))
      .toEqual(input.queries);
    for (const [url] of fetch.mock.calls) {
      expect(new URL(String(url)).searchParams.get("count")).toBe(String(input.count ?? 10));
    }
  });

  it.each([
    {},
    { query: "OpenAI official website" },
    { query: "OpenAI official website", queries: ["x"], count: 3 },
    { query: "OpenAI official website", queries: ["OpenAI official website"], count: 3 },
    { queries: null },
    { queries: [] },
    { queries: [""] },
    { queries: ["x".repeat(MAX_WEB_SEARCH_QUERY_LENGTH + 1)] },
    { queries: Array.from({ length: MAX_WEB_SEARCH_QUERIES + 1 }, () => "search") },
    { queries: ["search"], count: 0 },
    { queries: ["search"], count: 21 },
  ])("rejects legacy, ambiguous, missing, and out-of-bounds arguments (%j)", (input) => {
    const tool = createWebSearchTool({ apiKey: "server-secret", timeoutMs: 1_000 });
    expect(() => validateToolArguments(tool, {
      type: "toolCall", id: "invalid-search", name: tool.name, arguments: input,
    })).toThrow("Validation failed");
  });

  it("rejects whitespace-only queries before network IO", async () => {
    const fetch = vi.fn();
    const tool = createWebSearchTool({ apiKey: "server-secret", timeoutMs: 1_000, fetch });
    await expect(tool.execute(
      "blank", { queries: ["  "] }, undefined, undefined, {} as never,
    )).rejects.toThrow("Use a one-item array for a single search");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("redacts transport failures", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("request included server-secret");
    });
    const tool = createWebSearchTool({
      apiKey: "server-secret",
      timeoutMs: 1_000,
      fetch: fetch as typeof globalThis.fetch,
    });

    await expect(tool.execute(
      "failed",
      { queries: ["one"] },
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
      { queries: ["one"] },
      undefined,
      undefined,
      {} as never,
    )).rejects.toThrow("Brave Search request failed with HTTP 401");
  });
});
