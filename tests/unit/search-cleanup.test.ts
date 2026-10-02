import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SearchInvalidation } from "../../src/server/search/authority.js";
import { MAX_SEARCH_CLEANUP_DOCUMENTS, SearchIndexCleanup, type SearchCleanupCursor } from "../../src/server/search/cleanup.js";
import type { SearchRepositoryOptions } from "../../src/server/search/database.js";
import { SearchRepositoryError } from "../../src/server/search/errors.js";
import { PostgresSearchRepository, type SearchCheckpointPageRequest, type SearchDocumentCheckpoint, type SearchDocumentDeletion, type SearchRepositoryScope } from "../../src/server/search/repository.js";
import { REPOSITORY_WORKSPACE, searchPublication } from "../fixtures/search-repository.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function saved(sessionId = "session", sourcePath = "/synthetic/sessions/shared.jsonl"): SearchDocumentCheckpoint {
  const candidate = searchPublication([], { sessionId, sourcePath });
  return { ...candidate, documentId: randomUUID(), generation: "1", lastSeenScanId: candidate.scanId };
}
function fixture(count = 1, timeoutMs?: number) {
  const state = { current: true };
  const checkpoints = new Map(Array.from({ length: count }, (_, index) => {
    const checkpoint = saved(`session-${String(index).padStart(4, "0")}`); return [checkpoint.sessionId, checkpoint];
  }));
  const assertCurrent = vi.fn((): undefined => { if (!state.current) throw new SearchRepositoryError("search_source_changed"); });
  const scope = { workspaceId: REPOSITORY_WORKSPACE.workspaceId, sourceRevision: REPOSITORY_WORKSPACE.sourceRevision };
  const intent: SearchInvalidation = { ...scope, kind: "paths", paths: ["/synthetic/sessions/shared.jsonl"], assertCurrent };
  const repository = {
    readCheckpoint: vi.fn(async (_scope: SearchRepositoryScope, sessionId: string, options?: SearchRepositoryOptions) => { options?.assertCurrent?.(); return checkpoints.get(sessionId) ?? null; }),
    readCheckpointPage: vi.fn(async (_scope: SearchRepositoryScope, request: SearchCheckpointPageRequest = {}, options?: SearchRepositoryOptions) => {
      options?.assertCurrent?.();
      const matches = [...checkpoints.values()].filter((item) => item.sourcePath === request.sourcePath && item.sessionId > (request.afterSessionId ?? "")).sort((a, b) => a.sessionId < b.sessionId ? -1 : 1);
      const page = matches.slice(0, request.limit);
      return { checkpoints: page, nextAfterSessionId: matches.length > page.length ? page.at(-1)!.sessionId : null };
    }),
    deleteDocumentVersion: vi.fn(async (target: SearchDocumentDeletion, options?: SearchRepositoryOptions) => {
      options?.assertCurrent?.(); const current = checkpoints.get(target.sessionId);
      if (!current || current.documentId !== target.documentId || current.generation !== target.generation || current.sourcePath !== target.sourcePath) return false;
      checkpoints.delete(target.sessionId); return true;
    }),
    deleteWorkspace: vi.fn(async (_scope: SearchRepositoryScope, options?: SearchRepositoryOptions) => { options?.assertCurrent?.(); checkpoints.clear(); return true; }),
  };
  const cleanup = new SearchIndexCleanup(repository, timeoutMs);
  return { cleanup, repository, state, checkpoints, intent, scope, assertCurrent };
}

describe("bounded explicit known-invalidation cleanup", () => {
  it("constructs lazily and deletes only observed path/session versions under required seals", async () => {
    const f = fixture(2); expect(f.repository.readCheckpointPage).not.toHaveBeenCalled();
    expect(await f.cleanup.clean(f.intent)).toEqual({ deleted: 2, skipped: 0, next: null });
    expect(f.checkpoints.size).toBe(0);
    expect(f.repository.deleteDocumentVersion.mock.calls[0]?.[0]).toMatchObject({ ...f.scope, generation: "1", sourcePath: f.intent.kind === "paths" ? f.intent.paths[0] : "" });
    expect(f.repository.deleteDocumentVersion.mock.calls[0]?.[1]?.assertCurrent).toBeTypeOf("function");
    expect(f.repository.deleteWorkspace).not.toHaveBeenCalled();
  });

  it("handles session and guarded workspace intents without scanning or using unconditional document deletion", async () => {
    const f = fixture(2);
    expect(await f.cleanup.clean({ ...f.scope, kind: "session", sessionId: "session-0000", assertCurrent: f.assertCurrent })).toEqual({ deleted: 1, skipped: 0, next: null });
    expect(f.repository.readCheckpointPage).not.toHaveBeenCalled();
    expect(await f.cleanup.clean({ ...f.scope, kind: "workspace", assertCurrent: f.assertCurrent })).toEqual({ deleted: 1, skipped: 0, next: null });
    expect(f.checkpoints.size).toBe(0);
  });

  it("treats missing sessions and stale conditional versions as safe no-ops", async () => {
    const f = fixture();
    expect(await f.cleanup.clean({ ...f.scope, kind: "session", sessionId: "absent", assertCurrent: f.assertCurrent })).toEqual({ deleted: 0, skipped: 1, next: null });
    f.repository.deleteDocumentVersion.mockResolvedValueOnce(false);
    expect(await f.cleanup.clean(f.intent)).toEqual({ deleted: 0, skipped: 1, next: null });
    expect(f.checkpoints.size).toBe(1);
  });

  it("caps each call at 64 exact generations and continues via bounded keyset cursors", async () => {
    const f = fixture(MAX_SEARCH_CLEANUP_DOCUMENTS + 2);
    const first = await f.cleanup.clean(f.intent);
    expect(first).toEqual({ deleted: 64, skipped: 0, next: { pathIndex: 0, afterSessionId: "session-0063" } });
    expect(Object.isFrozen(first.next)).toBe(true);
    expect(f.repository.deleteDocumentVersion).toHaveBeenCalledTimes(64);
    expect(await f.cleanup.clean(f.intent, { cursor: first.next! })).toEqual({ deleted: 2, skipped: 0, next: null });
    expect(f.repository.readCheckpointPage.mock.calls[1]?.[1]).toMatchObject({ limit: 64, afterSessionId: "session-0063" });
  });

  it("shares the document budget across target/alias paths and returns a second-path continuation", async () => {
    const f = fixture(64); const extra = saved("alias-session", "/synthetic/sessions/alias.jsonl"); f.checkpoints.set(extra.sessionId, extra);
    const intent: SearchInvalidation = { ...f.scope, kind: "paths", paths: ["/synthetic/sessions/shared.jsonl", extra.sourcePath], assertCurrent: f.assertCurrent };
    const first = await f.cleanup.clean(intent);
    expect(first.next).toEqual({ pathIndex: 1, afterSessionId: null });
    expect(await f.cleanup.clean(intent, { cursor: first.next! })).toEqual({ deleted: 1, skipped: 0, next: null });
  });

  it("processes a short second path within the same budget and does not touch unrelated documents", async () => {
    const f = fixture(2); const alias = saved("alias", "/synthetic/sessions/alias.jsonl"); const other = saved("other", "/other/path.jsonl");
    f.checkpoints.set(alias.sessionId, alias); f.checkpoints.set(other.sessionId, other);
    expect(await f.cleanup.clean({ ...f.scope, kind: "paths", paths: ["/synthetic/sessions/shared.jsonl", alias.sourcePath], assertCurrent: f.assertCurrent })).toEqual({ deleted: 3, skipped: 0, next: null });
    expect([...f.checkpoints.keys()]).toEqual(["other"]);
    expect(f.repository.readCheckpointPage.mock.calls[1]?.[1]?.limit).toBe(62);
  });

  it("snapshots mutable intent paths, scopes and cursors before its first await", async () => {
    const f = fixture(); const paths = ["/synthetic/sessions/shared.jsonl"]; const cursor = { pathIndex: 0, afterSessionId: null as string | null };
    const intent: SearchInvalidation = { ...f.scope, kind: "paths", paths, assertCurrent: f.assertCurrent };
    const attempt = f.cleanup.clean(intent, { cursor });
    paths[0] = "/other.jsonl"; (intent as { sourceRevision: string }).sourceRevision = "b".repeat(64); cursor.afterSessionId = "zzz";
    expect(await attempt).toMatchObject({ deleted: 1 });
    expect(f.repository.readCheckpointPage.mock.calls[0]?.[0]).toEqual(f.scope);
    expect(f.repository.readCheckpointPage.mock.calls[0]?.[1]).toMatchObject({ sourcePath: "/synthetic/sessions/shared.jsonl", afterSessionId: null });
  });

  it("snapshots all observed versions before starting the first delete", async () => {
    const f = fixture(2); const second = f.checkpoints.get("session-0001")!;
    f.repository.deleteDocumentVersion.mockImplementationOnce(async () => { (second as { generation: string }).generation = "2"; return false; });
    expect(await f.cleanup.clean(f.intent)).toEqual({ deleted: 0, skipped: 2, next: null });
    expect(f.repository.deleteDocumentVersion.mock.calls[1]?.[0].generation).toBe("1");
  });

  it("rejects revoked tickets before repository IO", async () => {
    const f = fixture(); f.state.current = false;
    await expect(f.cleanup.clean(f.intent)).rejects.toThrow("search_source_changed");
    expect(f.repository.readCheckpointPage).not.toHaveBeenCalled(); expect(f.checkpoints.size).toBe(1);
  });

  it("does not delete late pages after authority changes during a read", async () => {
    const f = fixture(); const pending = deferred<Awaited<ReturnType<typeof f.repository.readCheckpointPage>>>();
    f.repository.readCheckpointPage.mockReturnValueOnce(pending.promise);
    const attempt = f.cleanup.clean(f.intent); await vi.waitFor(() => expect(f.repository.readCheckpointPage).toHaveBeenCalled());
    f.state.current = false; pending.resolve({ checkpoints: [...f.checkpoints.values()], nextAfterSessionId: null });
    await expect(attempt).rejects.toThrow("search_source_changed"); expect(f.repository.deleteDocumentVersion).not.toHaveBeenCalled();
  });

  it("checks synchronous repository pre-commit seals; never retries failed or ambiguous deletion", async () => {
    const f = fixture(); f.repository.deleteDocumentVersion.mockImplementationOnce(async (_target, options) => {
      f.state.current = false; options?.assertCurrent?.(); return true;
    });
    await expect(f.cleanup.clean(f.intent)).rejects.toThrow("search_source_changed");
    expect(f.checkpoints.size).toBe(1); expect(f.repository.deleteDocumentVersion).toHaveBeenCalledOnce();
    f.state.current = true; f.repository.deleteDocumentVersion.mockRejectedValueOnce(new Error("lost COMMIT acknowledgement, private SQL"));
    await expect(f.cleanup.clean(f.intent)).rejects.toThrow(/^search_database_unavailable$/u);
    expect(f.repository.deleteDocumentVersion).toHaveBeenCalledTimes(2);
  });

  it.each(["abort", "close", "deadline"] as const)("bounds a stalled injected read by %s and prevents late cleanup", async (kind) => {
    const f = fixture(1, kind === "deadline" ? 40 : 5000); const pending = deferred<Awaited<ReturnType<typeof f.repository.readCheckpointPage>>>();
    f.repository.readCheckpointPage.mockReturnValueOnce(pending.promise); const controller = new AbortController();
    const attempt = f.cleanup.clean(f.intent, { signal: controller.signal });
    await vi.waitFor(() => expect(f.repository.readCheckpointPage).toHaveBeenCalled(), { interval: 1 });
    if (kind === "abort") controller.abort("private reason"); else if (kind === "close") f.cleanup.close();
    await expect(attempt).rejects.toThrow(kind === "deadline" ? "search_timeout" : "search_cancelled");
    pending.resolve({ checkpoints: [...f.checkpoints.values()], nextAfterSessionId: null }); await Promise.resolve();
    expect(f.repository.deleteDocumentVersion).not.toHaveBeenCalled(); expect(f.checkpoints.size).toBe(1);
  });

  it("applies one aggregate deadline across multiple individually short repository operations", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(3, 50);
      const read = f.repository.readCheckpointPage.getMockImplementation()!;
      const remove = f.repository.deleteDocumentVersion.getMockImplementation()!;
      f.repository.readCheckpointPage.mockImplementation(async (...args) => { await new Promise((resolve) => setTimeout(resolve, 20)); return read(...args); });
      f.repository.deleteDocumentVersion.mockImplementation(async (...args) => { await new Promise((resolve) => setTimeout(resolve, 20)); return remove(...args); });
      const attempt = expect(f.cleanup.clean(f.intent)).rejects.toThrow("search_timeout");
      await vi.advanceTimersByTimeAsync(80); await attempt;
      // First complete deletion can remain committed; no third operation or late
      // second deletion is allowed. A later explicit attempt must re-read metadata.
      expect(f.checkpoints.size).toBe(2);
      expect(f.repository.deleteDocumentVersion).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("is single-flight without a queue, and seals closed/pre-aborted admission", async () => {
    const f = fixture(); const pending = deferred<Awaited<ReturnType<typeof f.repository.readCheckpointPage>>>();
    f.repository.readCheckpointPage.mockReturnValueOnce(pending.promise); const controller = new AbortController();
    const attempt = f.cleanup.clean(f.intent, { signal: controller.signal });
    await expect(f.cleanup.clean(f.intent)).rejects.toThrow("search_busy"); controller.abort();
    await expect(attempt).rejects.toThrow("search_cancelled"); pending.resolve({ checkpoints: [], nextAfterSessionId: null });
    await expect(f.cleanup.clean(f.intent, { signal: controller.signal })).rejects.toThrow("search_cancelled");
    f.cleanup.close(); await expect(f.cleanup.clean(f.intent)).rejects.toThrow("search_cancelled");
  });

  it.each([
    { pathIndex: -1, afterSessionId: null }, { pathIndex: 2, afterSessionId: null },
    { pathIndex: 0.5, afterSessionId: null }, { pathIndex: 0, afterSessionId: "../private" },
    {} as SearchCleanupCursor,
  ])("rejects invalid continuation cursors before IO (%j)", async (cursor) => {
    const f = fixture(); await expect(f.cleanup.clean(f.intent, { cursor })).rejects.toThrow("search_index_invalid");
    expect(f.repository.readCheckpointPage).not.toHaveBeenCalled();
  });

  it("rejects serialized/forged over-limit intents and safe-wraps arbitrary guard diagnostics", async () => {
    const f = fixture();
    await expect(f.cleanup.clean(JSON.parse(JSON.stringify(f.intent)) as SearchInvalidation)).rejects.toThrow("search_index_invalid");
    await expect(f.cleanup.clean({ ...f.scope, kind: "paths", paths: Array(3).fill("/a.jsonl"), assertCurrent: f.assertCurrent })).rejects.toThrow("search_index_invalid");
    await expect(f.cleanup.clean({ ...f.intent, assertCurrent: () => { throw new Error("private filesystem path"); } })).rejects.toThrow(/^search_source_changed$/u);
    expect(f.repository.readCheckpointPage).not.toHaveBeenCalled();
    await expect(f.cleanup.clean({ ...f.intent, assertCurrent: (() => Promise.resolve()) as unknown as () => undefined })).rejects.toThrow("search_index_invalid");
  });

  it.each(["oversize", "scope", "path", "order", "cursor"] as const)("rejects corrupt injected checkpoint pages (%s)", async (corruption) => {
    const f = fixture(2); const rows = [...f.checkpoints.values()];
    if (corruption === "oversize") while (rows.length < 65) rows.push(rows[0]!);
    if (corruption === "scope") rows[0] = { ...rows[0]!, workspaceId: "other" };
    if (corruption === "path") rows[0] = { ...rows[0]!, sourcePath: "/other.jsonl" };
    if (corruption === "order") rows.reverse();
    f.repository.readCheckpointPage.mockResolvedValueOnce({ checkpoints: rows, nextAfterSessionId: corruption === "cursor" ? "wrong" : null });
    await expect(f.cleanup.clean(f.intent)).rejects.toThrow("search_database_unavailable");
    expect(f.repository.deleteDocumentVersion).not.toHaveBeenCalled();
  });

  it.each([0, -1, 5001, 1.5])("cannot raise/disable cleanup deadlines (%s)", (timeout) => {
    expect(() => fixture(0, timeout)).toThrow("search_index_invalid");
  });
});

function conditionalFixture(override?: (sql: string) => { rows: Record<string, unknown>[] } | undefined) {
  const checkpoint = saved(); const client = {
    query: vi.fn(async (sql: string, _values?: unknown[]) => {
      const custom = override?.(sql); if (custom) return custom;
      if (sql.startsWith("SELECT workspace_id")) return { rows: [{ workspace_id: checkpoint.workspaceId }] };
      if (sql.startsWith("SELECT id FROM search_documents") || sql.startsWith("DELETE FROM search_documents")) return { rows: [{ id: checkpoint.documentId }] };
      if (sql.startsWith("SELECT count(*)")) return { rows: [{ count: "3" }] };
      return { rows: [] };
    }), release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  return { checkpoint, client, pool, repository: new PostgresSearchRepository(pool) };
}

describe("conditional repository document cleanup", () => {
  it("locks exact scope and document version/path, cascades evidence and adjusts counters atomically", async () => {
    const f = conditionalFixture(); expect(await f.repository.deleteDocumentVersion(f.checkpoint)).toBe(true);
    const select = f.client.query.mock.calls.find(([sql]) => sql.startsWith("SELECT id FROM search_documents"))!;
    expect(select[0]).toContain("FOR UPDATE");
    expect(select[1]).toEqual([f.checkpoint.workspaceId, f.checkpoint.sourceRevision, f.checkpoint.sessionId, f.checkpoint.documentId, "1", f.checkpoint.sourcePath]);
    const remove = f.client.query.mock.calls.find(([sql]) => sql.startsWith("DELETE FROM search_documents"))!;
    expect(remove[1]).toEqual(select[1]); expect(remove[0]).toContain("generation = $5::bigint AND source_path = $6");
    expect(f.client.query.mock.calls.find(([sql]) => sql.startsWith("UPDATE search_workspaces"))?.[1]).toEqual([f.checkpoint.workspaceId, -1, -3]);
    expect(f.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it.each(["workspace", "document"])("missing/stale %s is a no-op without counter updates", async (part) => {
    const f = conditionalFixture((sql) => sql.startsWith(part === "workspace" ? "SELECT workspace_id" : "SELECT id FROM search_documents") ? { rows: [] } : undefined);
    expect(await f.repository.deleteDocumentVersion(f.checkpoint)).toBe(false);
    expect(f.client.query.mock.calls.some(([sql]) => sql.startsWith("DELETE") || sql.startsWith("UPDATE"))).toBe(false);
  });

  it("snapshots exact bigint generation and scope/path before borrowing a client", async () => {
    const f = conditionalFixture(); const checkpoint = { ...f.checkpoint, generation: "9007199254740993" };
    const attempt = f.repository.deleteDocumentVersion(checkpoint); checkpoint.generation = "1"; checkpoint.sourcePath = "/other.jsonl";
    expect(await attempt).toBe(true);
    expect(f.client.query.mock.calls.find(([sql]) => sql.startsWith("DELETE FROM search_documents"))?.[1]?.slice(4)).toEqual(["9007199254740993", f.checkpoint.sourcePath]);
  });

  it.each([{ generation: "0" }, { documentId: "invalid" }, { sessionId: "../secret" }, { sourcePath: "/a/../b.jsonl" }])("rejects invalid deletion witnesses before IO (%j)", async (mutation) => {
    const f = conditionalFixture(); await expect(f.repository.deleteDocumentVersion({ ...f.checkpoint, ...mutation })).rejects.toThrow("search_index_invalid");
    expect(f.pool.connect).not.toHaveBeenCalled();
  });

  it("rolls back deletion/counters on a changed pre-commit seal", async () => {
    const f = conditionalFixture(); let checks = 0;
    await expect(f.repository.deleteDocumentVersion(f.checkpoint, { assertCurrent: () => {
      if (++checks === 2) throw new SearchRepositoryError("search_source_changed");
    } })).rejects.toThrow("search_source_changed");
    expect(f.client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(f.client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });

  it("rejects corrupt delete acknowledgements without committing counts", async () => {
    const f = conditionalFixture((sql) => sql.startsWith("DELETE FROM search_documents") ? { rows: [] } : undefined);
    await expect(f.repository.deleteDocumentVersion(f.checkpoint)).rejects.toThrow("search_index_invalid");
    expect(f.client.query.mock.calls.some(([sql]) => sql.startsWith("UPDATE"))).toBe(false);
    expect(f.client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
});
