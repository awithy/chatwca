import { describe, expect, it, vi } from "vitest";

import { checkSearchSchema, loadSearchMigrations, migrateSearchDatabase, SearchSchemaError, type SearchDatabaseConnection } from "../../src/server/search/migrations.js";

const migration = { name: "001_initial.sql", checksum: "hash", sql: "CREATE TABLE example (id integer)" };

function fakeDatabase(options: {
  history?: Record<string, unknown>[];
  extension?: boolean;
  ledger?: boolean;
  dimension?: string;
  failDdl?: boolean;
  failRollback?: boolean;
} = {}) {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql === migration.sql && options.failDdl) throw new Error("private pg diagnostic");
    if (sql === "ROLLBACK" && options.failRollback) throw new Error("connection lost");
    if (sql.includes("FROM pg_extension")) return { rows: options.extension === false ? [] : [{ "?column?": 1 }] };
    if (sql.includes("AS ledger")) return { rows: [{ ledger: options.ledger === false ? null : "search_schema_migrations" }] };
    if (sql.includes("SELECT name, checksum")) return { rows: options.history ?? [] };
    if (sql.includes("format_type")) return { rows: [{ type: options.dimension ?? "vector(1024)" }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const connection: SearchDatabaseConnection = { query, release };
  const pool = { connect: vi.fn(async () => connection) };
  return { pool, query, release };
}

describe("explicit search migrations", () => {
  it("loads a fixed separate migration history with content checksums", async () => {
    const migrations = await loadSearchMigrations();
    expect(migrations.map((entry) => entry.name)).toEqual(["001_initial.sql", "002_checkpoint_lookup.sql"]);
    expect(migrations[1]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(migrations[1]?.sql).toContain('session_id COLLATE "C"');
    expect(migrations[1]?.sql).toContain("md5(source_path)");
    expect(migrations[0]?.checksum).toMatch(/^[a-f0-9]{64}$/u);
    expect(migrations[0]?.sql).toContain("embedding vector(1024) NOT NULL");
    expect(migrations[0]?.sql).not.toMatch(/CREATE EXTENSION|USING hnsw/iu);
  });

  it("locks, applies DDL and the checkpoint in one transaction, and releases", async () => {
    const db = fakeDatabase();
    expect(await migrateSearchDatabase(db.pool, [migration])).toEqual([migration.name]);
    const calls = db.query.mock.calls.map(([sql]) => sql);
    expect(calls[0]).toBe("BEGIN");
    expect(calls[2]).toContain("pg_advisory_xact_lock");
    expect(calls.indexOf(migration.sql)).toBeLessThan(calls.findIndex((sql) => sql.startsWith("INSERT INTO")));
    expect(calls.at(-1)).toBe("COMMIT");
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO search_schema_migrations"), [migration.name, migration.checksum]);
    expect(db.release).toHaveBeenCalledWith(false);
  });

  it("is idempotent", async () => {
    const db = fakeDatabase({ history: [{ name: migration.name, checksum: migration.checksum }] });
    expect(await migrateSearchDatabase(db.pool, [migration])).toEqual([]);
    expect(db.query).not.toHaveBeenCalledWith(migration.sql);
  });

  it.each([
    { extension: false },
    { history: [{ name: "999_future.sql", checksum: "future" }] },
    { history: [{ name: migration.name, checksum: "changed" }] },
  ])("rejects missing extensions and unknown/modified migration history (%j)", async (options) => {
    const db = fakeDatabase(options);
    await expect(migrateSearchDatabase(db.pool, [migration])).rejects.toBeInstanceOf(SearchSchemaError);
    expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    expect(db.query).not.toHaveBeenCalledWith(migration.sql);
    expect(db.release).toHaveBeenCalledWith(false);
  });

  it("upgrades existing initial-only history without rerunning or modifying the initial migration", async () => {
    const migrations = await loadSearchMigrations();
    const db = fakeDatabase({ history: [{ name: migrations[0]!.name, checksum: migrations[0]!.checksum }] });
    await expect(checkSearchSchema(db.pool, migrations)).rejects.toBeInstanceOf(SearchSchemaError);
    expect(await migrateSearchDatabase(db.pool, migrations)).toEqual(["002_checkpoint_lookup.sql"]);
    expect(db.query).not.toHaveBeenCalledWith(migrations[0]!.sql);
    expect(db.query).toHaveBeenCalledWith(migrations[1]!.sql);
  });

  it("rejects a gap, unknown migration or altered new migration before applying DDL", async () => {
    const migrations = await loadSearchMigrations();
    for (const history of [
      [{ name: migrations[1]!.name, checksum: migrations[1]!.checksum }],
      [...migrations.map(({ name, checksum }) => ({ name, checksum })), { name: "003_unknown.sql", checksum: "unknown" }],
      [{ name: migrations[0]!.name, checksum: migrations[0]!.checksum }, { name: migrations[1]!.name, checksum: "altered" }],
    ]) {
      const db = fakeDatabase({ history });
      await expect(migrateSearchDatabase(db.pool, migrations)).rejects.toBeInstanceOf(SearchSchemaError);
      expect(db.query).not.toHaveBeenCalledWith(migrations[1]!.sql);
      expect(db.query).toHaveBeenCalledWith("ROLLBACK");
    }
  });

  it("rolls back failed DDL and destroys a connection if rollback fails", async () => {
    for (const failRollback of [false, true]) {
      const db = fakeDatabase({ failDdl: true, failRollback });
      await expect(migrateSearchDatabase(db.pool, [migration])).rejects.toThrow("private pg diagnostic");
      expect(db.query).not.toHaveBeenCalledWith("COMMIT");
      expect(db.query).toHaveBeenCalledWith("ROLLBACK");
      expect(db.release).toHaveBeenCalledWith(failRollback);
    }
  });

  it("checks compatibility with read-only queries, never DDL", async () => {
    const db = fakeDatabase({ history: [{ name: migration.name, checksum: migration.checksum }] });
    await expect(checkSearchSchema(db.pool, [migration])).resolves.toBeUndefined();
    expect(db.query.mock.calls.every(([sql]) => sql.startsWith("SELECT") || sql === "BEGIN READ ONLY" || sql === "COMMIT")).toBe(true);
    expect(db.query.mock.calls[0]?.[0]).toBe("BEGIN READ ONLY");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    expect(db.release).toHaveBeenCalledOnce();
  });

  it("cancels schema checks before admission or during non-cooperative database IO", async () => {
    const db = fakeDatabase();
    await expect(checkSearchSchema(db.pool, [migration], { signal: AbortSignal.abort() })).rejects.toThrow("search_cancelled");
    expect(db.pool.connect).not.toHaveBeenCalled();
    const controller = new AbortController();
    db.query.mockImplementation(() => new Promise(() => {}));
    const result = checkSearchSchema(db.pool, [migration], { signal: controller.signal }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(db.query).toHaveBeenCalled()); controller.abort();
    expect(await result).toMatchObject({ code: "search_cancelled" }); expect(db.release).toHaveBeenCalledWith(true);
  });

  it.each([{ ledger: false }, { history: [] }, { dimension: "vector(768)" }])("rejects incompatible schemas (%j)", async (options) => {
    const db = fakeDatabase({ history: [{ name: migration.name, checksum: migration.checksum }], ...options });
    await expect(checkSearchSchema(db.pool, [migration])).rejects.toBeInstanceOf(SearchSchemaError);
    expect(db.release).toHaveBeenCalledOnce();
  });
});
