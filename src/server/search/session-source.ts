import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  requireCanonicalSessionWorkspace, scopedSessionStorePath, storedCwdOwnership,
  type SessionWorkspaceScope,
} from "../session-scope.js";
import { SearchSourceError } from "./errors.js";
import {
  MAX_SESSION_RECORD_BYTES, MAX_SESSION_SNAPSHOT_BYTES, SessionExtractor, searchHash,
  type ExtractedSession,
} from "./extract.js";

export interface SourceFingerprint {
  readonly device: string;
  readonly inode: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}
export const MAX_DISCOVERED_SESSION_FILES = 100_000;

export interface SessionFileCandidate {
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly piAgentDirectory: string;
  /** Private paths, never an HTTP result or authority for conversation open. */
  readonly path: string;
  readonly canonicalPath: string;
  readonly storePath: string;
  readonly storeDevice: string;
  readonly storeInode: string;
  readonly fingerprint: SourceFingerprint;
}
export interface SessionDiscovery {
  readonly storePath: string;
  readonly storeFingerprint: SourceFingerprint;
  readonly candidates: readonly SessionFileCandidate[];
  /** Every encountered JSONL path is seen even when it cannot be admitted. */
  readonly seenPaths: ReadonlySet<string>;
  readonly errors: readonly { readonly path: string; readonly code: SearchSourceError["code"] }[];
  /** Only a complete, still-current enumeration can authorize absence pruning. */
  readonly complete: boolean;
}
export interface SessionSnapshot {
  readonly candidate: SessionFileCandidate;
  readonly snapshotHash: string;
  readonly session: ExtractedSession;
}

export function sourceFingerprint(details: BigIntStats): SourceFingerprint {
  return {
    device: details.dev.toString(), inode: details.ino.toString(), size: details.size.toString(),
    mtimeNs: details.mtimeNs.toString(), ctimeNs: details.ctimeNs.toString(),
  };
}
export function sameSourceFingerprint(left: SourceFingerprint, right: SourceFingerprint): boolean {
  return left.device === right.device && left.inode === right.inode && left.size === right.size &&
    left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}
export function workspaceSourceRevision(workspace: SessionWorkspaceScope, piAgentDirectory: string): string {
  return searchHash(JSON.stringify({
    workspaceId: workspace.id, canonicalPath: workspace.path,
    sessionStorage: workspace.sessionDirectory === null ? "pi-default" : "workspace",
    sessionStore: scopedSessionStorePath(workspace, piAgentDirectory), piAgentDirectory: path.resolve(piAgentDirectory),
  }));
}
function changed(): never { throw new SearchSourceError("search_source_changed"); }
function isInsideStore(store: string, file: string): boolean {
  const relative = path.relative(store, file);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
async function canonicalWorkspace(workspace: SessionWorkspaceScope): Promise<SessionWorkspaceScope> {
  try { return await requireCanonicalSessionWorkspace(workspace); }
  catch { throw new SearchSourceError("search_scope_unavailable"); }
}

/**
 * Cheap flat enumeration of the exact store, never Pi listing or a global scan.
 * No transcript/header reads here. Ownership is checked on every new/changed
 * stable snapshot. Unchanged files can later be skipped by fingerprint/revision.
 */
export async function discoverSessionFiles(workspace: SessionWorkspaceScope, piAgentDirectory: string, signal?: AbortSignal): Promise<SessionDiscovery> {
  signal?.throwIfAborted();
  const scope = await canonicalWorkspace(workspace);
  const storePath = scopedSessionStorePath(scope, piAgentDirectory);
  let storeDetails: BigIntStats;
  try {
    if (await realpath(storePath) !== storePath) throw new Error("store alias");
    storeDetails = await stat(storePath, { bigint: true });
    if (!storeDetails.isDirectory()) throw new Error("not directory");
  } catch { throw new SearchSourceError("search_scope_unavailable"); }
  const candidates: SessionFileCandidate[] = [];
  const seenPaths = new Set<string>();
  const errors: { path: string; code: SearchSourceError["code"] }[] = [];
  let complete = true;
  try {
    const directory = await opendir(storePath);
    for await (const entry of directory) {
      signal?.throwIfAborted();
      // Do not recurse or follow directory symlinks. File symlinks are allowed
      // only when their real target is a regular file inside this exact store.
      if (!entry.name.endsWith(".jsonl") || entry.isDirectory()) continue;
      const filePath = path.join(storePath, entry.name);
      if (seenPaths.size >= MAX_DISCOVERED_SESSION_FILES) {
        complete = false;
        errors.push({ path: storePath, code: "search_session_limit" });
        break;
      }
      seenPaths.add(filePath);
      try {
        const canonicalPath = await realpath(filePath);
        if (!isInsideStore(storePath, canonicalPath)) throw new SearchSourceError("search_session_invalid");
        const details = await stat(canonicalPath, { bigint: true });
        if (!details.isFile()) throw new SearchSourceError("search_session_invalid");
        candidates.push({
          workspaceId: scope.id, workspacePath: scope.path, piAgentDirectory: path.resolve(piAgentDirectory),
          path: filePath, canonicalPath, storePath, storeDevice: storeDetails.dev.toString(),
          storeInode: storeDetails.ino.toString(), fingerprint: sourceFingerprint(details),
        });
      } catch (error) {
        complete = false;
        errors.push({ path: filePath, code: error instanceof SearchSourceError ? error.code : "search_source_changed" });
      }
    }
    const after = await stat(storePath, { bigint: true });
    if (await realpath(storePath) !== storePath || !sameSourceFingerprint(sourceFingerprint(storeDetails), sourceFingerprint(after))) {
      complete = false;
      errors.push({ path: storePath, code: "search_source_changed" });
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    // Permission/iteration errors are not an authoritative empty enumeration.
    throw new SearchSourceError("search_scope_unavailable");
  }
  candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  signal?.throwIfAborted();
  return { storePath, storeFingerprint: sourceFingerprint(storeDetails), candidates, seenPaths, errors, complete };
}

export interface SnapshotHandle {
  stat(): Promise<BigIntStats>;
  read(buffer: Buffer): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}
export interface SnapshotFileSystem {
  open(file: string): Promise<SnapshotHandle>;
  stat(file: string): Promise<BigIntStats>;
  realpath(file: string): Promise<string>;
}
const nodeSnapshotFileSystem: SnapshotFileSystem = {
  async open(file) {
    // NOFOLLOW prevents a replaced canonical target from becoming a symlink;
    // NONBLOCK prevents a race replacing a regular file with a FIFO from hanging.
    const handle = await open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    return {
      stat: () => handle.stat({ bigint: true }),
      read: (buffer) => handle.read(buffer, 0, buffer.length, null),
      close: () => handle.close(),
    };
  },
  stat: (file) => stat(file, { bigint: true }),
  realpath,
};

/** Revalidate the enumeration witness before future absence pruning. */
export async function assertSessionDiscoveryCurrent(discovery: SessionDiscovery, fileSystem: SnapshotFileSystem = nodeSnapshotFileSystem): Promise<void> {
  if (!discovery.complete) return changed();
  try {
    if (await fileSystem.realpath(discovery.storePath) !== discovery.storePath) return changed();
    const details = await fileSystem.stat(discovery.storePath);
    if (!details.isDirectory() || !sameSourceFingerprint(discovery.storeFingerprint, sourceFingerprint(details))) return changed();
  } catch { return changed(); }
}

/** Recheck immediately before future publication, not only after file reads. */
export async function assertSessionSourceCurrent(candidate: SessionFileCandidate, fileSystem: SnapshotFileSystem = nodeSnapshotFileSystem): Promise<void> {
  try {
    if (!isInsideStore(candidate.storePath, candidate.canonicalPath) || !isInsideStore(candidate.storePath, candidate.path)) return changed();
    if (await fileSystem.realpath(candidate.storePath) !== candidate.storePath || await fileSystem.realpath(candidate.path) !== candidate.canonicalPath) return changed();
    const directory = await fileSystem.stat(candidate.storePath);
    const file = await fileSystem.stat(candidate.canonicalPath);
    if (!directory.isDirectory() || directory.dev.toString() !== candidate.storeDevice || directory.ino.toString() !== candidate.storeInode ||
        !file.isFile() || !sameSourceFingerprint(candidate.fingerprint, sourceFingerprint(file))) return changed();
  } catch { return changed(); }
}

export interface SnapshotOptions {
  readonly expectedSessionId?: string;
  readonly signal?: AbortSignal;
  /** Tests may tighten bounds; callers cannot raise the maintenance limits. */
  readonly maximumBytes?: number;
  readonly maximumRecordBytes?: number;
  readonly fileSystem?: SnapshotFileSystem;
}
function boundedLimit(value: number | undefined, maximum: number): number {
  if (value === undefined) return maximum;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new RangeError("Invalid snapshot limit");
  return value;
}

/** Bounded UTF-8/JSONL read with descriptor and path identity checks, no writes. */
export async function readSessionSnapshot(workspace: SessionWorkspaceScope, candidate: SessionFileCandidate, options: SnapshotOptions = {}): Promise<SessionSnapshot> {
  options.signal?.throwIfAborted();
  const scope = await canonicalWorkspace(workspace);
  if (candidate.workspaceId !== scope.id || candidate.workspacePath !== scope.path ||
      scopedSessionStorePath(scope, candidate.piAgentDirectory) !== candidate.storePath) return changed();
  const fileSystem = options.fileSystem ?? nodeSnapshotFileSystem;
  const maximumBytes = boundedLimit(options.maximumBytes, MAX_SESSION_SNAPSHOT_BYTES);
  const maximumRecordBytes = boundedLimit(options.maximumRecordBytes, MAX_SESSION_RECORD_BYTES);
  const extractor = new SessionExtractor(options.expectedSessionId);
  const hash = createHash("sha256");
  let handle: SnapshotHandle | undefined;
  try {
    options.signal?.throwIfAborted();
    await assertSessionSourceCurrent(candidate, fileSystem);
    handle = await fileSystem.open(candidate.canonicalPath);
    const before = await handle.stat();
    if (!before.isFile() || !sameSourceFingerprint(candidate.fingerprint, sourceFingerprint(before))) return changed();
    if (before.size > BigInt(maximumBytes)) throw new SearchSourceError("search_session_limit");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    let recordBytes = 0;
    let parts: Buffer[] = [];
    const appendPart = (part: Buffer) => {
      recordBytes += part.length;
      if (recordBytes > maximumRecordBytes) throw new SearchSourceError("search_session_limit");
      if (part.length > 0) parts.push(Buffer.from(part));
    };
    const emitRecord = async (trailing: boolean) => {
      let value: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(parts, recordBytes));
        parts = [];
        recordBytes = 0;
        // Blank separators are harmless, as with the SDK. Malformed records
        // are never skipped. A parseable final record need not have a newline.
        if (!text.trim()) return;
        value = JSON.parse(text) as unknown;
      } catch {
        throw new SearchSourceError(trailing ? "search_source_changed" : "search_session_invalid");
      }
      if (extractor.header === undefined && typeof value === "object" && value !== null) {
        const header = value as Record<string, unknown>;
        if (header.type === "session" && typeof header.cwd === "string" && header.cwd.trim()) {
          const ownership = await storedCwdOwnership(header.cwd, scope);
          if (ownership !== "owned") throw new SearchSourceError("search_session_invalid", ownership === "mismatch");
        }
      }
      extractor.append(value);
    };
    while (true) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer);
      options.signal?.throwIfAborted();
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maximumBytes) throw new SearchSourceError("search_session_limit");
      const read = buffer.subarray(0, bytesRead);
      hash.update(read);
      let start = 0;
      let newline = read.indexOf(10);
      while (newline !== -1) {
        appendPart(read.subarray(start, newline));
        await emitRecord(false);
        start = newline + 1;
        newline = read.indexOf(10, start);
      }
      appendPart(read.subarray(start));
    }
    if (recordBytes > 0) await emitRecord(true);
    options.signal?.throwIfAborted();
    const after = await handle.stat();
    if (!sameSourceFingerprint(sourceFingerprint(before), sourceFingerprint(after)) || BigInt(total) !== after.size) return changed();
    await assertSessionSourceCurrent(candidate, fileSystem);
    await canonicalWorkspace(scope);
    options.signal?.throwIfAborted();
    return { candidate, snapshotHash: hash.digest("hex"), session: extractor.finish() };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // If parse/limit failures occurred while another process wrote, defer rather
    // than diagnose a transient truncated file as a stable invalid conversation.
    if (handle !== undefined) {
      const details = await handle.stat().catch(() => undefined);
      if (details === undefined || !sameSourceFingerprint(candidate.fingerprint, sourceFingerprint(details))) return changed();
      await assertSessionSourceCurrent(candidate, fileSystem);
    }
    if (error instanceof SearchSourceError) throw error;
    return changed();
  } finally {
    try { await handle?.close(); }
    catch { if (!options.signal?.aborted) throw new SearchSourceError("search_source_changed"); }
  }
}
