import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { AppError, ERROR_CODES } from "../shared/errors.js";
import { JOB_SCRIPT_PATH_MAX_LENGTH } from "../shared/jobs.js";
import {
  canonicalPathsOverlap,
  isCanonicalPathContained,
} from "./sandbox/admission.js";

export interface JobHookPathMetadata {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly isSymbolicLink: () => boolean;
}

export interface JobHookPathFileSystem {
  readonly lstat: (target: string) => JobHookPathMetadata;
  readonly realpath: (target: string) => string;
  readonly access: (target: string, mode: number) => void;
}

const nodeFileSystem: JobHookPathFileSystem = {
  lstat: lstatSync,
  realpath: realpathSync,
  access: accessSync,
};

export interface JobHookWorkspacePolicy {
  /** Canonical workspace directory. */
  readonly cwd: string;
  /** Canonical host mount sources, including read-only mounts. */
  readonly mounts?: readonly { readonly source: string }[];
}

export interface JobHookPathAdmissionOptions {
  /** Canonical configured roots. Roots are revalidated on every admission. */
  readonly scriptRoots: readonly string[];
  /** ChatWCA data, Pi state, helpers, workers, and sandbox runtime mounts. */
  readonly protectedPaths: readonly string[];
  readonly fileSystem?: JobHookPathFileSystem;
}

export type JobHookPathValidationPhase = "configuration" | "run";

function sameIdentity(left: JobHookPathMetadata, right: JobHookPathMetadata): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Canonical admission boundary for trusted host hooks.
 *
 * Parent symlinks may be submitted, but only the canonical path is returned and
 * persisted. The final submitted component itself must never be a symlink.
 */
export class JobHookPathAdmission {
  readonly #scriptRoots: readonly string[];
  readonly #protectedPaths: readonly string[];
  readonly #fileSystem: JobHookPathFileSystem;

  constructor(options: Readonly<JobHookPathAdmissionOptions>) {
    this.#scriptRoots = Object.freeze([...options.scriptRoots]);
    this.#protectedPaths = Object.freeze([...options.protectedPaths]);
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
  }

  validateForConfiguration(
    submittedPath: string,
    workspace: Readonly<JobHookWorkspacePolicy>,
  ): string {
    return this.validate(submittedPath, workspace, "configuration");
  }

  validateForRun(
    canonicalScriptPath: string,
    workspace: Readonly<JobHookWorkspacePolicy>,
  ): string {
    return this.validate(canonicalScriptPath, workspace, "run");
  }

  validate(
    submittedPath: string,
    workspace: Readonly<JobHookWorkspacePolicy>,
    phase: JobHookPathValidationPhase,
  ): string {
    if (this.#scriptRoots.length === 0) {
      throw new AppError(ERROR_CODES.JOB_SCRIPT_ROOTS_UNAVAILABLE);
    }
    const failureCode = phase === "configuration"
      ? ERROR_CODES.JOB_SCRIPT_INVALID
      : ERROR_CODES.JOB_SCRIPT_UNAVAILABLE;

    try {
      if (
        typeof submittedPath !== "string" || submittedPath.length === 0 ||
        submittedPath.length > JOB_SCRIPT_PATH_MAX_LENGTH ||
        submittedPath.includes("\0") || !path.isAbsolute(submittedPath)
      ) {
        throw new Error("invalid script path shape");
      }
      if (!path.isAbsolute(workspace.cwd)) throw new Error("invalid workspace policy");

      // Reject a final-component symlink before following any parent aliases.
      const submittedMetadata = this.#fileSystem.lstat(submittedPath);
      if (submittedMetadata.isSymbolicLink()) throw new Error("script final component is a symlink");

      const canonical = path.normalize(this.#fileSystem.realpath(submittedPath));
      if (!path.isAbsolute(canonical)) throw new Error("script did not resolve absolutely");
      const initialMetadata = this.#fileSystem.lstat(canonical);
      if (initialMetadata.isSymbolicLink() || !initialMetadata.isFile()) {
        throw new Error("script is not a regular file");
      }
      if (!sameIdentity(submittedMetadata, initialMetadata)) {
        throw new Error("script identity changed while resolving");
      }
      this.#fileSystem.access(canonical, fsConstants.R_OK);

      let containingRoots = 0;
      for (const root of this.#scriptRoots) {
        const rootCanonical = path.normalize(this.#fileSystem.realpath(root));
        const rootMetadata = this.#fileSystem.lstat(rootCanonical);
        this.#fileSystem.access(rootCanonical, fsConstants.R_OK | fsConstants.X_OK);
        if (
          rootCanonical !== path.normalize(root) || rootMetadata.isSymbolicLink() ||
          !rootMetadata.isDirectory()
        ) {
          throw new Error("script root identity changed");
        }
        if (isCanonicalPathContained(rootCanonical, canonical)) containingRoots += 1;
      }
      if (containingRoots !== 1) throw new Error("script is not beneath exactly one root");

      const excluded = [
        workspace.cwd,
        ...(workspace.mounts ?? []).map((mount) => mount.source),
        ...this.#protectedPaths,
      ];
      if (excluded.some((protectedPath) =>
        !path.isAbsolute(protectedPath) || canonicalPathsOverlap(canonical, protectedPath)
      )) {
        throw new Error("script overlaps an execution-controlled path");
      }

      // Re-read both name resolution and inode identity after all checks. This
      // closes deterministic swaps during validation; callers also revalidate
      // immediately before each spawn to narrow the unavoidable post-check race.
      if (path.normalize(this.#fileSystem.realpath(submittedPath)) !== canonical) {
        throw new Error("script canonical identity changed");
      }
      const finalMetadata = this.#fileSystem.lstat(submittedPath);
      if (
        finalMetadata.isSymbolicLink() || !finalMetadata.isFile() ||
        !sameIdentity(initialMetadata, finalMetadata)
      ) {
        throw new Error("script inode changed during validation");
      }
      this.#fileSystem.access(canonical, fsConstants.R_OK);
      return canonical;
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(failureCode, { cause: error });
    }
  }
}
