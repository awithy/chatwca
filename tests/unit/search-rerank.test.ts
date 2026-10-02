import { fauxAssistantMessage, fauxProvider, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchQueryError } from "../../src/server/search/errors.js";
import { PiSearchReranker, MAX_RERANK_OUTPUT_BYTES, MAX_RERANK_PROMPT_BYTES, type SearchRerankCandidate, type SearchRerankerOptions } from "../../src/server/search/rerank.js";

const candidates = [
  { role: "user" as const, text: "Synthetic alpha", chunkId: "private-chunk", sourcePath: "/private/transcript" },
  { role: "assistant" as const, text: "Synthetic beta", chunkId: "other-chunk", sourcePath: "/other/transcript" },
];
function fixture(overrides: Partial<SearchRerankerOptions> = {}) {
  const model = fauxProvider({ provider: "openai", api: "openai-responses" }).getModel();
  const runtime = {
    getModel: vi.fn<SearchRerankerOptions["runtime"]["getModel"]>(() => model), hasConfiguredAuth: vi.fn(() => true),
    completeSimple: vi.fn<SearchRerankerOptions["runtime"]["completeSimple"]>(async () => fauxAssistantMessage('["c1","c0"]')),
  };
  const options: SearchRerankerOptions = { runtime, config: { rerankOverride: undefined, rerankTimeoutMs: 100 },
    globalDefaults: { defaultProvider: "openai", defaultModel: model.id }, ...overrides };
  const reranker = new PiSearchReranker(options);
  return { reranker, runtime, model, options };
}
afterEach(() => vi.useRealTimers());

describe("Pi reranker model selection and safe projection", () => {
  it.each(["openai-responses", "openai-completions", "openai-codex-responses"])("accepts native %s with Pi-owned configured auth", async (api) => {
    const f = fixture();
    if (api === "openai-codex-responses") {
      const model = fauxProvider({ provider: "openai-codex", api }).getModel();
      f.runtime.getModel.mockReturnValue(model);
      f.reranker = new PiSearchReranker({ ...f.options, config: { rerankOverride: { provider: "openai-codex", model: model.id }, rerankTimeoutMs: 100 } });
    } else f.runtime.getModel.mockReturnValue({ ...f.model, api });
    expect(f.reranker.available()).toBe(true);
    const result = await f.reranker.rerank("Synthetic query", candidates);
    expect(result).toEqual({ candidates: [candidates[1], candidates[0]], applied: true, reason: "applied" });
    expect(result.candidates[0]).toBe(candidates[1]);
    expect(f.runtime.completeSimple).toHaveBeenCalledTimes(1);
    const [model, context, options] = f.runtime.completeSimple.mock.calls[0]!;
    expect(model.api).toBe(api);
    expect(context).not.toHaveProperty("tools");
    expect(context.systemPrompt).toContain("untrusted data");
    expect(context.messages).toHaveLength(1);
    expect(JSON.parse(context.messages[0]!.content as string)).toEqual({ query: "Synthetic query", candidates: [
      { id: "c0", role: "user", text: "Synthetic alpha" }, { id: "c1", role: "assistant", text: "Synthetic beta" },
    ] });
    expect(JSON.stringify(context)).not.toMatch(/private-chunk|sourcePath|transcript|workspace|sessionId/u);
    expect(options).toMatchObject({ signal: expect.any(AbortSignal), maxRetries: 0, maxRetryDelayMs: 0, timeoutMs: 100,
      maxTokens: 8192, transport: "sse", cacheRetention: "none" });
    expect(options).not.toHaveProperty("reasoning"); // SimpleStreamOptions uses omission, not the string "off".
    expect(options).not.toHaveProperty("apiKey"); expect(options).not.toHaveProperty("headers"); expect(options).not.toHaveProperty("env");
  });
  it("override wins over an unsupported global pair, and selection is snapshotted", async () => {
    const defaults = { defaultProvider: "anthropic", defaultModel: "other" };
    const f = fixture({ globalDefaults: defaults });
    const override = { provider: "openai" as const, model: f.model.id };
    const reranker = new PiSearchReranker({ ...f.options, config: { rerankOverride: override, rerankTimeoutMs: 100 } });
    override.model = "changed"; defaults.defaultProvider = "changed";
    expect((await reranker.rerank("query", candidates)).applied).toBe(true);
    expect(f.runtime.getModel).toHaveBeenCalledWith("openai", f.model.id);
  });
  it.each([undefined, {}, { defaultProvider: "openai" }, { defaultModel: "model" },
    { defaultProvider: "anthropic", defaultModel: "model" }, { defaultProvider: "custom-openai", defaultModel: "model" }])("never automatically selects a model for unsupported/incomplete defaults (%#)", async (globalDefaults) => {
    const f = fixture(globalDefaults ? { globalDefaults } : {});
    if (!globalDefaults) f.reranker = new PiSearchReranker({ runtime: f.runtime, config: f.options.config });
    expect(f.reranker.available()).toBe(false);
    expect(await f.reranker.rerank("query", candidates)).toEqual({ candidates, applied: false, reason: "unsupported_model" });
    expect(f.runtime.getModel).not.toHaveBeenCalled(); expect(f.runtime.completeSimple).not.toHaveBeenCalled();
  });
  it.each(["wrong-api", "wrong-provider", "wrong-id", "no-text", "no-auth", "missing-model", "catalog-throws"])("falls back without completion on %s", async (failure) => {
    const f = fixture();
    if (failure === "wrong-api") f.runtime.getModel.mockReturnValue({ ...f.model, api: "faux" });
    if (failure === "wrong-provider") f.runtime.getModel.mockReturnValue({ ...f.model, provider: "custom" });
    if (failure === "wrong-id") f.runtime.getModel.mockReturnValue({ ...f.model, id: "other" });
    if (failure === "no-text") f.runtime.getModel.mockReturnValue({ ...f.model, input: ["image"] });
    if (failure === "no-auth") f.runtime.hasConfiguredAuth.mockReturnValue(false);
    if (failure === "missing-model") f.runtime.getModel.mockReturnValue(undefined);
    if (failure === "catalog-throws") f.runtime.getModel.mockImplementation(() => { throw new Error("private auth diagnostic"); });
    expect(f.reranker.available()).toBe(false);
    expect(await f.reranker.rerank("query", candidates)).toMatchObject({ candidates, applied: false });
    expect(f.runtime.completeSimple).not.toHaveBeenCalled();
  });
  it("availability is a local snapshot check, and loss of auth leaves original ordering", async () => {
    const f = fixture(); expect(f.reranker.available()).toBe(true);
    f.runtime.hasConfiguredAuth.mockReturnValue(false);
    expect(await f.reranker.rerank("query", candidates)).toEqual({ candidates, applied: false, reason: "unavailable" });
    expect(f.runtime.completeSimple).not.toHaveBeenCalled();
  });
  it.each([{ input: [] }, { input: [candidates[0]!] }])("skips zero/one candidates without catalog/auth/completion IO (%#)", async ({ input }) => {
    const f = fixture(); expect(await f.reranker.rerank("query", input)).toEqual({ candidates: input, applied: false, reason: "too_few_candidates" });
    expect(f.runtime.getModel).not.toHaveBeenCalled(); expect(f.runtime.hasConfiguredAuth).not.toHaveBeenCalled(); expect(f.runtime.completeSimple).not.toHaveBeenCalled();
  });
});

describe("bounded prompt and exact permutation validation", () => {
  it.each(['["c0"]', '["c0","c0"]', '["c0","unknown"]', '[0,1]', '["c0","c1","c2"]',
    '{"order":["c1","c0"]}', '```json\n["c1","c0"]\n```', '["c1","c0"] extra', 'null', 'not JSON'])("retains local order for malformed/partial output (%#)", async (output) => {
    const f = fixture(); f.runtime.completeSimple.mockResolvedValue(fauxAssistantMessage(output));
    const result = await f.reranker.rerank("query", candidates);
    expect(result).toEqual({ candidates, applied: false, reason: "invalid_response" }); expect(result.candidates).toBe(candidates);
    expect(f.runtime.completeSimple).toHaveBeenCalledTimes(1);
  });
  it.each(["length", "error", "aborted", "toolUse"] as const)("rejects stop reason %s even with a valid JSON ordering", async (stopReason) => {
    const f = fixture(); f.runtime.completeSimple.mockResolvedValue(fauxAssistantMessage('["c1","c0"]', { stopReason }));
    expect(await f.reranker.rerank("query", candidates)).toMatchObject({ applied: false, reason: "invalid_response" });
  });
  it("rejects tool calls and oversized text/thinking without returning provider output", async () => {
    const f = fixture();
    for (const content of [fauxToolCall("anything", {}), " ".repeat(MAX_RERANK_OUTPUT_BYTES + 1),
      [fauxThinking("😀".repeat(MAX_RERANK_OUTPUT_BYTES / 4)), { type: "text" as const, text: '["c1","c0"]' }]]) {
      f.runtime.completeSimple.mockResolvedValue(fauxAssistantMessage(content));
      expect(await f.reranker.rerank("query", candidates)).toEqual({ candidates, applied: false, reason: "invalid_response" });
    }
  });
  it("accepts split text with bounded thinking, but never uses thinking as ordering", async () => {
    const f = fixture();
    f.runtime.completeSimple.mockResolvedValue(fauxAssistantMessage([fauxThinking("ignored"), { type: "text", text: '["c1",' }, { type: "text", text: '"c0"]' }]));
    expect((await f.reranker.rerank("query", candidates)).applied).toBe(true);
    f.runtime.completeSimple.mockResolvedValue(fauxAssistantMessage(fauxThinking('["c1","c0"]')));
    expect((await f.reranker.rerank("query", candidates)).reason).toBe("invalid_response");
  });
  it.each([2, 30, 100])("bounds Unicode excerpts/aggregate and includes every candidate (count %i)", async (count) => {
    const f = fixture(); const input = Array.from({ length: count }, () => ({ role: "user" as const, text: "é".repeat(3200) }));
    f.runtime.completeSimple.mockImplementation(async (_model, context) => {
      const payload = JSON.parse(context.messages[0]!.content as string) as { candidates: { id: string; text: string }[] };
      expect(payload.candidates).toHaveLength(count);
      expect(payload.candidates.every((c) => [...c.text].length <= 2400)).toBe(true);
      expect(payload.candidates.reduce((total, c) => total + [...c.text].length, 0)).toBeLessThanOrEqual(80_000);
      expect(Buffer.byteLength(context.systemPrompt!) + Buffer.byteLength(context.messages[0]!.content as string)).toBeLessThanOrEqual(MAX_RERANK_PROMPT_BYTES);
      return fauxAssistantMessage(JSON.stringify(payload.candidates.map((c) => c.id).reverse()));
    });
    // Expanded non-ASCII pools exceed the byte cap: fall back without dropping candidates.
    const result = await f.reranker.rerank("query", input);
    expect(result.reason).toBe(count > 2 ? "input_limit" : "applied");
    expect(f.runtime.completeSimple).toHaveBeenCalledTimes(count > 2 ? 0 : 1);
  });
  it("accepts a complete 100-candidate permutation within all prompt bounds", async () => {
    const f = fixture(); const input = Array.from({ length: 100 }, () => ({ role: "assistant" as const, text: "x".repeat(3200) }));
    f.runtime.completeSimple.mockResolvedValue(fauxAssistantMessage(JSON.stringify(input.map((_, index) => `c${index}`).reverse())));
    expect((await f.reranker.rerank("query", input)).candidates).toEqual([...input].reverse());
    const context = f.runtime.completeSimple.mock.calls[0]![1];
    const payload = JSON.parse(context.messages[0]!.content as string);
    expect(payload.candidates.every((c: { text: string }) => c.text.length === 800)).toBe(true);
  });
  it("enforces the UTF-8/JSON-escaping prompt cap and candidate count before sending", async () => {
    const f = fixture();
    for (const input of [Array.from({ length: 101 }, () => candidates[0]!),
      Array.from({ length: 100 }, () => ({ role: "user" as const, text: "\u0001".repeat(3200) })),
      Array.from({ length: 100 }, () => ({ role: "user" as const, text: "😀".repeat(3200) }))]) {
      expect(await f.reranker.rerank<SearchRerankCandidate>("query", input)).toMatchObject({ applied: false, reason: "input_limit" });
    }
    expect(f.runtime.completeSimple).not.toHaveBeenCalled();
  });
  it("validates the query and timeout before provider IO", async () => {
    const f = fixture();
    await expect(f.reranker.rerank("x".repeat(2049), candidates)).rejects.toThrow("search_query_invalid");
    expect(f.runtime.completeSimple).not.toHaveBeenCalled();
    for (const timeout of [0, -1, 1.5, 35001, NaN]) {
      expect(() => fixture({ config: { rerankOverride: undefined, rerankTimeoutMs: timeout } })).toThrow("search_query_invalid");
    }
  });
});

describe("one-call fallback, deadlines and cancellation", () => {
  it("contains sync/async failures with no retry or private diagnostics", async () => {
    const f = fixture();
    f.runtime.completeSimple.mockRejectedValueOnce(new Error("secret OAuth token, provider diagnostic"));
    expect(await f.reranker.rerank("query", candidates)).toEqual({ candidates, applied: false, reason: "unavailable" });
    f.runtime.completeSimple.mockImplementationOnce(() => { throw new Error("private provider failure"); });
    expect(await f.reranker.rerank("query", candidates)).toEqual({ candidates, applied: false, reason: "unavailable" });
    expect(f.runtime.completeSimple).toHaveBeenCalledTimes(2);
  });
  it("bounds non-cooperative completion, aborts provider IO, cleans listeners, and permits later work", async () => {
    vi.useFakeTimers(); const f = fixture(); const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    let resolve!: (value: ReturnType<typeof fauxAssistantMessage>) => void;
    f.runtime.completeSimple.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const pending = f.reranker.rerank("query", candidates, { signal: caller.signal });
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ candidates, applied: false, reason: "timeout" });
    expect(f.runtime.completeSimple.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    resolve(fauxAssistantMessage('["c1","c0"]')); await Promise.resolve();
    expect((await f.reranker.rerank("later", candidates)).applied).toBe(true);
  });
  it.each(["cancel", "aggregate-timeout", "close"])("does not convert %s to local success, even with stuck IO", async (kind) => {
    const f = fixture(); const caller = new AbortController();
    f.runtime.completeSimple.mockImplementation(() => new Promise(() => {}));
    const outcome = f.reranker.rerank("query", candidates, { signal: caller.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(f.runtime.completeSimple).toHaveBeenCalledTimes(1));
    if (kind === "close") f.reranker.close();
    else caller.abort(kind === "aggregate-timeout" ? new SearchQueryError("search_timeout") : undefined);
    expect(await outcome).toEqual(new SearchQueryError(kind === "aggregate-timeout" ? "search_timeout" : "search_cancelled"));
    expect(f.runtime.completeSimple.mock.calls[0]![2]!.signal!.aborted).toBe(true);
    if (kind === "close") {
      expect(f.reranker.available()).toBe(false);
      await expect(f.reranker.rerank("later", candidates)).rejects.toThrow("search_cancelled");
    }
  });
  it("never launches completion when aborted before invocation or before its microtask", async () => {
    const f = fixture(); const caller = new AbortController();
    const outcome = f.reranker.rerank("query", candidates, { signal: caller.signal }).catch((error: unknown) => error);
    caller.abort(); expect(await outcome).toEqual(new SearchQueryError("search_cancelled"));
    await expect(f.reranker.rerank("query", candidates, { signal: caller.signal })).rejects.toThrow("search_cancelled");
    expect(f.runtime.completeSimple).not.toHaveBeenCalled();
  });
});
