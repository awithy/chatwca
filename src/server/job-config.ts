import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

import {
  JOB_INTERVAL_MINUTES_MAX,
  JOB_INTERVAL_MINUTES_MIN,
  SUPPORTED_JOB_TIME_ZONES,
  type PublicJobsConfig,
} from "../shared/jobs.js";
import { canonicalPathsOverlap } from "./sandbox/admission.js";
import { ConfigurationError } from "./sandbox/config.js";

export const DEFAULT_JOB_HOOK_TIMEOUT_MS = 300_000;
export const MAX_JOB_HOOK_TIMEOUT_MS = 3_600_000;
export const DEFAULT_JOB_HOOK_MAX_OUTPUT_BYTES = 1_048_576;
export const JOB_BASH_PATH = "/usr/bin/bash";

export const JOB_HOST_AUTHORITY_WARNING =
  "Pre-run and post-run scripts run on the host with the ChatWCA service user's authority. Configure only trusted scripts.";
export const JOB_UNATTENDED_USAGE_WARNING =
  "Scheduled prompts run unattended and may incur provider costs or disclose readable workspace content to the configured model provider.";

export interface JobConfig {
  /** Canonical administrator-owned directories accepted for trusted hooks. */
  readonly scriptRoots: readonly string[];
  readonly hookTimeoutMs: number;
  readonly hookMaxOutputBytes: number;
  readonly bashPath: typeof JOB_BASH_PATH;
}

export interface JobConfigFileSystem {
  readonly realpath: (target: string) => string;
  readonly stat: (target: string) => {
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
  };
  readonly access: (target: string, mode: number) => void;
}

const nodeFileSystem: JobConfigFileSystem = {
  realpath: realpathSync,
  stat: statSync,
  access: accessSync,
};

function parseScriptRoots(environment: NodeJS.ProcessEnv): string[] {
  const raw = environment.CHATWCA_JOB_SCRIPT_ROOTS;
  if (raw === undefined) return [];
  if (raw.trim().length === 0) {
    throw new ConfigurationError("CHATWCA_JOB_SCRIPT_ROOTS must not be empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new ConfigurationError(
      "CHATWCA_JOB_SCRIPT_ROOTS must be a JSON string array",
    );
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new ConfigurationError(
      "CHATWCA_JOB_SCRIPT_ROOTS must be a JSON string array",
    );
  }
  if (parsed.some((entry) => (entry as string).trim().length === 0)) {
    throw new ConfigurationError(
      "CHATWCA_JOB_SCRIPT_ROOTS entries must not be empty",
    );
  }
  return parsed as string[];
}

function positiveSafeInteger(
  environment: NodeJS.ProcessEnv,
  variable: string,
  defaultValue: number,
): number {
  const raw = environment[variable];
  if (raw === undefined) return defaultValue;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`${variable} must be a positive safe integer`);
  }
  return value;
}

function canonicalizeRoots(
  configured: readonly string[],
  fileSystem: JobConfigFileSystem,
): readonly string[] {
  const roots: string[] = [];
  for (const configuredRoot of configured) {
    if (!path.isAbsolute(configuredRoot)) {
      throw new ConfigurationError(
        "CHATWCA_JOB_SCRIPT_ROOTS entries must be absolute paths",
      );
    }

    let canonical: string;
    try {
      canonical = path.normalize(fileSystem.realpath(configuredRoot));
      if (!fileSystem.stat(canonical).isDirectory()) {
        throw new Error("not a directory");
      }
      fileSystem.access(canonical, fsConstants.R_OK | fsConstants.X_OK);
    } catch {
      throw new ConfigurationError(
        "CHATWCA_JOB_SCRIPT_ROOTS entries must be existing readable and searchable directories",
      );
    }

    if (roots.includes(canonical)) {
      throw new ConfigurationError(
        "CHATWCA_JOB_SCRIPT_ROOTS contains a canonical duplicate",
      );
    }
    if (roots.some((root) => canonicalPathsOverlap(root, canonical))) {
      throw new ConfigurationError(
        "CHATWCA_JOB_SCRIPT_ROOTS contains overlapping roots",
      );
    }
    roots.push(canonical);
  }
  return Object.freeze(roots);
}

function validateBash(fileSystem: JobConfigFileSystem): void {
  try {
    if (!fileSystem.stat(JOB_BASH_PATH).isFile()) {
      throw new Error("not a regular file");
    }
    fileSystem.access(JOB_BASH_PATH, fsConstants.X_OK);
  } catch {
    throw new ConfigurationError(
      "/usr/bin/bash must be an executable regular file when job hooks are enabled",
    );
  }
}

export function loadJobConfig(
  environment: NodeJS.ProcessEnv,
  fileSystem: JobConfigFileSystem = nodeFileSystem,
): Readonly<JobConfig> {
  const scriptRoots = canonicalizeRoots(parseScriptRoots(environment), fileSystem);
  const hookTimeoutMs = positiveSafeInteger(
    environment,
    "CHATWCA_JOB_HOOK_TIMEOUT_MS",
    DEFAULT_JOB_HOOK_TIMEOUT_MS,
  );
  if (hookTimeoutMs > MAX_JOB_HOOK_TIMEOUT_MS) {
    throw new ConfigurationError(
      `CHATWCA_JOB_HOOK_TIMEOUT_MS must not exceed ${String(MAX_JOB_HOOK_TIMEOUT_MS)}`,
    );
  }
  const hookMaxOutputBytes = positiveSafeInteger(
    environment,
    "CHATWCA_JOB_HOOK_MAX_OUTPUT_BYTES",
    DEFAULT_JOB_HOOK_MAX_OUTPUT_BYTES,
  );

  // No hook subprocess can be admitted with an empty root set, so disabled
  // hooks deliberately do not make server startup depend on Bash.
  if (scriptRoots.length > 0) validateBash(fileSystem);

  return Object.freeze({
    scriptRoots,
    hookTimeoutMs,
    hookMaxOutputBytes,
    bashPath: JOB_BASH_PATH,
  });
}

export function publicJobConfig(
  config: Readonly<JobConfig>,
  schedulerAvailable = true,
): PublicJobsConfig {
  return {
    schedulerAvailable,
    hooksAvailable: config.scriptRoots.length > 0,
    scriptRoots: [...config.scriptRoots],
    minIntervalMinutes: JOB_INTERVAL_MINUTES_MIN,
    maxIntervalMinutes: JOB_INTERVAL_MINUTES_MAX,
    supportedTimeZones: [...SUPPORTED_JOB_TIME_ZONES],
    hostAuthorityWarning: JOB_HOST_AUTHORITY_WARNING,
    unattendedUsageWarning: JOB_UNATTENDED_USAGE_WARNING,
  };
}
