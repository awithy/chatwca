import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import type Database from "better-sqlite3";

import { SandboxWorkspaceAdmission } from "./sandbox/admission.js";
import {
  AppError,
  ERROR_CODES,
  toAppError,
} from "../shared/errors.js";
import type {
  ManagedEgressMode,
  SandboxMode,
  SandboxNetworkPolicy,
  Workspace,
  WorkspaceNetworkPolicyIssue,
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
  readonly network_policy: SandboxNetworkPolicy;
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
  readonly managedEgressMode?: ManagedEgressMode;
  readonly networkHelperPath?: string;
  readonly networkHelperDirectory?: string;
}

const DEFAULT_POLICY: WorkspacePolicyInputs = Object.freeze({
  mode: "disabled",
  workspaceRoots: Object.freeze([]),
  // In disabled mode these inert sentinels can never reject unrestricted rows.
  dataDirectory: path.parse(process.cwd()).root,
  piAgentDirectory: path.parse(process.cwd()).root,
  readOnlyMounts: Object.freeze([]),
  managedEgressMode: "disabled",
});

export interface WorkspaceRepositoryOptions {
  /** Stable process base for resolving relative workspace paths. */
  readonly cwd?: string;
  readonly uuid?: () => string;
  readonly clock?: () => number;
  readonly fileSystem?: WorkspaceFileSystem;
  readonly policy?: Readonly<WorkspacePolicyInputs>;
  readonly sandboxAdmission?: Pick<SandboxWorkspaceAdmission, "admit">;
}

export interface RuntimeWorkspacePolicy {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly sessionDirectory: string | null;
  readonly securityProfile: WorkspaceSecurityProfile;
  readonly networkPolicy: SandboxNetworkPolicy | null;
}

export interface CreateWorkspaceInput {
  readonly name: string;
  readonly path: string;
  readonly sessionStorage?: WorkspaceSessionStorage;
  readonly securityProfile?: WorkspaceSecurityProfile;
  readonly networkPolicy?: SandboxNetworkPolicy;
}

export interface UpdateWorkspaceInput {
  readonly name?: string;
  readonly path?: string;
  readonly securityProfile?: WorkspaceSecurityProfile;
  readonly networkPolicy?: SandboxNetworkPolicy;
  readonly acknowledgeSecurityDowngrade?: true;
  readonly acknowledgeNetworkExposure?: true;
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
  if (row.network_policy !== "isolated" && row.network_policy !== "managed-egress") {
    throw new AppError(ERROR_CODES.DATABASE_ERROR);
  }
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    sessionStorage: row.session_storage,
    sessionDirectory: workspaceSessionDirectory(row.path, row.session_storage),
    securityProfile: row.security_profile,
    networkPolicy: row.network_policy,
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
  readonly #sandboxAdmission: Pick<SandboxWorkspaceAdmission, "admit">;
  readonly #listStatement: Database.Statement<[], WorkspaceRow>;
  readonly #getStatement: Database.Statement<[string], WorkspaceRow>;
  readonly #insertStatement: Database.Statement<
    [string, string, string, WorkspaceSessionStorage, WorkspaceSecurityProfile, SandboxNetworkPolicy, number, number]
  >;
  readonly #updateStatement: Database.Statement<
    [string, string, WorkspaceSecurityProfile, SandboxNetworkPolicy, number, string]
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
      managedEgressMode: suppliedPolicy.managedEgressMode ?? "disabled",
    });
    this.#sandboxAdmission = options.sandboxAdmission ?? new SandboxWorkspaceAdmission();

    try {
      this.#listStatement = connection.prepare<[], WorkspaceRow>(
        "SELECT id, name, path, session_storage, security_profile, network_policy, created_at, updated_at FROM workspaces",
      );
      this.#getStatement = connection.prepare<[string], WorkspaceRow>(
        "SELECT id, name, path, session_storage, security_profile, network_policy, created_at, updated_at FROM workspaces WHERE id = ?",
      );
      this.#insertStatement = connection.prepare<
        [string, string, string, WorkspaceSessionStorage, WorkspaceSecurityProfile, SandboxNetworkPolicy, number, number]
      >(
        "INSERT INTO workspaces (id, name, path, session_storage, security_profile, network_policy, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      );
      this.#updateStatement = connection.prepare<
        [string, string, WorkspaceSecurityProfile, SandboxNetworkPolicy, number, string]
      >(
        "UPDATE workspaces SET name = ?, path = ?, security_profile = ?, network_policy = ?, updated_at = ? WHERE id = ?",
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
  async requireUsable(workspaceId: string): Promise<RuntimeWorkspacePolicy> {
    const workspace = this.requireAvailable(workspaceId);
    const evaluation = this.#evaluatePolicy(workspace);
    if (!evaluation.usable || evaluation.effectiveSecurityProfile === null) {
      if (evaluation.policyIssue === "sandbox_disabled") {
        throw new AppError(ERROR_CODES.SANDBOX_DISABLED);
      }
      if (evaluation.networkPolicyIssue === "managed_egress_disabled") {
        throw new AppError(ERROR_CODES.MANAGED_EGRESS_DISABLED);
      }
      throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED);
    }

    if (evaluation.effectiveSecurityProfile === "workspace-sandboxed") {
      await this.#sandboxAdmission.admit({
        workspacePath: workspace.path,
        workspaceRoots: this.#policy.workspaceRoots,
        protectedPaths: this.#protectedPaths(),
      });
    }
    return Object.freeze({
      workspaceId: workspace.id,
      cwd: workspace.path,
      sessionDirectory: workspace.sessionDirectory,
      securityProfile: evaluation.effectiveSecurityProfile,
      networkPolicy: evaluation.effectiveNetworkPolicy,
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
    const networkPolicy = this.#validNetworkPolicy(
      input.networkPolicy ?? "isolated",
    );
    if (
      securityProfile === "workspace-sandboxed" &&
      networkPolicy === "managed-egress" &&
      this.#policy.managedEgressMode !== "optional"
    ) {
      throw new AppError(ERROR_CODES.MANAGED_EGRESS_DISABLED);
    }
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
    this.#assertPathPolicy(canonicalPath, securityProfile, networkPolicy);
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
          networkPolicy,
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
      networkPolicy,
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
      changes.securityProfile === undefined &&
      changes.networkPolicy === undefined
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

    const networkPolicy = changes.networkPolicy === undefined
      ? current.networkPolicy
      : this.#validNetworkPolicy(changes.networkPolicy);
    const addsNetworkExposure =
      current.networkPolicy === "isolated" && networkPolicy === "managed-egress";
    if (changes.acknowledgeNetworkExposure === true && !addsNetworkExposure) {
      throw new AppError(ERROR_CODES.INVALID_COMMAND);
    }
    if (addsNetworkExposure && changes.acknowledgeNetworkExposure !== true) {
      throw new AppError(ERROR_CODES.INVALID_COMMAND);
    }
    if (
      (changes.securityProfile !== undefined || changes.networkPolicy !== undefined) &&
      securityProfile === "workspace-sandboxed" &&
      networkPolicy === "managed-egress" &&
      this.#policy.managedEgressMode !== "optional"
    ) {
      throw new AppError(ERROR_CODES.MANAGED_EGRESS_DISABLED);
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
    if (
      changes.path !== undefined ||
      changes.securityProfile !== undefined ||
      changes.networkPolicy !== undefined
    ) {
      this.#assertPathPolicy(canonicalPath, securityProfile, networkPolicy);
    }
    const now = this.#clock();

    this.#database(() => {
      try {
        const result = this.#updateStatement.run(
          name,
          canonicalPath,
          securityProfile,
          networkPolicy,
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
      networkPolicy,
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

  #validNetworkPolicy(input: unknown): SandboxNetworkPolicy {
    if (input !== "isolated" && input !== "managed-egress") {
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
    networkPolicy: SandboxNetworkPolicy,
  ): void {
    const workspace: Workspace = {
      id: "policy-candidate",
      name: "policy-candidate",
      path: canonicalPath,
      sessionStorage: "pi-default",
      sessionDirectory: null,
      securityProfile: storedProfile,
      networkPolicy,
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

  #protectedPaths(): readonly string[] {
    const protectedPaths = [
      this.#policy.dataDirectory,
      this.#policy.piAgentDirectory,
      ...this.#policy.readOnlyMounts,
    ];
    if (this.#policy.managedEgressMode === "optional") {
      if (this.#policy.networkHelperPath !== undefined) {
        protectedPaths.push(this.#policy.networkHelperPath);
      }
      if (this.#policy.networkHelperDirectory !== undefined) {
        protectedPaths.push(this.#policy.networkHelperDirectory);
      }
    }
    return protectedPaths;
  }

  #evaluatePolicy(
    workspace: Workspace,
    ignoreDisabledRequest = false,
  ): Pick<WorkspaceSummary,
    | "effectiveSecurityProfile"
    | "effectiveNetworkPolicy"
    | "networkPolicyIssue"
    | "usable"
    | "policyIssue"
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

    const effectiveNetworkPolicy = effectiveSecurityProfile === "workspace-sandboxed"
      ? workspace.networkPolicy
      : null;
    let networkPolicyIssue: WorkspaceNetworkPolicyIssue = null;
    if (
      !ignoreDisabledRequest &&
      effectiveNetworkPolicy === "managed-egress" &&
      this.#policy.managedEgressMode !== "optional"
    ) {
      networkPolicyIssue = "managed_egress_disabled";
    }

    if (
      policyIssue === null &&
      this.#policy.workspaceRoots.length > 0 &&
      !this.#policy.workspaceRoots.some((root) => isPathContained(root, workspace.path))
    ) {
      policyIssue = "outside_workspace_roots";
    }

    if (policyIssue === null && effectiveSecurityProfile === "workspace-sandboxed") {
      if (this.#protectedPaths().some((protectedPath) =>
        pathsOverlap(workspace.path, protectedPath)
      )) {
        policyIssue = "protected_path_overlap";
      }
    }

    return {
      effectiveSecurityProfile,
      effectiveNetworkPolicy,
      networkPolicyIssue,
      usable:
        effectiveSecurityProfile !== null &&
        policyIssue === null &&
        networkPolicyIssue === null &&
        this.#isAvailable(workspace),
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
