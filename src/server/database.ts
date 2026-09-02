import { mkdirSync } from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export const DATABASE_FILENAME = "chatwca.sqlite";
export const DATABASE_SCHEMA_VERSION = 7;
export const DATABASE_BUSY_TIMEOUT_MS = 5_000;

const JOB_SCHEMA = `
  CREATE TABLE jobs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
      CHECK (length(trim(name)) BETWEEN 1 AND 200),
    workspace_id TEXT NOT NULL
      REFERENCES workspaces(id) ON DELETE RESTRICT,
    prompt TEXT NOT NULL
      CHECK (length(prompt) BETWEEN 1 AND 100000 AND length(trim(prompt)) > 0),
    schedule_kind TEXT NOT NULL
      CHECK (schedule_kind IN ('interval', 'daily')),
    interval_minutes INTEGER,
    anchor_at INTEGER,
    daily_time TEXT,
    time_zone TEXT,
    pre_run_script TEXT
      CHECK (pre_run_script IS NULL OR length(pre_run_script) BETWEEN 1 AND 4096),
    post_run_script TEXT
      CHECK (post_run_script IS NULL OR length(post_run_script) BETWEEN 1 AND 4096),
    enabled INTEGER NOT NULL DEFAULT 1
      CHECK (typeof(enabled) = 'integer' AND enabled IN (0, 1)),
    next_run_at INTEGER,
    created_at INTEGER NOT NULL
      CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL
      CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991),
    CHECK (
      (schedule_kind = 'interval'
        AND typeof(interval_minutes) = 'integer'
        AND interval_minutes BETWEEN 1 AND 525600
        AND typeof(anchor_at) = 'integer'
        AND anchor_at BETWEEN 0 AND 9007199254740991
        AND daily_time IS NULL
        AND time_zone IS NULL)
      OR
      (schedule_kind = 'daily'
        AND interval_minutes IS NULL
        AND anchor_at IS NULL
        AND daily_time IS NOT NULL
        AND length(daily_time) = 5
        AND daily_time GLOB '[0-2][0-9]:[0-5][0-9]'
        AND substr(daily_time, 1, 2) <= '23'
        AND time_zone IS NOT NULL
        AND length(time_zone) BETWEEN 1 AND 255)
    ),
    CHECK (
      (enabled = 0 AND next_run_at IS NULL)
      OR
      (enabled = 1
        AND typeof(next_run_at) = 'integer'
        AND next_run_at BETWEEN 0 AND 9007199254740991)
    )
  );

  CREATE INDEX jobs_due_idx
    ON jobs(enabled, next_run_at);

  CREATE TABLE job_runs (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL
      REFERENCES jobs(id) ON DELETE CASCADE,
    conversation_id TEXT,
    trigger TEXT NOT NULL
      CHECK (trigger IN ('scheduled', 'manual', 'catch-up')),
    scheduled_for INTEGER NOT NULL
      CHECK (typeof(scheduled_for) = 'integer' AND scheduled_for BETWEEN 0 AND 9007199254740991),
    started_at INTEGER
      CHECK (started_at IS NULL OR (typeof(started_at) = 'integer' AND started_at BETWEEN 0 AND 9007199254740991)),
    finished_at INTEGER
      CHECK (finished_at IS NULL OR (typeof(finished_at) = 'integer' AND finished_at BETWEEN 0 AND 9007199254740991)),
    status TEXT NOT NULL
      CHECK (status IN (
        'queued', 'running', 'succeeded', 'failed', 'blocked', 'skipped',
        'aborted', 'interrupted'
      )),
    phase TEXT
      CHECK (phase IS NULL OR phase IN ('pre-hook', 'prompt', 'post-hook')),
    error_code TEXT,
    error_message TEXT,
    pre_exit_code INTEGER
      CHECK (pre_exit_code IS NULL OR typeof(pre_exit_code) = 'integer'),
    pre_stdout TEXT,
    pre_stderr TEXT,
    post_exit_code INTEGER
      CHECK (post_exit_code IS NULL OR typeof(post_exit_code) = 'integer'),
    post_stdout TEXT,
    post_stderr TEXT,
    revision INTEGER NOT NULL DEFAULT 0
      CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
    created_at INTEGER NOT NULL
      CHECK (typeof(created_at) = 'integer' AND created_at BETWEEN 0 AND 9007199254740991),
    updated_at INTEGER NOT NULL
      CHECK (typeof(updated_at) = 'integer' AND updated_at BETWEEN 0 AND 9007199254740991)
  );

  CREATE INDEX job_runs_job_time_idx
    ON job_runs(job_id, scheduled_for DESC);

  CREATE UNIQUE INDEX job_runs_active_job_idx
    ON job_runs(job_id)
    WHERE status IN ('queued', 'running');
`;

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

  CREATE TABLE workspace_mounts (
    workspace_id TEXT NOT NULL
      REFERENCES workspaces(id) ON DELETE CASCADE,
    name TEXT NOT NULL
      CHECK (
        length(name) BETWEEN 1 AND 64 AND
        name NOT GLOB '*[^a-z0-9_-]*' AND
        substr(name, 1, 1) GLOB '[a-z0-9]' AND
        substr(name, -1, 1) GLOB '[a-z0-9]'
      ),
    source_path TEXT NOT NULL
      CHECK (length(source_path) BETWEEN 1 AND 4096),
    access TEXT NOT NULL
      CHECK (access IN ('read-only', 'read-write')),
    PRIMARY KEY (workspace_id, name),
    UNIQUE (workspace_id, source_path)
  );

  ${JOB_SCHEMA}
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

function migrateVersionFive(connection: Database.Database): void {
  connection.transaction(() => {
    connection.exec(`
      CREATE TABLE workspace_mounts (
        workspace_id TEXT NOT NULL
          REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL
          CHECK (
            length(name) BETWEEN 1 AND 64 AND
            name NOT GLOB '*[^a-z0-9_-]*' AND
            substr(name, 1, 1) GLOB '[a-z0-9]' AND
            substr(name, -1, 1) GLOB '[a-z0-9]'
          ),
        source_path TEXT NOT NULL
          CHECK (length(source_path) BETWEEN 1 AND 4096),
        access TEXT NOT NULL
          CHECK (access IN ('read-only', 'read-write')),
        PRIMARY KEY (workspace_id, name),
        UNIQUE (workspace_id, source_path)
      );
    `);
    connection.pragma("user_version = 6");
  })();
}

/** Add scheduled-job persistence without inspecting history or creating rows. */
function migrateVersionSix(connection: Database.Database): void {
  connection.transaction(() => {
    connection.exec(JOB_SCHEMA);
    connection.pragma("user_version = 7");
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
      migrateVersionFive(connection);
      migrateVersionSix(connection);
    } else if (version === 2) {
      migrateVersionTwo(connection);
      migrateVersionThree(connection);
      migrateVersionFour(connection);
      migrateVersionFive(connection);
      migrateVersionSix(connection);
    } else if (version === 3) {
      migrateVersionThree(connection);
      migrateVersionFour(connection);
      migrateVersionFive(connection);
      migrateVersionSix(connection);
    } else if (version === 4) {
      migrateVersionFour(connection);
      migrateVersionFive(connection);
      migrateVersionSix(connection);
    } else if (version === 5) {
      migrateVersionFive(connection);
      migrateVersionSix(connection);
    } else if (version === 6) {
      migrateVersionSix(connection);
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
