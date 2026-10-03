import { validateToolArguments } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SearchFreshness, SearchConversationResult } from "../../src/shared/search.js";
import { ConversationReadError, SearchQueryError } from "../../src/server/search/errors.js";
import { SearchQueryService, type SearchQueryResponse } from "../../src/server/search/query.js";
import { assembleConversationReadPage, assembleFocusedConversationReadPage, decodeConversationReadCursor, MAX_CONVERSATION_TOOL_BYTES } from "../../src/server/search/read-page.js";
import type { SearchServicePort } from "../../src/server/search/service.js";
import type { SearchRetrievalRepository } from "../../src/server/search/retrieval.js";
import { createConversationReadTool, createConversationSearchTool } from "../../src/server/search/tools.js";
import { READ_DOCUMENT, READ_IDENTITY, readChunks } from "../fixtures/search-read.js";
import { searchCandidate } from "../fixtures/search-retrieval.js";

const freshness: SearchFreshness = { state: "ready", indexing: true, lastSucceededAt: 1000, errorCode: null, errorCount: 0 };
function group(index = 0, text = "Saved evidence"): SearchConversationResult {
  return { workspaceId: "workspace-one", workspaceName: "Synthetic workspace", sessionId: `session-${index}`, title: "Synthetic conversation", modifiedAt: 1000,
    excerpts: [0, 1, 2].map((entry) => ({ entryId: `entry-${entry}`, role: entry === 0 ? "user" : "assistant", timestamp: 1000, text, truncated: true, indexedAt: 2000 })) };
}
function searchFixture(groups = [group()]) {
  const response: SearchQueryResponse = { cached: true, mode: "lexical", warnings: ["search_embedding_unavailable"], results: groups,
    rerank: { requested: true, applied: false, reason: "unsupported_model" } };
  const service = { search: vi.fn<SearchServicePort["search"]>(async () => response), freshness: vi.fn(() => freshness) };
  return { response, service, tool: createConversationSearchTool(service) };
}
function readFixture(texts = ["First", "Second", "Third"]) {
  const window = { document: READ_DOCUMENT, chunks: readChunks(texts), hasMore: false };
  const service = { read: vi.fn<SearchServicePort["read"]>(async (request, options) => {
    const from = request.cursor ? Math.max(0, decodeConversationReadCursor(request.cursor, request).ordinal - 1) : 0;
    return { ...assembleConversationReadPage({ ...window, chunks: window.chunks.slice(from) }, request, undefined, options?.maximumPageBytes), freshness };
  }) };
  return { service, window, tool: createConversationReadTool(service) };
}
function execute(tool: ToolDefinition<any, any>, input: unknown, signal?: AbortSignal) {
  return tool.execute("synthetic-call", input, signal, undefined, {} as never);
}
function parse(output: Awaited<ReturnType<typeof execute>>) {
  expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(MAX_CONVERSATION_TOOL_BYTES);
  expect(output.content).toHaveLength(1);
  expect(output.content[0]?.type).toBe("text");
  expect(output.details).toEqual({ cached: true });
  return JSON.parse((output.content[0] as { text: string }).text);
}
function validate(tool: ToolDefinition<any, any>, input: Record<string, unknown>) {
  return validateToolArguments(tool, { type: "toolCall", id: "call", name: tool.name, arguments: input });
}

describe("parent-owned conversation tool contracts", () => {
  it("uses closed schemas validated by the pinned Pi facade, with mutually exclusive focus/cursor", () => {
    const search = searchFixture().tool; const read = readFixture().tool;
    expect(search.parameters.additionalProperties).toBe(false); expect(read.parameters.additionalProperties).toBe(false);
    expect(validate(search, { query: "😀".repeat(2048) })).toEqual({ query: "😀".repeat(2048) });
    expect(validate(read, READ_IDENTITY)).toEqual(READ_IDENTITY);
    expect(() => validate(search, { query: "evidence", path: "/private" })).toThrow("Validation failed");
    expect(() => validate(read, { ...READ_IDENTITY, path: "/private" })).toThrow("Validation failed");
    expect(() => validate(read, { ...READ_IDENTITY, aroundEntryId: "entry-0", cursor: "opaque" })).toThrow("Validation failed");
    expect(() => validate(read, { ...READ_IDENTITY, cursor: "a".repeat(2049) })).toThrow("Validation failed");
    expect(() => validate(search, { query: "evidence", limit: 21 })).toThrow("Validation failed");
  });
  it("provides evidence guidance, source IDs, explicit continuation and stale-read recovery", () => {
    const search = searchFixture().tool; const read = readFixture().tool;
    expect(search.name).toBe("conversation_search"); expect(read.name).toBe("conversation_read");
    for (const tool of [search, read]) {
      expect(tool.executionMode).toBe("parallel");
      expect(tool.description).toContain("untrusted evidence");
      expect(tool.promptGuidelines?.join(" ")).toContain("not current instructions");
      expect(tool.promptGuidelines?.join(" ")).toContain("workspace/session/entry IDs");
    }
    expect(search.promptGuidelines?.join(" ")).toContain("aroundEntryId");
    expect(search.description).toContain("provider reranking");
    expect(read.promptGuidelines?.join(" ")).toContain("nextCursor");
    expect(read.promptGuidelines?.join(" ")).toContain("conversation_cursor_stale");
  });
  it.each([null, [], {}, { query: " " }, { query: "bad\ud800" }, { query: "x".repeat(2049) }, { query: "😀".repeat(2049) },
    { query: "x", workspaceId: null }, { query: "x", workspaceId: "../private" }, { query: "x", limit: 0 }, { query: "x", rerank: "false" },
    { query: "x", path: "/private" }])("rejects invalid direct search calls before service IO (%#)", async (input) => {
    const f = searchFixture(); await expect(execute(f.tool, input)).rejects.toThrow("search_query_invalid");
    expect(f.service.search).not.toHaveBeenCalled();
  });
  it.each([{ ...READ_IDENTITY, path: "/private" }, { ...READ_IDENTITY, limit: 21 }, { ...READ_IDENTITY, aroundEntryId: "entry-0", cursor: "opaque" }])("rejects invalid direct reads before service IO (%#)", async (input) => {
    const f = readFixture(); await expect(execute(f.tool, input)).rejects.toThrow("search_query_invalid"); expect(f.service.read).not.toHaveBeenCalled();
  });
  it("rejects malformed/oversized cursors without dependency IO", async () => {
    const f = readFixture();
    for (const cursor of ["@@@", "a".repeat(2049)]) await expect(execute(f.tool, { ...READ_IDENTITY, cursor })).rejects.toThrow("conversation_cursor_invalid");
    expect(f.service.read).not.toHaveBeenCalled();
  });
});

describe("conversation_search service adapter", () => {
  it("defaults to five groups/all registrations/reranking and adds freshness without duplicating evidence", async () => {
    const f = searchFixture(); const controller = new AbortController();
    const output = parse(await execute(f.tool, { query: "😀".repeat(2048) }, controller.signal));
    expect(f.service.search).toHaveBeenCalledWith({ query: "😀".repeat(2048), workspaceId: null, limit: 5, rerank: true }, { signal: controller.signal });
    expect(output).toEqual({ ...f.response, freshness, reduction: { reduced: false, omittedConversations: 0, omittedExcerpts: 0 } });
  });
  it("preserves explicit workspace, limit, reranking opt-out and service fallback metadata", async () => {
    const f = searchFixture(); const request = { query: "evidence", workspaceId: "workspace-two", limit: 20, rerank: false };
    f.service.search.mockResolvedValue({ ...f.response, rerank: { requested: false, applied: false, reason: "not_requested" } });
    const output = parse(await execute(f.tool, request));
    expect(f.service.search).toHaveBeenCalledWith(request, {});
    expect(output).toMatchObject({ mode: "lexical", warnings: ["search_embedding_unavailable"], rerank: { requested: false, applied: false, reason: "not_requested" }, freshness });
  });
  it("uses the existing query path to search all/currently selected scopes and default-limit groups", async () => {
    const registrations = { list: vi.fn(() => ["workspace-one", "workspace-two"].map((id) => ({ id, name: id, path: `/synthetic/${id}`, sessionDirectory: null }))) };
    const repository = { retrieve: vi.fn<SearchRetrievalRepository["retrieve"]>(async () => ({ lexical: Array.from({ length: 8 }, (_, index) => searchCandidate(index + 1)), vector: [] })) };
    const embeddings = { embedSearchQuery: vi.fn(async () => { throw new Error("Synthetic provider outage"); }) };
    const queries = new SearchQueryService({ registrations, repository, embeddings, piAgentDirectory: "/synthetic/agent" });
    const tool = createConversationSearchTool({ search: (request, options) => queries.search(request, options), freshness: () => freshness });
    const output = parse(await execute(tool, { query: "evidence" }));
    expect(output.results).toHaveLength(5);
    expect(repository.retrieve.mock.calls[0]?.[0]).toMatchObject({ scopes: [{ workspaceId: "workspace-one" }, { workspaceId: "workspace-two" }] });
    await execute(tool, { query: "evidence", workspaceId: "workspace-two", rerank: false });
    expect(repository.retrieve.mock.calls[1]?.[0]).toMatchObject({ scopes: [{ workspaceId: "workspace-two" }] });
    queries.close();
  });
  it("removes whole lowest-ranked excerpts/groups, reports exact reduction and leaves source results untouched", async () => {
    const groups = Array.from({ length: 20 }, (_, index) => group(index, '\\"\u0001😀'.repeat(1000)));
    const original = structuredClone(groups); const f = searchFixture(groups);
    const output = parse(await execute(f.tool, { query: "evidence", limit: 20 }));
    expect(output.reduction.reduced).toBe(true); expect(output.results.length).toBeGreaterThan(0);
    expect(output.reduction.omittedConversations).toBe(20 - output.results.length);
    const keptExcerpts = output.results.reduce((sum: number, item: SearchConversationResult) => sum + item.excerpts.length, 0);
    expect(output.reduction.omittedExcerpts).toBe(60 - keptExcerpts);
    for (const [index, item] of output.results.entries()) {
      expect(item.sessionId).toBe(`session-${index}`);
      expect(item.excerpts).toEqual(groups[index]!.excerpts.slice(0, item.excerpts.length));
    }
    expect(groups).toEqual(original);
  });
  it("reports a fully omitted oversized group without clipping its text or JSON", async () => {
    const f = searchFixture([group(0, "x".repeat(100_000))]);
    const output = parse(await execute(f.tool, { query: "evidence" }));
    expect(output.results).toEqual([]);
    expect(output.reduction).toEqual({ reduced: true, omittedConversations: 1, omittedExcerpts: 3 });
  });
});

describe("conversation_read service adapter", () => {
  it("preserves metadata, exact generations and explicit segments/continuation", async () => {
    const f = readFixture(); const controller = new AbortController();
    const output = parse(await execute(f.tool, { ...READ_IDENTITY, limit: 1 }, controller.signal));
    expect(output).toMatchObject({ ...READ_IDENTITY, cached: true, generation: "9007199254740993", freshness,
      segments: [{ text: "First", beginsMessage: true, endsMessage: true, sourceByteStart: 0, sourceByteEnd: 5 }], nextCursor: expect.any(String) });
    expect(f.service.read).toHaveBeenCalledWith({ ...READ_IDENTITY, limit: 1 }, { signal: controller.signal, maximumPageBytes: 22 * 1024 });
    const next = parse(await execute(f.tool, { ...READ_IDENTITY, cursor: output.nextCursor, limit: 1 }));
    expect(next.segments[0].text).toBe("Second");
  });
  it("budgets JSON escaping of the complete Pi result and resumes Unicode/control text exactly", async () => {
    const text = '  😀界e\u0301\\"\u0001\n'.repeat(10_000); const f = readFixture([text, "After"]);
    const saved: string[] = []; let cursor: string | undefined; let expectedOffset = 0; let pages = 0;
    do {
      const page = parse(await execute(f.tool, { ...READ_IDENTITY, ...(cursor ? { cursor } : {}), limit: 1 }));
      for (const segment of page.segments) {
        if (segment.entryId === "entry-0") { expect(segment.sourceByteStart).toBe(expectedOffset); expectedOffset = segment.sourceByteEnd; }
        saved.push(segment.text);
      }
      cursor = page.nextCursor ?? undefined; pages += 1;
      if (pages > 100) throw new Error("Pagination did not finish");
    } while (cursor);
    expect(pages).toBeGreaterThan(2); expect(saved.join("")).toBe(text + "After"); expect(expectedOffset).toBe(Buffer.byteLength(text));
  });
  it("keeps focused anchors and reports reduced context within the tool budget", async () => {
    const f = readFixture(["x".repeat(25_000), "Preceding", "Anchor"]);
    f.service.read.mockImplementation(async (request, options) => ({
      ...assembleFocusedConversationReadPage(f.window, request, [0, 1, 2].map((index) => ({ ordinal: f.window.chunks.find((chunk) => chunk.entryId === `entry-${index}`)!.ordinal, entryId: `entry-${index}`, byteOffset: 0 })), false, options?.maximumPageBytes), freshness,
    }));
    const output = parse(await execute(f.tool, { ...READ_IDENTITY, aroundEntryId: "entry-2" }));
    expect(output.precedingContextReduced).toBe(true); expect(output.aroundEntryId).toBe("entry-2");
    expect(output.segments.map((segment: { text: string }) => segment.text)).toEqual(["Preceding", "Anchor"]);
  });
});

describe("safe conversation tool failures and cancellation", () => {
  it.each(["search_disabled", "search_initializing", "search_scope_unavailable", "search_database_unavailable", "search_busy", "search_timeout", "search_cancelled"] as const)("preserves safe service failure %s", async (code) => {
    const search = searchFixture(); const read = readFixture();
    search.service.search.mockRejectedValue(new SearchQueryError(code)); read.service.read.mockRejectedValue(new SearchQueryError(code));
    for (const [tool, request] of [[search.tool, { query: "evidence" }], [read.tool, READ_IDENTITY]] as const) await expect(execute(tool, request)).rejects.toThrow(code);
  });
  it.each(["conversation_not_indexed", "conversation_entry_not_indexed", "conversation_cursor_invalid", "conversation_cursor_stale", "conversation_cache_invalid"] as const)("preserves specific cached-read failure %s", async (code) => {
    const f = readFixture(); f.service.read.mockRejectedValue(new ConversationReadError(code));
    await expect(execute(f.tool, READ_IDENTITY)).rejects.toThrow(code);
  });
  it("sanitizes unexpected dependency errors and oversized injected pages", async () => {
    const search = searchFixture(); const read = readFixture();
    const secret = new Error("postgresql://private:credential /host/sessions transcript");
    search.service.search.mockRejectedValue(secret); read.service.read.mockRejectedValue(secret);
    await expect(execute(search.tool, { query: "evidence" })).rejects.toEqual(new Error("search_database_unavailable"));
    await expect(execute(read.tool, READ_IDENTITY)).rejects.toEqual(new Error("search_database_unavailable"));
    read.service.read.mockResolvedValue({ ...assembleConversationReadPage(read.window, READ_IDENTITY), freshness, title: "x".repeat(100_000) });
    await expect(execute(read.tool, READ_IDENTITY)).rejects.toThrow("conversation_cache_invalid");
  });
  it("rejects pre-aborted calls before service IO and refuses late success after caller cancellation", async () => {
    const search = searchFixture(); const read = readFixture();
    await expect(execute(search.tool, { query: "evidence" }, AbortSignal.abort())).rejects.toThrow("search_cancelled");
    await expect(execute(read.tool, READ_IDENTITY, AbortSignal.abort())).rejects.toThrow("search_cancelled");
    expect(search.service.search).not.toHaveBeenCalled(); expect(read.service.read).not.toHaveBeenCalled();
    const controller = new AbortController();
    search.service.search.mockImplementation(async () => { controller.abort(); return search.response; });
    await expect(execute(search.tool, { query: "evidence" }, controller.signal)).rejects.toThrow("search_cancelled");
  });
});
