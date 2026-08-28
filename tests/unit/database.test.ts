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
  it("creates nested storage and initializes the version-one schema", () => {
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
      expect.objectContaining({ name: "created_at", notnull: 1, pk: 0 }),
      expect.objectContaining({ name: "updated_at", notnull: 1, pk: 0 }),
    ]);

    database.close();
  });

  it("accepts and preserves an existing version-one database", () => {
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
      created_at: 10,
      updated_at: 20,
    });
    expect(
      reopened.connection.pragma("user_version", { simple: true }),
    ).toBe(DATABASE_SCHEMA_VERSION);
    reopened.close();
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
    unsupported.pragma("user_version = 2");
    unsupported.close();

    expect(() => openDatabase(dataDir)).toThrow(
      UnsupportedDatabaseVersionError,
    );
    expect(() => openDatabase(dataDir)).toThrow(
      /schema version 2; expected 1/,
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
