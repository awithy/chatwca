import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { SearchRepositoryDatabase, type SearchRepositoryOptions } from "./database.js";
import { SearchRepositoryError } from "./errors.js";

export const SEARCH_MIGRATION_NAMES = Object.freeze(["001_initial.sql", "002_checkpoint_lookup.sql"]);

export interface SearchMigration {
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

/** Narrow boundary shared by pg and deterministic migration tests. */
export interface SearchDatabaseConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(destroy?: boolean): void;
}
export interface SearchDatabasePool {
  connect(): Promise<SearchDatabaseConnection>;
}

export class SearchSchemaError extends SearchRepositoryError {
  constructor() { super("search_schema_incompatible"); this.message = "Search schema is incompatible; run the explicit search migration command."; }
}

export async function loadSearchMigrations(directory = path.resolve("migrations/search")): Promise<readonly SearchMigration[]> {
  return Promise.all(SEARCH_MIGRATION_NAMES.map(async (name) => {
    const sql = await readFile(path.join(directory, name), "utf8");
    return Object.freeze({ name, sql, checksum: createHash("sha256").update(sql).digest("hex") });
  }));
}

function validateHistory(rows: readonly Record<string, unknown>[], migrations: readonly SearchMigration[], requireComplete: boolean): Set<string> {
  const known = new Map(migrations.map((migration) => [migration.name, migration.checksum]));
  const applied = new Set<string>();
  for (const row of rows) {
    if (typeof row.name !== "string" || known.get(row.name) !== row.checksum || applied.has(row.name)) throw new SearchSchemaError();
    applied.add(row.name);
  }
  // Gaps are incompatible too: never apply older DDL after a newer migration.
  let missing = false;
  for (const migration of migrations) {
    if (!applied.has(migration.name)) missing = true;
    else if (missing) throw new SearchSchemaError();
  }
  if (requireComplete && applied.size !== migrations.length) throw new SearchSchemaError();
  return applied;
}

/** Administrator-invoked DDL only. Serializes writers and records checksums atomically. */
export async function migrateSearchDatabase(pool: SearchDatabasePool, migrations: readonly SearchMigration[]): Promise<string[]> {
  const connection = await pool.connect();
  let transaction = false;
  let destroy = false;
  try {
    await connection.query("BEGIN");
    transaction = true;
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query("SELECT pg_advisory_xact_lock(hashtext('chatwca-search'), hashtext('schema-migrations'))");
    // Do not silently install extensions or require superuser authority.
    const extension = await connection.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    if (extension.rows.length !== 1) throw new SearchSchemaError();
    await connection.query(`CREATE TABLE IF NOT EXISTS search_schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const history = await connection.query("SELECT name, checksum FROM search_schema_migrations ORDER BY name");
    const applied = validateHistory(history.rows, migrations, false);
    const newlyApplied: string[] = [];
    for (const migration of migrations) {
      if (applied.has(migration.name)) continue;
      await connection.query(migration.sql);
      await connection.query("INSERT INTO search_schema_migrations (name, checksum) VALUES ($1, $2)", [migration.name, migration.checksum]);
      newlyApplied.push(migration.name);
    }
    await connection.query("COMMIT");
    transaction = false;
    return newlyApplied;
  } catch (error) {
    if (transaction) {
      try { await connection.query("ROLLBACK"); }
      catch { destroy = true; }
    }
    throw error;
  } finally {
    connection.release(destroy);
  }
}

/** Bounded, cancellable read-only startup compatibility check; never runs DDL. */
export async function checkSearchSchema(pool: SearchDatabasePool, migrations: readonly SearchMigration[], options: SearchRepositoryOptions = {}): Promise<void> {
  const database = new SearchRepositoryDatabase(pool);
  await database.transaction(async (connection) => {
    const ledger = await connection.query("SELECT to_regclass('search_schema_migrations') AS ledger");
    if (!ledger.rows[0]?.ledger) throw new SearchSchemaError();
    const history = await connection.query("SELECT name, checksum FROM search_schema_migrations ORDER BY name");
    validateHistory(history.rows, migrations, true);
    const column = await connection.query(`SELECT format_type(a.atttypid, a.atttypmod) AS type
      FROM pg_attribute a WHERE a.attrelid = to_regclass('search_chunks')
      AND a.attname = 'embedding' AND NOT a.attisdropped`);
    if (column.rows.length !== 1 || column.rows[0]?.type !== "vector(1024)") throw new SearchSchemaError();
  }, options, true);
}
