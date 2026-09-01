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
  SandboxMode,
  Workspace,
  WorkspacePolicyIssue,
  WorkspaceSecurityProfile,
  WorkspaceSessionStorage,
  WorkspaceSummary,
} from "../shared/protocol.js";

interface WorkspaceRow {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly session_storage: WorkspaceSessionStorage;
  readonly security_profile: WorkspaceSecurityProfile;
  readonly created_at: number;
  readonly updated_at: number;
}

export const WORKSPACE_SESSION_DIRECTORY = path.join(".chatwca", "sessions");

export function workspaceSessionDirectory(
  workspacePath: string,
  storage: WorkspaceSessionStorage,
): string | null {
  return storage === "workspace"
    ? path.join(workspacePath, WORKSPACE_SESSION_DIRECTORY)
    : null;
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

export interface WorkspacePolicyInputs {
  readonly mode: SandboxMode;
  /** Canonical existing directories. */
  readonly workspaceRoots: readonly string[];
  readonly dataDirectory: string;
  readonly piAgentDirectory: string;
  /** Canonical read-only mount source paths. */
  readonly readOnlyMounts: readonly string[];
}

const DEFAULT_POLICY: WorkspacePolicyInputs = Object.freeze({
  mode: "disabled",
  workspaceRoots: Object.freeze([]),
  // In disabled mode these inert sentinels can never reject unrestricted rows.
  dataDirectory: path.parse(process.cwd()).root,
  piAgentDirectory: path.parse(process.cwd()).root,
  readOnlyMounts: Object.freeze([]),
});

export interface WorkspaceRepositoryOptions {
  /** Stable process base for resolving relative workspace paths. */
  readonly cwd?: string;
  readonly uuid?: () => string;
  readonly clock?: () => number;
  readonly fileSystem?: WorkspaceFileSystem;
  readonly policy?: Readonly<WorkspacePolicyInputs>;
}

export interface RuntimeWorkspacePolicy {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly sessionDirectory: string | null;
  readonly securityProfile: WorkspaceSecurityProfile;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly path: string;
  readonly sessionStorage?: WorkspaceSessionStorage;
  readonly securityProfile: WorkspaceSecurityProfile;
}

export interface UpdateWorkspaceInput {
  readonly name?: string;
  readonly path?: string;
  readonly securityProfile?: WorkspaceSecurityProfile;
  readonly acknowledgeSecurityDowngrade?: true;
}

function isPathContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function pathsOverlap(left: string, right: string): boolean {
  return isPathContained(left, right) || isPathContained(right, left);
}

function workspaceFromRow(row: WorkspaceRow): Workspace {
  if (
    row.security_profile !== "unrestricted" &&
    row.security_profile !== "workspace-sandboxed"
  ) {
    throw new AppError(ERROR_CODES.DATABASE_ERROR);
  }
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    sessionStorage: row.session_storage,
    sessionDirectory: workspaceSessionDirectory(row.path, row.session_storage),
    securityProfile: row.security_profile,
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
  readonly #policy: Readonly<WorkspacePolicyInputs>;
  readonly #listStatement: Database.Statement<[], WorkspaceRow>;
  readonly #getStatement: Database.Statement<[string], WorkspaceRow>;
  readonly #insertStatement: Database.Statement<
    [string, string, string, WorkspaceSessionStorage, WorkspaceSecurityProfile, number, number]
  >;
  readonly #updateStatement: Database.Statement<
    [string, string, WorkspaceSecurityProfile, number, string]
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
    const suppliedPolicy = options.policy ?? DEFAULT_POLICY;
    this.#policy = Object.freeze({
      ...suppliedPolicy,
      workspaceRoots: Object.freeze([...suppliedPolicy.workspaceRoots]),
      readOnlyMounts: Object.freeze([...suppliedPolicy.readOnlyMounts]),
    });

    try {
      this.#listStatement = connection.prepare<[], WorkspaceRow>(
        "SELECT id, name, path, session_storage, security_profile, created_at, updated_at FROM workspaces",
      );
      this.#getStatement = connection.prepare<[string], WorkspaceRow>(
        "SELECT id, name, path, session_storage, security_profile, created_at, updated_at FROM workspaces WHERE id = ?",
      );
      this.#insertStatement = connection.prepare<
        [string, string, string, WorkspaceSessionStorage, WorkspaceSecurityProfile, number, number]
      >(
        "INSERT INTO workspaces (id, name, path, session_storage, security_profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      this.#updateStatement = connection.prepare<
        [string, string, WorkspaceSecurityProfile, number, string]
      >(
        "UPDATE workspaces SET name = ?, path = ?, security_profile = ?, updated_at = ? WHERE id = ?",
      );
      this.#deleteStatement = connection.prepare<[string]>(
        "DELETE FROM workspaces WHERE id = ?",
      );
    } catch (error) {
      throw toAppError(error, { source: "database" });
    }
  }

  list(): WorkspaceSummary[] {
    return this.#database(() => this.#listStatement.all()
      .map((row) => this.#summary(workspaceFromRow(row)))
      .sort(compareWorkspaces));
  }

  get(workspaceId: string): WorkspaceSummary {
    const workspace = this.#getStored(workspaceId);
    return this.#summary(workspace);
  }

  /** Resolve a row for scoped history/filesystem operations that start no tools. */
  requireAvailable(workspaceId: string): Workspace {
    const workspace = this.#getStored(workspaceId);
    if (!this.#isAvailable(workspace)) {
      throw new AppError(ERROR_CODES.WORKSPACE_UNAVAILABLE);
    }
    return workspace;
  }

  /** Freshly resolve all policy needed to construct a conversation runtime. */
  requireUsable(workspaceId: string): RuntimeWorkspacePolicy {
    const workspace = this.requireAvailable(workspaceId);
    const evaluation = this.#evaluatePolicy(workspace);
    if (!evaluation.usable || evaluation.effectiveSecurityProfile === null) {
      if (evaluation.policyIssue === "sandbox_disabled") {
        throw new AppError(ERROR_CODES.SANDBOX_DISABLED);
      }
      throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED);
    }

    // Availability verifies canonical identity. Sandboxed tools additionally
    // require mutation access; Phase 2 extends this boundary with mask/socket
    // admission immediately before worker construction.
    if (evaluation.effectiveSecurityProfile === "workspace-sandboxed") {
      try {
        this.#fileSystem.access(
          workspace.path,
          fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
        );
      } catch (error) {
        throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED, { cause: error });
      }
    }
    return Object.freeze({
      workspaceId: workspace.id,
      cwd: workspace.path,
      sessionDirectory: workspace.sessionDirectory,
      securityProfile: evaluation.effectiveSecurityProfile,
    });
  }

  create(input: CreateWorkspaceInput): WorkspaceSummary {
    const name = this.#validName(input.name);
    const sessionStorage = this.#validSessionStorage(
      input.sessionStorage ?? "pi-default",
    );
    // The wire protocol requires this field. The fallback keeps trusted legacy
    // server callers source-compatible while preserving disabled-mode behavior.
    const securityProfile = this.#validSecurityProfile(
      input.securityProfile ?? "unrestricted",
    );
    this.#assertCreateProfileAllowed(securityProfile);
    const canonicalPath = this.#canonicalDirectory(
      input.path,
      sessionStorage === "workspace",
    );
    const sessionDirectory = workspaceSessionDirectory(
      canonicalPath,
      sessionStorage,
    );
    if (
      sessionDirectory !== null &&
      !this.#isSessionDirectoryContained(canonicalPath, sessionDirectory)
    ) {
      throw new AppError(ERROR_CODES.INVALID_WORKSPACE_PATH);
    }
    this.#assertPathPolicy(canonicalPath, securityProfile);
    const id = this.#uuid();
    const now = this.#clock();

    this.#database(() => {
      try {
        this.#insertStatement.run(
          id,
          name,
          canonicalPath,
          sessionStorage,
          securityProfile,
          now,
          now,
        );
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
      sessionStorage,
      sessionDirectory,
      securityProfile,
      createdAt: now,
      updatedAt: now,
    });
  }

  update(
    workspaceId: string,
    changes: UpdateWorkspaceInput,
  ): WorkspaceSummary {
    const current = this.#getStored(workspaceId);
    if (
      changes.name === undefined &&
      changes.path === undefined &&
      changes.securityProfile === undefined
    ) {
      throw new AppError(ERROR_CODES.INVALID_COMMAND);
    }

    const securityProfile = changes.securityProfile === undefined
      ? current.securityProfile
      : this.#validSecurityProfile(changes.securityProfile);
    const isDowngrade =
      current.securityProfile === "workspace-sandboxed" &&
      securityProfile === "unrestricted";
    if (changes.acknowledgeSecurityDowngrade === true && !isDowngrade) {
      throw new AppError(ERROR_CODES.INVALID_COMMAND);
    }
    if (isDowngrade && changes.acknowledgeSecurityDowngrade !== true) {
      throw new AppError(ERROR_CODES.INVALID_COMMAND);
    }
    if (
      changes.securityProfile !== undefined &&
      this.#policy.mode === "disabled" &&
      securityProfile === "workspace-sandboxed"
    ) {
      throw new AppError(ERROR_CODES.SANDBOX_DISABLED);
    }
    if (
      changes.securityProfile !== undefined &&
      this.#policy.mode === "required" &&
      securityProfile !== "workspace-sandboxed"
    ) {
      throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED);
    }

    // A name-only update deliberately does not touch the filesystem. This lets
    // an unavailable registered workspace still be renamed.
    const name =
      changes.name === undefined ? current.name : this.#validName(changes.name);
    const canonicalPath =
      changes.path === undefined
        ? current.path
        : this.#canonicalDirectory(
            changes.path,
            current.sessionStorage === "workspace",
          );
    const sessionDirectory = workspaceSessionDirectory(
      canonicalPath,
      current.sessionStorage,
    );
    if (
      changes.path !== undefined &&
      sessionDirectory !== null &&
      !this.#isSessionDirectoryContained(canonicalPath, sessionDirectory)
    ) {
      throw new AppError(ERROR_CODES.INVALID_WORKSPACE_PATH);
    }
    if (changes.path !== undefined || changes.securityProfile !== undefined) {
      this.#assertPathPolicy(canonicalPath, securityProfile);
    }
    const now = this.#clock();

    this.#database(() => {
      try {
        const result = this.#updateStatement.run(
          name,
          canonicalPath,
          securityProfile,
          now,
          workspaceId,
        );
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
      sessionDirectory,
      securityProfile,
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

  #validSessionStorage(input: unknown): WorkspaceSessionStorage {
    if (input !== "pi-default" && input !== "workspace") {
      throw new AppError(ERROR_CODES.INVALID_COMMAND);
    }
    return input;
  }

  #validSecurityProfile(input: unknown): WorkspaceSecurityProfile {
    if (input !== "unrestricted" && input !== "workspace-sandboxed") {
      throw new AppError(ERROR_CODES.INVALID_COMMAND);
    }
    return input;
  }

  #assertCreateProfileAllowed(profile: WorkspaceSecurityProfile): void {
    if (this.#policy.mode === "disabled" && profile === "workspace-sandboxed") {
      throw new AppError(ERROR_CODES.SANDBOX_DISABLED);
    }
    if (this.#policy.mode === "required" && profile !== "workspace-sandboxed") {
      throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED);
    }
  }

  #assertPathPolicy(
    canonicalPath: string,
    storedProfile: WorkspaceSecurityProfile,
  ): void {
    const workspace: Workspace = {
      id: "policy-candidate",
      name: "policy-candidate",
      path: canonicalPath,
      sessionStorage: "pi-default",
      sessionDirectory: null,
      securityProfile: storedProfile,
      createdAt: 0,
      updatedAt: 0,
    };
    const evaluation = this.#evaluatePolicy(workspace, true);
    if (evaluation.policyIssue === "outside_workspace_roots" ||
        evaluation.policyIssue === "protected_path_overlap") {
      throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED);
    }
  }

  #canonicalDirectory(input: string, requireWrite = false): string {
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
        fsConstants.R_OK |
          fsConstants.X_OK |
          (requireWrite ? fsConstants.W_OK : 0),
      );
      return canonical;
    } catch (error) {
      throw toAppError(error, { source: "workspace", issue: "path" });
    }
  }

  #isAvailable(workspace: Workspace): boolean {
    try {
      const canonical = path.normalize(this.#fileSystem.realpath(workspace.path));
      if (canonical !== path.normalize(workspace.path)) return false;
      if (!this.#fileSystem.stat(canonical).isDirectory()) return false;
      this.#fileSystem.access(
        workspace.path,
        fsConstants.R_OK |
          fsConstants.X_OK |
          (workspace.sessionStorage === "workspace" ? fsConstants.W_OK : 0),
      );
      if (
        workspace.sessionDirectory !== null &&
        !this.#isSessionDirectoryContained(
          workspace.path,
          workspace.sessionDirectory,
        )
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  #isSessionDirectoryContained(
    workspacePath: string,
    sessionDirectory: string,
  ): boolean {
    for (const candidate of [path.dirname(sessionDirectory), sessionDirectory]) {
      try {
        const canonical = this.#fileSystem.realpath(candidate);
        if (!this.#fileSystem.stat(canonical).isDirectory()) return false;
        this.#fileSystem.access(
          canonical,
          fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
        );
        const relative = path.relative(workspacePath, canonical);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          return false;
        }
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { readonly code?: unknown }).code
            : undefined;
        if (code !== "ENOENT") return false;
      }
    }
    return true;
  }

  #evaluatePolicy(
    workspace: Workspace,
    ignoreDisabledRequest = false,
  ): Pick<WorkspaceSummary,
    "effectiveSecurityProfile" | "usable" | "policyIssue"
  > {
    let effectiveSecurityProfile: WorkspaceSecurityProfile | null;
    let policyIssue: WorkspacePolicyIssue = null;
    if (this.#policy.mode === "disabled") {
      if (workspace.securityProfile === "workspace-sandboxed") {
        effectiveSecurityProfile = null;
        if (!ignoreDisabledRequest) policyIssue = "sandbox_disabled";
      } else {
        effectiveSecurityProfile = "unrestricted";
      }
    } else if (this.#policy.mode === "required") {
      effectiveSecurityProfile = "workspace-sandboxed";
    } else {
      effectiveSecurityProfile = workspace.securityProfile;
    }

    if (
      policyIssue === null &&
      this.#policy.workspaceRoots.length > 0 &&
      !this.#policy.workspaceRoots.some((root) => isPathContained(root, workspace.path))
    ) {
      policyIssue = "outside_workspace_roots";
    }

    if (policyIssue === null && effectiveSecurityProfile === "workspace-sandboxed") {
      const protectedPaths = [
        this.#policy.dataDirectory,
        this.#policy.piAgentDirectory,
        ...this.#policy.readOnlyMounts,
      ];
      if (protectedPaths.some((protectedPath) => pathsOverlap(workspace.path, protectedPath))) {
        policyIssue = "protected_path_overlap";
      }
    }

    return {
      effectiveSecurityProfile,
      usable: effectiveSecurityProfile !== null && policyIssue === null && this.#isAvailable(workspace),
      policyIssue,
    };
  }

  #summary(workspace: Workspace): WorkspaceSummary {
    const available = this.#isAvailable(workspace);
    const evaluation = this.#evaluatePolicy(workspace);
    return { ...workspace, available, ...evaluation, usable: available && evaluation.usable };
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
