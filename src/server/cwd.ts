import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  AppError,
  ERROR_CODES,
  toAppError,
  type ErrorCode,
} from "../shared/errors.js";

/** Result used by history so a stored workspace remains visible when unavailable. */
export type StoredCwdInspection =
  | {
      readonly storedCwd: string;
      readonly runnable: true;
      readonly canonicalCwd: string;
    }
  | {
      readonly storedCwd: string;
      readonly runnable: false;
      readonly errorCode: ErrorCode;
    };

function resolveCandidate(requestedCwd: string, baseCwd: string): string {
  if (requestedCwd.trim().length === 0) {
    throw new AppError(ERROR_CODES.INVALID_CWD);
  }

  try {
    return path.resolve(baseCwd, requestedCwd);
  } catch (error) {
    throw toAppError(error, { source: "filesystem", target: "cwd" });
  }
}

/**
 * Resolve and validate a workspace for a new or reopened conversation.
 *
 * The returned path is canonical, which lets the registry treat symlink aliases
 * as the same workspace. Read and search access are checked explicitly because
 * metadata calls can succeed for a directory the process cannot actually use.
 */
export async function resolveConversationCwd(
  requestedCwd: string,
  baseCwd = process.cwd(),
): Promise<string> {
  const resolvedCwd = resolveCandidate(requestedCwd, baseCwd);

  try {
    const canonicalCwd = await realpath(resolvedCwd);
    const details = await stat(canonicalCwd);
    if (!details.isDirectory()) {
      throw new AppError(ERROR_CODES.INVALID_CWD);
    }

    await access(canonicalCwd, fsConstants.R_OK | fsConstants.X_OK);
    return canonicalCwd;
  } catch (error) {
    throw toAppError(error, { source: "filesystem", target: "cwd" });
  }
}

/**
 * Check a CWD read from a Pi session header without dropping its original value.
 * History can display `storedCwd` with `runnable: false`; an open attempt can
 * report `errorCode` until the directory is restored.
 */
export async function inspectStoredCwd(
  storedCwd: string,
  baseCwd = process.cwd(),
): Promise<StoredCwdInspection> {
  try {
    return {
      storedCwd,
      runnable: true,
      canonicalCwd: await resolveConversationCwd(storedCwd, baseCwd),
    };
  } catch (error) {
    const appError = toAppError(error, {
      source: "filesystem",
      target: "cwd",
    });
    return { storedCwd, runnable: false, errorCode: appError.code };
  }
}
