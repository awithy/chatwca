import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export const DATABASE_FILENAME = "chatwca.sqlite";
export const DATABASE_SCHEMA_VERSION = 5;
export const DATABASE_BUSY_TIMEOUT_MS = 5_000;

const INITIAL_SCHEMA = `
  CREATE TABLE workspaces (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    path       TEXT NOT NULL UNIQUE,
    session_storage TEXT NOT NULL DEFAULT 'pi-default'
      CHECK (session_storage IN ('pi-default', 'workspace')),
    security_profile TEXT NOT NULL DEFAULT 'unrestricted'
      CHECK (security_profile IN ('unrestricted', 'workspace-sandboxed')),
    network_policy TEXT NOT NULL DEFAULT 'isolated'
      CHECK (network_policy IN ('isolated', 'managed-egress')),
    network_policy_set_id TEXT NOT NULL DEFAULT 'default'
      CHECK (
        length(network_policy_set_id) BETWEEN 1 AND 64 AND
        network_policy_set_id NOT GLOB '*[^a-z0-9_-]*' AND
        substr(network_policy_set_id, 1, 1) GLOB '[a-z0-9]' AND
        substr(network_policy_set_id, -1, 1) GLOB '[a-z0-9]'
      ),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

export class UnsupportedDatabaseVersionError extends Error {
  override readonly name = "UnsupportedDatabaseVersionError";
  readonly version: number;

  constructor(version: number) {
    super(
      `Unsupported ChatWCA database schema version ${String(version)}; expected ${String(DATABASE_SCHEMA_VERSION)}`,
    );
    this.version = version;
  }
}

/** Owns the process-wide SQLite connection and closes it at most once. */
export class ChatWcaDatabase {
  readonly connection: Database.Database;
  readonly filename: string;
  #closed = false;

  constructor(connection: Database.Database, filename: string) {
    this.connection = connection;
    this.filename = filename;
  }

  get closed(): boolean {
    return this.#closed;
  }

  close(): void {
    if (this.#closed) return;
    // Claim closure before entering the native boundary. A failed close is
    // reported by the caller, but repeated shutdown must never invoke SQLite
    // close more than once.
    this.#closed = true;
    if (this.connection.open) this.connection.close();
  }
}

function schemaVersion(connection: Database.Database): number {
  return connection.pragma("user_version", { simple: true }) as number;
}

function initializeSchema(connection: Database.Database): void {
  connection.transaction(() => {
    connection.exec(INITIAL_SCHEMA);
    connection.pragma(`user_version = ${String(DATABASE_SCHEMA_VERSION)}`);
  })();
}

function migrateVersionOne(connection: Database.Database): void {
  connection.transaction(() => {
    connection.exec(`
      ALTER TABLE workspaces
      ADD COLUMN session_storage TEXT NOT NULL DEFAULT 'pi-default'
        CHECK (session_storage IN ('pi-default', 'workspace'));
    `);
    // Advance only this completed step. A following migration may fail and
    // must never leave user_version claiming work that was rolled back.
    connection.pragma("user_version = 2");
  })();
}

function migrateVersionTwo(connection: Database.Database): void {
  connection.transaction(() => {
    connection.exec(`
      ALTER TABLE workspaces
      ADD COLUMN security_profile TEXT NOT NULL DEFAULT 'unrestricted'
        CHECK (security_profile IN ('unrestricted', 'workspace-sandboxed'));
    `);
    connection.pragma("user_version = 3");
  })();
}

function migrateVersionThree(connection: Database.Database): void {
  connection.transaction(() => {
    connection.exec(`
      ALTER TABLE workspaces
      ADD COLUMN network_policy TEXT NOT NULL DEFAULT 'isolated'
        CHECK (network_policy IN ('isolated', 'managed-egress'));
    `);
    connection.pragma("user_version = 4");
  })();
}

function migrateVersionFour(connection: Database.Database): void {
  connection.transaction(() => {
    connection.exec(`
      ALTER TABLE workspaces
      ADD COLUMN network_policy_set_id TEXT NOT NULL DEFAULT 'default'
        CHECK (
          length(network_policy_set_id) BETWEEN 1 AND 64 AND
          network_policy_set_id NOT GLOB '*[^a-z0-9_-]*' AND
          substr(network_policy_set_id, 1, 1) GLOB '[a-z0-9]' AND
          substr(network_policy_set_id, -1, 1) GLOB '[a-z0-9]'
        );
    `);
    connection.pragma("user_version = 5");
  })();
}

/**
 * Create/open and initialize ChatWCA's SQLite database.
 *
 * `filename` is injectable so focused tests can use SQLite's `:memory:` target;
 * production always uses the default `<dataDir>/chatwca.sqlite` path.
 */
export function openDatabase(
  dataDir: string,
  filename: string = DATABASE_FILENAME,
): ChatWcaDatabase {
  mkdirSync(dataDir, { recursive: true });
  const databasePath =
    filename === ":memory:" ? filename : path.join(dataDir, filename);
  let connection: Database.Database | undefined;

  try {
    connection = new Database(databasePath);
    connection.pragma(`busy_timeout = ${String(DATABASE_BUSY_TIMEOUT_MS)}`);
    connection.pragma("foreign_keys = ON");
    connection.pragma("journal_mode = WAL");

    const version = schemaVersion(connection);
    if (version === 0) {
      initializeSchema(connection);
    } else if (version === 1) {
      migrateVersionOne(connection);
      migrateVersionTwo(connection);
      migrateVersionThree(connection);
      migrateVersionFour(connection);
    } else if (version === 2) {
      migrateVersionTwo(connection);
      migrateVersionThree(connection);
      migrateVersionFour(connection);
    } else if (version === 3) {
      migrateVersionThree(connection);
      migrateVersionFour(connection);
    } else if (version === 4) {
      migrateVersionFour(connection);
    } else if (version !== DATABASE_SCHEMA_VERSION) {
      throw new UnsupportedDatabaseVersionError(version);
    }

    return new ChatWcaDatabase(connection, databasePath);
  } catch (error) {
    if (connection?.open === true) {
      try {
        connection.close();
      } catch {
        // Preserve the initialization failure, which is the actionable cause.
      }
    }
    throw error;
  }
}
