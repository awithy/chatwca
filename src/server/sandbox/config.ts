import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import type {
  PublicSandboxConfig,
  SandboxMode,
  WorkspaceSecurityProfile,
} from "../../shared/protocol.js";

export const DEFAULT_SANDBOX_MODE: SandboxMode = "disabled";
export const DEFAULT_BWRAP_PATH = "/usr/bin/bwrap";
export const DEFAULT_SANDBOX_PATH = "/usr/bin:/bin";
export const DEFAULT_SANDBOX_START_TIMEOUT_MS = 5_000;
export const DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS = 900_000;
export const DEFAULT_SANDBOX_MAX_COMMAND_OUTPUT_BYTES = 64 * 1024 * 1024;

export const REMOTE_PROVIDER_DISCLOSURE_WARNING =
  "Workspace content may still be sent to the configured model provider.";

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

export interface SandboxReadOnlyMount {
  /** Canonical host source. The guest destination is deliberately identical. */
  readonly source: string;
  readonly destination: string;
  readonly kind: "file" | "directory";
}

export interface SandboxConfig {
  readonly mode: SandboxMode;
  readonly bwrapPath: string;
  readonly workspaceRoots: readonly string[];
  readonly readOnlyMounts: readonly SandboxReadOnlyMount[];
  readonly guestPath: string;
  readonly startTimeoutMs: number;
  readonly commandTimeoutMs: number;
  readonly maxCommandOutputBytes: number;
}

export interface SandboxConfigFileSystem {
  readonly realpath: (target: string) => string;
  readonly stat: (target: string) => {
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
  };
}

const nodeFileSystem: SandboxConfigFileSystem = {
  realpath: realpathSync,
  stat: statSync,
};

const PROTECTED_MOUNT_DESTINATIONS = Object.freeze([
  "/app",
  "/dev",
  "/etc",
  "/proc",
  "/run",
  "/sys",
  "/tmp",
  "/var/tmp",
  "/workspace",
]);

function isContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function overlaps(left: string, right: string): boolean {
  return isContained(left, right) || isContained(right, left);
}

function parseMode(environment: NodeJS.ProcessEnv): SandboxMode {
  const raw = environment.CHATWCA_SANDBOX_MODE;
  if (raw === undefined) return DEFAULT_SANDBOX_MODE;
  if (raw === "disabled" || raw === "optional" || raw === "required") return raw;
  throw new ConfigurationError(
    "CHATWCA_SANDBOX_MODE must be disabled, optional, or required",
  );
}

function parseJsonStringArray(
  environment: NodeJS.ProcessEnv,
  variable: string,
): string[] {
  const raw = environment[variable];
  if (raw === undefined) return [];
  if (raw.trim().length === 0) {
    throw new ConfigurationError(`${variable} must not be empty`);
  }

  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    throw new ConfigurationError(`${variable} must be a JSON string array`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ConfigurationError(`${variable} must be a JSON string array`);
  }
  if (value.some((item) => item.length === 0 || item.trim().length === 0)) {
    throw new ConfigurationError(`${variable} entries must not be empty`);
  }
  return value as string[];
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  variable: string,
  defaultValue: number,
): number {
  const raw = environment[variable];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`${variable} must be a positive integer`);
  }
  return value;
}

function canonicalizeRoots(
  configured: readonly string[],
  fileSystem: SandboxConfigFileSystem,
): readonly string[] {
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const root of configured) {
    if (!path.isAbsolute(root)) {
      throw new ConfigurationError("CHATWCA_WORKSPACE_ROOTS entries must be absolute paths");
    }
    try {
      const resolved = path.normalize(fileSystem.realpath(root));
      if (!fileSystem.stat(resolved).isDirectory()) throw new Error("not a directory");
      if (seen.has(resolved)) {
        throw new ConfigurationError("CHATWCA_WORKSPACE_ROOTS contains a canonical duplicate");
      }
      seen.add(resolved);
      canonical.push(resolved);
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError("CHATWCA_WORKSPACE_ROOTS entries must be existing directories");
    }
  }
  return Object.freeze(canonical);
}

function canonicalizeMounts(
  configured: readonly string[],
  mode: SandboxMode,
  fileSystem: SandboxConfigFileSystem,
): readonly SandboxReadOnlyMount[] {
  // Disabled mode intentionally performs no sandbox toolchain/mount stat. The
  // values remain private and inert until an operator enables sandboxing.
  if (mode === "disabled") {
    const normalized = configured.map((source) => {
      if (!path.isAbsolute(source)) {
        throw new ConfigurationError("CHATWCA_SANDBOX_RO_MOUNTS entries must be absolute paths");
      }
      return path.normalize(source);
    });
    if (normalized.some((candidate, index) =>
      normalized.some((other, otherIndex) => index !== otherIndex && overlaps(candidate, other))
    )) {
      throw new ConfigurationError("CHATWCA_SANDBOX_RO_MOUNTS contains overlapping destinations");
    }
    return Object.freeze(normalized.map((source) => Object.freeze({
      source,
      destination: source,
      kind: "directory" as const,
    })));
  }

  const mounts: SandboxReadOnlyMount[] = [];
  const seen = new Set<string>();
  for (const source of configured) {
    if (!path.isAbsolute(source)) {
      throw new ConfigurationError("CHATWCA_SANDBOX_RO_MOUNTS entries must be absolute paths");
    }
    try {
      const canonical = path.normalize(fileSystem.realpath(source));
      const metadata = fileSystem.stat(canonical);
      if (!metadata.isDirectory() && !metadata.isFile()) throw new Error("unsupported type");
      if (seen.has(canonical)) {
        throw new ConfigurationError("CHATWCA_SANDBOX_RO_MOUNTS contains a canonical duplicate");
      }
      if (mounts.some((mount) => overlaps(mount.destination, canonical))) {
        throw new ConfigurationError("CHATWCA_SANDBOX_RO_MOUNTS contains overlapping destinations");
      }
      if (PROTECTED_MOUNT_DESTINATIONS.some((protectedPath) => overlaps(canonical, protectedPath))) {
        throw new ConfigurationError("CHATWCA_SANDBOX_RO_MOUNTS overlaps a protected destination");
      }
      seen.add(canonical);
      mounts.push(Object.freeze({
        source: canonical,
        destination: canonical,
        kind: metadata.isDirectory() ? "directory" : "file",
      }));
    } catch (error) {
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(
        "CHATWCA_SANDBOX_RO_MOUNTS entries must be existing regular files or directories",
      );
    }
  }
  return Object.freeze(mounts);
}

function parseGuestPath(
  environment: NodeJS.ProcessEnv,
  mounts: readonly SandboxReadOnlyMount[],
): string {
  const guestPath = environment.CHATWCA_SANDBOX_PATH ?? DEFAULT_SANDBOX_PATH;
  if (guestPath.length === 0) {
    throw new ConfigurationError("CHATWCA_SANDBOX_PATH must not be empty");
  }
  const entries = guestPath.split(":");
  for (const entry of entries) {
    if (
      entry.length === 0 ||
      !path.posix.isAbsolute(entry) ||
      entry.split("/").slice(1).some((segment) => segment.length === 0) ||
      path.posix.normalize(entry) !== entry
    ) {
      throw new ConfigurationError(
        "CHATWCA_SANDBOX_PATH entries must be absolute and contain no empty segments",
      );
    }

    const suppliedByUsr = isContained("/usr", entry);
    const compatibilityTarget = entry === "/bin" || entry.startsWith("/bin/")
      ? `/usr${entry}`
      : entry === "/sbin" || entry.startsWith("/sbin/")
        ? `/usr${entry}`
        : undefined;
    const suppliedByCompatibilityLink =
      compatibilityTarget !== undefined && isContained("/usr", compatibilityTarget);
    const suppliedByMount = mounts.some(
      (mount) => mount.kind === "directory" && isContained(mount.destination, entry),
    );
    if (!suppliedByUsr && !suppliedByCompatibilityLink && !suppliedByMount) {
      throw new ConfigurationError(
        "CHATWCA_SANDBOX_PATH contains an entry not supplied by /usr or an approved read-only mount",
      );
    }
  }
  return guestPath;
}

export function loadSandboxConfig(
  environment: NodeJS.ProcessEnv,
  fileSystem: SandboxConfigFileSystem = nodeFileSystem,
): Readonly<SandboxConfig> {
  const mode = parseMode(environment);
  const bwrapPath = environment.CHATWCA_BWRAP_PATH ?? DEFAULT_BWRAP_PATH;
  if (bwrapPath.trim().length === 0 || !path.isAbsolute(bwrapPath)) {
    throw new ConfigurationError("CHATWCA_BWRAP_PATH must be a non-empty absolute path");
  }

  const workspaceRoots = canonicalizeRoots(
    parseJsonStringArray(environment, "CHATWCA_WORKSPACE_ROOTS"),
    fileSystem,
  );
  if (mode === "required" && workspaceRoots.length === 0) {
    throw new ConfigurationError(
      "CHATWCA_WORKSPACE_ROOTS must contain at least one root in required mode",
    );
  }
  const readOnlyMounts = canonicalizeMounts(
    parseJsonStringArray(environment, "CHATWCA_SANDBOX_RO_MOUNTS"),
    mode,
    fileSystem,
  );
  const guestPath = parseGuestPath(environment, readOnlyMounts);

  return Object.freeze({
    mode,
    bwrapPath: path.normalize(bwrapPath),
    workspaceRoots,
    readOnlyMounts,
    guestPath,
    startTimeoutMs: positiveInteger(
      environment,
      "CHATWCA_SANDBOX_START_TIMEOUT_MS",
      DEFAULT_SANDBOX_START_TIMEOUT_MS,
    ),
    commandTimeoutMs: positiveInteger(
      environment,
      "CHATWCA_SANDBOX_COMMAND_TIMEOUT_MS",
      DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
    ),
    maxCommandOutputBytes: positiveInteger(
      environment,
      "CHATWCA_SANDBOX_MAX_COMMAND_OUTPUT_BYTES",
      DEFAULT_SANDBOX_MAX_COMMAND_OUTPUT_BYTES,
    ),
  });
}

export function publicSandboxConfig(
  sandbox: Readonly<SandboxConfig>,
  functionalProbeSucceeded = false,
): PublicSandboxConfig {
  const selectableProfiles: readonly WorkspaceSecurityProfile[] =
    sandbox.mode === "optional"
      ? ["unrestricted", "workspace-sandboxed"]
      : sandbox.mode === "required"
        ? ["workspace-sandboxed"]
        : ["unrestricted"];
  return {
    mode: sandbox.mode,
    selectableProfiles: [...selectableProfiles],
    remoteProviderWarning: REMOTE_PROVIDER_DISCLOSURE_WARNING,
    functionalProbeSucceeded,
  };
}
