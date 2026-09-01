import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  opendir,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { AppError, ERROR_CODES } from "../../shared/errors.js";

export const SANDBOX_SOCKET_WALK_MAX_ENTRIES = 100_000;
export const SANDBOX_SOCKET_WALK_DEADLINE_MS = 2_000;

export interface SandboxAdmissionPolicy {
  /** Canonical path stored in the workspace row. */
  readonly workspacePath: string;
  readonly workspaceRoots: readonly string[];
  readonly protectedPaths: readonly string[];
}

export interface SandboxAdmissionBounds {
  readonly maxEntries: number;
  readonly deadlineMs: number;
}

export interface SandboxAdmissionFileSystem {
  readonly realpath: (target: string) => Promise<string>;
  readonly access: (target: string, mode: number) => Promise<void>;
  readonly lstat: (target: string) => Promise<{
    readonly isDirectory: () => boolean;
    readonly isSymbolicLink: () => boolean;
    readonly isSocket: () => boolean;
  }>;
  readonly opendir: typeof opendir;
  readonly now: () => number;
}

const nodeFileSystem: SandboxAdmissionFileSystem = {
  realpath,
  access,
  lstat,
  opendir,
  now: () => performance.now(),
};

const DEFAULT_BOUNDS: Readonly<SandboxAdmissionBounds> = Object.freeze({
  maxEntries: SANDBOX_SOCKET_WALK_MAX_ENTRIES,
  deadlineMs: SANDBOX_SOCKET_WALK_DEADLINE_MS,
});

export function isCanonicalPathContained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function canonicalPathsOverlap(left: string, right: string): boolean {
  return isCanonicalPathContained(left, right) || isCanonicalPathContained(right, left);
}

function errno(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { readonly code?: unknown }).code
    : undefined;
}

/**
 * Best-effort pre-mount socket check. It deliberately does not follow symlinks.
 * A host process can still race this walk, so Bubblewrap remains the primary
 * filesystem boundary and operators must not place service sockets in a sandbox.
 */
export class SandboxWorkspaceAdmission {
  readonly #fileSystem: SandboxAdmissionFileSystem;
  readonly #bounds: Readonly<SandboxAdmissionBounds>;

  constructor(options: {
    readonly fileSystem?: SandboxAdmissionFileSystem;
    readonly bounds?: Partial<SandboxAdmissionBounds>;
  } = {}) {
    this.#fileSystem = options.fileSystem ?? nodeFileSystem;
    this.#bounds = Object.freeze({ ...DEFAULT_BOUNDS, ...options.bounds });
    if (!Number.isSafeInteger(this.#bounds.maxEntries) || this.#bounds.maxEntries <= 0) {
      throw new RangeError("Sandbox admission maxEntries must be a positive integer");
    }
    if (!Number.isFinite(this.#bounds.deadlineMs) || this.#bounds.deadlineMs <= 0) {
      throw new RangeError("Sandbox admission deadlineMs must be positive");
    }
  }

  async admit(policy: Readonly<SandboxAdmissionPolicy>): Promise<void> {
    try {
      const expected = path.normalize(policy.workspacePath);
      const canonical = path.normalize(await this.#fileSystem.realpath(expected));
      if (canonical !== expected) throw new Error("workspace canonical identity changed");
      if (
        policy.workspaceRoots.length > 0 &&
        !policy.workspaceRoots.some((root) => isCanonicalPathContained(root, canonical))
      ) {
        throw new Error("workspace is outside approved roots");
      }
      if (policy.protectedPaths.some((protectedPath) =>
        canonicalPathsOverlap(canonical, protectedPath)
      )) {
        throw new Error("workspace overlaps a protected path");
      }

      await this.#fileSystem.access(
        canonical,
        fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK,
      );
      await this.#validateChatWcaMask(canonical);
      await this.#rejectSockets(canonical);

      // Detect replacement of the registered directory during the bounded walk.
      if (path.normalize(await this.#fileSystem.realpath(expected)) !== expected) {
        throw new Error("workspace canonical identity changed during admission");
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED, { cause: error });
    }
  }

  async #validateChatWcaMask(workspace: string): Promise<void> {
    try {
      const metadata = await this.#fileSystem.lstat(path.join(workspace, ".chatwca"));
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(".chatwca is not a real directory");
      }
    } catch (error) {
      if (errno(error) !== "ENOENT") throw error;
    }
  }

  async #rejectSockets(workspace: string): Promise<void> {
    const started = this.#fileSystem.now();
    const pending = [workspace];
    let entries = 0;

    while (pending.length > 0) {
      if (this.#fileSystem.now() - started >= this.#bounds.deadlineMs) {
        throw new Error("socket walk deadline reached");
      }
      const directoryPath = pending.pop();
      if (directoryPath === undefined) break;

      const directory = await this.#fileSystem.opendir(directoryPath);
      try {
        for await (const entry of directory) {
          entries += 1;
          if (entries > this.#bounds.maxEntries) {
            throw new Error("socket walk entry bound reached");
          }
          if (this.#fileSystem.now() - started >= this.#bounds.deadlineMs) {
            throw new Error("socket walk deadline reached");
          }

          const child = path.join(directoryPath, entry.name);
          const metadata = await this.#fileSystem.lstat(child);
          if (metadata.isSocket()) throw new Error("workspace contains a Unix socket");
          if (metadata.isDirectory() && !metadata.isSymbolicLink()) pending.push(child);
        }
      } finally {
        // for-await closes normal directories. close() throws ERR_DIR_CLOSED in
        // that case, while this explicit close covers a rejected early walk.
        await directory.close().catch((error: unknown) => {
          if (errno(error) !== "ERR_DIR_CLOSED") throw error;
        });
      }
    }
  }
}
