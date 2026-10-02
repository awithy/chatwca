import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchRepositoryDatabase, type SearchRepositoryTransaction } from "../../src/server/search/database.js";
import { SearchRepositoryError } from "../../src/server/search/errors.js";
import type { SearchDatabaseConnection, SearchDatabasePool } from "../../src/server/search/migrations.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
function fixture(handler?: (sql: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) {
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => handler ? handler(sql, values) : { rows: [] }), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  const db = new SearchRepositoryDatabase(pool, 1000);
  return { client, pool, db };
}
afterEach(() => vi.useRealTimers());

describe("aggregate bounded repository transactions", () => {
  it("is lazy, reserves one connection, bounds server deadlines and commits after all work", async () => {
    const { db, pool, client } = fixture();
    expect(pool.connect).not.toHaveBeenCalled();
    expect(await db.transaction(async (tx) => { await tx.query("SELECT synthetic"); return "complete"; })).toBe("complete");
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN",
      "SELECT set_config('transaction_timeout', $1, true), set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)",
      "SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", "SELECT synthetic", "COMMIT",
    ]);
    const timeout = client.query.mock.calls[1]?.[1]?.[0] as string;
    expect(Number(timeout.replace("ms", ""))).toBeLessThanOrEqual(1000);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("supports read-only transactions, and seals retained query handles after commit", async () => {
    const { db, client } = fixture();
    let saved: SearchRepositoryTransaction | undefined;
    await db.transaction(async (tx) => { saved = tx; }, {}, true);
    expect(client.query.mock.calls[0]?.[0]).toBe("BEGIN READ ONLY");
    const calls = client.query.mock.calls.length;
    await expect(saved!.query("UPDATE should_never_run")).rejects.toThrow("search_cancelled");
    expect(client.query.mock.calls).toHaveLength(calls);
  });

  it("cannot dispatch a late data statement after COMMIT begins, even if its setup query was already pending", async () => {
    const setup = deferred<{ rows: Record<string, unknown>[] }>();
    const commit = deferred<{ rows: Record<string, unknown>[] }>();
    const { db, client } = fixture(async (sql) => {
      if (sql.startsWith("SELECT set_config('statement_timeout'")) return setup.promise;
      if (sql === "COMMIT") return commit.promise;
      return { rows: [] };
    });
    let orphan: Promise<unknown> | undefined;
    const pending = db.transaction(async (tx) => {
      orphan = tx.query("UPDATE must_not_autocommit").catch((error: unknown) => error);
      return "complete";
    });
    await vi.waitFor(() => expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(true));
    setup.resolve({ rows: [] });
    expect(await orphan).toEqual(new SearchRepositoryError("search_cancelled"));
    expect(client.query.mock.calls.some(([sql]) => sql === "UPDATE must_not_autocommit")).toBe(false);
    commit.resolve({ rows: [] });
    expect(await pending).toBe("complete");
  });

  it("rolls back ordinary failures and safely reuses the connection", async () => {
    const { db, client } = fixture(async (sql) => {
      if (sql === "FAIL") throw new Error("SQL includes private transcript and credential");
      return { rows: [] };
    });
    const error = await db.transaction((tx) => tx.query("FAIL")).catch((value: unknown) => value);
    expect(error).toEqual(new SearchRepositoryError("search_database_unavailable"));
    expect((error as Error).cause).toBeUndefined();
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
    await expect(db.transaction(async () => "next")).resolves.toBe("next");
  });

  it("destroys an unacknowledged BEGIN rather than reusing a potentially open transaction", async () => {
    const { db, client } = fixture(async (sql) => {
      if (sql === "BEGIN") throw new Error("lost acknowledgement");
      return { rows: [] };
    });
    await expect(db.transaction(async () => "never")).rejects.toThrow("search_database_unavailable");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("rechecks synchronous registration/invalidation guards before COMMIT and rolls back on change", async () => {
    const { db, client } = fixture();
    let current = true;
    const guard = vi.fn((): undefined => { if (!current) throw new SearchRepositoryError("search_source_changed"); });
    await expect(db.transaction(async (tx) => {
      await tx.query("UPDATE candidate_generation");
      current = false;
    }, { assertCurrent: guard })).rejects.toThrow("search_source_changed");
    expect(guard).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
  });

  it("destroys a connection when rollback fails", async () => {
    const { db, client } = fixture(async (sql) => {
      if (sql === "FAIL" || sql === "ROLLBACK") throw new Error("private");
      return { rows: [] };
    });
    await expect(db.transaction((tx) => tx.query("FAIL"))).rejects.toThrow("search_database_unavailable");
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not retry an ambiguous COMMIT or return an unacknowledged generation", async () => {
    const { db, client } = fixture(async (sql) => {
      if (sql === "COMMIT") throw new Error("connection lost after server may have committed");
      return { rows: [] };
    });
    await expect(db.transaction(async () => "candidate")).rejects.toThrow("search_database_unavailable");
    expect(client.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1);
    expect(client.query.mock.calls.some(([sql]) => sql === "ROLLBACK")).toBe(false);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it.each(["57014", "55P03", "25P04"])("redacts database timeout code %s", async (code) => {
    const { db } = fixture(async (sql) => {
      if (sql === "FAIL") throw Object.assign(new Error("provider SQL diagnostic"), { code });
      return { rows: [] };
    });
    await expect(db.transaction((tx) => tx.query("FAIL"))).rejects.toEqual(new SearchRepositoryError("search_timeout"));
  });

  it("redacts pool failure and clears admission", async () => {
    const { pool, db } = fixture();
    pool.connect.mockRejectedValueOnce(new Error("postgres://user:password/private"));
    await expect(db.transaction(async () => "never")).rejects.toEqual(new SearchRepositoryError("search_database_unavailable"));
    await expect(db.transaction(async () => "next")).resolves.toBe("next");
  });

  it("rejects duplicate admission without waiting for the pool", async () => {
    const gate = deferred<void>();
    const { pool, db } = fixture();
    const active = db.transaction(async () => { await gate.promise; });
    await expect(db.transaction(async () => undefined)).rejects.toThrow("search_busy");
    expect(pool.connect).toHaveBeenCalledOnce();
    gate.resolve();
    await active;
  });

  it("bounds stuck pool acquisition to three seconds and destroys a late connection", async () => {
    vi.useFakeTimers();
    const gate = deferred<SearchDatabaseConnection>();
    const client = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() };
    const pool: SearchDatabasePool = { connect: () => gate.promise };
    const db = new SearchRepositoryDatabase(pool);
    const pending = expect(db.transaction(async () => undefined)).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(3001);
    await pending;
    gate.resolve(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("cancels hung queries, destroys the client, and never sends a late COMMIT", async () => {
    vi.useFakeTimers();
    const gate = deferred<{ rows: Record<string, unknown>[] }>();
    const { db, client } = fixture(async (sql) => sql === "STALLED" ? gate.promise : { rows: [] });
    const pending = expect(db.transaction((tx) => tx.query("STALLED"))).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    gate.resolve({ rows: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT" || sql === "ROLLBACK")).toBe(false);
  });

  it("counts all statements toward one deadline, not a fresh timeout per statement", async () => {
    vi.useFakeTimers();
    const { db, client } = fixture(async (sql) => {
      if (sql.startsWith("DATA")) await new Promise<void>((resolve) => setTimeout(resolve, 600));
      return { rows: [] };
    });
    const pending = expect(db.transaction(async (tx) => { await tx.query("DATA1"); await tx.query("DATA2"); })).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    expect(client.query.mock.calls.filter(([sql]) => sql.startsWith("DATA"))).toHaveLength(2);
    expect(client.query.mock.calls.some(([sql]) => sql === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("bounds a stuck callback and seals any later attempt to use its transaction", async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const { db, client } = fixture();
    let late: Promise<unknown> | undefined;
    const pending = expect(db.transaction(async (tx) => {
      await gate.promise;
      late = tx.query("UPDATE late_publication").catch((error: unknown) => error);
      await late;
    })).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(1001);
    await pending;
    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(await late).toEqual(new SearchRepositoryError("search_cancelled"));
    expect(client.query.mock.calls.some(([sql]) => sql === "UPDATE late_publication" || sql === "COMMIT")).toBe(false);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("handles caller abort and shutdown without exposing caller reasons or opening more connections", async () => {
    const { db, pool, client } = fixture();
    const aborted = new AbortController();
    aborted.abort(new Error("private caller reason"));
    await expect(db.transaction(async () => undefined, { signal: aborted.signal })).rejects.toThrow("search_cancelled");
    expect(pool.connect).not.toHaveBeenCalled();
    const gate = deferred<void>();
    const pending = expect(db.transaction(async () => gate.promise)).rejects.toThrow("search_cancelled");
    await vi.waitFor(() => expect(client.query.mock.calls.some(([sql]) => sql.startsWith("SELECT set_config('transaction_timeout'"))).toBe(true));
    db.close();
    await pending;
    gate.resolve();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    await expect(db.transaction(async () => undefined)).rejects.toThrow("search_cancelled");
    expect(pool.connect).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 1.5, 5001, NaN])("rejects invalid deadline override %s without IO", (timeout) => {
    const pool = { connect: vi.fn() };
    expect(() => new SearchRepositoryDatabase(pool, timeout)).toThrow("search_index_invalid");
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
