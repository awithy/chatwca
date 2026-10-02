import path from "node:path";

import { AppError, ERROR_CODES } from "../shared/errors.js";
import { inspectStoredCwd, resolveConversationCwd } from "./cwd.js";

/** Discovery never grants authority beyond this canonical registered workspace. */
export interface SessionWorkspaceScope {
  readonly id: string;
  readonly path: string;
  readonly sessionDirectory: string | null;
}

export async function requireCanonicalSessionWorkspace(workspace: SessionWorkspaceScope): Promise<SessionWorkspaceScope> {
  try {
    const canonicalPath = await resolveConversationCwd(workspace.path);
    if (path.resolve(canonicalPath) !== path.resolve(workspace.path)) throw new Error("noncanonical");
    return { id: workspace.id, path: canonicalPath, sessionDirectory: workspace.sessionDirectory };
  } catch (error) {
    throw new AppError(ERROR_CODES.WORKSPACE_UNAVAILABLE, { cause: error });
  }
}

/** A failed path resolution is not proof that another workspace owns the file. */
export async function storedCwdOwnership(storedCwd: string, workspace: SessionWorkspaceScope): Promise<"owned" | "mismatch" | "unavailable"> {
  const inspection = await inspectStoredCwd(storedCwd);
  if (!inspection.runnable) return "unavailable";
  return path.resolve(inspection.canonicalCwd) === path.resolve(workspace.path) ? "owned" : "mismatch";
}

/** Scoped listings and read-only search snapshots share the same CWD ownership check. */
export async function storedCwdOwnsWorkspace(storedCwd: string, workspace: SessionWorkspaceScope): Promise<boolean> {
  return await storedCwdOwnership(storedCwd, workspace) === "owned";
}

/**
 * Pi 0.84.3 getDefaultSessionDirPath convention, pinned by an SDK contract test.
 * Its getDefaultSessionDir helper is not a read API: it mkdirs missing stores and
 * is not a package export. Keep this pure; never create a directory for search.
 */
export function scopedSessionStorePath(workspace: SessionWorkspaceScope, piAgentDirectory: string): string {
  if (workspace.sessionDirectory !== null) return path.resolve(workspace.sessionDirectory);
  const safePath = `--${path.resolve(workspace.path).replace(/^[/\\]/u, "").replace(/[/\\:]/gu, "-")}--`;
  return path.join(path.resolve(piAgentDirectory), "sessions", safePath);
}
