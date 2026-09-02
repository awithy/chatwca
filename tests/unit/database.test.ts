import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DATABASE_BUSY_TIMEOUT_MS,
  DATABASE_FILENAME,
  DATABASE_SCHEMA_VERSION,
  UnsupportedDatabaseVersionError,
  openDatabase,
} from "../../src/server/database.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "chatwca-database-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("openDatabase", () => {
  it("creates nested storage and initializes the version-seven schema", () => {
    const dataDir = path.join(temporaryDirectory(), "nested", "data");
    const database = openDatabase(dataDir);

    expect(database.filename).toBe(path.join(dataDir, DATABASE_FILENAME));
    expect(
      database.connection.pragma("user_version", { simple: true }),
    ).toBe(DATABASE_SCHEMA_VERSION);
    expect(
      database.connection.pragma("foreign_keys", { simple: true }),
    ).toBe(1);
    expect(
      database.connection.pragma("busy_timeout", { simple: true }),
    ).toBe(DATABASE_BUSY_TIMEOUT_MS);
    expect(
      database.connection.pragma("journal_mode", { simple: true }),
    ).toBe("wal");

    const columns = database.connection
      .prepare("PRAGMA table_info(workspaces)")
      .all() as Array<{ name: string; notnull: number; pk: number }>;
    expect(columns).toEqual([
      expect.objectContaining({ name: "id", notnull: 0, pk: 1 }),
      expect.objectContaining({ name: "name", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "path", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "session_storage", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "security_profile", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "network_policy", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "network_policy_set_id", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "created_at", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "updated_at", notnull: 1, pk: 0 }),
    ]);

    database.close();
  });

  it("accepts and preserves an existing version-seven database", () => {
    const dataDir = temporaryDirectory();
    const first = openDatabase(dataDir);
    first.connection
      .prepare(
        "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("workspace-1", "Example", "/work/example", 10, 20);
    first.close();

    const reopened = openDatabase(dataDir);
    expect(
      reopened.connection.prepare("SELECT * FROM workspaces").get(),
    ).toEqual({
      id: "workspace-1",
      name: "Example",
      path: "/work/example",
      session_storage: "pi-default",
      security_profile: "unrestricted",
      network_policy: "isolated",
      network_policy_set_id: "default",
      created_at: 10,
      updated_at: 20,
    });
    expect(
      reopened.connection.pragma("user_version", { simple: true }),
    ).toBe(DATABASE_SCHEMA_VERSION);
    reopened.close();
  });

  it("migrates version-one workspace rows to Pi-default storage", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO workspaces VALUES ('legacy', 'Legacy', '/work/legacy', 1, 2);
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const migrated = openDatabase(dataDir);
    expect(migrated.connection.prepare("SELECT * FROM workspaces").get()).toEqual({
      id: "legacy",
      name: "Legacy",
      path: "/work/legacy",
      created_at: 1,
      updated_at: 2,
      session_storage: "pi-default",
      security_profile: "unrestricted",
      network_policy: "isolated",
      network_policy_set_id: "default",
    });
    expect(
      migrated.connection.pragma("user_version", { simple: true }),
    ).toBe(DATABASE_SCHEMA_VERSION);
    migrated.close();
  });

  it("migrates version-two rows to unrestricted security", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        session_storage TEXT NOT NULL DEFAULT 'pi-default'
          CHECK (session_storage IN ('pi-default', 'workspace')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO workspaces VALUES
        ('version-2', 'Version 2', '/work/version-2', 'workspace', 3, 4);
      PRAGMA user_version = 2;
    `);
    legacy.close();

    const migrated = openDatabase(dataDir);
    expect(migrated.connection.prepare(
      "SELECT security_profile FROM workspaces WHERE id = 'version-2'",
    ).get()).toEqual({ security_profile: "unrestricted" });
    expect(migrated.connection.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
    expect(migrated.connection.prepare(
      "SELECT network_policy, network_policy_set_id FROM workspaces WHERE id = 'version-2'",
    ).get()).toEqual({ network_policy: "isolated", network_policy_set_id: "default" });
    migrated.close();
  });

  it("migrates version-three rows to isolated networking", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        session_storage TEXT NOT NULL DEFAULT 'pi-default',
        security_profile TEXT NOT NULL DEFAULT 'unrestricted',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      INSERT INTO workspaces VALUES
        ('version-3a', 'Version 3a', '/work/a', 'pi-default', 'unrestricted', 1, 2),
        ('version-3b', 'Version 3b', '/work/b', 'workspace', 'workspace-sandboxed', 3, 4);
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const migrated = openDatabase(dataDir);
    expect(migrated.connection.prepare(
      "SELECT id, network_policy FROM workspaces ORDER BY id",
    ).all()).toEqual([
      { id: "version-3a", network_policy: "isolated" },
      { id: "version-3b", network_policy: "isolated" },
    ]);
    expect(migrated.connection.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
    expect(migrated.connection.prepare(
      "SELECT id, network_policy_set_id, created_at, updated_at FROM workspaces ORDER BY id",
    ).all()).toEqual([
      { id: "version-3a", network_policy_set_id: "default", created_at: 1, updated_at: 2 },
      { id: "version-3b", network_policy_set_id: "default", created_at: 3, updated_at: 4 },
    ]);
    migrated.close();
  });

  it("enforces valid stored security and network policies", () => {
    const database = openDatabase(temporaryDirectory(), ":memory:");
    expect(() => database.connection.prepare(`
      INSERT INTO workspaces
        (id, name, path, security_profile, created_at, updated_at)
      VALUES ('bad', 'Bad', '/bad', 'invalid', 1, 1)
    `).run()).toThrow(/CHECK constraint failed/);
    expect(() => database.connection.prepare(`
      INSERT INTO workspaces
        (id, name, path, network_policy, created_at, updated_at)
      VALUES ('bad-network', 'Bad', '/bad-network', 'invalid', 1, 1)
    `).run()).toThrow(/CHECK constraint failed/);
    for (const id of ["", "Upper", "-leading", "trailing_", "has space", "a".repeat(65)]) {
      expect(() => database.connection.prepare(`
        INSERT INTO workspaces
          (id, name, path, network_policy_set_id, created_at, updated_at)
        VALUES (?, 'Bad set', ?, ?, 1, 1)
      `).run(`bad-set-${id.length}`, `/bad-set-${id.length}-${id}`, id)).toThrow(/CHECK constraint failed/);
    }
    database.connection.prepare(`
      INSERT INTO workspaces
        (id, name, path, network_policy_set_id, created_at, updated_at)
      VALUES ('good-set', 'Good set', '/good-set', 'github_packages-2', 1, 1)
    `).run();
    database.close();
  });

  it("rolls back a failed 2-to-3 migration without advancing user_version", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const broken = new Database(filename);
    broken.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        session_storage TEXT NOT NULL DEFAULT 'pi-default',
        security_profile TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 2;
    `);
    broken.close();

    expect(() => openDatabase(dataDir)).toThrow(/duplicate column name/);
    const inspected = new Database(filename);
    expect(inspected.pragma("user_version", { simple: true })).toBe(2);
    expect((inspected.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>)
      .filter(({ name }) => name === "security_profile")).toHaveLength(1);
    inspected.close();
  });

  it("rolls back a failed 3-to-4 migration without advancing user_version", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const broken = new Database(filename);
    broken.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        session_storage TEXT,
        security_profile TEXT,
        network_policy TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 3;
    `);
    broken.close();

    expect(() => openDatabase(dataDir)).toThrow(/duplicate column name/);
    const inspected = new Database(filename);
    expect(inspected.pragma("user_version", { simple: true })).toBe(3);
    expect((inspected.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>)
      .filter(({ name }) => name === "network_policy")).toHaveLength(1);
    inspected.close();
  });

  it("migrates version-four rows to the default policy set", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        session_storage TEXT NOT NULL DEFAULT 'pi-default',
        security_profile TEXT NOT NULL DEFAULT 'unrestricted',
        network_policy TEXT NOT NULL DEFAULT 'isolated',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO workspaces VALUES
        ('v4-isolated', 'Isolated', '/work/isolated', 'pi-default', 'workspace-sandboxed', 'isolated', 1, 2),
        ('v4-managed', 'Managed', '/work/managed', 'workspace', 'workspace-sandboxed', 'managed-egress', 3, 4);
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const migrated = openDatabase(dataDir);
    expect(migrated.connection.prepare(
      "SELECT id, network_policy, network_policy_set_id FROM workspaces ORDER BY id",
    ).all()).toEqual([
      { id: "v4-isolated", network_policy: "isolated", network_policy_set_id: "default" },
      { id: "v4-managed", network_policy: "managed-egress", network_policy_set_id: "default" },
    ]);
    expect(migrated.connection.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
    migrated.close();
  });

  it("migrates version-five databases to empty workspace mount collections", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        session_storage TEXT NOT NULL DEFAULT 'pi-default',
        security_profile TEXT NOT NULL DEFAULT 'unrestricted',
        network_policy TEXT NOT NULL DEFAULT 'isolated',
        network_policy_set_id TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO workspaces VALUES
        ('v5', 'Version 5', '/work/v5', 'pi-default', 'workspace-sandboxed', 'isolated', 'default', 1, 2);
      PRAGMA user_version = 5;
    `);
    legacy.close();

    const migrated = openDatabase(dataDir);
    expect(migrated.connection.prepare("SELECT * FROM workspace_mounts").all()).toEqual([]);
    expect(migrated.connection.pragma("user_version", { simple: true })).toBe(DATABASE_SCHEMA_VERSION);
    migrated.close();
  });

  it("migrates version-six databases to empty job tables", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const legacy = new Database(filename);
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        session_storage TEXT NOT NULL DEFAULT 'pi-default',
        security_profile TEXT NOT NULL DEFAULT 'unrestricted',
        network_policy TEXT NOT NULL DEFAULT 'isolated',
        network_policy_set_id TEXT NOT NULL DEFAULT 'default',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE workspace_mounts (
        workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        name TEXT NOT NULL, source_path TEXT NOT NULL, access TEXT NOT NULL,
        PRIMARY KEY (workspace_id, name), UNIQUE (workspace_id, source_path)
      );
      INSERT INTO workspaces VALUES
        ('v6', 'Version 6', '/work/v6', 'pi-default', 'unrestricted', 'isolated', 'default', 1, 2);
      PRAGMA user_version = 6;
    `);
    legacy.close();

    const migrated = openDatabase(dataDir);
    expect(migrated.connection.prepare("SELECT * FROM jobs").all()).toEqual([]);
    expect(migrated.connection.prepare("SELECT * FROM job_runs").all()).toEqual([]);
    expect(migrated.connection.prepare("SELECT id FROM workspaces").all()).toEqual([{ id: "v6" }]);
    expect(migrated.connection.pragma("user_version", { simple: true })).toBe(7);
    migrated.close();
  });

  it("creates constrained job tables, foreign keys, and scheduling indexes", () => {
    const database = openDatabase(temporaryDirectory(), ":memory:");
    const connection = database.connection;
    connection.prepare(`
      INSERT INTO workspaces (id, name, path, created_at, updated_at)
      VALUES ('workspace', 'Workspace', '/workspace', 1, 1)
    `).run();
    const insertInterval = connection.prepare(`
      INSERT INTO jobs (
        id, name, workspace_id, prompt, schedule_kind, interval_minutes,
        anchor_at, enabled, next_run_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'interval', ?, ?, ?, ?, 1, 1)
    `);
    insertInterval.run("job", "Job", "workspace", "prompt", 60, 10, 1, 20);

    const jobColumns = connection.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>;
    const runColumns = connection.prepare("PRAGMA table_info(job_runs)").all() as Array<{ name: string }>;
    expect(jobColumns.map(({ name }) => name)).toContain("next_run_at");
    expect(runColumns.map(({ name }) => name)).toContain("revision");
    expect(connection.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'index'
        AND name IN ('jobs_due_idx', 'job_runs_job_time_idx', 'job_runs_active_job_idx')
      ORDER BY name
    `).all()).toEqual([
      { name: "job_runs_active_job_idx" },
      { name: "job_runs_job_time_idx" },
      { name: "jobs_due_idx" },
    ]);

    for (const values of [
      ["bad-interval", "Bad", "workspace", "prompt", 0, 10, 1, 20],
      ["bad-disabled", "Bad", "workspace", "prompt", 60, 10, 0, 20],
      ["bad-anchor", "Bad", "workspace", "prompt", 60, 1.5, 1, 20],
      ["bad-workspace", "Bad", "missing", "prompt", 60, 10, 1, 20],
    ] as const) {
      expect(() => insertInterval.run(...values)).toThrow();
    }
    expect(() => connection.prepare(`
      INSERT INTO jobs (
        id, name, workspace_id, prompt, schedule_kind, daily_time, time_zone,
        enabled, next_run_at, created_at, updated_at
      ) VALUES ('bad-daily', 'Bad', 'workspace', 'prompt', 'daily', '24:00', 'UTC', 1, 20, 1, 1)
    `).run()).toThrow(/CHECK constraint failed/);
    expect(() => connection.prepare(`
      INSERT INTO jobs (
        id, name, workspace_id, prompt, schedule_kind, interval_minutes,
        anchor_at, enabled, next_run_at, created_at, updated_at
      ) VALUES ('mixed', 'Mixed', 'workspace', 'prompt', 'interval', 5, 1, 1, 20, 1, 1)
    `).run()).not.toThrow();

    const insertRun = connection.prepare(`
      INSERT INTO job_runs
        (id, job_id, trigger, scheduled_for, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, 1)
    `);
    insertRun.run("run-1", "job", "scheduled", 20, "queued");
    expect(() => insertRun.run("run-2", "job", "manual", 21, "running"))
      .toThrow(/UNIQUE constraint failed/);
    connection.prepare("UPDATE job_runs SET status = 'succeeded' WHERE id = 'run-1'").run();
    insertRun.run("run-2", "job", "manual", 21, "running");
    for (const invalid of [
      ["run-trigger", "job", "timer", 22, "queued"],
      ["run-status", "job", "scheduled", 22, "unknown"],
      ["run-time", "job", "scheduled", 1.5, "queued"],
      ["run-fk", "missing", "scheduled", 22, "queued"],
    ] as const) {
      expect(() => insertRun.run(...invalid)).toThrow();
    }
    expect(() => connection.prepare("DELETE FROM workspaces WHERE id = 'workspace'").run())
      .toThrow(/FOREIGN KEY constraint failed/);
    connection.prepare("DELETE FROM jobs WHERE id = 'job'").run();
    expect(connection.prepare("SELECT * FROM job_runs").all()).toEqual([]);
    database.close();
  });

  it("rolls back a failed 6-to-7 migration without partial job tables", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const broken = new Database(filename);
    broken.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY);
      CREATE TABLE jobs (id TEXT PRIMARY KEY);
      PRAGMA user_version = 6;
    `);
    broken.close();

    expect(() => openDatabase(dataDir)).toThrow(/table jobs already exists/);
    const inspected = new Database(filename);
    expect(inspected.pragma("user_version", { simple: true })).toBe(6);
    expect(inspected.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'job_runs'
    `).get()).toBeUndefined();
    inspected.close();
  });

  it("rolls back a failed 4-to-5 migration without advancing user_version", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const broken = new Database(filename);
    broken.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        session_storage TEXT, security_profile TEXT, network_policy TEXT,
        network_policy_set_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      PRAGMA user_version = 4;
    `);
    broken.close();

    expect(() => openDatabase(dataDir)).toThrow(/duplicate column name/);
    const inspected = new Database(filename);
    expect(inspected.pragma("user_version", { simple: true })).toBe(4);
    expect((inspected.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>)
      .filter(({ name }) => name === "network_policy_set_id")).toHaveLength(1);
    inspected.close();
  });

  it("supports an in-memory database for focused consumers", () => {
    const database = openDatabase(temporaryDirectory(), ":memory:");

    expect(database.filename).toBe(":memory:");
    expect(
      database.connection
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'workspaces'")
        .get(),
    ).toEqual({ name: "workspaces" });
    database.close();
  });

  it("rejects unsupported schema versions and releases the connection", () => {
    const dataDir = temporaryDirectory();
    const filename = path.join(dataDir, DATABASE_FILENAME);
    const unsupported = new Database(filename);
    unsupported.pragma("user_version = 8");
    unsupported.close();

    expect(() => openDatabase(dataDir)).toThrow(
      UnsupportedDatabaseVersionError,
    );
    expect(() => openDatabase(dataDir)).toThrow(
      /schema version 8; expected 7/,
    );

    const afterFailure = new Database(filename);
    expect(afterFailure.open).toBe(true);
    afterFailure.close();
  });

  it("closes idempotently", () => {
    const database = openDatabase(temporaryDirectory(), ":memory:");

    database.close();
    database.close();

    expect(database.closed).toBe(true);
    expect(database.connection.open).toBe(false);
  });

  it("does not retry the native close boundary after a close failure", () => {
    const database = openDatabase(temporaryDirectory(), ":memory:");
    const failure = new Error("native close failed");
    const close = vi.spyOn(database.connection, "close").mockImplementation(() => {
      throw failure;
    });

    expect(() => database.close()).toThrow(failure);
    expect(() => database.close()).not.toThrow();
    expect(close).toHaveBeenCalledOnce();
    expect(database.closed).toBe(true);

    close.mockRestore();
    database.connection.close();
  });
});
