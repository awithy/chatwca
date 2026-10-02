import { Pool } from "pg";

import { validateSearchDatabaseUrl } from "./config.js";

/** Construction is explicit and lazy; importing configuration never loads pg. */
export function createSearchPool(databaseUrl: string, onIdleError?: (code: "search_database_unavailable") => void): Pool {
  const pool = new Pool({
    connectionString: validateSearchDatabaseUrl(databaseUrl),
    max: 4,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    query_timeout: 5_000,
    idle_in_transaction_session_timeout: 5_000,
    application_name: "chatwca-search",
  });
  // pg emits idle-client failures outside query promises. Optional search must
  // not turn a database restart into an uncaught process-wide EventEmitter error.
  pool.on("error", () => onIdleError?.("search_database_unavailable"));
  return pool;
}
