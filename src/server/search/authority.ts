import path from "node:path";
import { requireCanonicalSessionWorkspace, scopedSessionStorePath, type SessionWorkspaceScope } from "../session-scope.js";
import { SearchRepositoryError, SearchSourceError } from "./errors.js";
import { isWellFormedText } from "./extract.js";
import type { SearchRepositoryScope } from "./repository.js";
import { workspaceSourceRevision, type SessionFileCandidate } from "./session-source.js";

export const MAX_SEARCH_AUTHORITY_IDENTITIES = 100_000;
export const MAX_SEARCH_AUTHORITY_WORKSPACES = 1_024;

/** Legacy contract for this retired, unwired authority module only. */
export interface SearchDocumentAuthority {
  assertCurrent(sessionId: string | undefined): undefined;
  revalidate(sessionId: string | undefined, signal: AbortSignal): Promise<void>;
  invalidatePrevious(candidate: SessionFileCandidate): undefined;
}

export interface SearchAuthorityRegistrations {
  /** Fresh synchronous SQLite read, NOT runtime/sandbox-policy admission or derived PostgreSQL metadata. */
  read(workspaceId: string): SessionWorkspaceScope | null;
}
type SearchInvalidationDetails =
  | (SearchRepositoryScope & { readonly kind: "workspace" })
  | (SearchRepositoryScope & { readonly kind: "session"; readonly sessionId: string })
  | (SearchRepositoryScope & { readonly kind: "paths"; readonly paths: readonly string[] });
/** Private process-local ticket. Never reconstruct its required seal from serialized metadata. */
export type SearchInvalidation = SearchInvalidationDetails & { readonly assertCurrent: () => undefined };
/** Workspace incarnation seal only; never complete source membership or pruning authority. */
export interface SearchWorkspaceAuthority {
  readonly scope: SearchRepositoryScope;
  assertCurrent(): undefined;
  revalidate(signal: AbortSignal): Promise<void>;
}
export interface SearchAuthorityOptions {
  /** Queue a bounded private intent, not deletion authority; never perform asynchronous cleanup here. */
  readonly onInvalidate: (invalidation: SearchInvalidation) => undefined;
  readonly admitSource?: (workspace: SessionWorkspaceScope) => Promise<SessionWorkspaceScope>;
  /** Tests may tighten, never raise the fixed process limits. */
  readonly maximumIdentities?: number;
  readonly maximumWorkspaces?: number;
}
interface WorkspaceState {
  readonly workspace: SessionWorkspaceScope;
  readonly scope: SearchRepositoryScope;
  readonly paths: Map<string, bigint>;
  readonly sessions: Map<string, bigint>;
  blocked: boolean;
  attemptEpoch: bigint;
}
function invalid(): never { throw new SearchRepositoryError("search_index_invalid"); }
function changed(): never { throw new SearchSourceError("search_source_changed"); }
function unavailable(): never { throw new SearchSourceError("search_scope_unavailable"); }
function identifier(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) invalid();
  return value;
}
function sourcePath(value: string): string {
  if (typeof value !== "string" || !value || value.includes("\0") || !isWellFormedText(value) ||
      Buffer.byteLength(value) > 4096 || !path.isAbsolute(value) || path.normalize(value) !== value) invalid();
  return value;
}
function limit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) invalid();
  return value;
}

/**
 * Unwired process-owned attempt seals and monotonic result suppression. No scan,
 * membership authority, DB cleanup, or suppression-release/recovery is implemented.
 * Mutation hooks MUST call invalidation after durable source/registration changes,
 * before yielding to other work. Observing only final revisions cannot detect ABA.
 */
export class SearchIndexAuthority {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly lifetime = new AbortController();
  private readonly maximumIdentities: number;
  private readonly maximumWorkspaces: number;
  private readonly piAgentDirectory: string;
  private readonly admitSource: (workspace: SessionWorkspaceScope) => Promise<SessionWorkspaceScope>;
  private readonly onInvalidate: SearchAuthorityOptions["onInvalidate"];
  private sequence = 0n;
  private identities = 0;

  constructor(private readonly registrations: SearchAuthorityRegistrations, piAgentDirectory: string, options: SearchAuthorityOptions) {
    this.piAgentDirectory = sourcePath(piAgentDirectory);
    this.maximumIdentities = limit(options.maximumIdentities, MAX_SEARCH_AUTHORITY_IDENTITIES);
    this.maximumWorkspaces = limit(options.maximumWorkspaces, MAX_SEARCH_AUTHORITY_WORKSPACES);
    this.admitSource = options.admitSource ?? requireCanonicalSessionWorkspace;
    this.onInvalidate = options.onInvalidate;
  }

  close(): void { this.lifetime.abort(); this.workspaces.clear(); this.identities = 0; }
  private checkOpen(): void {
    if (this.lifetime.signal.aborted) throw new SearchRepositoryError("search_cancelled");
  }
  private lookup(workspaceId: string): SessionWorkspaceScope | null {
    let current: SessionWorkspaceScope | null;
    try { current = this.registrations.read(workspaceId); }
    catch { return unavailable(); }
    if (current === null) return null;
    if (!current || current.id !== workspaceId) return unavailable();
    return Object.freeze({ id: identifier(current.id), path: sourcePath(current.path),
      sessionDirectory: current.sessionDirectory === null ? null : sourcePath(current.sessionDirectory) });
  }
  private read(workspaceId: string): SessionWorkspaceScope {
    return this.lookup(workspaceId) ?? unavailable();
  }
  private notify(invalidation: SearchInvalidationDetails, state: WorkspaceState, retired = false): void {
    const attemptEpoch = state.attemptEpoch;
    const sessionEpoch = invalidation.kind === "session" ? state.sessions.get(invalidation.sessionId) : undefined;
    const pathEpochs = invalidation.kind === "paths" ? invalidation.paths.map((file) => state.paths.get(file)) : [];
    const assertCurrent = (): undefined => {
      this.checkOpen();
      const registered = this.lookup(state.workspace.id);
      const revision = registered === null ? null : workspaceSourceRevision(registered, this.piAgentDirectory);
      const current = this.workspaces.get(state.workspace.id);
      if (retired) {
        // Even an as-yet unadmitted same-revision re-registration forbids delayed
        // workspace deletion. Source-revision equality alone cannot identify ABA.
        if (revision === state.scope.sourceRevision || current?.scope.sourceRevision === state.scope.sourceRevision) changed();
      } else {
        if (current !== state || revision !== state.scope.sourceRevision || state.attemptEpoch !== attemptEpoch) changed();
        if (invalidation.kind === "workspace") { if (!state.blocked) changed(); }
        else if (state.blocked || (invalidation.kind === "session" ? state.sessions.get(invalidation.sessionId) !== sessionEpoch
          : invalidation.paths.some((file, index) => state.paths.get(file) !== pathEpochs[index]))) changed();
      }
    };
    // Keep the callback non-enumerable: JSON metadata is deliberately not a reusable
    // cleanup capability. A fresh document attempt conservatively revokes all tickets
    // in that workspace, even when it later fails or targets an unrelated session.
    const ticket = Object.freeze(Object.defineProperty(invalidation, "assertCurrent", { value: assertCurrent }));
    // A broken cleanup queue must never undo the already-applied seal/suppression.
    try { this.onInvalidate(ticket as SearchInvalidation); }
    catch { unavailable(); }
  }
  private retire(state: WorkspaceState): void {
    this.workspaces.delete(state.workspace.id);
    this.identities -= state.paths.size + state.sessions.size;
    this.notify({ ...state.scope, kind: "workspace" }, state, true);
  }

  /** Explicit pass admission from current registrations; lazy construction does no reads. */
  admitWorkspace(workspaceId: string): SessionWorkspaceScope {
    this.checkOpen(); identifier(workspaceId);
    const workspace = this.read(workspaceId);
    const sourceRevision = workspaceSourceRevision(workspace, this.piAgentDirectory);
    const previous = this.workspaces.get(workspaceId);
    if (previous?.scope.sourceRevision === sourceRevision) {
      if (previous.blocked) unavailable();
      return workspace; // name/policy changes do not invalidate dialogue vectors
    }
    if (previous) this.retire(previous);
    if (this.workspaces.size >= this.maximumWorkspaces) throw new SearchRepositoryError("search_busy");
    this.workspaces.set(workspaceId, {
      workspace, scope: Object.freeze({ workspaceId, sourceRevision }),
      paths: new Map(), sessions: new Map(), blocked: false, attemptEpoch: 0n,
    });
    return workspace;
  }

  /** Call on unregister/path/storage mutation, even if the final revision later returns to the same value. */
  invalidateWorkspace(workspaceId: string): void {
    this.checkOpen(); identifier(workspaceId);
    const state = this.workspaces.get(workspaceId);
    if (state) this.retire(state);
  }
  private currentState(scope: SearchRepositoryScope): WorkspaceState | undefined {
    const state = this.workspaces.get(scope.workspaceId);
    return state?.scope.sourceRevision === scope.sourceRevision ? state : undefined;
  }
  private stamp(state: WorkspaceState, map: Map<string, bigint>, keys: readonly string[]): boolean {
    if (state.blocked) return false;
    const added = keys.filter((key) => !map.has(key)).length;
    if (this.identities + added > this.maximumIdentities) {
      // Never evict a tombstone and silently authorize stale work/results. Fail this
      // workspace closed; recovery requires a later authoritative lifecycle increment.
      state.blocked = true;
      this.identities -= state.paths.size + state.sessions.size;
      state.paths.clear(); state.sessions.clear();
      this.notify({ ...state.scope, kind: "workspace" }, state);
      return false;
    }
    this.identities += added;
    const epoch = ++this.sequence;
    for (const key of keys) map.set(key, epoch);
    return true;
  }
  /** Known deletion/rewind, including sessions not present in the derived index yet. */
  invalidateSession(scope: SearchRepositoryScope, sessionId: string): void {
    this.checkOpen(); identifier(sessionId);
    const state = this.currentState(scope);
    if (state && this.stamp(state, state.sessions, [sessionId])) this.notify({ ...state.scope, kind: "session", sessionId }, state);
  }
  /** Canonical target plus optional discovered alias; path-wide suppression covers ALL prior session IDs. */
  invalidatePaths(scope: SearchRepositoryScope, paths: readonly string[]): void {
    this.checkOpen();
    if (!Array.isArray(paths) || paths.length < 1 || paths.length > 2) invalid();
    const keys = Object.freeze([...new Set(paths.map(sourcePath))]);
    const state = this.currentState(scope);
    if (state && this.stamp(state, state.paths, keys)) this.notify({ ...state.scope, kind: "paths", paths: keys }, state);
  }

  /** Suppression only, NOT positive eligibility: current complete membership is still required by retrieval. */
  isSuppressed(scope: SearchRepositoryScope, sessionId: string, sourceFilePath: string): boolean {
    if (this.lifetime.signal.aborted) return true;
    const state = this.currentState(scope);
    if (!state || state.blocked || state.sessions.has(sessionId) || state.paths.has(sourceFilePath)) return true;
    try { return workspaceSourceRevision(this.read(scope.workspaceId), this.piAgentDirectory) !== scope.sourceRevision; }
    catch { return true; }
  }

  /** Seal workspace metadata work without starting a document attempt or releasing suppression. */
  captureWorkspace(supplied: SessionWorkspaceScope): SearchWorkspaceAuthority {
    this.checkOpen();
    const workspace = Object.freeze({ id: identifier(supplied.id), path: sourcePath(supplied.path),
      sessionDirectory: supplied.sessionDirectory === null ? null : sourcePath(supplied.sessionDirectory) });
    const sourceRevision = workspaceSourceRevision(workspace, this.piAgentDirectory);
    const state = this.currentState({ workspaceId: workspace.id, sourceRevision });
    if (!state || state.blocked) unavailable();
    const assertCurrent = (): undefined => {
      this.checkOpen();
      if (this.workspaces.get(workspace.id) !== state || state.blocked ||
          workspaceSourceRevision(this.read(workspace.id), this.piAgentDirectory) !== sourceRevision) changed();
    };
    assertCurrent();
    return Object.freeze({ scope: state.scope, assertCurrent,
      revalidate: (signal: AbortSignal) => this.revalidateWorkspace(workspace, sourceRevision, assertCurrent, signal) });
  }

  private async revalidateWorkspace(workspace: SessionWorkspaceScope, expectedRevision: string, assertCurrent: () => undefined, signal: AbortSignal): Promise<void> {
    const cancel = (): never => { throw new SearchRepositoryError("search_cancelled"); };
    if (signal.aborted || this.lifetime.signal.aborted) cancel();
    assertCurrent();
    const before = this.read(workspace.id);
    let admitted: SessionWorkspaceScope;
    let abort!: () => void;
    try {
      admitted = await new Promise<SessionWorkspaceScope>((resolve, reject) => {
        abort = () => reject(new SearchRepositoryError("search_cancelled"));
        signal.addEventListener("abort", abort, { once: true });
        this.lifetime.signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => {
          if (signal.aborted || this.lifetime.signal.aborted) cancel();
          assertCurrent();
          return this.admitSource(before);
        }).then(resolve, reject);
        if (signal.aborted || this.lifetime.signal.aborted) abort();
      });
    } catch (error) {
      if (signal.aborted || this.lifetime.signal.aborted) cancel();
      if (error instanceof SearchSourceError || error instanceof SearchRepositoryError) throw error;
      unavailable();
    } finally {
      signal.removeEventListener("abort", abort);
      this.lifetime.signal.removeEventListener("abort", abort);
    }
    if (signal.aborted || this.lifetime.signal.aborted) cancel();
    assertCurrent(); // catches mutation during async canonical admission
    try {
      if (!admitted || workspaceSourceRevision(admitted, this.piAgentDirectory) !== expectedRevision) unavailable();
    } catch { unavailable(); }
  }

  /** Capture BEFORE starting IO, not when a parsed header first reveals the session ID. */
  capture(suppliedWorkspace: SessionWorkspaceScope, supplied: SessionFileCandidate): SearchDocumentAuthority {
    this.checkOpen();
    const workspace = Object.freeze({ id: identifier(suppliedWorkspace.id), path: sourcePath(suppliedWorkspace.path),
      sessionDirectory: suppliedWorkspace.sessionDirectory === null ? null : sourcePath(suppliedWorkspace.sessionDirectory) });
    const expectedRevision = workspaceSourceRevision(workspace, this.piAgentDirectory);
    const state = this.currentState({ workspaceId: workspace.id, sourceRevision: expectedRevision });
    if (!state || state.blocked) unavailable();
    const candidate = Object.freeze({ ...supplied, fingerprint: Object.freeze({ ...supplied.fingerprint }) });
    if (candidate.workspaceId !== workspace.id || candidate.workspacePath !== workspace.path ||
        candidate.piAgentDirectory !== this.piAgentDirectory || candidate.storePath !== scopedSessionStorePath(workspace, this.piAgentDirectory)) changed();
    const paths = Object.freeze([...new Set([sourcePath(candidate.path), sourcePath(candidate.canonicalPath)])]);
    for (const file of paths) {
      const relative = path.relative(candidate.storePath, file);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) invalid();
    }
    const captured = ++this.sequence;
    state.attemptEpoch = captured;
    const assertCurrent = (sessionId: string | undefined): undefined => {
      this.checkOpen();
      if (this.workspaces.get(workspace.id) !== state || state.blocked) changed();
      if (workspaceSourceRevision(this.read(workspace.id), this.piAgentDirectory) !== expectedRevision) changed();
      if (paths.some((file) => (state.paths.get(file) ?? 0n) > captured) ||
          (sessionId !== undefined && (state.sessions.get(identifier(sessionId)) ?? 0n) > captured)) changed();
    };
    assertCurrent(undefined);
    return Object.freeze({
      assertCurrent,
      revalidate: (sessionId: string | undefined, signal: AbortSignal): Promise<void> =>
        this.revalidateWorkspace(workspace, expectedRevision, () => assertCurrent(sessionId), signal),
      invalidatePrevious: (previous: SessionFileCandidate): undefined => {
        // A stale attempt cannot suppress a replacement registration or an unrelated path.
        if (previous.path !== candidate.path || previous.canonicalPath !== candidate.canonicalPath ||
            previous.workspaceId !== candidate.workspaceId || previous.storePath !== candidate.storePath) invalid();
        if (this.workspaces.get(workspace.id) === state) this.invalidatePaths(state.scope, paths);
      },
    });
  }
}
