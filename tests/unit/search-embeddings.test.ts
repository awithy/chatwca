import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_EMBEDDING_INPUT_BYTES, MAX_EMBEDDING_REQUEST_BYTES, MAX_EMBEDDING_RESPONSE_BYTES, normalizeSearchVector, OllamaSearchEmbeddings, type SearchEmbeddingFetch } from "../../src/server/search/embeddings.js";
import { queryEmbeddingInput } from "../../src/server/search/chunk.js";
import { SearchEmbeddingError } from "../../src/server/search/errors.js";
import { createEmbeddingSpace } from "../../src/server/search/signatures.js";
import { FAKE_CHANGED_DIGEST, FAKE_EMBEDDING_DIGEST, FAKE_EMBEDDING_MODEL, fakeSearchVector } from "../fixtures/search-ollama.js";

const space = createEmbeddingSpace(FAKE_EMBEDDING_MODEL, FAKE_EMBEDDING_DIGEST);
const settings = { ollamaUrl: "http://synthetic.invalid", embeddingModel: FAKE_EMBEDDING_MODEL, embeddingTimeoutMs: 30_000 };
const adapters: OllamaSearchEmbeddings[] = [];
function json(value: unknown): Response { return new Response(JSON.stringify(value)); }
function makeAdapter(fetcher?: SearchEmbeddingFetch, overrides = {}) {
  const adapter = new OllamaSearchEmbeddings({ ...settings, ...overrides }, fetcher);
  adapters.push(adapter);
  return adapter;
}
function transport(override?: (path: string, init: RequestInit) => Response | Promise<Response> | undefined) {
  const requests: { path: string; init: RequestInit }[] = [];
  const state = { digest: FAKE_EMBEDDING_DIGEST };
  const fetcher: SearchEmbeddingFetch = async (url, init) => {
    const path = new URL(url).pathname;
    requests.push({ path, init });
    const custom = override?.(path, init);
    if (custom !== undefined) return custom;
    if (path === "/api/tags") return json({ models: [{ name: FAKE_EMBEDDING_MODEL, digest: state.digest }] });
    if (path === "/api/show") return json({ capabilities: ["embedding"] });
    const body = JSON.parse(init.body as string) as { input: string[] };
    return json({ model: FAKE_EMBEDDING_MODEL, embeddings: body.input.map(() => fakeSearchVector()) });
  };
  return { fetcher, requests, state };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function blockedEmbeds() {
  const calls: { body: { input: string[] }; complete: (response: Response) => void }[] = [];
  const fake = transport((path, init) => {
    if (path !== "/api/embed") return;
    const gate = deferred<Response>();
    calls.push({ body: JSON.parse(init.body as string) as { input: string[] }, complete: gate.resolve });
    return gate.promise;
  });
  const finish = (index: number) => calls[index]!.complete(json({ model: FAKE_EMBEDDING_MODEL, embeddings: calls[index]!.body.input.map(() => fakeSearchVector()) }));
  return { ...fake, calls, finish };
}

afterEach(() => { for (const adapter of adapters.splice(0)) adapter.close(); vi.useRealTimers(); });

describe("bounded lazy Ollama adapter", () => {
  it.each([
    { ollamaUrl: "https://user:secret@example.invalid" }, { ollamaUrl: "file:///private/path" },
    { ollamaUrl: "http://example.invalid?secret=query" }, { ollamaUrl: "http://example.invalid#secret" },
    { embeddingTimeoutMs: 0 }, { embeddingTimeoutMs: 120_001 }, { embeddingTimeoutMs: 1.5 },
  ])("rejects invalid direct construction without IO (%#)", (override) => {
    const fake = transport();
    expect(() => makeAdapter(fake.fetcher, override)).toThrow("search_embedding_invalid");
    expect(fake.requests).toHaveLength(0);
  });

  it("does no IO at construction, resolves immutable identity and embedding capability without pulling", async () => {
    const fake = transport();
    const adapter = makeAdapter(fake.fetcher);
    expect(fake.requests).toEqual([]);
    expect(await adapter.resolveSpace()).toEqual(space);
    expect(fake.requests.map(({ path }) => path)).toEqual(["/api/tags", "/api/show", "/api/tags"]);
    expect(fake.requests[1]?.init.body).toBe(JSON.stringify({ model: FAKE_EMBEDDING_MODEL }));
    expect(fake.requests.every(({ init }) => init.redirect === "error")).toBe(true);
  });

  it("sends at most 16 inputs, truncate=false, role input unchanged, and normalizes both channels", async () => {
    const fake = transport();
    const adapter = makeAdapter(fake.fetcher);
    const input = "User message:\n  Preserve_Identifier.ts\n    x()";
    const result = await adapter.embedDocuments(Array<string>(16).fill(input), space);
    expect(result).toHaveLength(16);
    expect(result[0]?.slice(0, 3)).toEqual([0.6, 0.8, 0]);
    const request = fake.requests.find(({ path }) => path === "/api/embed")!;
    expect(JSON.parse(request.init.body as string)).toEqual({ model: FAKE_EMBEDDING_MODEL, input: Array<string>(16).fill(input), truncate: false, keep_alive: "10m" });
    expect(fake.requests.map(({ path }) => path)).toEqual(["/api/tags", "/api/embed", "/api/tags"]);
    expect(await adapter.embedQuery("Find a previous decision", space)).toEqual(result[0]);
    expect(JSON.parse(fake.requests.filter(({ path }) => path === "/api/embed")[1]!.init.body as string).input).toEqual([queryEmbeddingInput("Find a previous decision")]);
  });

  it("resolves and embeds search queries in one query-lane operation while background work is busy", async () => {
    const fake = blockedEmbeds(); const adapter = makeAdapter(fake.fetcher);
    const background = adapter.embedDocuments(["User message:\nBackground"], space);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    const query = adapter.embedSearchQuery("Find a decision");
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    expect(fake.calls[1]?.body.input).toEqual([queryEmbeddingInput("Find a decision")]);
    fake.finish(1); expect(await query).toEqual({ space, embedding: fakeSearchVector(0.6, 0.8) });
    fake.finish(0); await background;
  });

  it("search-query resolution rejects missing capabilities and digest drift without returning a mixed space", async () => {
    const unavailable = transport((path) => path === "/api/show" ? json({ capabilities: ["completion"] }) : undefined);
    await expect(makeAdapter(unavailable.fetcher).embedSearchQuery("decision")).rejects.toThrow("search_embedding_invalid");
    const drift = transport((path, init) => {
      if (path !== "/api/embed") return;
      drift.state.digest = FAKE_CHANGED_DIGEST;
      return json({ model: FAKE_EMBEDDING_MODEL, embeddings: JSON.parse(init.body as string).input.map(() => fakeSearchVector()) });
    });
    await expect(makeAdapter(drift.fetcher).embedSearchQuery("decision")).rejects.toThrow("search_embedding_space_changed");
  });

  it("accepts exact UTF-8 limits without changing Unicode or whitespace", async () => {
    const fake = transport();
    const adapter = makeAdapter(fake.fetcher);
    const input = "😀".repeat(MAX_EMBEDDING_INPUT_BYTES / 4);
    expect(await adapter.embedDocuments([input], space)).toHaveLength(1);
    expect(JSON.parse(fake.requests.find(({ path }) => path === "/api/embed")!.init.body as string).input).toEqual([input]);
  });

  it("returns empty document batches without probing and snapshots mutable input arrays", async () => {
    const fake = blockedEmbeds();
    const adapter = makeAdapter(fake.fetcher);
    expect(await adapter.embedDocuments([], space)).toEqual([]);
    expect(fake.requests).toHaveLength(0);
    const inputs = ["original"];
    const result = adapter.embedDocuments(inputs, space);
    inputs.push("mutated");
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    expect(fake.calls[0]?.body.input).toEqual(["original"]);
    fake.finish(0);
    expect(await result).toHaveLength(1);
  });

  it.each([
    Array<string>(17).fill("text"), [""], [" \n"], ["\ud800"], ["x".repeat(MAX_EMBEDDING_INPUT_BYTES + 1)],
    ["界".repeat(Math.floor(MAX_EMBEDDING_INPUT_BYTES / 3) + 1)],
    Array<string>(16).fill("\u0000".repeat(MAX_EMBEDDING_INPUT_BYTES / 2)),
  ].map((inputs) => ({ inputs })))("rejects oversized, malformed or empty inputs before network (%#)", async ({ inputs }) => {
    const fake = transport();
    await expect(makeAdapter(fake.fetcher).embedDocuments(inputs, space)).rejects.toThrow("search_embedding_invalid");
    expect(fake.requests).toHaveLength(0);
  });

  it.each(["", "  ", "\udfff", "x".repeat(MAX_EMBEDDING_INPUT_BYTES)])("rejects invalid or oversized profiled queries (%#)", async (query) => {
    const fake = transport();
    await expect(makeAdapter(fake.fetcher).embedQuery(query, space)).rejects.toThrow("search_embedding_invalid");
    expect(fake.requests).toHaveLength(0);
  });

  it("bounds the serialized aggregate request rather than only raw inputs", async () => {
    const fake = transport();
    const adapter = makeAdapter(fake.fetcher);
    const input = "x".repeat(MAX_EMBEDDING_INPUT_BYTES);
    await expect(adapter.embedDocuments(Array<string>(16).fill(input), space)).rejects.toThrow("search_embedding_invalid");
    expect(fake.requests).toHaveLength(0);
    expect(await adapter.embedDocuments(Array<string>(15).fill(input), space)).toHaveLength(15);
    const body = fake.requests.find(({ path }) => path === "/api/embed")!.init.body as string;
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(MAX_EMBEDDING_REQUEST_BYTES);
  });

  it.each([
    {}, { models: null }, { models: [null] }, { models: [{ name: FAKE_EMBEDDING_MODEL, digest: "short" }] },
    { models: [{ name: FAKE_EMBEDDING_MODEL, digest: FAKE_EMBEDDING_DIGEST }, { name: FAKE_EMBEDDING_MODEL, digest: FAKE_EMBEDDING_DIGEST }] },
  ])("rejects invalid/ambiguous digest catalogs (%#)", async (response) => {
    const fake = transport((path) => path === "/api/tags" ? json(response) : undefined);
    await expect(makeAdapter(fake.fetcher).resolveSpace()).rejects.toThrow("search_embedding_invalid");
    expect(fake.requests).toHaveLength(1);
  });

  it("does not pull a missing model and rejects non-embedding capability", async () => {
    const missing = transport((path) => path === "/api/tags" ? json({ models: [] }) : undefined);
    await expect(makeAdapter(missing.fetcher).resolveSpace()).rejects.toThrow("search_embedding_unavailable");
    expect(missing.requests.map(({ path }) => path)).toEqual(["/api/tags"]);
    const wrong = transport((path) => path === "/api/show" ? json({ capabilities: ["completion"] }) : undefined);
    await expect(makeAdapter(wrong.fetcher).resolveSpace()).rejects.toThrow("search_embedding_invalid");
  });

  it("detects tag changes during capability resolution, before/after embedding, and before publication", async () => {
    const duringShow = transport((path) => {
      if (path === "/api/show") { duringShow.state.digest = FAKE_CHANGED_DIGEST; return json({ capabilities: ["embedding"] }); }
      return undefined;
    });
    await expect(makeAdapter(duringShow.fetcher).resolveSpace()).rejects.toThrow("search_embedding_space_changed");
    const fake = transport();
    const adapter = makeAdapter(fake.fetcher);
    fake.state.digest = FAKE_CHANGED_DIGEST;
    await expect(adapter.embedDocuments(["text"], space)).rejects.toThrow("search_embedding_space_changed");
    expect(fake.requests.map(({ path }) => path)).toEqual(["/api/tags"]);
    await expect(adapter.assertSpaceCurrent(space)).rejects.toThrow("search_embedding_space_changed");
    const duringEmbed = transport((path) => {
      if (path === "/api/embed") { duringEmbed.state.digest = FAKE_CHANGED_DIGEST; return json({ model: FAKE_EMBEDDING_MODEL, embeddings: [fakeSearchVector()] }); }
      return undefined;
    });
    await expect(makeAdapter(duringEmbed.fetcher).embedDocuments(["text"], space)).rejects.toThrow("search_embedding_space_changed");
  });

  it("rejects forged/incompatible spaces before IO", async () => {
    const fake = transport();
    const adapter = makeAdapter(fake.fetcher);
    for (const incompatible of [createEmbeddingSpace("other:tag", FAKE_EMBEDDING_DIGEST), { ...space, signature: "forged" }, { ...space, dimensions: 512 }]) {
      await expect(adapter.embedDocuments(["text"], incompatible as typeof space)).rejects.toThrow("search_embedding_space_changed");
    }
    expect(fake.requests).toHaveLength(0);
  });

  it.each([
    {}, { model: FAKE_EMBEDDING_MODEL, embeddings: [] }, { model: FAKE_EMBEDDING_MODEL, embeddings: [fakeSearchVector(), fakeSearchVector()] },
    { model: "other:tag", embeddings: [fakeSearchVector()] }, { embeddings: [fakeSearchVector()] },
    { model: FAKE_EMBEDDING_MODEL, embeddings: [Array<number>(1023).fill(1)] },
    { model: FAKE_EMBEDDING_MODEL, embeddings: [Array<number>(1024).fill(0)] },
    { model: FAKE_EMBEDDING_MODEL, embeddings: [Array<string>(1024).fill("1")] },
  ])("rejects invalid embedding envelopes (%#)", async (response) => {
    const fake = transport((path) => path === "/api/embed" ? json(response) : undefined);
    await expect(makeAdapter(fake.fetcher).embedDocuments(["text"], space)).rejects.toThrow("search_embedding_invalid");
  });

  it("rejects infinite JSON numeric values and strict UTF-8/JSON failures", async () => {
    for (const body of [new TextEncoder().encode(`{"model":"${FAKE_EMBEDDING_MODEL}","embeddings":[[1e400,${Array<string>(1023).fill("0").join(",")}]]}`), new Uint8Array([0xff]), new TextEncoder().encode("{invalid transcript secret")]) {
      const fake = transport((path) => path === "/api/embed" ? new Response(body) : undefined);
      await expect(makeAdapter(fake.fetcher).embedDocuments(["text"], space)).rejects.toThrow("search_embedding_invalid");
    }
  });

  it("rejects response Content-Length excess and cancels an incrementally oversized stream", async () => {
    const excess = transport((path) => path === "/api/embed" ? new Response("{}", { headers: { "content-length": String(MAX_EMBEDDING_RESPONSE_BYTES + 1) } }) : undefined);
    await expect(makeAdapter(excess.fetcher).embedDocuments(["text"], space)).rejects.toThrow("search_embedding_invalid");
    const cancel = vi.fn();
    let emitted = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { emitted += 1; controller.enqueue(new Uint8Array(8192).fill(32)); }, cancel,
    });
    const oversized = transport((path) => path === "/api/embed" ? new Response(stream) : undefined);
    await expect(makeAdapter(oversized.fetcher).embedDocuments(["text"], space)).rejects.toThrow("search_embedding_invalid");
    expect(cancel).toHaveBeenCalledOnce();
    expect(emitted).toBeLessThan(10); // one vector's count-derived body allowance
  });

  it("also bounds metadata bodies", async () => {
    for (const path of ["/api/tags", "/api/show"]) {
      const fake = transport((current) => current === path ? new Response("{}", { headers: { "content-length": "99999999" } }) : undefined);
      await expect(makeAdapter(fake.fetcher).resolveSpace()).rejects.toThrow("search_embedding_invalid");
    }
  });

  it("redacts network/status diagnostics without reading error bodies or retrying", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fake = transport((path) => path === "/api/embed" ? new Response(body, { status: 500 }) : undefined);
    const adapter = makeAdapter(fake.fetcher);
    await expect(adapter.embedDocuments(["private transcript"], space)).rejects.toEqual(new SearchEmbeddingError("search_embedding_unavailable"));
    expect(cancel).toHaveBeenCalledOnce();
    expect(fake.requests.filter(({ path }) => path === "/api/embed")).toHaveLength(1);
    const error = await makeAdapter(async () => { throw new Error("private endpoint credential diagnostic"); }).resolveSpace().catch((value: unknown) => value);
    expect(error).toEqual(new SearchEmbeddingError("search_embedding_unavailable"));
    expect((error as Error).cause).toBeUndefined();
    expect(String(error)).not.toContain("private");
  });

  it("cancels fetches that ignore signals and disposes late bodies", async () => {
    vi.useFakeTimers();
    const gate = deferred<Response>();
    const fake = transport(() => gate.promise);
    const adapter = makeAdapter(fake.fetcher, { embeddingTimeoutMs: 1000 });
    const pending = expect(adapter.resolveSpace()).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(fake.requests[0]?.init.signal?.aborted).toBe(true);
    const cancel = vi.fn();
    gate.resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fake.requests).toHaveLength(1);
  });

  it("times out stalled body reads and includes all metadata calls in a single deadline", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stalled = transport((path) => path === "/api/embed" ? new Response(new ReadableStream({ cancel })) : undefined);
    const adapter = makeAdapter(stalled.fetcher, { embeddingTimeoutMs: 1000 });
    const pending = expect(adapter.embedDocuments(["text"], space)).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(stalled.requests.map(({ path }) => path)).toEqual(["/api/tags", "/api/embed"]);
    const slow = transport(async (path) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 600));
      return path === "/api/tags" ? json({ models: [{ name: FAKE_EMBEDDING_MODEL, digest: FAKE_EMBEDDING_DIGEST }] }) : json({ capabilities: ["embedding"] });
    });
    const result = expect(makeAdapter(slow.fetcher, { embeddingTimeoutMs: 1000 }).resolveSpace()).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(1001);
    await result;
    expect(slow.requests.map(({ path }) => path)).toEqual(["/api/tags", "/api/show"]);
  });

  it("uses at most 10 seconds for query embedding", async () => {
    vi.useFakeTimers();
    const fake = transport(() => new Promise<Response>(() => undefined));
    const pending = expect(makeAdapter(fake.fetcher).embedQuery("query", space)).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(10_001);
    await pending;
    expect(fake.requests).toHaveLength(1);
  });

  it("counts queue time toward query deadlines and recovers admission after expiration", async () => {
    vi.useFakeTimers();
    const fake = blockedEmbeds();
    const adapter = makeAdapter(fake.fetcher, { embeddingTimeoutMs: 1000 });
    const first = adapter.embedQuery("first", space);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toHaveLength(1);
    const queued = expect(adapter.embedQuery("queued", space)).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(800);
    expect(fake.calls).toHaveLength(1);
    fake.finish(0);
    await vi.advanceTimersByTimeAsync(0);
    await first;
    expect(fake.calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(201); // only 200ms remains after admission, not a new 1000ms
    await queued;
    fake.finish(1);
    const next = adapter.embedQuery("next", space);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls).toHaveLength(3);
    fake.finish(2);
    await vi.advanceTimersByTimeAsync(0);
    expect((await next).slice(0, 3)).toEqual([0.6, 0.8, 0]);
  });

  it("handles already-aborted requests, active cancellation, shutdown, and sealed admission", async () => {
    const fake = blockedEmbeds();
    const adapter = makeAdapter(fake.fetcher);
    const controller = new AbortController();
    controller.abort(new Error("raw caller reason"));
    await expect(adapter.resolveSpace({ signal: controller.signal })).rejects.toThrow("search_cancelled");
    expect(fake.requests).toHaveLength(0);
    const active = new AbortController();
    const pending = expect(adapter.embedDocuments(["text"], space, { signal: active.signal })).rejects.toThrow("search_cancelled");
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    active.abort();
    await pending;
    fake.finish(0);
    const shutdown = expect(adapter.embedQuery("query", space)).rejects.toThrow("search_cancelled");
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    adapter.close();
    await shutdown;
    fake.finish(1);
    const requests = fake.requests.length;
    await expect(adapter.resolveSpace()).rejects.toThrow("search_cancelled");
    expect(fake.requests).toHaveLength(requests);
  });

  it("admits one background batch and a separate query lane with a bounded FIFO queue", async () => {
    const fake = blockedEmbeds();
    const adapter = makeAdapter(fake.fetcher);
    const background = adapter.embedDocuments(["background"], space);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(1));
    await expect(adapter.embedDocuments(["duplicate"], space)).rejects.toThrow("search_busy");
    const query0 = adapter.embedQuery("first", space);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(2));
    const cancelled = new AbortController();
    const queued = expect(adapter.embedQuery("cancelled", space, { signal: cancelled.signal })).rejects.toThrow("search_cancelled");
    const query1 = adapter.embedQuery("second", space);
    await expect(adapter.embedQuery("overflow", space)).rejects.toThrow("search_busy");
    cancelled.abort();
    await queued;
    const query2 = adapter.embedQuery("third", space);
    expect(fake.calls).toHaveLength(2);
    fake.finish(1);
    await query0;
    await vi.waitFor(() => expect(fake.calls).toHaveLength(3));
    expect(fake.calls[2]?.body.input).toEqual([queryEmbeddingInput("second")]);
    fake.finish(2);
    await query1;
    await vi.waitFor(() => expect(fake.calls).toHaveLength(4));
    expect(fake.calls[3]?.body.input).toEqual([queryEmbeddingInput("third")]);
    fake.finish(3);
    await query2;
    fake.finish(0);
    await background;
    const next = adapter.embedDocuments(["new background"], space);
    await vi.waitFor(() => expect(fake.calls).toHaveLength(5));
    fake.finish(4);
    expect(await next).toHaveLength(1);
  });
});

describe("stable cosine normalization", () => {
  it.each([3, Number.MAX_VALUE, Number.MIN_VALUE, 1e-300])("normalizes finite nonzero magnitudes without overflow/underflow (%s)", (magnitude) => {
    const vector = normalizeSearchVector(fakeSearchVector(magnitude, -magnitude));
    expect(vector[0]).toBeCloseTo(Math.SQRT1_2, 15);
    expect(vector[1]).toBeCloseTo(-Math.SQRT1_2, 15);
    expect(vector.every(Number.isFinite)).toBe(true);
    expect(vector.reduce((sum, element) => sum + element * element, 0)).toBeCloseTo(1, 15);
  });
  it.each([null, [], Array<number>(1025).fill(1), fakeSearchVector(NaN), fakeSearchVector(Infinity), fakeSearchVector(-Infinity), Array<number>(1024).fill(0), ["1", ...Array<number>(1023).fill(0)]].map((vector) => ({ vector })))("rejects incompatible vectors (%#)", ({ vector }) => {
    expect(() => normalizeSearchVector(vector)).toThrow("search_embedding_invalid");
  });
});
