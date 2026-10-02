import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { PiSearchReranker } from "../../src/server/search/rerank.js";

const candidates = [{ role: "user" as const, text: "Synthetic alpha" }, { role: "assistant" as const, text: "Synthetic beta" }];

// Actual pinned ModelRuntime/auth/stream facade, but all inference goes to an in-memory
// faux provider. No sessions, real credentials, catalog network, source files or paid IO.
async function fixture(provider: "openai" | "openai-codex") {
  const faux = fauxProvider({ provider, api: provider === "openai" ? "openai-responses" : "openai-codex-responses", tokensPerSecond: 100_000 });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.refresh({ allowNetwork: false });
  // Native registration schedules an asynchronous local refresh. Publish a fresh
  // complete availability snapshot after it, rather than racing its provider pass.
  await runtime.getAvailable();
  const reranker = new PiSearchReranker({ runtime, config: { rerankOverride: { provider, model: faux.getModel().id }, rerankTimeoutMs: 1000 } });
  return { faux, runtime, reranker };
}

describe("reranking through pinned Pi ModelRuntime", () => {
  it.each(["openai", "openai-codex"] as const)("uses the runtime's %s auth and exactly one tool-free completion", async (provider) => {
    const f = await fixture(provider);
    f.faux.setResponses([(context, options, _state, model) => {
      expect(model.provider).toBe(provider);
      expect(context.tools).toBeUndefined();
      expect(options).toMatchObject({ maxRetries: 0, transport: "sse", signal: expect.any(AbortSignal) });
      expect(JSON.parse(context.messages[0]!.content as string).candidates.map((c: { id: string }) => c.id)).toEqual(["c0", "c1"]);
      return fauxAssistantMessage('["c1","c0"]');
    }]);
    try {
      expect(f.reranker.available()).toBe(true);
      expect(await f.reranker.rerank("Synthetic query", candidates)).toEqual({ candidates: [candidates[1], candidates[0]], applied: true, reason: "applied" });
      expect(f.faux.state.callCount).toBe(1);
    } finally { f.reranker.close(); }
  });
  it("retains local order on actual SDK error messages without retrying", async () => {
    const f = await fixture("openai-codex");
    f.faux.setResponses([fauxAssistantMessage("private provider diagnostic", { stopReason: "error", errorMessage: "private error" })]);
    try {
      expect(await f.reranker.rerank("Synthetic query", candidates)).toEqual({ candidates, applied: false, reason: "invalid_response" });
      expect(f.faux.state.callCount).toBe(1);
    } finally { f.reranker.close(); }
  });
  it("cancels a real SDK completion with blocked faux inference and seals admission", async () => {
    const f = await fixture("openai");
    let providerSignal: AbortSignal | undefined;
    f.faux.setResponses([(_context, options) => {
      providerSignal = options?.signal;
      return new Promise(() => {});
    }]);
    const pending = f.reranker.rerank("Synthetic query", candidates).catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(f.faux.state.callCount).toBe(1));
      f.reranker.close();
      expect(await pending).toMatchObject({ code: "search_cancelled" });
      expect(providerSignal?.aborted).toBe(true);
      await expect(f.reranker.rerank("later", candidates)).rejects.toThrow("search_cancelled");
    } finally { f.reranker.close(); }
  });
});
