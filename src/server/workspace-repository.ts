import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import {
  AppError,
  ERROR_CODES,
  toAppError,
} from "../shared/errors.js";
import type {
  Workspace,
  WorkspaceSummary,
} from "../shared/protocol.js";

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface WorkspaceFileSystem {
  readonly realpath: (target: string) => string;
  readonly stat: (target: string) => { readonly isDirectory: () => boolean };
  readonly access: (target: string, mode: number) => void;
}

const nodeFileSystem: WorkspaceFileSystem = {
  realpath: (target) => realpathSync(target),
  stat: (target) => statSync(target),
  access: (target, mode) => accessSync(target, mode),
};

export interface WorkspaceRepositoryOptions {
  /** Stable process base for resolving relative workspace paths. */
  readonly cwd?: string;
  readonly uuid?: () => string;
  readonly clock?: () => number;
  readonly fileSystem?: WorkspaceFileSystem;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly path: string;
}

export interface UpdateWorkspaceInput {
  readonly name?: string;
  readonly path?: string;
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compareWorkspaces(left: Workspace, right: Workspace): number {
  const leftName = left.name.toLowerCase();
  const rightName = right.name.toLowerCase();
  if (leftName < rightName) return -1;
  if (leftName > rightName) return 1;
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function isDuplicatePathConstraint(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as {
    readonly code?: unknown;
    readonly message?: unknown;
  };
  return (
    candidate.code === "SQLITE_CONSTRAINT_UNIQUE" &&
    typeof candidate.message === "string" &&
    candidate.message.includes("workspaces.path")
  );
}

/**
 * Persistent CRUD boundary for ChatWCA-owned workspace metadata.
 *
 * The repository does not own the SQLite connection and never mutates anything
 * beneath a workspace path. Filesystem access is limited to validating and
 * projecting the registered directory itself.
 */
export class WorkspaceRepository {
  readonly #cwd: string;
  readonly #uuid: () => string;
  readonly #clock: () => number;
  readonly #fileSystem: WorkspaceFileSystem;
  readonly #listStatement: Database.Statement<[], WorkspaceRow>;
  readonly #getStatement: Database.Statement<[string], WorkspaceRow>;
  readonly #insertStatement: Database.Statement<
    [string, string, string, number, number]
  >;
  readonly #updateNameStatement: Database.Statement<[string, number, string]>;
  readonly #updatePathStatement: Database.Statement<[string, number, string]>;
  readonly #updateNameAndPathStatement: Database.Statement<
    [string, string, number, string]
  >;
  readonly #deleteStatement: Database.Statement<[string]>;

  constructor(
    connection: Database.Database,
    options: WorkspaceRepositoryOptions = {},
  ) {
    this.#cwd = path.resolve(options.cwd ?? process.cwd());
    this.#uuid = options.uuid ?? randomUUID;
    this.#clock = options.clock ?? Date.now;
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;

    try {
      this.#listStatement = connection.prepare<[], WorkspaceRow>(
        "SELECT id, name, path, created_at, updated_at FROM workspaces",
      );
      this.#getStatement = connection.prepare<[string], WorkspaceRow>(
        "SELECT id, name, path, created_at, updated_at FROM workspaces WHERE id = ?",
      );
      this.#insertStatement = connection.prepare<
        [string, string, string, number, number]
      >(
        "INSERT INTO workspaces (id, name, path, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      this.#updateNameStatement = connection.prepare<[string, number, string]>(
        "UPDATE workspaces SET name = ?, updated_at = ? WHERE id = ?",
      );
      this.#updatePathStatement = connection.prepare<[string, number, string]>(
        "UPDATE workspaces SET path = ?, updated_at = ? WHERE id = ?",
      );
      this.#updateNameAndPathStatement = connection.prepare<
        [string, string, number, string]
      >(
        "UPDATE workspaces SET name = ?, path = ?, updated_at = ? WHERE id = ?",
      );
      this.#deleteStatement = connection.prepare<[string]>(
        "DELETE FROM workspaces WHERE id = ?",
      );
    } catch (error) {
      throw toAppError(error, { source: "database" });
    }
  }

  list(): WorkspaceSummary[] {
    const rows = this.#database(() => this.#listStatement.all());
    return rows
      .map((row) => this.#summary(workspaceFromRow(row)))
      .sort(compareWorkspaces);
  }

  get(workspaceId: string): WorkspaceSummary {
    const workspace = this.#getStored(workspaceId);
    return this.#summary(workspace);
  }

  /** Resolve a row for an operation that requires its directory right now. */
  requireAvailable(workspaceId: string): Workspace {
    const workspace = this.#getStored(workspaceId);
    if (!this.#isAvailable(workspace.path)) {
      throw new AppError(ERROR_CODES.WORKSPACE_UNAVAILABLE);
    }
    return workspace;
  }

  create(input: CreateWorkspaceInput): WorkspaceSummary {
    const name = this.#validName(input.name);
    const canonicalPath = this.#canonicalDirectory(input.path);
    const id = this.#uuid();
    const now = this.#clock();

    this.#database(() => {
      try {
        this.#insertStatement.run(id, name, canonicalPath, now, now);
      } catch (error) {
        if (isDuplicatePathConstraint(error)) {
          throw toAppError(error, {
            source: "workspace",
            issue: "duplicate",
          });
        }
        throw error;
      }
    });

    return this.#summary({
      id,
      name,
      path: canonicalPath,
      createdAt: now,
      updatedAt: now,
    });
  }

  update(
    workspaceId: string,
    changes: UpdateWorkspaceInput,
  ): WorkspaceSummary {
    const current = this.#getStored(workspaceId);
    if (changes.name === undefined && changes.path === undefined) {
      throw new AppError(ERROR_CODES.INVALID_COMMAND);
    }

    // A name-only update deliberately does not touch the filesystem. This lets
    // an unavailable registered workspace still be renamed.
    const name =
      changes.name === undefined ? current.name : this.#validName(changes.name);
    const canonicalPath =
      changes.path === undefined
        ? current.path
        : this.#canonicalDirectory(changes.path);
    const now = this.#clock();

    this.#database(() => {
      try {
        const result =
          changes.name !== undefined && changes.path !== undefined
            ? this.#updateNameAndPathStatement.run(
                name,
                canonicalPath,
                now,
                workspaceId,
              )
            : changes.name !== undefined
              ? this.#updateNameStatement.run(name, now, workspaceId)
              : this.#updatePathStatement.run(canonicalPath, now, workspaceId);
        if (result.changes !== 1) {
          throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND);
        }
      } catch (error) {
        if (isDuplicatePathConstraint(error)) {
          throw toAppError(error, {
            source: "workspace",
            issue: "duplicate",
          });
        }
        throw error;
      }
    });

    return this.#summary({
      ...current,
      name,
      path: canonicalPath,
      updatedAt: now,
    });
  }

  delete(workspaceId: string): void {
    this.#database(() => {
      const result = this.#deleteStatement.run(workspaceId);
      if (result.changes !== 1) {
        throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND);
      }
    });
  }

  #getStored(workspaceId: string): Workspace {
    const row = this.#database(() => this.#getStatement.get(workspaceId));
    if (row === undefined) {
      throw new AppError(ERROR_CODES.WORKSPACE_NOT_FOUND);
    }
    return workspaceFromRow(row);
  }

  #validName(input: string): string {
    if (typeof input !== "string") {
      throw new AppError(ERROR_CODES.INVALID_WORKSPACE_NAME);
    }
    const name = input.trim();
    if (name.length === 0) {
      throw new AppError(ERROR_CODES.INVALID_WORKSPACE_NAME);
    }
    return name;
  }

  #canonicalDirectory(input: string): string {
    if (typeof input !== "string" || input.length === 0) {
      throw new AppError(ERROR_CODES.INVALID_WORKSPACE_PATH);
    }

    try {
      const resolved = path.resolve(this.#cwd, input);
      const real = this.#fileSystem.realpath(resolved);
      const canonical = path.isAbsolute(real)
        ? path.normalize(real)
        : path.resolve(this.#cwd, real);
      if (!this.#fileSystem.stat(canonical).isDirectory()) {
        throw new Error("Workspace target is not a directory");
      }
      this.#fileSystem.access(
        canonical,
        fsConstants.R_OK | fsConstants.X_OK,
      );
      return canonical;
    } catch (error) {
      throw toAppError(error, { source: "workspace", issue: "path" });
    }
  }

  #isAvailable(canonicalPath: string): boolean {
    try {
      if (!this.#fileSystem.stat(canonicalPath).isDirectory()) return false;
      this.#fileSystem.access(
        canonicalPath,
        fsConstants.R_OK | fsConstants.X_OK,
      );
      return true;
    } catch {
      return false;
    }
  }

  #summary(workspace: Workspace): WorkspaceSummary {
    return { ...workspace, available: this.#isAvailable(workspace.path) };
  }

  #database<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw toAppError(error, { source: "database" });
    }
  }
}
