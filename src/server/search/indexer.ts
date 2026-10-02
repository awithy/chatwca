import { randomUUID } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { scopedSessionStorePath, type SessionWorkspaceScope } from "../session-scope.js";
import type { SearchRepositoryOptions } from "./database.js";
import { SearchDocumentIndexer, type SearchDocumentEmbeddings, type SearchDocumentIndexRequest, type SearchDocumentIndexResult } from "./document-indexer.js";
import type { SearchEmbeddingOptions } from "./embeddings.js";
import { SearchEmbeddingError, SearchRepositoryError, SearchSourceError } from "./errors.js";
import { isWellFormedText } from "./extract.js";
import { MAX_SEARCH_CHECKPOINT_PAGE, type SearchIndexRepository, type SearchRepositoryScope, type SearchRepositoryWorkspace } from "./repository.js";
import { assertSessionDiscoveryCurrent, discoverSessionFiles, workspaceSourceRevision, type SessionDiscovery } from "./session-source.js";
import type { SearchEmbeddingSpace } from "./signatures.js";

export interface SearchRegisteredWorkspace extends SessionWorkspaceScope { readonly name: string }
export interface SearchIndexerRegistrations { list(): readonly SearchRegisteredWorkspace[] }
export interface SearchIndexerEmbeddings extends SearchDocumentEmbeddings {
  resolveSpace(options?: SearchEmbeddingOptions): Promise<SearchEmbeddingSpace>;
}
export interface SearchIndexerSources {
  discover(workspace: SessionWorkspaceScope, piAgentDirectory: string, signal?: AbortSignal): Promise<SessionDiscovery>;
  assertDiscoveryCurrent(discovery: SessionDiscovery): Promise<void>;
}
export interface SearchIndexerDocuments {
  index(request: SearchDocumentIndexRequest): Promise<SearchDocumentIndexResult>;
  close(): void;
}
type Repository = Pick<SearchIndexRepository, "readWorkspace" | "readWorkspacePage" | "synchronizeWorkspace" | "readCheckpointPage" | "deleteDocumentVersion" | "deleteWorkspace">;
export interface SearchIndexerOptions {
  readonly repository: SearchIndexRepository;
  readonly registrations: SearchIndexerRegistrations;
  readonly embeddings: SearchIndexerEmbeddings;
  readonly piAgentDirectory: string;
  readonly sources?: SearchIndexerSources;
  readonly documents?: SearchIndexerDocuments;
  readonly clock?: () => number;
}
export interface SearchRefreshRequest {
  /** null/omitted means all currently registered stores. */
  readonly workspaceId?: string | null;
  readonly rebuild?: boolean;
}
export type SearchIndexerErrorCode = SearchRepositoryError["code"] | SearchEmbeddingError["code"] | SearchSourceError["code"];
export interface SearchIndexerError { readonly workspaceId: string | null; readonly code: SearchIndexerErrorCode }
export interface SearchIndexerProgress {
  readonly workspaces: number;
  readonly discovered: number;
  readonly published: number;
  readonly unchanged: number;
  readonly failed: number;
  readonly deleted: number;
  readonly removedWorkspaces: number;
}
export interface SearchIndexerStatus {
  readonly state: "idle" | "indexing" | "unavailable" | "closed";
  readonly pending: boolean;
  readonly workspaceId: string | null;
  readonly startedAt: number | null;
  readonly completedAt: number | null;
  readonly lastSucceededAt: number | null;
  /** Counts describe the current/last pass, not total cached corpus coverage. */
  readonly progress: SearchIndexerProgress;
  readonly errorCount: number;
  readonly errors: readonly SearchIndexerError[];
}
export const MAX_SEARCH_INDEXER_ERRORS = 100;
interface Pending { workspaceIds: Set<string> | null; force: boolean }
const emptyProgress = (): SearchIndexerProgress => ({ workspaces: 0, discovered: 0, published: 0, unchanged: 0, failed: 0, deleted: 0, removedWorkspaces: 0 });
const defaultSources: SearchIndexerSources = { discover: discoverSessionFiles, assertDiscoveryCurrent: assertSessionDiscoveryCurrent };
function cancelled(): never { throw new SearchRepositoryError("search_cancelled"); }
function safeError(error: unknown, fallback: SearchIndexerErrorCode): SearchIndexerErrorCode {
  return error instanceof SearchRepositoryError || error instanceof SearchEmbeddingError || error instanceof SearchSourceError ? error.code : fallback;
}

/** One process-owned writer. No startup IO, timer, pool ownership, authority or cleanup queue. */
export class SearchIndexer {
  private readonly repository: Repository;
  private readonly documents: SearchIndexerDocuments;
  private readonly sources: SearchIndexerSources;
  private readonly clock: () => number;
  private pending: Pending | null = null;
  private running: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private closed = false;
  private statusValue: SearchIndexerStatus = { state: "idle", pending: false, workspaceId: null, startedAt: null, completedAt: null,
    lastSucceededAt: null, progress: emptyProgress(), errorCount: 0, errors: [] };

  constructor(private readonly options: SearchIndexerOptions) {
    this.repository = options.repository;
    this.documents = options.documents ?? new SearchDocumentIndexer(options.repository, options.embeddings);
    this.sources = options.sources ?? defaultSources;
    this.clock = options.clock ?? Date.now;
  }

  status(): SearchIndexerStatus {
    return Object.freeze({ ...this.statusValue, pending: this.pending !== null, progress: Object.freeze({ ...this.statusValue.progress }),
      errors: Object.freeze(this.statusValue.errors.map((error) => Object.freeze({ ...error }))) });
  }

  /** Returns immediately. While busy, union scopes into ONE pending pass; rebuild promotes it to forced rereading. */
  requestRefresh(request: SearchRefreshRequest = {}): void {
    if (this.closed) cancelled();
    const id = request.workspaceId ?? null;
    if (id !== null && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(id)) throw new SearchRepositoryError("search_index_invalid");
    if (this.pending === null) this.pending = { workspaceIds: id === null ? null : new Set([id]), force: request.rebuild === true };
    else {
      if (id === null) this.pending.workspaceIds = null;
      else this.pending.workspaceIds?.add(id);
      this.pending.force ||= request.rebuild === true;
    }
    this.schedule();
  }

  private schedule(): void {
    if (!this.running && !this.closed && this.pending) {
      this.running = Promise.resolve().then(() => this.drain()).finally(() => {
        this.running = undefined;
        // A request arriving between drain completion and this finalizer must not be lost.
        this.schedule();
      });
    }
  }

  /** Wait for admitted/coalesced work. Dependency failures are reported by status, not unhandled rejections. */
  async idle(): Promise<void> { while (this.running) await this.running; }

  /** Stop admission, discard pending work and cancel the active pass. Caller closes embedder/repository/pool separately. */
  async close(): Promise<void> {
    this.closed = true;
    this.pending = null;
    this.controller?.abort();
    this.documents.close();
    await this.idle();
    this.statusValue = { ...this.statusValue, state: "closed", workspaceId: null };
  }

  private registrations(): readonly SearchRegisteredWorkspace[] {
    try {
      const seen = new Set<string>();
      return this.options.registrations.list().map((workspace) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(workspace.id) || seen.has(workspace.id) ||
            !workspace.name.trim() || workspace.name.includes("\0") || !isWellFormedText(workspace.name) || Buffer.byteLength(workspace.name) > 2048) {
          throw new Error("invalid registration");
        }
        seen.add(workspace.id);
        return Object.freeze({ id: workspace.id, name: workspace.name, path: workspace.path, sessionDirectory: workspace.sessionDirectory });
      });
    } catch { throw new SearchSourceError("search_scope_unavailable"); }
  }

  private current(workspace: SearchRegisteredWorkspace): boolean {
    const current = this.registrations().find((item) => item.id === workspace.id);
    if (current && current.name === workspace.name && current.path === workspace.path && current.sessionDirectory === workspace.sessionDirectory) return true;
    // An ordinary workspace-boundary comparison, not per-document epoch/commit seals.
    this.error(workspace.id, "search_source_changed");
    this.requestRefresh();
    return false;
  }

  private error(workspaceId: string | null, code: SearchIndexerErrorCode): void {
    this.statusValue = { ...this.statusValue, errorCount: this.statusValue.errorCount + 1,
      errors: this.statusValue.errors.length < MAX_SEARCH_INDEXER_ERRORS ? [...this.statusValue.errors, { workspaceId, code }] : this.statusValue.errors };
  }
  private increment(key: keyof SearchIndexerProgress, amount = 1): void {
    this.statusValue = { ...this.statusValue, progress: { ...this.statusValue.progress, [key]: this.statusValue.progress[key] + amount } };
  }
  private check(): undefined { if (this.closed || this.controller?.signal.aborted) cancelled(); }

  /** Cancellation also bounds injected adapters that ignore AbortSignal; late results cannot resume this worker. */
  private async call<T>(task: () => Promise<T>, fallback: SearchIndexerErrorCode): Promise<T> {
    this.check();
    const signal = this.controller!.signal;
    let abort: (() => void) | undefined;
    try {
      const result = await new Promise<T>((resolve, reject) => {
        abort = () => reject(new SearchRepositoryError("search_cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => { this.check(); return task(); }).then(resolve, reject);
        if (signal.aborted) abort();
      });
      this.check();
      return result;
    } catch (error) {
      this.check();
      if (error instanceof SearchRepositoryError || error instanceof SearchEmbeddingError || error instanceof SearchSourceError) throw error;
      if (fallback === "search_database_unavailable") throw new SearchRepositoryError(fallback);
      if (fallback === "search_embedding_unavailable") throw new SearchEmbeddingError(fallback);
      throw new SearchSourceError("search_scope_unavailable");
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  }

  private async drain(): Promise<void> {
    while (this.pending && !this.closed) {
      const request = this.pending; this.pending = null;
      this.controller = new AbortController();
      this.statusValue = { ...this.statusValue, state: "indexing", workspaceId: null, startedAt: this.clock(), completedAt: null,
        progress: emptyProgress(), errorCount: 0, errors: [] };
      try {
        await this.pass(request);
        this.check();
        const completedAt = this.clock();
        this.statusValue = { ...this.statusValue, state: "idle", completedAt, workspaceId: null,
          lastSucceededAt: this.statusValue.errorCount === 0 ? completedAt : this.statusValue.lastSucceededAt };
      } catch (error) {
        if (!this.closed) {
          this.error(this.statusValue.workspaceId, safeError(error, "search_database_unavailable"));
          this.statusValue = { ...this.statusValue, state: "unavailable", completedAt: this.clock(), workspaceId: null };
        }
      } finally { this.controller = undefined; }
    }
  }

  private async pass(request: Pending): Promise<void> {
    const registered = this.registrations();
    const options: SearchRepositoryOptions = { signal: this.controller!.signal, assertCurrent: () => this.check() };
    const scanId = randomUUID();
    let space: SearchEmbeddingSpace | null | undefined;
    for (const workspace of registered) {
      this.check();
      if (request.workspaceIds && !request.workspaceIds.has(workspace.id)) continue;
      this.statusValue = { ...this.statusValue, workspaceId: workspace.id };
      if (!this.current(workspace)) continue;
      this.increment("workspaces");
      const scope = { workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, this.options.piAgentDirectory) };
      const target: SearchRepositoryWorkspace = { ...scope, displayName: workspace.name, canonicalPath: workspace.path,
        sessionDirectory: scopedSessionStorePath(workspace, this.options.piAgentDirectory) };
      const previous = await this.call(() => this.repository.readWorkspace(workspace.id, options), "search_database_unavailable");
      if (!previous || previous.sourceRevision !== target.sourceRevision || previous.displayName !== target.displayName ||
          previous.canonicalPath !== target.canonicalPath || previous.sessionDirectory !== target.sessionDirectory) {
        await this.call(() => this.repository.synchronizeWorkspace(target, previous?.sourceRevision ?? null, options), "search_database_unavailable");
      }
      let discovery: SessionDiscovery;
      try { discovery = await this.call(() => this.sources.discover(workspace, this.options.piAgentDirectory, options.signal), "search_scope_unavailable"); }
      catch (error) { this.check(); this.error(workspace.id, safeError(error, "search_scope_unavailable")); continue; }
      for (const error of discovery.errors) this.error(workspace.id, error.code);
      if (!discovery.complete && discovery.errors.length === 0) this.error(workspace.id, "search_source_changed");
      this.increment("discovered", discovery.candidates.length);
      const seen = new Set(discovery.seenPaths);
      for (const candidate of discovery.candidates) seen.add(candidate.canonicalPath);
      if (discovery.candidates.length && space === undefined) {
        try { space = await this.call(() => this.options.embeddings.resolveSpace({ signal: this.controller!.signal }), "search_embedding_unavailable"); }
        catch (error) { this.check(); space = null; this.error(null, safeError(error, "search_embedding_unavailable")); }
      }
      if (space) {
        const documentSpace = space;
        const processedPaths = new Set<string>();
        for (const candidate of discovery.candidates) {
          this.check();
          if (processedPaths.has(candidate.canonicalPath)) continue;
          // Only deduplicate successful alias reads; another alias may survive a failed read.
          let result: SearchDocumentIndexResult;
          try {
            result = await this.call(() => this.documents.index({ workspace, candidate, space: documentSpace, scanId, force: request.force, signal: this.controller!.signal }), "search_database_unavailable");
          } catch (error) {
            this.check();
            if (error instanceof SearchRepositoryError && !["search_source_changed", "search_session_limit"].includes(error.code)) throw error;
            this.increment("failed"); this.error(workspace.id, safeError(error, "search_database_unavailable"));
            await yieldToEventLoop(); continue;
          }
          processedPaths.add(candidate.canonicalPath);
          this.increment(result.status === "published" ? "published" : "unchanged");
          if (result.status === "published") await this.prune(scope, options, { sourcePath: candidate.canonicalPath, keepSessionId: result.sessionId });
          await yieldToEventLoop();
        }
      }
      this.check();
      if (!this.current(workspace)) continue;
      if (discovery.complete) {
        try { await this.call(() => this.sources.assertDiscoveryCurrent(discovery), "search_scope_unavailable"); }
        catch (error) { this.check(); this.error(workspace.id, safeError(error, "search_source_changed")); continue; }
        await this.prune(scope, options, { seen });
      }
    }
    this.statusValue = { ...this.statusValue, workspaceId: null };
    // Fresh ordinary registration filter; persisted metadata finds orphans after restart.
    const currentIds = new Set(this.registrations().map((workspace) => workspace.id));
    let afterWorkspaceId: string | null = null;
    do {
      const page = await this.call(() => this.repository.readWorkspacePage({ afterWorkspaceId, limit: MAX_SEARCH_CHECKPOINT_PAGE }, options), "search_database_unavailable");
      for (const workspace of page.workspaces) {
        if (!currentIds.has(workspace.workspaceId) && await this.call(() => this.repository.deleteWorkspace(workspace, options), "search_database_unavailable")) {
          this.increment("removedWorkspaces");
        }
      }
      afterWorkspaceId = page.nextAfterWorkspaceId;
    } while (afterWorkspaceId !== null);
  }

  private async prune(scope: SearchRepositoryScope, options: SearchRepositoryOptions, filter: { readonly seen?: ReadonlySet<string>; readonly sourcePath?: string; readonly keepSessionId?: string }): Promise<void> {
    let afterSessionId: string | null = null;
    do {
      const page = await this.call(() => this.repository.readCheckpointPage(scope, { afterSessionId, limit: MAX_SEARCH_CHECKPOINT_PAGE,
        ...(filter.sourcePath === undefined ? {} : { sourcePath: filter.sourcePath }) }, options), "search_database_unavailable");
      for (const saved of page.checkpoints) {
        if (filter.seen?.has(saved.sourcePath) || saved.sessionId === filter.keepSessionId) continue;
        if (await this.call(() => this.repository.deleteDocumentVersion(saved, options), "search_database_unavailable")) this.increment("deleted");
      }
      afterSessionId = page.nextAfterSessionId;
    } while (afterSessionId !== null);
  }
}
