import path from "node:path";
import { performance } from "node:perf_hooks";
import type { SessionWorkspaceScope } from "../session-scope.js";
import { scopedSessionStorePath } from "../session-scope.js";
import { SearchIndexAuthority } from "./authority.js";
import { SearchRepositoryError, SearchSourceError } from "./errors.js";
import { isWellFormedText } from "./extract.js";
import type { SearchIndexRepository, SearchRepositoryWorkspace } from "./repository.js";
import { workspaceSourceRevision } from "./session-source.js";

export const SEARCH_WORKSPACE_SYNC_TIMEOUT_MS = 5_000;
export interface SearchWorkspaceRegistrations {
  /** Fresh synchronous SQLite read including display metadata; never a cached runtime or PostgreSQL row. */
  read(workspaceId: string): (SessionWorkspaceScope & { readonly name: string }) | null;
}
export interface SearchWorkspaceSyncResult {
  readonly status: "created" | "updated" | "unchanged";
  readonly workspace: SearchRepositoryWorkspace;
}
type Repository = Pick<SearchIndexRepository, "readWorkspace" | "synchronizeWorkspace">;
function invalid(): never { throw new SearchRepositoryError("search_index_invalid"); }
function unavailable(): never { throw new SearchRepositoryError("search_scope_unavailable"); }
function sourcePath(value: string): string {
  if (typeof value !== "string" || !value || !isWellFormedText(value) || value.includes("\0") || Buffer.byteLength(value) > 4096 ||
      !path.isAbsolute(value) || path.normalize(value) !== value) unavailable();
  return value;
}
function displayName(value: string): string {
  if (typeof value !== "string" || !value.trim() || !isWellFormedText(value) || value.includes("\0") || Buffer.byteLength(value) > 2048) unavailable();
  return value;
}

/**
 * Explicit, unwired preparation for a future pass. Canonical workspace admission is
 * NOT store discovery, positive membership, suppression recovery or pruning authority.
 * Uses the SAME fresh registry/authority as document work; owns neither dependency.
 */
export class SearchWorkspaceSynchronizer {
  private active: AbortController | undefined;
  private closed = false;
  private readonly piAgentDirectory: string;
  constructor(
    private readonly repository: Repository,
    private readonly registrations: SearchWorkspaceRegistrations,
    private readonly authority: SearchIndexAuthority,
    piAgentDirectory: string,
    private readonly timeoutMs = SEARCH_WORKSPACE_SYNC_TIMEOUT_MS,
  ) {
    this.piAgentDirectory = sourcePath(piAgentDirectory);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > SEARCH_WORKSPACE_SYNC_TIMEOUT_MS) invalid();
  }
  close(): void { this.closed = true; this.active?.abort(new SearchRepositoryError("search_cancelled")); }
  private read(workspaceId: string): SessionWorkspaceScope & { readonly name: string } {
    let current: ReturnType<SearchWorkspaceRegistrations["read"]>;
    try { current = this.registrations.read(workspaceId); } catch { unavailable(); }
    if (!current || current.id !== workspaceId) unavailable();
    return Object.freeze({ id: workspaceId, name: displayName(current.name), path: sourcePath(current.path),
      sessionDirectory: current.sessionDirectory === null ? null : sourcePath(current.sessionDirectory) });
  }

  async synchronize(workspaceId: string, request: { readonly signal?: AbortSignal } = {}): Promise<SearchWorkspaceSyncResult> {
    if (this.closed || request.signal?.aborted) throw new SearchRepositoryError("search_cancelled");
    if (this.active) throw new SearchRepositoryError("search_busy");
    if (typeof workspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(workspaceId)) invalid();
    const callerSignal = request.signal;
    const controller = new AbortController(); this.active = controller;
    const expiresAt = performance.now() + this.timeoutMs;
    const callerAbort = (): void => controller.abort(new SearchRepositoryError("search_cancelled"));
    callerSignal?.addEventListener("abort", callerAbort, { once: true });
    if (callerSignal?.aborted) callerAbort();
    const timeout = (): void => controller.abort(new SearchRepositoryError("search_timeout"));
    const timer = setTimeout(timeout, this.timeoutMs); timer.unref();
    const checkCancelled = (): undefined => {
      if (!controller.signal.aborted && performance.now() >= expiresAt) timeout();
      if (controller.signal.aborted) throw controller.signal.reason as SearchRepositoryError;
    };
    const call = async <T>(task: () => Promise<T>, check: () => undefined): Promise<T> => {
      check();
      let abort!: () => void;
      try {
        const result = await new Promise<T>((resolve, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", abort, { once: true });
          Promise.resolve().then(() => { check(); return task(); }).then(resolve, reject);
          if (controller.signal.aborted) abort();
        });
        check(); return result;
      } finally { controller.signal.removeEventListener("abort", abort); }
    };
    try {
      checkCancelled();
      const registered = this.read(workspaceId);
      this.authority.admitWorkspace(workspaceId);
      const seal = this.authority.captureWorkspace(registered);
      if (seal.scope.sourceRevision !== workspaceSourceRevision(registered, this.piAgentDirectory)) unavailable();
      const target = Object.freeze({ ...seal.scope, displayName: registered.name, canonicalPath: registered.path,
        sessionDirectory: scopedSessionStorePath(registered, this.piAgentDirectory) });
      const check = (): undefined => {
        checkCancelled(); seal.assertCurrent();
        const current = this.read(workspaceId);
        if (current.name !== registered.name || current.path !== registered.path || current.sessionDirectory !== registered.sessionDirectory) {
          throw new SearchRepositoryError("search_source_changed");
        }
      };
      const options = { signal: controller.signal, assertCurrent: check };
      await call(() => seal.revalidate(controller.signal), check);
      const previous = await call(() => this.repository.readWorkspace(workspaceId, options), check);
      // Snapshot derived metadata before another await. It supplies only CAS, never admission.
      const observed = previous === null ? null : Object.freeze({ ...previous });
      if (observed !== null && (observed.workspaceId !== workspaceId || !/^[a-f0-9]{64}$/u.test(observed.sourceRevision))) {
        throw new SearchRepositoryError("search_database_unavailable");
      }
      const unchanged = observed !== null && observed.sourceRevision === target.sourceRevision && observed.displayName === target.displayName &&
        observed.canonicalPath === target.canonicalPath && observed.sessionDirectory === target.sessionDirectory;
      await call(() => seal.revalidate(controller.signal), check);
      if (!unchanged) await call(() => this.repository.synchronizeWorkspace(target, observed?.sourceRevision ?? null, options), check);
      check();
      return Object.freeze({ status: unchanged ? "unchanged" : observed === null ? "created" : "updated", workspace: target });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason as SearchRepositoryError;
      if (error instanceof SearchRepositoryError || error instanceof SearchSourceError) throw error;
      throw new SearchRepositoryError("search_database_unavailable");
    } finally {
      clearTimeout(timer); callerSignal?.removeEventListener("abort", callerAbort); this.active = undefined;
    }
  }
}
