import { performance } from "node:perf_hooks";
import { queryEmbeddingInput } from "./chunk.js";
import { MAX_SEARCH_EMBEDDING_TIMEOUT_MS, SEARCH_EMBEDDING_DIMENSIONS, type SearchConfig } from "./config.js";
import { SearchEmbeddingError, type SearchEmbeddingErrorCode } from "./errors.js";
import { isWellFormedText } from "./extract.js";
import { canonicalEmbeddingModel, createEmbeddingSpace, type SearchEmbeddingSpace } from "./signatures.js";

export const MAX_EMBEDDING_BATCH = 16;
export const MAX_EMBEDDING_INPUT_BYTES = 16 * 1024;
export const MAX_EMBEDDING_REQUEST_BYTES = 256 * 1024;
export const MAX_EMBEDDING_RESPONSE_BYTES = 1024 * 1024;
export const MAX_EMBEDDING_QUERY_QUEUE = 2;
const MAX_TAGS_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_SHOW_RESPONSE_BYTES = 256 * 1024;
const MAX_QUERY_TIMEOUT_MS = 10_000;

export type SearchEmbeddingFetch = (url: string, init: RequestInit) => Promise<Response>;
export interface SearchEmbeddingOptions { readonly signal?: AbortSignal }
type Lane = "background" | "query";
type Settings = Pick<SearchConfig, "ollamaUrl" | "embeddingModel" | "embeddingTimeoutMs">;

function fail(code: SearchEmbeddingErrorCode = "search_embedding_invalid"): never { throw new SearchEmbeddingError(code); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}

/** Deadline covers admission, metadata requests, response streaming, and validation. */
class Deadline {
  readonly controller = new AbortController();
  readonly expiresAt: number;
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  constructor(timeoutMs: number, signal?: AbortSignal) {
    this.expiresAt = performance.now() + timeoutMs;
    const abort = (): void => this.cancel("search_cancelled");
    signal?.addEventListener("abort", abort, { once: true });
    this.unsubscribe = () => signal?.removeEventListener("abort", abort);
    this.timer = setTimeout(() => this.cancel("search_timeout"), timeoutMs);
    this.timer.unref();
    if (signal?.aborted) abort();
  }
  get signal(): AbortSignal { return this.controller.signal; }
  cancel(code: SearchEmbeddingErrorCode): void { this.controller.abort(new SearchEmbeddingError(code)); }
  check(): void {
    if (!this.signal.aborted && performance.now() >= this.expiresAt) this.cancel("search_timeout");
    if (this.signal.aborted) throw this.signal.reason as SearchEmbeddingError;
  }
  dispose(): void { clearTimeout(this.timer); this.unsubscribe(); }
}

/** Also bounds injected transports that do not honor AbortSignal themselves. */
function abortable<T>(promise: Promise<T>, deadline: Deadline): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(deadline.signal.reason);
    deadline.signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => deadline.signal.removeEventListener("abort", abort));
    if (deadline.signal.aborted) abort();
  });
}

interface QueryWaiter { readonly admit: () => void }

/** Explicitly constructed, lazy local adapter. No pulls, daemon changes, retries, or startup probes. */
export class OllamaSearchEmbeddings {
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private backgroundActive = false;
  private queryActive = false;
  private readonly queryQueue: QueryWaiter[] = [];
  private readonly operations = new Set<Deadline>();
  private closed = false;

  constructor(settings: Settings, private readonly fetcher: SearchEmbeddingFetch = globalThis.fetch) {
    this.model = canonicalEmbeddingModel(settings.embeddingModel);
    this.timeoutMs = settings.embeddingTimeoutMs;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > MAX_SEARCH_EMBEDDING_TIMEOUT_MS) fail();
    this.baseUrl = (() => {
      try {
        const url = new URL(settings.ollamaUrl);
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || /[?#]/u.test(settings.ollamaUrl)) fail();
        return url.toString().replace(/\/$/u, "");
      } catch { return fail(); }
    })();
  }

  /** Capability and digest check once per pass. Dimensions are validated on every vector. */
  resolveSpace(options: SearchEmbeddingOptions = {}): Promise<Readonly<SearchEmbeddingSpace>> {
    return this.run("background", options, async (deadline) => {
      const space = await this.currentSpace(deadline);
      const result = object(await this.json("/api/show", { model: this.model }, MAX_SHOW_RESPONSE_BYTES, deadline));
      if (!Array.isArray(result.capabilities) || !result.capabilities.includes("embedding")) fail();
      await this.assertCurrent(space, deadline);
      return space;
    });
  }

  /** Caller must repeat this immediately before publishing a document generation. */
  async assertSpaceCurrent(space: SearchEmbeddingSpace, options: SearchEmbeddingOptions = {}): Promise<void> {
    const identity = this.validateSpace(space);
    return this.run("background", options, (deadline) => this.assertCurrent(identity, deadline));
  }

  /** Inputs are already role-prefixed. Reject over-limit batches; callers stream batches <=16. */
  async embedDocuments(inputs: readonly string[], space: SearchEmbeddingSpace, options: SearchEmbeddingOptions = {}): Promise<number[][]> {
    const identity = this.validateSpace(space);
    const body = this.embeddingBody(inputs);
    const count = inputs.length;
    return this.run("background", options, async (deadline) => count === 0 ? [] : this.embed(body, count, identity, deadline));
  }

  async embedQuery(query: string, space: SearchEmbeddingSpace, options: SearchEmbeddingOptions = {}): Promise<number[]> {
    const identity = this.validateSpace(space);
    if (typeof query !== "string" || !query.trim() || query.length > MAX_EMBEDDING_INPUT_BYTES || !isWellFormedText(query)) fail();
    const body = this.embeddingBody([queryEmbeddingInput(query)]);
    return this.run("query", options, async (deadline) => (await this.embed(body, 1, identity, deadline))[0]!);
  }

  /** Resolve and embed in the query lane under ONE deadline, independent of background indexing. */
  async embedSearchQuery(query: string, options: SearchEmbeddingOptions = {}): Promise<{ space: Readonly<SearchEmbeddingSpace>; embedding: number[] }> {
    if (typeof query !== "string" || !query.trim() || query.length > MAX_EMBEDDING_INPUT_BYTES || !isWellFormedText(query)) fail();
    const body = this.embeddingBody([queryEmbeddingInput(query)]);
    return this.run("query", options, async (deadline) => {
      const space = await this.currentSpace(deadline);
      const result = object(await this.json("/api/show", { model: this.model }, MAX_SHOW_RESPONSE_BYTES, deadline));
      if (!Array.isArray(result.capabilities) || !result.capabilities.includes("embedding")) fail();
      const embedding = (await this.embed(body, 1, space, deadline))[0]!;
      return { space, embedding };
    });
  }

  /** Seals admission and aborts active/queued requests; no future transport is launched. */
  close(): void {
    this.closed = true;
    for (const operation of this.operations) operation.cancel("search_cancelled");
  }

  private validateSpace(space: SearchEmbeddingSpace): Readonly<SearchEmbeddingSpace> {
    const expected = createEmbeddingSpace(space.model, space.digest);
    if (space.model !== this.model || space.signature !== expected.signature || space.dimensions !== expected.dimensions || space.normalizationVersion !== expected.normalizationVersion) {
      fail("search_embedding_space_changed");
    }
    return expected;
  }

  private embeddingBody(inputs: readonly string[]): string {
    if (!Array.isArray(inputs) || inputs.length > MAX_EMBEDDING_BATCH) fail();
    for (const input of inputs) {
      if (typeof input !== "string" || !input.trim() || input.length > MAX_EMBEDDING_INPUT_BYTES || !isWellFormedText(input) || Buffer.byteLength(input, "utf8") > MAX_EMBEDDING_INPUT_BYTES) fail();
    }
    const body = JSON.stringify({ model: this.model, input: inputs, truncate: false, keep_alive: "10m" });
    if (Buffer.byteLength(body, "utf8") > MAX_EMBEDDING_REQUEST_BYTES) fail();
    return body;
  }

  private async run<T>(lane: Lane, options: SearchEmbeddingOptions, task: (deadline: Deadline) => Promise<T>): Promise<T> {
    if (this.closed) fail("search_cancelled");
    const deadline = new Deadline(lane === "query" ? Math.min(this.timeoutMs, MAX_QUERY_TIMEOUT_MS) : this.timeoutMs, options.signal);
    this.operations.add(deadline);
    let release: (() => void) | undefined;
    try {
      deadline.check();
      release = await this.acquire(lane, deadline);
      deadline.check();
      const result = await task(deadline);
      deadline.check();
      return result;
    } catch (error) {
      deadline.check();
      if (error instanceof SearchEmbeddingError) throw error;
      return fail("search_embedding_unavailable");
    } finally {
      release?.();
      deadline.dispose();
      this.operations.delete(deadline);
    }
  }

  private async acquire(lane: Lane, deadline: Deadline): Promise<() => void> {
    if (lane === "background") {
      if (this.backgroundActive) fail("search_busy");
      this.backgroundActive = true;
      return () => { this.backgroundActive = false; };
    }
    if (this.queryActive) {
      if (this.queryQueue.length >= MAX_EMBEDDING_QUERY_QUEUE) fail("search_busy");
      let waiter: QueryWaiter | undefined;
      try {
        await abortable(new Promise<void>((resolve) => {
          waiter = { admit: resolve };
          this.queryQueue.push(waiter);
        }), deadline);
      } catch (error) {
        const index = waiter ? this.queryQueue.indexOf(waiter) : -1;
        if (index >= 0) this.queryQueue.splice(index, 1);
        // If admission won the race with cancellation, pass its slot onward.
        else this.releaseQuery();
        throw error;
      }
    } else this.queryActive = true;
    return () => this.releaseQuery();
  }

  private releaseQuery(): void {
    const next = this.queryQueue.shift();
    if (next) next.admit();
    else this.queryActive = false;
  }

  private async currentSpace(deadline: Deadline): Promise<Readonly<SearchEmbeddingSpace>> {
    const result = object(await this.json("/api/tags", undefined, MAX_TAGS_RESPONSE_BYTES, deadline));
    if (!Array.isArray(result.models) || result.models.length > 10_000) fail();
    const matches = result.models.filter((value: unknown) => {
      const entry = object(value);
      return entry.name === this.model || entry.model === this.model;
    });
    if (matches.length === 0) fail("search_embedding_unavailable");
    if (matches.length !== 1) fail();
    const model = object(matches[0]);
    if (typeof model.digest !== "string") fail();
    return createEmbeddingSpace(this.model, model.digest);
  }

  private async assertCurrent(space: SearchEmbeddingSpace, deadline: Deadline): Promise<void> {
    if ((await this.currentSpace(deadline)).signature !== space.signature) fail("search_embedding_space_changed");
  }

  private async embed(body: string, count: number, space: SearchEmbeddingSpace, deadline: Deadline): Promise<number[][]> {
    await this.assertCurrent(space, deadline);
    // Count-derived allowance plus a fixed hard cap limits even adversarial numeric encodings.
    const limit = Math.min(MAX_EMBEDDING_RESPONSE_BYTES, count * SEARCH_EMBEDDING_DIMENSIONS * 48 + 4096);
    const result = object(await this.json("/api/embed", body, limit, deadline));
    if (typeof result.model !== "string" || canonicalEmbeddingModel(result.model) !== this.model) fail();
    if (!Array.isArray(result.embeddings) || result.embeddings.length !== count) fail();
    const vectors = result.embeddings.map((vector: unknown) => normalizeSearchVector(vector));
    deadline.check();
    await this.assertCurrent(space, deadline);
    return vectors;
  }

  private async json(path: string, body: unknown, limit: number, deadline: Deadline): Promise<unknown> {
    deadline.check();
    const transport = this.fetcher(`${this.baseUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) }),
      signal: deadline.signal,
      redirect: "error",
    }).then((response) => {
      if (deadline.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        deadline.check();
      }
      return response;
    });
    const response = await abortable(transport, deadline);
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return fail("search_embedding_unavailable");
    }
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > limit)) {
      void response.body?.cancel().catch(() => undefined);
      return fail();
    }
    if (!response.body) fail();
    const reader = response.body.getReader();
    const cancel = (): void => { void reader.cancel().catch(() => undefined); };
    deadline.signal.addEventListener("abort", cancel, { once: true });
    const parts: Uint8Array[] = [];
    let bytes = 0;
    let complete = false;
    try {
      for (;;) {
        deadline.check();
        const part = await abortable(reader.read(), deadline);
        deadline.check();
        if (part.done) { complete = true; break; }
        bytes += part.value.byteLength;
        if (bytes > limit) fail();
        parts.push(part.value);
      }
      try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts, bytes))) as unknown; }
      catch { return fail(); }
    } finally {
      deadline.signal.removeEventListener("abort", cancel);
      if (!complete) cancel();
      reader.releaseLock();
    }
  }
}

/** Scale first to avoid overflow/underflow, then L2 normalize for cosine retrieval. */
export function normalizeSearchVector(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== SEARCH_EMBEDDING_DIMENSIONS) fail();
  let maximum = 0;
  for (const element of value) {
    if (typeof element !== "number" || !Number.isFinite(element)) fail();
    maximum = Math.max(maximum, Math.abs(element));
  }
  if (maximum === 0) fail();
  const scaled = (value as number[]).map((element) => element / maximum);
  const norm = Math.sqrt(scaled.reduce((sum, element) => sum + element * element, 0));
  return scaled.map((element) => element / norm);
}
