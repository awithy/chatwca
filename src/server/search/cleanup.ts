import path from "node:path";
import { performance } from "node:perf_hooks";
import type { SearchInvalidation } from "./authority.js";
import { SearchRepositoryError, SearchSourceError } from "./errors.js";
import { isWellFormedText } from "./extract.js";
import { MAX_SEARCH_CHECKPOINT_PAGE, type SearchDocumentCheckpoint, type SearchDocumentDeletion, type SearchIndexRepository } from "./repository.js";

export const MAX_SEARCH_CLEANUP_DOCUMENTS = MAX_SEARCH_CHECKPOINT_PAGE;
export const SEARCH_CLEANUP_TIMEOUT_MS = 5_000;
export interface SearchCleanupCursor {
  readonly pathIndex: number;
  readonly afterSessionId: string | null;
}
export interface SearchCleanupOptions {
  readonly signal?: AbortSignal;
  /** Continuation of this exact private ticket, never a fresh deletion authorization. */
  readonly cursor?: SearchCleanupCursor;
}
export interface SearchCleanupResult {
  readonly deleted: number;
  readonly skipped: number;
  readonly next: SearchCleanupCursor | null;
}
type Repository = Pick<SearchIndexRepository, "readCheckpoint" | "readCheckpointPage" | "deleteDocumentVersion" | "deleteWorkspace">;
function invalid(): never { throw new SearchRepositoryError("search_index_invalid"); }
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) invalid();
  return value;
}
function sourcePath(value: string): string {
  if (typeof value !== "string" || !isWellFormedText(value) || value.includes("\0") || Buffer.byteLength(value) > 4096 ||
      !path.isAbsolute(value) || path.normalize(value) !== value) invalid();
  return value;
}
function deletion(saved: SearchDocumentCheckpoint, workspaceId: string, sourceRevision: string, sessionId?: string, exactPath?: string): SearchDocumentDeletion {
  if (!saved || saved.workspaceId !== workspaceId || saved.sourceRevision !== sourceRevision ||
      (sessionId !== undefined && saved.sessionId !== sessionId) || (exactPath !== undefined && saved.sourcePath !== exactPath)) {
    throw new SearchRepositoryError("search_database_unavailable");
  }
  return Object.freeze({ workspaceId, sourceRevision, sessionId: identifier(saved.sessionId), sourcePath: sourcePath(saved.sourcePath), documentId: saved.documentId, generation: saved.generation });
}

/** Explicit, unwired cleanup of known invalidations only. No queue, retry, scan/pruning, or suppression release. */
export class SearchIndexCleanup {
  private active: AbortController | undefined;
  private closed = false;
  constructor(private readonly repository: Repository, private readonly timeoutMs = SEARCH_CLEANUP_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SEARCH_CLEANUP_TIMEOUT_MS) invalid();
  }
  close(): void { this.closed = true; this.active?.abort(new SearchRepositoryError("search_cancelled")); }

  async clean(intent: SearchInvalidation, request: SearchCleanupOptions = {}): Promise<SearchCleanupResult> {
    if (this.closed || request.signal?.aborted) throw new SearchRepositoryError("search_cancelled");
    if (this.active) throw new SearchRepositoryError("search_busy");
    if (!intent || typeof intent.assertCurrent !== "function") invalid();
    const workspaceId = identifier(intent.workspaceId);
    const sourceRevision = intent.sourceRevision;
    if (typeof sourceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(sourceRevision)) invalid();
    const kind = intent.kind;
    if (kind !== "workspace" && kind !== "session" && kind !== "paths") invalid();
    const sessionId = kind === "session" ? identifier(intent.sessionId) : undefined;
    if (kind === "paths" && (!Array.isArray(intent.paths) || intent.paths.length < 1 || intent.paths.length > 2)) invalid();
    const paths = kind === "paths" ? Object.freeze([...intent.paths].map(sourcePath)) : [];
    if (new Set(paths).size !== paths.length) invalid();
    const assertIntent = intent.assertCurrent.bind(intent);
    let pathIndex = request.cursor?.pathIndex ?? 0;
    let afterSessionId = request.cursor?.afterSessionId ?? null;
    if (request.cursor !== undefined && (kind !== "paths" || !request.cursor || !Number.isSafeInteger(request.cursor.pathIndex) || pathIndex < 0 || pathIndex >= paths.length ||
        (request.cursor.afterSessionId !== null && typeof request.cursor.afterSessionId !== "string"))) invalid();
    if (afterSessionId !== null) afterSessionId = identifier(afterSessionId);
    const scope = Object.freeze({ workspaceId, sourceRevision });
    const callerSignal = request.signal;
    const controller = new AbortController();
    this.active = controller;
    const expiresAt = performance.now() + this.timeoutMs;
    const callerAbort = (): void => controller.abort(new SearchRepositoryError("search_cancelled"));
    callerSignal?.addEventListener("abort", callerAbort, { once: true });
    if (callerSignal?.aborted) callerAbort();
    const timeout = (): void => controller.abort(new SearchRepositoryError("search_timeout"));
    const timer = setTimeout(timeout, this.timeoutMs); timer.unref();
    const check = (): undefined => {
      if (!controller.signal.aborted && performance.now() >= expiresAt) timeout();
      if (controller.signal.aborted) throw controller.signal.reason as SearchRepositoryError;
      try { if (assertIntent() !== undefined) invalid(); }
      catch (error) {
        if (error instanceof SearchRepositoryError) throw error;
        if (error instanceof SearchSourceError) throw new SearchRepositoryError(error.code === "search_source_changed" ? "search_source_changed" : "search_scope_unavailable");
        throw new SearchRepositoryError("search_source_changed");
      }
    };
    const options = { signal: controller.signal, assertCurrent: check };
    const call = async <T>(task: () => Promise<T>): Promise<T> => {
      check();
      let abort!: () => void;
      try {
        const result = await new Promise<T>((resolve, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", abort, { once: true });
          Promise.resolve().then(() => { check(); return task(); }).then(resolve, reject);
          if (controller.signal.aborted) abort();
        });
        check();
        return result;
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason as SearchRepositoryError;
        if (error instanceof SearchRepositoryError) throw error;
        throw new SearchRepositoryError("search_database_unavailable");
      } finally { controller.signal.removeEventListener("abort", abort); }
    };
    let deleted = 0; let skipped = 0;
    const remove = async (target: SearchDocumentDeletion): Promise<void> => {
      const removed = await call(() => this.repository.deleteDocumentVersion(target, options));
      if (typeof removed !== "boolean") throw new SearchRepositoryError("search_database_unavailable");
      if (removed) deleted += 1; else skipped += 1;
    };
    try {
      if (kind === "workspace") {
        const removed = await call(() => this.repository.deleteWorkspace(scope, options));
        if (typeof removed !== "boolean") throw new SearchRepositoryError("search_database_unavailable");
        return Object.freeze({ deleted: removed ? 1 : 0, skipped: removed ? 0 : 1, next: null });
      }
      if (kind === "session") {
        const saved = await call(() => this.repository.readCheckpoint(scope, sessionId!, options));
        if (saved !== null) await remove(deletion(saved, workspaceId, sourceRevision, sessionId));
        return Object.freeze({ deleted, skipped: saved === null ? 1 : skipped, next: null });
      }
      while (pathIndex < paths.length) {
        const exactPath = paths[pathIndex]!;
        const remaining = MAX_SEARCH_CLEANUP_DOCUMENTS - deleted - skipped;
        const page = await call(() => this.repository.readCheckpointPage(scope, { sourcePath: exactPath, afterSessionId, limit: remaining }, options));
        if (!page || !Array.isArray(page.checkpoints) || page.checkpoints.length > remaining) throw new SearchRepositoryError("search_database_unavailable");
        let last = afterSessionId ?? "";
        const targets = page.checkpoints.map((saved) => {
          const target = deletion(saved, workspaceId, sourceRevision, undefined, exactPath);
          if (target.sessionId <= last) throw new SearchRepositoryError("search_database_unavailable");
          last = target.sessionId; return target;
        });
        if (page.nextAfterSessionId !== null && (targets.length !== remaining || page.nextAfterSessionId !== last)) throw new SearchRepositoryError("search_database_unavailable");
        for (const target of targets) await remove(target);
        if (page.nextAfterSessionId !== null) afterSessionId = page.nextAfterSessionId;
        else { pathIndex += 1; afterSessionId = null; }
        if (deleted + skipped === MAX_SEARCH_CLEANUP_DOCUMENTS && pathIndex < paths.length) {
          return Object.freeze({ deleted, skipped, next: Object.freeze({ pathIndex, afterSessionId }) });
        }
      }
      return Object.freeze({ deleted, skipped, next: null });
    } finally {
      clearTimeout(timer); callerSignal?.removeEventListener("abort", callerAbort); this.active = undefined;
    }
  }
}
