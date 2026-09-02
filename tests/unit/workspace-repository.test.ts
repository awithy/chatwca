import {
  accessSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type ChatWcaDatabase } from "../../src/server/database.js";
import {
  WorkspaceRepository,
  type WorkspaceFileSystem,
} from "../../src/server/workspace-repository.js";
import { AppError, ERROR_CODES } from "../../src/shared/errors.js";

const temporaryDirectories: string[] = [];
const databases: ChatWcaDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "chatwca-workspaces-"));
  temporaryDirectories.push(directory);
  return directory;
}

function database(dataDir = temporaryDirectory(), filename = ":memory:") {
  const opened = openDatabase(dataDir, filename);
  databases.push(opened);
  return opened;
}

function directory(parent: string, name: string): string {
  const target = path.join(parent, name);
  mkdirSync(target, { recursive: true });
  return target;
}

const realFileSystem: WorkspaceFileSystem = {
  realpath: realpathSync,
  stat: statSync,
  access: accessSync,
};

afterEach(() => {
  for (const opened of databases.splice(0)) opened.close();
  for (const target of temporaryDirectories.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("WorkspaceRepository CRUD", () => {
  it("creates, gets, renames, repoints, and removes workspace rows only", () => {
    const root = temporaryDirectory();
    const firstPath = directory(root, "first");
    const secondPath = directory(root, "second");
    const retainedFile = path.join(secondPath, "session.jsonl");
    writeFileSync(retainedFile, "retained");
    const opened = database();
    const times = [10, 20, 30];
    const repository = new WorkspaceRepository(opened.connection, {
      cwd: root,
      uuid: () => "workspace-1",
      clock: () => times.shift() ?? 99,
    });

    const created = repository.create({ name: "  Example  ", path: "first" });
    expect(created).toEqual({
      id: "workspace-1",
      name: "Example",
      path: realpathSync(firstPath),
      sessionStorage: "pi-default",
      sessionDirectory: null,
      securityProfile: "unrestricted",
      networkPolicy: "isolated",
      effectiveSecurityProfile: "unrestricted",
      effectiveNetworkPolicy: null,
      networkPolicyIssue: null,
      createdAt: 10,
      updatedAt: 10,
      available: true,
      usable: true,
      policyIssue: null,
    });
    expect(repository.get(created.id)).toEqual(created);

    expect(repository.update(created.id, { name: " Renamed " })).toMatchObject({
      id: created.id,
      name: "Renamed",
      path: realpathSync(firstPath),
      createdAt: 10,
      updatedAt: 20,
    });
    expect(
      repository.update(created.id, { name: "Final", path: secondPath }),
    ).toMatchObject({
      name: "Final",
      path: realpathSync(secondPath),
      createdAt: 10,
      updatedAt: 30,
    });

    repository.delete(created.id);
    expect(repository.list()).toEqual([]);
    expect(() => repository.get(created.id)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.WORKSPACE_NOT_FOUND }),
    );
    expect(() => repository.delete(created.id)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.WORKSPACE_NOT_FOUND }),
    );
    expect(statSync(retainedFile).isFile()).toBe(true);
  });

  it("persists rows when the SQLite database is reopened", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const dataDir = temporaryDirectory();
    const firstDatabase = database(dataDir, "chatwca.sqlite");
    const firstRepository = new WorkspaceRepository(firstDatabase.connection, {
      uuid: () => "workspace-persisted",
      clock: () => 123,
    });
    firstRepository.create({ name: "Persisted", path: workspacePath });
    firstDatabase.close();

    const reopened = database(dataDir, "chatwca.sqlite");
    const reopenedRepository = new WorkspaceRepository(reopened.connection);
    expect(reopenedRepository.list()).toEqual([
      {
        id: "workspace-persisted",
        name: "Persisted",
        path: realpathSync(workspacePath),
        sessionStorage: "pi-default",
        sessionDirectory: null,
        securityProfile: "unrestricted",
        networkPolicy: "isolated",
        effectiveSecurityProfile: "unrestricted",
        effectiveNetworkPolicy: null,
        networkPolicyIssue: null,
        createdAt: 123,
        updatedAt: 123,
        available: true,
        usable: true,
        policyIssue: null,
      },
    ]);
  });

  it("stores an immutable workspace-local session policy without creating files", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "local-project");
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-local",
      clock: () => 10,
    });

    const created = repository.create({
      name: "Local sessions",
      path: workspacePath,
      sessionStorage: "workspace",
    });

    expect(created).toMatchObject({
      sessionStorage: "workspace",
      sessionDirectory: path.join(workspacePath, ".chatwca", "sessions"),
      available: true,
    });
    expect(() => statSync(path.join(workspacePath, ".chatwca"))).toThrow();
    expect(repository.update(created.id, { name: "Renamed" })).toMatchObject({
      sessionStorage: "workspace",
      sessionDirectory: path.join(workspacePath, ".chatwca", "sessions"),
    });
  });

  it("rejects empty names and preserves the prior timestamp after failed updates", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const times = [10, 20, 30];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-1",
      clock: () => times.shift() ?? 99,
    });

    expect(() => repository.create({ name: " \t ", path: workspacePath })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_NAME }),
    );
    const created = repository.create({ name: "Valid", path: workspacePath });
    expect(() => repository.update(created.id, { name: "\n" })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_NAME }),
    );
    expect(() => repository.update(created.id, {})).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }),
    );
    expect(repository.get(created.id).updatedAt).toBe(10);
  });
});

describe("workspace path canonicalization and availability", () => {
  it("canonicalizes symlinks and rejects duplicate canonical paths", () => {
    const root = temporaryDirectory();
    const target = directory(root, "target");
    const alias = path.join(root, "alias");
    symlinkSync(target, alias, "dir");
    const opened = database();
    const ids = ["workspace-target", "workspace-alias"];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => ids.shift() ?? "workspace-extra",
      clock: () => 10,
    });

    const created = repository.create({ name: "Target", path: alias });
    expect(created.path).toBe(realpathSync(target));
    expect(() => repository.create({ name: "Alias", path: target })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.DUPLICATE_WORKSPACE_PATH }),
    );
    expect(repository.list()).toHaveLength(1);
  });

  it("rejects workspace-local session directories that escape through a symlink", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const outside = directory(root, "outside");
    symlinkSync(outside, path.join(workspacePath, ".chatwca"), "dir");
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-local",
      clock: () => 10,
    });

    expect(() => repository.create({
      name: "Escaped",
      path: workspacePath,
      sessionStorage: "workspace",
    })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_PATH }),
    );
    expect(repository.list()).toEqual([]);
  });

  it("enforces canonical path uniqueness on updates without changing the row", () => {
    const root = temporaryDirectory();
    const first = directory(root, "first");
    const second = directory(root, "second");
    const opened = database();
    const ids = ["workspace-1", "workspace-2"];
    const times = [10, 20, 30];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => ids.shift() ?? "workspace-extra",
      clock: () => times.shift() ?? 99,
    });
    repository.create({ name: "First", path: first });
    const secondWorkspace = repository.create({ name: "Second", path: second });

    expect(() =>
      repository.update(secondWorkspace.id, { name: "Changed", path: first }),
    ).toThrow(
      expect.objectContaining({ code: ERROR_CODES.DUPLICATE_WORKSPACE_PATH }),
    );
    expect(repository.get(secondWorkspace.id)).toMatchObject({
      name: "Second",
      path: realpathSync(second),
      updatedAt: 20,
    });
  });

  it("rejects missing, non-directory, and inaccessible create/update paths safely", () => {
    const root = temporaryDirectory();
    const valid = directory(root, "valid");
    const inaccessible = directory(root, "private-project");
    const file = path.join(root, "file.txt");
    writeFileSync(file, "not a directory");
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-1",
      clock: () => 10,
    });

    for (const invalidPath of [path.join(root, "missing"), file]) {
      expect(() => repository.create({ name: "Invalid", path: invalidPath })).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_PATH }),
      );
    }

    const privateError = Object.assign(
      new Error(`EACCES at ${inaccessible}`),
      { code: "EACCES" },
    );
    const inaccessibleRepository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-private",
      clock: () => 20,
      fileSystem: {
        ...realFileSystem,
        access: (target, mode) => {
          if (target === realpathSync(inaccessible)) throw privateError;
          accessSync(target, mode);
        },
      },
    });
    let failure: unknown;
    try {
      inaccessibleRepository.create({ name: "Private", path: inaccessible });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: ERROR_CODES.INVALID_WORKSPACE_PATH });
    expect((failure as Error).message).not.toContain(inaccessible);

    const created = repository.create({ name: "Valid", path: valid });
    expect(() => repository.update(created.id, { path: file })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_PATH }),
    );
    expect(repository.get(created.id)).toMatchObject({
      path: realpathSync(valid),
      updatedAt: 10,
    });
  });

  it("keeps unavailable rows, permits renaming, and recovers when the path returns", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const times = [10, 20];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-1",
      clock: () => times.shift() ?? 30,
    });
    const created = repository.create({ name: "Original", path: workspacePath });

    rmSync(workspacePath, { recursive: true });
    expect(repository.get(created.id).available).toBe(false);
    expect(() => repository.requireAvailable(created.id)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.WORKSPACE_UNAVAILABLE }),
    );
    expect(repository.update(created.id, { name: "Renamed" })).toMatchObject({
      name: "Renamed",
      path: created.path,
      available: false,
      updatedAt: 20,
    });

    mkdirSync(workspacePath);
    expect(repository.requireAvailable(created.id)).toMatchObject({
      id: created.id,
      name: "Renamed",
      path: realpathSync(workspacePath),
    });
    expect(repository.get(created.id).available).toBe(true);
  });

  it("marks a stored path unavailable when directory access fails", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const normal = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-1",
      clock: () => 10,
    });
    normal.create({ name: "Private", path: workspacePath });

    const inaccessible = new WorkspaceRepository(opened.connection, {
      fileSystem: {
        ...realFileSystem,
        access: () => {
          throw Object.assign(new Error("private path"), { code: "EACCES" });
        },
      },
    });
    expect(inaccessible.list()[0]?.available).toBe(false);
    expect(() => inaccessible.requireAvailable("workspace-1")).toThrow(
      expect.objectContaining({ code: ERROR_CODES.WORKSPACE_UNAVAILABLE }),
    );
  });
});

describe("workspace ordering and database errors", () => {
  it("sorts case-insensitive names deterministically and breaks ties by ID", () => {
    const root = temporaryDirectory();
    const opened = database();
    const ids = ["id-z", "id-b", "id-a"];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => ids.shift() ?? "id-extra",
      clock: () => 10,
    });
    repository.create({ name: "Alpha", path: directory(root, "one") });
    repository.create({ name: "beta", path: directory(root, "two") });
    repository.create({ name: "alpha", path: directory(root, "three") });

    expect(repository.list().map(({ id, name }) => `${name}:${id}`)).toEqual([
      "alpha:id-a",
      "Alpha:id-z",
      "beta:id-b",
    ]);
  });

  it("converts SQLite failures to a stable redacted database error", () => {
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection);
    opened.close();

    let failure: unknown;
    try {
      repository.list();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: ERROR_CODES.DATABASE_ERROR,
      message: "The workspace database operation failed.",
    });
    expect(JSON.stringify(failure)).not.toContain("database connection");
  });
});
