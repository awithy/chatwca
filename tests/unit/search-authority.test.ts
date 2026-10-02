import { describe, expect, it, vi } from "vitest";
import { SearchIndexAuthority, MAX_SEARCH_AUTHORITY_IDENTITIES, type SearchAuthorityOptions, type SearchInvalidation } from "../../src/server/search/authority.js";
import { workspaceSourceRevision, type SessionFileCandidate } from "../../src/server/search/session-source.js";
import type { SessionWorkspaceScope } from "../../src/server/session-scope.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(options: Partial<SearchAuthorityOptions> = {}) {
  const workspace: SessionWorkspaceScope = { id: "workspace", path: "/synthetic/workspace", sessionDirectory: "/synthetic/sessions" };
  const state = { registration: workspace as SessionWorkspaceScope | null };
  const registrations = { read: vi.fn((_id: string) => state.registration) };
  const events: SearchInvalidation[] = [];
  const onInvalidate = vi.fn((event: SearchInvalidation): undefined => { events.push(event); });
  const admitSource = vi.fn(async (admitted: SessionWorkspaceScope) => admitted);
  const ledger = new SearchIndexAuthority(registrations, "/synthetic/agent", { onInvalidate, admitSource, ...options });
  const scope = { workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, "/synthetic/agent") };
  const candidate: SessionFileCandidate = {
    workspaceId: workspace.id, workspacePath: workspace.path, piAgentDirectory: "/synthetic/agent",
    path: "/synthetic/sessions/alias.jsonl", canonicalPath: "/synthetic/sessions/target.jsonl", storePath: "/synthetic/sessions",
    storeDevice: "1", storeInode: "2", fingerprint: { device: "1", inode: "3", size: "100", mtimeNs: "1000", ctimeNs: "1000" },
  };
  const admit = () => ledger.admitWorkspace(workspace.id);
  const capture = () => ledger.capture(admit(), candidate);
  return { ledger, registrations, state, events, onInvalidate, admitSource, workspace, scope, candidate, admit, capture };
}
const signal = () => new AbortController().signal;

describe("process-owned search authority", () => {
  it("is lazy, reads fresh registrations, and requires explicit workspace admission before capture", async () => {
    const f = fixture();
    expect(f.registrations.read).not.toHaveBeenCalled();
    expect(() => f.ledger.capture(f.workspace, f.candidate)).toThrow("search_scope_unavailable");
    const authority = f.capture();
    expect(Object.isFrozen(authority)).toBe(true);
    expect(authority.assertCurrent(undefined)).toBeUndefined();
    await authority.revalidate("session", signal());
    expect(f.admitSource).toHaveBeenCalledOnce();
    expect(f.registrations.read.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(f.events).toEqual([]);
  });

  it("is suppression, never positive membership authority; absent/retired scopes fail closed", () => {
    const f = fixture();
    expect(f.ledger.isSuppressed(f.scope, "session", f.candidate.canonicalPath)).toBe(true);
    f.admit();
    expect(f.ledger.isSuppressed(f.scope, "session", f.candidate.canonicalPath)).toBe(false);
    f.ledger.invalidateWorkspace(f.workspace.id);
    expect(f.ledger.isSuppressed(f.scope, "session", f.candidate.canonicalPath)).toBe(true);
  });

  it.each([undefined, "known-session"])("catches invalidation for an initially absent identity even before header discovery (%s)", (initial) => {
    const f = fixture(); const authority = f.capture();
    authority.assertCurrent(initial);
    f.ledger.invalidateSession(f.scope, "known-session");
    authority.assertCurrent(undefined); // session is not known yet, but its start epoch is already captured
    expect(() => authority.assertCurrent("known-session")).toThrow("search_source_changed");
    expect(f.ledger.isSuppressed(f.scope, "known-session", "/other.jsonl")).toBe(true);
    expect(f.events).toEqual([{ ...f.scope, kind: "session", sessionId: "known-session" }]);
  });

  it.each(["path", "canonicalPath"] as const)("path epochs catch %s invalidation and suppress every prior identity", (key) => {
    const f = fixture(); const authority = f.capture();
    f.ledger.invalidatePaths(f.scope, [f.candidate[key]]);
    expect(() => authority.assertCurrent(undefined)).toThrow("search_source_changed");
    for (const session of ["old-session", "replacement-session"]) {
      expect(f.ledger.isSuppressed(f.scope, session, f.candidate[key])).toBe(true);
    }
  });

  it("does not seal unrelated identities or workspaces", () => {
    const f = fixture(); const authority = f.capture();
    f.ledger.invalidateSession(f.scope, "unrelated");
    f.ledger.invalidatePaths(f.scope, ["/synthetic/sessions/other.jsonl"]);
    f.ledger.invalidateSession({ ...f.scope, workspaceId: "other" }, "session");
    expect(authority.assertCurrent("session")).toBeUndefined();
  });

  it("ownership mismatch seals target and alias before notifying bounded cleanup", () => {
    const f = fixture(); const authority = f.capture();
    authority.invalidatePrevious(f.candidate);
    expect(() => authority.assertCurrent("session")).toThrow("search_source_changed");
    expect(f.events).toEqual([{ ...f.scope, kind: "paths", paths: [f.candidate.path, f.candidate.canonicalPath] }]);
    expect(Object.isFrozen(f.events[0])).toBe(true);
    const event = f.events[0]!;
    if (event.kind === "paths") expect(Object.isFrozen(event.paths)).toBe(true);
    expect(f.ledger.isSuppressed(f.scope, "unknown-prior-id", f.candidate.canonicalPath)).toBe(true);
  });

  it("rejects an ownership callback for an unrelated candidate without poisoning its path", () => {
    const f = fixture(); const authority = f.capture();
    expect(() => authority.invalidatePrevious({ ...f.candidate, canonicalPath: "/synthetic/sessions/other.jsonl" })).toThrow("search_index_invalid");
    expect(authority.assertCurrent("session")).toBeUndefined();
    expect(f.events).toEqual([]);
  });

  it("captures mutable workspace and candidate inputs before any IO", () => {
    const f = fixture(); const workspace = { ...f.workspace }; const candidate = { ...f.candidate };
    f.admit(); const authority = f.ledger.capture(workspace, candidate);
    workspace.id = "other"; workspace.path = "/other";
    candidate.path = "/other.jsonl"; candidate.canonicalPath = "/other.jsonl";
    expect(authority.assertCurrent("session")).toBeUndefined();
    authority.invalidatePrevious(f.candidate);
    expect(() => authority.assertCurrent("session")).toThrow("search_source_changed");
  });

  it("fresh registration reads seal unobserved path/storage changes without trusting PostgreSQL", () => {
    const f = fixture(); const authority = f.capture();
    f.state.registration = { ...f.workspace, sessionDirectory: null };
    expect(() => authority.assertCurrent(undefined)).toThrow("search_source_changed");
    expect(f.ledger.isSuppressed(f.scope, "session", f.candidate.canonicalPath)).toBe(true);
  });

  it("revision replacement cleans the obsolete scope and preserves unrelated vectors on non-source changes", () => {
    const f = fixture(); const authority = f.capture();
    f.state.registration = { ...f.workspace }; // rename/mount/network values are deliberately outside this boundary
    f.admit(); expect(authority.assertCurrent("session")).toBeUndefined();
    f.state.registration = { ...f.workspace, path: "/synthetic/moved" };
    f.admit();
    expect(() => authority.assertCurrent("session")).toThrow("search_source_changed");
    expect(f.events).toEqual([{ ...f.scope, kind: "workspace" }]);
    expect(f.ledger.isSuppressed(f.scope, "session", f.candidate.canonicalPath)).toBe(true);
  });

  it("unregister/re-register ABA cannot revive old seals or poison the replacement with a late ownership callback", () => {
    const f = fixture(); const authority = f.capture();
    f.state.registration = null; f.ledger.invalidateWorkspace(f.workspace.id);
    f.state.registration = { ...f.workspace }; const replacement = f.capture();
    expect(() => authority.assertCurrent(undefined)).toThrow("search_source_changed");
    authority.invalidatePrevious(f.candidate);
    expect(replacement.assertCurrent("session")).toBeUndefined();
    expect(f.events).toHaveLength(1);
  });

  it("path-change-and-restore hooks retire the original incarnation", () => {
    const f = fixture(); const authority = f.capture();
    f.state.registration = { ...f.workspace, path: "/synthetic/moved" };
    f.ledger.invalidateWorkspace(f.workspace.id);
    f.state.registration = { ...f.workspace }; f.admit();
    expect(() => authority.assertCurrent("session")).toThrow("search_source_changed");
  });

  it("delayed invalidation for an obsolete source revision cannot suppress its replacement", () => {
    const f = fixture(); f.capture();
    f.state.registration = { ...f.workspace, sessionDirectory: null }; f.admit();
    f.ledger.invalidatePaths(f.scope, [f.candidate.canonicalPath]);
    f.ledger.invalidateSession(f.scope, "session");
    const scope = { ...f.scope, sourceRevision: workspaceSourceRevision(f.state.registration!, "/synthetic/agent") };
    expect(f.ledger.isSuppressed(scope, "session", f.candidate.canonicalPath)).toBe(false);
    expect(f.events).toHaveLength(1);
  });

  it("a fresh post-invalidation attempt may reconcile but never clears result suppression", () => {
    const f = fixture(); f.admit(); f.ledger.invalidateSession(f.scope, "session");
    const authority = f.capture();
    expect(authority.assertCurrent("session")).toBeUndefined();
    expect(f.ledger.isSuppressed(f.scope, "session", f.candidate.canonicalPath)).toBe(true);
  });

  it("fresh registration failures and missing registrations are redacted and fail closed", async () => {
    const f = fixture(); const authority = f.capture();
    f.registrations.read.mockImplementation(() => { throw new Error("sqlite private path /secret and diagnostic"); });
    expect(() => authority.assertCurrent("session")).toThrow(/^search_scope_unavailable$/u);
    const failure = await authority.revalidate("session", signal()).catch((error: unknown) => error);
    expect(failure).toMatchObject({ message: "search_scope_unavailable" });
    expect(failure).not.toHaveProperty("cause");
    expect(f.ledger.isSuppressed(f.scope, "session", f.candidate.canonicalPath)).toBe(true);
    f.registrations.read.mockImplementation(() => null);
    expect(() => f.admit()).toThrow("search_scope_unavailable");
  });

  it("fresh canonical admission failures and forged admission results never leak raw details", async () => {
    const f = fixture(); const authority = f.capture();
    f.admitSource.mockRejectedValueOnce(new Error("/private/permission denied"));
    await expect(authority.revalidate("session", signal())).rejects.toThrow(/^search_scope_unavailable$/u);
    f.admitSource.mockResolvedValueOnce({ ...f.workspace, path: "/wrong/workspace" });
    await expect(authority.revalidate("session", signal())).rejects.toThrow("search_scope_unavailable");
  });

  it("catches registration/session mutation during asynchronous source admission", async () => {
    const f = fixture(); const authority = f.capture(); const pending = deferred<SessionWorkspaceScope>();
    f.admitSource.mockReturnValueOnce(pending.promise);
    const attempt = authority.revalidate("session", signal());
    await vi.waitFor(() => expect(f.admitSource).toHaveBeenCalled());
    f.ledger.invalidateSession(f.scope, "session"); pending.resolve(f.workspace);
    await expect(attempt).rejects.toThrow("search_source_changed");
  });

  it.each(["caller", "close"] as const)("cancels stalled injected source admission on %s and discards late completion", async (kind) => {
    const f = fixture(); const authority = f.capture(); const pending = deferred<SessionWorkspaceScope>(); const controller = new AbortController();
    f.admitSource.mockReturnValueOnce(pending.promise);
    const attempt = authority.revalidate("session", controller.signal);
    await vi.waitFor(() => expect(f.admitSource).toHaveBeenCalled());
    if (kind === "caller") controller.abort("private reason"); else f.ledger.close();
    await expect(attempt).rejects.toThrow(/^search_cancelled$/u);
    pending.resolve(f.workspace); await Promise.resolve();
    expect(f.events).toEqual([]);
  });

  it("removes the caller cancellation listener even when the injected admission never settles", async () => {
    const f = fixture(); const authority = f.capture(); const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    f.admitSource.mockReturnValueOnce(new Promise(() => {}));
    const attempt = authority.revalidate("session", controller.signal);
    await vi.waitFor(() => expect(f.admitSource).toHaveBeenCalled()); controller.abort();
    await expect(attempt).rejects.toThrow("search_cancelled");
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("pre-abort and closed admission do not call the source boundary", async () => {
    const f = fixture(); const authority = f.capture(); const controller = new AbortController(); controller.abort();
    await expect(authority.revalidate("session", controller.signal)).rejects.toThrow("search_cancelled");
    expect(f.admitSource).not.toHaveBeenCalled(); f.ledger.close();
    expect(() => authority.assertCurrent(undefined)).toThrow("search_cancelled");
    expect(() => f.admit()).toThrow("search_cancelled");
    expect(f.ledger.isSuppressed(f.scope, "session", f.candidate.path)).toBe(true);
  });

  it("cleanup queue failures cannot undo immediate seals or result suppression", () => {
    const f = fixture({ onInvalidate: () => { throw new Error("secret queue diagnostic"); } }); const authority = f.capture();
    expect(() => authority.invalidatePrevious(f.candidate)).toThrow(/^search_scope_unavailable$/u);
    expect(() => authority.assertCurrent("session")).toThrow("search_source_changed");
    expect(f.ledger.isSuppressed(f.scope, "session", f.candidate.canonicalPath)).toBe(true);
  });

  it("bounds identity tombstones globally and fails the overflowing workspace closed without evicting seals", () => {
    const f = fixture({ maximumIdentities: 2 }); const authority = f.capture();
    f.ledger.invalidateSession(f.scope, "one");
    f.ledger.invalidateSession(f.scope, "one"); // updates an epoch, not the capacity count
    f.ledger.invalidatePaths(f.scope, [f.candidate.path, f.candidate.path]);
    expect(() => authority.assertCurrent("other")).toThrow("search_source_changed");
    f.ledger.invalidateSession(f.scope, "overflow");
    expect(() => authority.assertCurrent(undefined)).toThrow("search_source_changed");
    expect(() => f.admit()).toThrow("search_scope_unavailable");
    expect(f.ledger.isSuppressed(f.scope, "never-seen", "/never-seen.jsonl")).toBe(true);
    expect(f.events.at(-1)).toEqual({ ...f.scope, kind: "workspace" });
    f.ledger.invalidateSession(f.scope, "again"); expect(f.events).toHaveLength(4);
  });

  it("retiring a scope releases tracked capacity, but repeated registration admission does not clear suppression", () => {
    const f = fixture({ maximumIdentities: 1 }); f.admit();
    f.ledger.invalidateSession(f.scope, "one"); f.admit();
    expect(f.ledger.isSuppressed(f.scope, "one", f.candidate.path)).toBe(true);
    f.ledger.invalidateWorkspace(f.workspace.id); f.admit();
    f.ledger.invalidateSession(f.scope, "two");
    expect(f.ledger.isSuppressed(f.scope, "other", f.candidate.path)).toBe(false);
  });

  it("shares the identity budget across workspaces without blocking unrelated scopes", () => {
    const f = fixture({ maximumIdentities: 1 }); f.admit();
    f.ledger.invalidateSession(f.scope, "one");
    f.registrations.read.mockImplementation((id) => ({ ...f.workspace, id }));
    const other = f.ledger.admitWorkspace("other");
    const otherScope = { workspaceId: "other", sourceRevision: workspaceSourceRevision(other, "/synthetic/agent") };
    f.ledger.invalidateSession(otherScope, "two");
    expect(f.ledger.isSuppressed(otherScope, "unrelated", f.candidate.path)).toBe(true);
    expect(f.ledger.isSuppressed(f.scope, "unrelated", f.candidate.path)).toBe(false);
    expect(f.events.at(-1)).toEqual({ ...otherScope, kind: "workspace" });
  });

  it("bounds workspace admission without probing sources or evicting active registrations", () => {
    const f = fixture({ maximumWorkspaces: 1 }); const authority = f.capture();
    f.registrations.read.mockImplementation((id) => ({ ...f.workspace, id }));
    expect(() => f.ledger.admitWorkspace("other")).toThrow("search_busy");
    expect(authority.assertCurrent("session")).toBeUndefined();
    expect(f.admitSource).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, MAX_SEARCH_AUTHORITY_IDENTITIES + 1])("rejects invalid identity capacity %s", (maximumIdentities) => {
    expect(() => fixture({ maximumIdentities })).toThrow("search_index_invalid");
  });

  it.each([
    { piAgentDirectory: "/different/agent" }, { storePath: "/different/store" },
    { canonicalPath: "/outside/target.jsonl" }, { path: "/synthetic/sessions/../outside.jsonl" },
  ])("rejects inconsistent/escaping source candidates %j", (mutation) => {
    const f = fixture(); f.admit();
    expect(() => f.ledger.capture(f.workspace, { ...f.candidate, ...mutation })).toThrow(/search_(source_changed|index_invalid)/u);
  });
});

describe("private invalidation cleanup tickets", () => {
  it("provides a frozen process-local guard that cannot be reconstructed from JSON", () => {
    const f = fixture(); f.admit(); f.ledger.invalidateSession(f.scope, "session");
    const ticket = f.events[0]!;
    expect(ticket.assertCurrent()).toBeUndefined();
    expect(JSON.parse(JSON.stringify(ticket))).not.toHaveProperty("assertCurrent");
    expect(Object.isFrozen(ticket)).toBe(true);
  });

  it("revokes old session/path cleanup on any fresh document attempt, even an unrelated failed attempt", () => {
    const f = fixture(); f.capture();
    f.ledger.invalidateSession(f.scope, "session"); f.ledger.invalidatePaths(f.scope, [f.candidate.canonicalPath]);
    const tickets = [...f.events]; tickets.forEach((ticket) => ticket.assertCurrent());
    f.capture();
    for (const ticket of tickets) expect(() => ticket.assertCurrent()).toThrow("search_source_changed");
  });

  it("repeated invalidation revokes the older matching cleanup epoch but not unrelated tickets", () => {
    const f = fixture(); f.admit();
    f.ledger.invalidateSession(f.scope, "session"); const old = f.events[0]!;
    f.ledger.invalidateSession(f.scope, "other"); old.assertCurrent();
    f.ledger.invalidateSession(f.scope, "session");
    expect(() => old.assertCurrent()).toThrow("search_source_changed");
    expect(f.events.at(-1)!.assertCurrent()).toBeUndefined();
  });

  it("retired workspace cleanup requires fresh unregister/different-source admission and rejects same-revision ABA before re-admission", () => {
    const f = fixture(); f.capture();
    f.state.registration = null; f.ledger.invalidateWorkspace(f.workspace.id);
    const ticket = f.events[0]!; expect(ticket.assertCurrent()).toBeUndefined();
    f.state.registration = { ...f.workspace }; // not yet re-admitted, still must revoke deletion
    expect(() => ticket.assertCurrent()).toThrow("search_source_changed");
    f.state.registration = { ...f.workspace, path: "/moved" };
    expect(ticket.assertCurrent()).toBeUndefined();
  });

  it("overflow workspace cleanup stays guarded by its blocked incarnation and new-source replacement", () => {
    const f = fixture({ maximumIdentities: 1 }); f.capture();
    f.ledger.invalidatePaths(f.scope, [f.candidate.path, f.candidate.canonicalPath]);
    const ticket = f.events[0]!; expect(ticket.assertCurrent()).toBeUndefined();
    f.state.registration = { ...f.workspace, path: "/moved" }; f.admit();
    expect(() => ticket.assertCurrent()).toThrow("search_source_changed");
  });

  it("registration IO failures and close seal all outstanding cleanup tickets", () => {
    const f = fixture(); f.admit(); f.ledger.invalidateSession(f.scope, "session");
    const ticket = f.events[0]!;
    f.registrations.read.mockImplementation(() => { throw new Error("private SQLite diagnostic"); });
    expect(() => ticket.assertCurrent()).toThrow(/^search_scope_unavailable$/u);
    f.ledger.close(); expect(() => ticket.assertCurrent()).toThrow("search_cancelled");
  });
});

