import { describe, expect, it, vi } from "vitest";
import { SearchIndexAuthority, type SearchInvalidation } from "../../src/server/search/authority.js";
import type { SearchRepositoryOptions } from "../../src/server/search/database.js";
import { SearchRepositoryError } from "../../src/server/search/errors.js";
import type { SearchRepositoryWorkspace } from "../../src/server/search/repository.js";
import { workspaceSourceRevision } from "../../src/server/search/session-source.js";
import { SEARCH_WORKSPACE_SYNC_TIMEOUT_MS, SearchWorkspaceSynchronizer } from "../../src/server/search/workspace-sync.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(timeoutMs?: number) {
  const registration = { id: "workspace", name: "Synthetic name", path: "/synthetic/workspace", sessionDirectory: "/synthetic/sessions" as string | null };
  const state = { registration: registration as typeof registration | null, derived: null as SearchRepositoryWorkspace | null };
  const registrations = { read: vi.fn(() => state.registration) };
  const events: SearchInvalidation[] = [];
  const admitSource = vi.fn(async (workspace: typeof registration | Omit<typeof registration, "name">) => workspace);
  const authority = new SearchIndexAuthority(registrations, "/synthetic/agent", { admitSource, onInvalidate: (ticket): undefined => { events.push(ticket); } });
  const target = { workspaceId: registration.id, sourceRevision: workspaceSourceRevision(registration, "/synthetic/agent"),
    displayName: registration.name, canonicalPath: registration.path, sessionDirectory: registration.sessionDirectory! };
  const repository = {
    readWorkspace: vi.fn(async (_id: string, options?: SearchRepositoryOptions) => { options?.assertCurrent?.(); return state.derived; }),
    synchronizeWorkspace: vi.fn(async (workspace: SearchRepositoryWorkspace, expected: string | null, options?: SearchRepositoryOptions) => {
      options?.assertCurrent?.();
      if ((state.derived?.sourceRevision ?? null) !== expected) throw new SearchRepositoryError("search_source_changed");
      state.derived = { ...workspace };
    }),
  };
  const sync = new SearchWorkspaceSynchronizer(repository, registrations, authority, "/synthetic/agent", timeoutMs);
  return { sync, state, registration, registrations, repository, authority, target, admitSource, events };
}
const signal = () => new AbortController().signal;

describe("guarded current-registration workspace synchronization", () => {
  it("constructs lazily and creates derived metadata only after fresh canonical admission", async () => {
    const f = fixture(); expect(f.registrations.read).not.toHaveBeenCalled(); expect(f.admitSource).not.toHaveBeenCalled();
    const result = await f.sync.synchronize("workspace");
    expect(result).toEqual({ status: "created", workspace: f.target });
    expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.workspace)).toBe(true);
    expect(f.admitSource).toHaveBeenCalledTimes(2);
    expect(f.repository.synchronizeWorkspace).toHaveBeenCalledWith(f.target, null, expect.objectContaining({ assertCurrent: expect.any(Function), signal: expect.any(AbortSignal) }));
  });

  it("avoids an unnecessary write but still performs fresh canonical/registry revalidation", async () => {
    const f = fixture(); f.state.derived = { ...f.target };
    expect((await f.sync.synchronize("workspace")).status).toBe("unchanged");
    expect(f.repository.synchronizeWorkspace).not.toHaveBeenCalled(); expect(f.admitSource).toHaveBeenCalledTimes(2);
  });

  it("updates copied names under revision CAS without changing embedding identity", async () => {
    const f = fixture(); f.state.derived = { ...f.target, displayName: "Old name" };
    expect((await f.sync.synchronize("workspace")).status).toBe("updated");
    expect(f.repository.synchronizeWorkspace).toHaveBeenCalledWith(f.target, f.target.sourceRevision, expect.anything());
  });

  it("replaces obsolete revisions only using the freshly observed previous revision", async () => {
    const f = fixture(); f.state.derived = { ...f.target, sourceRevision: "b".repeat(64), canonicalPath: "/old/workspace" };
    await f.sync.synchronize("workspace");
    expect(f.repository.synchronizeWorkspace).toHaveBeenCalledWith(f.target, "b".repeat(64), expect.anything());
  });

  it("derives Pi-default store without creating or admitting that store", async () => {
    const f = fixture(); f.state.registration!.sessionDirectory = null;
    const result = await f.sync.synchronize("workspace");
    expect(result.workspace.sessionDirectory).toBe("/synthetic/agent/sessions/--synthetic-workspace--");
  });

  it("retains session/path suppression and does not revoke private cleanup tickets", async () => {
    const f = fixture(); f.authority.admitWorkspace("workspace");
    f.authority.invalidateSession(f.target, "session"); f.authority.invalidatePaths(f.target, ["/synthetic/sessions/session.jsonl"]);
    const tickets = [...f.events];
    await f.sync.synchronize("workspace");
    for (const ticket of tickets) expect(ticket.assertCurrent()).toBeUndefined();
    expect(f.authority.isSuppressed(f.target, "session", "/synthetic/sessions/session.jsonl")).toBe(true);
  });

  it("does not let derived rows admit an unregistered workspace", async () => {
    const f = fixture(); f.state.registration = null; f.state.derived = { ...f.target };
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_scope_unavailable");
    expect(f.repository.readWorkspace).not.toHaveBeenCalled(); expect(f.repository.synchronizeWorkspace).not.toHaveBeenCalled();
  });

  it.each(["name", "path", "sessionDirectory", "unregister", "incarnation"])("rejects %s changes after observing derived metadata", async (change) => {
    const f = fixture();
    f.repository.readWorkspace.mockImplementationOnce(async () => {
      if (change === "unregister") f.state.registration = null;
      else if (change === "incarnation") { f.authority.invalidateWorkspace("workspace"); f.authority.admitWorkspace("workspace"); }
      else f.state.registration![change as "name" | "path" | "sessionDirectory"] = change === "name" ? "Renamed" : "/synthetic/other";
      return null;
    });
    await expect(f.sync.synchronize("workspace")).rejects.toThrow(/search_(source_changed|scope_unavailable)/u);
    expect(f.repository.synchronizeWorkspace).not.toHaveBeenCalled();
  });

  it("seals synchronous pre-commit rename races even after final canonical admission", async () => {
    const f = fixture();
    f.repository.synchronizeWorkspace.mockImplementationOnce(async (_workspace, _expected, options) => {
      f.state.registration!.name = "Changed before COMMIT";
      options!.assertCurrent!();
    });
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_source_changed"); expect(f.state.derived).toBeNull();
  });

  it("rejects register/path ABA hooks during canonical IO", async () => {
    const f = fixture();
    f.admitSource.mockImplementationOnce(async (workspace) => {
      f.state.registration!.path = "/synthetic/moved"; f.authority.invalidateWorkspace("workspace");
      f.state.registration!.path = "/synthetic/workspace"; f.authority.admitWorkspace("workspace"); return workspace;
    });
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_source_changed");
    expect(f.repository.readWorkspace).not.toHaveBeenCalled();
  });

  it("fails closed for identity-capacity-blocked incarnations instead of recovering them by metadata sync", async () => {
    const f = fixture();
    const authority = new SearchIndexAuthority(f.registrations, "/synthetic/agent", { admitSource: f.admitSource,
      maximumIdentities: 1, onInvalidate: (): undefined => {} });
    authority.admitWorkspace("workspace"); authority.invalidateSession(f.target, "first"); authority.invalidateSession(f.target, "overflow");
    const sync = new SearchWorkspaceSynchronizer(f.repository, f.registrations, authority, "/synthetic/agent");
    await expect(sync.synchronize("workspace")).rejects.toThrow("search_scope_unavailable");
    expect(f.repository.readWorkspace).not.toHaveBeenCalled(); expect(authority.isSuppressed(f.target, "any", "/any/path")).toBe(true);
  });

  it("uses optimistic CAS and never automatically retries contention", async () => {
    const f = fixture();
    f.repository.synchronizeWorkspace.mockImplementationOnce(async () => { throw new SearchRepositoryError("search_source_changed"); });
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_source_changed");
    expect(f.repository.readWorkspace).toHaveBeenCalledOnce(); expect(f.repository.synchronizeWorkspace).toHaveBeenCalledOnce();
  });

  it("reconciles an ambiguous write acknowledgement with a fresh explicit read", async () => {
    const f = fixture();
    f.repository.synchronizeWorkspace.mockImplementationOnce(async (workspace) => { f.state.derived = { ...workspace }; throw new SearchRepositoryError("search_timeout"); });
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_timeout");
    expect((await f.sync.synchronize("workspace")).status).toBe("unchanged");
    expect(f.repository.synchronizeWorkspace).toHaveBeenCalledOnce();
  });

  it("refuses a forged canonical admission result instead of trusting its filesystem scope", async () => {
    const f = fixture(); f.admitSource.mockResolvedValueOnce({ ...f.registration, path: "/synthetic/foreign" });
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_scope_unavailable");
    expect(f.repository.readWorkspace).not.toHaveBeenCalled();
  });

  it("redacts unavailable registration readers before any source/database work", async () => {
    const f = fixture(); f.registrations.read.mockImplementationOnce(() => { throw new Error("SQLite diagnostics and private path"); });
    const error = await f.sync.synchronize("workspace").catch((value: unknown) => value);
    expect(error).toMatchObject({ message: "search_scope_unavailable" }); expect(error).not.toHaveProperty("cause");
    expect(f.admitSource).not.toHaveBeenCalled(); expect(f.repository.readWorkspace).not.toHaveBeenCalled();
  });

  it.each(["canonical", "repository"])("redacts raw %s diagnostics", async (dependency) => {
    const f = fixture(); const error = new Error("secret database url /real/history");
    if (dependency === "canonical") f.admitSource.mockRejectedValueOnce(error);
    else f.repository.readWorkspace.mockRejectedValueOnce(error);
    const failed = await f.sync.synchronize("workspace").catch((value: unknown) => value);
    expect(failed).toMatchObject({ message: dependency === "canonical" ? "search_scope_unavailable" : "search_database_unavailable" });
    expect(failed).not.toHaveProperty("cause");
  });

  it.each(["wrong-id", "bad-revision"])("rejects corrupt derived %s results", async (corruption) => {
    const f = fixture(); f.state.derived = { ...f.target, ...(corruption === "wrong-id" ? { workspaceId: "other" } : { sourceRevision: "bad" }) };
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_database_unavailable");
    expect(f.repository.synchronizeWorkspace).not.toHaveBeenCalled();
  });

  it.each(["", "\0", "\ud800", "x".repeat(2049)])("rejects invalid authoritative names without writing (%j)", async (name) => {
    const f = fixture(); f.state.registration!.name = name;
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_scope_unavailable");
    expect(f.repository.readWorkspace).not.toHaveBeenCalled();
  });

  it("snapshots a mutable registration before asynchronous admission", async () => {
    const f = fixture(); const waiting = deferred<Omit<typeof f.registration, "name">>();
    f.admitSource.mockReturnValueOnce(waiting.promise);
    const attempt = f.sync.synchronize("workspace");
    await vi.waitFor(() => expect(f.admitSource).toHaveBeenCalledOnce());
    f.registration.name = "Mutated"; waiting.resolve(f.registration);
    await expect(attempt).rejects.toThrow("search_source_changed"); expect(f.state.derived).toBeNull();
  });

  it.each(["source", "read", "write"])("aggregate deadline bounds stalled %s and prevents late continuation", async (stage) => {
    const f = fixture(20); const waiting = deferred<any>();
    if (stage === "source") f.admitSource.mockReturnValueOnce(waiting.promise);
    if (stage === "read") f.repository.readWorkspace.mockReturnValueOnce(waiting.promise);
    if (stage === "write") f.repository.synchronizeWorkspace.mockReturnValueOnce(waiting.promise);
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_timeout");
    const reads = f.repository.readWorkspace.mock.calls.length; const writes = f.repository.synchronizeWorkspace.mock.calls.length;
    waiting.resolve(stage === "source" ? f.registration : stage === "read" ? null : undefined);
    await new Promise((done) => setTimeout(done, 10));
    expect(f.repository.readWorkspace).toHaveBeenCalledTimes(reads); expect(f.repository.synchronizeWorkspace).toHaveBeenCalledTimes(writes);
  });

  it.each(["abort", "close"])("%s seals stalled operations and retained transaction callbacks", async (action) => {
    const f = fixture(); const waiting = deferred<SearchRepositoryWorkspace | null>(); const controller = new AbortController();
    f.repository.readWorkspace.mockReturnValueOnce(waiting.promise);
    const attempt = f.sync.synchronize("workspace", { signal: controller.signal });
    await vi.waitFor(() => expect(f.repository.readWorkspace).toHaveBeenCalledOnce());
    const options = f.repository.readWorkspace.mock.calls[0]![1]!;
    if (action === "abort") controller.abort(new Error("private reason")); else f.sync.close();
    await expect(attempt).rejects.toThrow("search_cancelled"); expect(() => options.assertCurrent!()).toThrow("search_cancelled");
    waiting.resolve(null); await Promise.resolve(); expect(f.repository.synchronizeWorkspace).not.toHaveBeenCalled();
    if (action === "close") await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_cancelled");
    else expect((await f.sync.synchronize("workspace")).status).toBe("created");
    expect(f.authority.admitWorkspace("workspace")).toMatchObject({ id: "workspace" }); // dependencies still open
  });

  it("admits one operation with no queue", async () => {
    const f = fixture(); const waiting = deferred<SearchRepositoryWorkspace | null>(); f.repository.readWorkspace.mockReturnValueOnce(waiting.promise);
    const first = f.sync.synchronize("workspace");
    await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_busy"); waiting.resolve(null); await first;
  });

  it("closed/aborted admission does no registry or repository IO", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.sync.synchronize("workspace", { signal: controller.signal })).rejects.toThrow("search_cancelled");
    f.sync.close(); await expect(f.sync.synchronize("workspace")).rejects.toThrow("search_cancelled"); expect(f.registrations.read).not.toHaveBeenCalled();
  });

  it("rejects inconsistent selected Pi universes before DB IO", async () => {
    const f = fixture(); const other = new SearchWorkspaceSynchronizer(f.repository, f.registrations, f.authority, "/other/agent");
    await expect(other.synchronize("workspace")).rejects.toThrow("search_scope_unavailable"); expect(f.repository.readWorkspace).not.toHaveBeenCalled();
  });

  it.each([0, -1, 1.5, SEARCH_WORKSPACE_SYNC_TIMEOUT_MS + 1])("limits timeout overrides (%s)", (timeout) => {
    expect(() => fixture(timeout)).toThrow("search_index_invalid");
  });
});

describe("workspace incarnation seals", () => {
  it("requires prior admission and rejects obsolete supplied source scopes", () => {
    const f = fixture(); expect(() => f.authority.captureWorkspace(f.registration)).toThrow("search_scope_unavailable");
    f.authority.admitWorkspace("workspace"); expect(() => f.authority.captureWorkspace({ ...f.registration, path: "/other/path" })).toThrow("search_scope_unavailable");
  });
  it("survives unrelated document invalidation but not workspace retirement", async () => {
    const f = fixture(); f.authority.admitWorkspace("workspace"); const seal = f.authority.captureWorkspace(f.registration);
    f.authority.invalidateSession(f.target, "session"); expect(seal.assertCurrent()).toBeUndefined();
    await seal.revalidate(signal()); f.authority.invalidateWorkspace("workspace"); f.authority.admitWorkspace("workspace");
    expect(() => seal.assertCurrent()).toThrow("search_source_changed");
  });
  it("bounds uncooperative canonical admission on close and removes cancellation listeners", async () => {
    const f = fixture(); f.authority.admitWorkspace("workspace"); const seal = f.authority.captureWorkspace(f.registration);
    f.admitSource.mockReturnValueOnce(new Promise(() => {})); const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, "removeEventListener"); const attempt = seal.revalidate(controller.signal);
    f.authority.close(); await expect(attempt).rejects.toThrow("search_cancelled"); expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });
});
