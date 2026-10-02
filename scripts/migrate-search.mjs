import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

import { validateSearchDatabaseUrl } from "../src/server/search/config.ts";
import { createSearchPool } from "../src/server/search/postgres.ts";
import { loadSearchMigrations, migrateSearchDatabase, SearchSchemaError } from "../src/server/search/migrations.ts";

let pool;
try {
  if (existsSync(".env")) loadEnvFile(".env");
  // Run from the repository root. This explicit command works while search is
  // disabled; it never loads conversations, Pi credentials, or Ollama.
  const url = process.env.CHATWCA_SEARCH_DATABASE_URL;
  if (url === undefined) throw new Error("missing configuration");
  validateSearchDatabaseUrl(url);
  const migrations = await loadSearchMigrations();
  pool = createSearchPool(url);
  const applied = await migrateSearchDatabase(pool, migrations);
  console.info(`Search migrations applied: ${applied.length === 0 ? "none (up to date)" : applied.join(", ")}`);
} catch (error) {
  // pg and URL diagnostics may contain credentials or server paths.
  console.error(error instanceof SearchSchemaError ? error.code : "search_migration_failed");
  process.exitCode = 1;
} finally {
  await pool?.end();
}
