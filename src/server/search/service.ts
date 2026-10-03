import { performance } from "node:perf_hooks";
import type { PublicSearchConfig, SearchAvailability, SearchCounts, SearchFreshness, SearchStatus } from "../../shared/search.js";
import type { SearchConfig } from "./config.js";
import type { SearchRepositoryOptions } from "./database.js";
import { OllamaSearchEmbeddings } from "./embeddings.js";
import { ConversationReadError, SearchQueryError, SearchRepositoryError, type SearchQueryErrorCode } from "./errors.js";
import { SearchIndexer, type SearchIndexerRegistrations, type SearchIndexerStatus, type SearchRefreshRequest } from "./indexer.js";
import { checkSearchSchema, loadSearchMigrations } from "./migrations.js";
import { createSearchPool } from "./postgres.js";
import { SearchQueryService, validateSearchQueryRequest, type SearchQueryRequest, type SearchQueryResponse } from "./query.js";
import { PostgresSearchRepository, type SearchRepositoryScope } from "./repository.js";
import { PostgresSearchRetrieval } from "./retrieval.js";
import { workspaceSourceRevision } from "./session-source.js";
import { PiSearchReranker, type SearchRerankerOptions } from "./rerank.js";
import { validateConversationReadRequest, type ConversationReadPage, type ConversationReadRequest } from "./read-page.js";
import { conversationReadPageBudget, MAX_CONVERSATION_CONCURRENT_READS, PostgresConversationReader, type ConversationReadOptions, type ConversationReadRepository } from "./read-repository.js";

export const MAX_CONVERSATION_READ_TIMEOUT_MS = 10_000;
export interface ConversationReadResponse extends ConversationReadPage {
  readonly freshness: SearchFreshness;
}

export interface SearchServiceStatus extends SearchStatus {
  readonly mode: SearchConfig["mode"];
  readonly available: boolean;
  readonly counts: SearchCounts | null;
  readonly indexer: SearchIndexerStatus | null;
}
export interface SearchServicePort {
  start(): void;
  capability(): PublicSearchConfig;
  freshness(): SearchFreshness;
  status(options?: SearchRepositoryOptions): Promise<SearchServiceStatus>;
  search(request: SearchQueryRequest, options?: SearchRepositoryOptions): Promise<SearchQueryResponse>;
  read(request: ConversationReadRequest, options?: ConversationReadOptions): Promise<ConversationReadResponse>;
  requestRefresh(request?: SearchRefreshRequest): void;
  /** Synchronous admission/cancellation boundary; returned promise includes pool closure. */
  close(): Promise<void>;
}
export interface SearchServiceResources {
  readonly indexer: Pick<SearchIndexer, "status" | "requestRefresh" | "close">;
  readonly queries: Pick<SearchQueryService, "search" | "close">;
  readonly reads: ConversationReadRepository;
  checkSchema(options: SearchRepositoryOptions): Promise<void>;
  readCounts(scopes: readonly SearchRepositoryScope[], options: SearchRepositoryOptions): Promise<SearchCounts>;
  /** Cancels all IO synchronously, then closes the pool. */
  close(): Promise<void>;
}
export interface SearchServiceOptions {
  readonly config: Readonly<SearchConfig>;
  readonly registrations: SearchIndexerRegistrations;
  readonly piAgentDirectory: string;
  /** Internal test override, never an environment/browser setting. */
  readonly readTimeoutMs?: number;
  /** Constructed only asynchronously in optional mode; tests use synthetic isolated dependencies. */
  readonly createResources?: (reranker?: PiSearchReranker) => SearchServiceResources;
  /** Existing Pi runtime and global-only snapshot; invoked asynchronously only in optional mode. */
  readonly getRerankContext?: () => Pick<SearchRerankerOptions, "runtime" | "globalDefaults">;
}
function safeFailure(error: unknown): SearchQueryErrorCode {
  if (error instanceof SearchQueryError) return error.code;
  if (error instanceof SearchRepositoryError && ["search_schema_incompatible", "search_busy", "search_timeout", "search_cancelled"].includes(error.code)) {
    return error.code as SearchQueryErrorCode;
  }
  return "search_database_unavailable";
}
function defaultResources(options: SearchServiceOptions, reranker?: PiSearchReranker): SearchServiceResources {
  const embeddings = new OllamaSearchEmbeddings(options.config);
  const pool = createSearchPool(options.config.databaseUrl!);
  const repository = new PostgresSearchRepository(pool);
  const reader = new PostgresSearchRetrieval(pool);
  const conversations = new PostgresConversationReader(pool);
  const indexer = new SearchIndexer({ repository, registrations: options.registrations, embeddings, piAgentDirectory: options.piAgentDirectory });
  const queries = new SearchQueryService({ repository: reader, registrations: options.registrations, embeddings, piAgentDirectory: options.piAgentDirectory,
    ...(reranker ? { reranker } : {}) });
  return {
    indexer, queries, reads: conversations,
    checkSchema: async (settings) => checkSearchSchema(pool, await loadSearchMigrations(), settings),
    readCounts: (scopes, settings) => reader.readCounts(scopes, settings),
    close: async () => {
      queries.close(); conversations.close(); embeddings.close(); reader.close(); repository.close();
      await indexer.close(); await pool.end();
    },
  };
}
interface Pending { workspaceIds: Set<string> | null; rebuild: boolean }

/** One optional process-owned service. Search startup/failure never gates chat/job readiness. */
export class SearchService implements SearchServicePort {
  private state: SearchAvailability;
  private errorCode: SearchQueryErrorCode | null = null;
  private started = false;
  private timer: NodeJS.Timeout | undefined;
  private resources: SearchServiceResources | undefined;
  private reranker: PiSearchReranker | undefined;
  private initialized = false;
  private initializing: Promise<void> | undefined;
  private pending: Pending | null = null;
  private readonly controller = new AbortController();
  private readonly activeReads = new Set<AbortController>();
  private closing: Promise<void> | undefined;

  constructor(private readonly options: SearchServiceOptions) {
    const timeout = options.readTimeoutMs ?? MAX_CONVERSATION_READ_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_CONVERSATION_READ_TIMEOUT_MS) throw new SearchQueryError("search_query_invalid");
    this.state = options.config.mode === "disabled" ? "disabled" : "initializing";
  }
  start(): void {
    if (this.started || this.state === "closed") return;
    this.started = true;
    if (this.options.config.mode === "disabled") return;
    this.timer = setInterval(() => { this.queue({}); }, this.options.config.indexIntervalMs); this.timer.unref();
    this.queue({});
  }
  capability(): PublicSearchConfig {
    return { mode: this.options.config.mode, available: this.freshness().state === "ready", state: this.freshness().state,
      rerankAvailable: this.initialized && this.state !== "closed" && (this.reranker?.available() ?? false) };
  }
  freshness(): SearchFreshness {
    const status = this.resources?.indexer.status();
    const workerUnavailable = this.initialized && status?.state === "unavailable";
    return { state: this.state === "ready" && (workerUnavailable || this.errorCode === "search_database_unavailable") ? "unavailable" : this.state,
      indexing: status?.state === "indexing", lastSucceededAt: status?.lastSucceededAt ?? null,
      errorCode: this.errorCode ?? status?.errors[0]?.code ?? (workerUnavailable ? "search_database_unavailable" : null),
      errorCount: (status?.errorCount ?? 0) + (this.errorCode ? 1 : 0) };
  }
  async status(options: SearchRepositoryOptions = {}): Promise<SearchServiceStatus> {
    let counts: SearchCounts | null = null; let errorCode: string | null = null;
    if (this.initialized && this.state !== "closed") {
      try {
        const scopes = this.options.registrations.list().map((workspace) => ({ workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, this.options.piAgentDirectory) }));
        counts = await this.resources!.readCounts(scopes, { ...options, signal: options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal });
        if (this.errorCode === "search_database_unavailable") this.errorCode = null;
      } catch (error) { errorCode = safeFailure(error); }
    }
    const freshness = this.freshness();
    return { ...freshness, state: errorCode === "search_database_unavailable" ? "unavailable" : freshness.state, errorCode: errorCode ?? freshness.errorCode,
      mode: this.options.config.mode, available: errorCode === "search_database_unavailable" ? false : this.capability().available, counts, indexer: this.resources?.indexer.status() ?? null };
  }
  async search(request: SearchQueryRequest, options: SearchRepositoryOptions = {}): Promise<SearchQueryResponse> {
    this.requireReady();
    request = validateSearchQueryRequest(request);
    try {
      const result = await this.resources!.queries.search(request, { signal: options.signal ? AbortSignal.any([options.signal, this.controller.signal]) : this.controller.signal });
      this.errorCode = null;
      return result;
    } catch (error) {
      const code = safeFailure(error);
      if (code === "search_database_unavailable") this.errorCode = code;
      throw new SearchQueryError(code);
    }
  }
  async read(input: ConversationReadRequest, options: ConversationReadOptions = {}): Promise<ConversationReadResponse> {
    this.requireReady();
    if (options.signal?.aborted) throw new SearchQueryError("search_cancelled");
    const request = validateConversationReadRequest(input);
    const maximumPageBytes = conversationReadPageBudget(options);
    if (this.activeReads.size >= MAX_CONVERSATION_CONCURRENT_READS) throw new SearchQueryError("search_busy");
    const controller = new AbortController(); this.activeReads.add(controller);
    const timeout = this.options.readTimeoutMs ?? MAX_CONVERSATION_READ_TIMEOUT_MS;
    const expiresAt = performance.now() + timeout;
    const timer = setTimeout(() => controller.abort(new SearchQueryError("search_timeout")), timeout); timer.unref();
    const abort = (): void => controller.abort(new SearchQueryError("search_cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    this.controller.signal.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted || this.controller.signal.aborted) abort();
    const check = (): void => {
      if (performance.now() >= expiresAt && !controller.signal.aborted) controller.abort(new SearchQueryError("search_timeout"));
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    let cancel: (() => void) | undefined;
    try {
      check();
      let scope: SearchRepositoryScope;
      try {
        const workspace = this.options.registrations.list().find((workspace) => workspace.id === request.workspaceId);
        if (!workspace) throw new Error("unknown scope");
        scope = { workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, this.options.piAgentDirectory) };
      } catch { throw new SearchQueryError("search_scope_unavailable"); }
      check();
      // Like query execution, race injected IO too. Late settlement cannot resume
      // this call, change freshness, or keep admission held after cancellation.
      const result = await new Promise<ConversationReadPage>((resolve, reject) => {
        cancel = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", cancel, { once: true });
        Promise.resolve().then(() => { check(); return this.resources!.reads.read(scope, request, { signal: controller.signal, maximumPageBytes }); }).then(resolve, reject);
        if (controller.signal.aborted) cancel();
      });
      check();
      this.errorCode = null;
      return { ...result, freshness: this.freshness() };
    } catch (error) {
      check();
      if (error instanceof ConversationReadError) throw error;
      const code = safeFailure(error);
      if (code === "search_database_unavailable") this.errorCode = code;
      throw new SearchQueryError(code);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      this.controller.signal.removeEventListener("abort", abort);
      if (cancel) controller.signal.removeEventListener("abort", cancel);
      this.activeReads.delete(controller);
    }
  }
  private requireReady(): void {
    if (this.state === "disabled") throw new SearchQueryError("search_disabled");
    if (this.state === "closed") throw new SearchQueryError("search_cancelled");
    if (!this.initialized) throw new SearchQueryError(this.state === "unavailable" ? this.errorCode ?? "search_database_unavailable" : "search_initializing");
  }
  requestRefresh(request: SearchRefreshRequest = {}): void {
    if (this.state === "disabled" || this.state === "closed") this.requireReady();
    const id = request.workspaceId ?? null;
    if (id !== null) {
      if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(id)) throw new SearchQueryError("search_query_invalid");
      try {
        if (!this.options.registrations.list().some((workspace) => workspace.id === id)) throw new Error("unknown workspace");
      } catch { throw new SearchQueryError("search_scope_unavailable"); }
    }
    this.queue(request);
  }
  private queue(request: SearchRefreshRequest): void {
    if (this.state === "closed" || this.state === "disabled") return;
    if (this.initialized) { this.resources!.indexer.requestRefresh(request); return; }
    const id = request.workspaceId ?? null;
    if (!this.pending) this.pending = { workspaceIds: id === null ? null : new Set([id]), rebuild: request.rebuild === true };
    else {
      if (id === null) this.pending.workspaceIds = null; else this.pending.workspaceIds?.add(id);
      this.pending.rebuild ||= request.rebuild === true;
    }
    if (!this.initializing) {
      this.state = "initializing";
      this.initializing = Promise.resolve().then(() => this.initialize()).finally(() => { this.initializing = undefined; });
    }
  }
  private async initialize(): Promise<void> {
    if (this.state === "closed") return;
    try {
      if (!this.resources) {
        try {
          const context = this.options.getRerankContext?.();
          if (context) this.reranker ??= new PiSearchReranker({ ...context, config: this.options.config });
        } catch { /* Optional Pi setup failure leaves local search usable. */ }
        this.resources = (this.options.createResources ?? ((reranker) => defaultResources(this.options, reranker)))(this.reranker);
      }
      await this.resources.checkSchema({ signal: this.controller.signal });
      if (this.controller.signal.aborted) return;
      this.initialized = true; this.state = "ready"; this.errorCode = null;
      const pending = this.pending; this.pending = null;
      if (pending) {
        if (pending.workspaceIds === null) this.resources.indexer.requestRefresh({ rebuild: pending.rebuild });
        else for (const workspaceId of pending.workspaceIds) this.resources.indexer.requestRefresh({ workspaceId, rebuild: pending.rebuild });
      }
    } catch (error) {
      if (!this.controller.signal.aborted) { this.state = "unavailable"; this.errorCode = safeFailure(error); }
    }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.state = "closed"; this.pending = null;
    if (this.timer) clearInterval(this.timer);
    this.controller.abort();
    this.reranker?.close();
    // Never wait for initialization before cancelling owned resources. PG connections are destroyed by their IO deadline/abort.
    this.closing = this.resources?.close().catch(() => undefined) ?? Promise.resolve();
    return this.closing;
  }
}
