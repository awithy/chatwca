import { describe, expect, it, vi } from "vitest";

import type { HttpToolConfig } from "../../src/server/http-tool-catalog.js";
import { createHttpTool } from "../../src/server/http-tool.js";

function config(overrides: Partial<HttpToolConfig> = {}): Readonly<HttpToolConfig> {
  return {
    name: "network_brain_search",
    label: "Network Brain Search",
    description: "Search local infrastructure documentation.",
    method: "POST",
    url: "http://127.0.0.1:53147/v1/search",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: { query: { type: "string" } },
    },
    timeoutMs: 1_000,
    maxResponseBytes: 1_024,
    ...overrides,
  };
}

describe("parent-owned HTTP tool", () => {
  it("posts tool input as JSON and returns formatted JSON", async () => {
    const fetch = vi.fn(async () => Response.json({
      results: [{ citation: "network.md#router", content: "Router documentation" }],
    }));
    const tool = createHttpTool(config(), { fetch: fetch as typeof globalThis.fetch });

    const result = await tool.execute(
      "call-1",
      { query: "router", limit: 5 },
      undefined,
      undefined,
      {} as never,
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:53147/v1/search",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ query: "router", limit: 5 }),
        redirect: "error",
      }),
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: expect.stringContaining("Router documentation") }],
      details: { status: 200 },
    });
  });

  it("rejects non-JSON, invalid JSON, unsuccessful, and oversized responses", async () => {
    const nonJson = createHttpTool(config(), {
      fetch: async () => new Response("text", { headers: { "content-type": "text/plain" } }),
    });
    await expect(nonJson.execute("call", { query: "x" }, undefined, undefined, {} as never))
      .rejects.toThrow("unsupported content type");

    const invalidJson = createHttpTool(config(), {
      fetch: async () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    });
    await expect(invalidJson.execute("call", { query: "x" }, undefined, undefined, {} as never))
      .rejects.toThrow("invalid JSON");

    const unavailable = createHttpTool(config(), {
      fetch: async () => Response.json({ private: "diagnostic" }, { status: 503 }),
    });
    await expect(unavailable.execute("call", { query: "x" }, undefined, undefined, {} as never))
      .rejects.toThrow("HTTP tool request failed with HTTP 503");

    const oversized = createHttpTool(config({ maxResponseBytes: 4 }), {
      fetch: async () => new Response("{\"value\":true}", {
        headers: { "content-type": "application/json" },
      }),
    });
    await expect(oversized.execute("call", { query: "x" }, undefined, undefined, {} as never))
      .rejects.toThrow("exceeded its size limit");
  });

  it("honors the tool timeout", async () => {
    vi.useFakeTimers();
    try {
      const tool = createHttpTool(config({ timeoutMs: 25 }), {
        fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }),
      });
      const execution = tool.execute("call", { query: "x" }, undefined, undefined, {} as never);
      const rejection = expect(execution).rejects.toThrow("Network Brain Search timed out");
      await vi.advanceTimersByTimeAsync(25);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
