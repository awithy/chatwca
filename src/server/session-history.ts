import { unlink } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  SessionManager,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";

import {
  AppError,
  ERROR_CODES,
  toAppError,
} from "../shared/errors.js";
import type {
  ConversationSummary,
  LiveConversationStatus,
} from "../shared/protocol.js";
import { inspectStoredCwd, resolveConversationCwd } from "./cwd.js";

const UNTITLED_CONVERSATION = "Untitled conversation";

/** A repository-resolved workspace whose path was canonical and available. */
export interface SessionHistoryWorkspace {
  readonly id: string;
  readonly path: string;
}

export interface SessionHistoryIdentity {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionFile: string;
}

/** Registry state needed to decorate history without coupling history to the registry. */
export type SessionHistoryLiveStatus = LiveConversationStatus;
export interface SessionHistoryLiveRecord {
  readonly workspaceId: string;
  readonly status: SessionHistoryLiveStatus;
}
/** Return only a live record matching the supplied session ID or canonical file. */
export type SessionHistoryLiveStatusLookup = (
  identity: SessionHistoryIdentity,
) => SessionHistoryLiveRecord | undefined;

export interface SessionHistoryOptions {
  /** Optional Pi session root, primarily used by isolated integration tests. */
  readonly sessionDir?: string;
  /** Injectable workspace-scoped Pi listing boundary for focused tests. */
  readonly listSessions?: (cwd: string) => Promise<readonly SessionInfo[]>;
  /** A defined result means that this workspace owns the matching live runtime. */
  readonly getLiveStatus?: SessionHistoryLiveStatusLookup;
}

export interface ListedConversation {
  readonly info: SessionInfo;
  readonly summary: ConversationSummary;
}

export interface SessionHistorySnapshot {
  readonly conversations: readonly ConversationSummary[];
  /** Canonical paths from this exact scoped listing, used as the open/delete allow-set. */
  readonly allowedSessionFiles: ReadonlySet<string>;
}

interface HistoryIndex {
  readonly snapshot: SessionHistorySnapshot;
  readonly byId: ReadonlyMap<string, ListedConversation>;
}

function emptyIndex(): HistoryIndex {
  return {
    snapshot: { conversations: [], allowedSessionFiles: new Set() },
    byId: new Map(),
  };
}

function timestamp(date: Date): number | undefined {
  const value = date.getTime();
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function titleOf(info: SessionInfo): string {
  const explicitName = info.name?.trim();
  if (explicitName) return explicitName;

  // Pi uses this literal when no user text exists. It is listing metadata, not
  // a title selected by the user, so do not expose it as a conversation name.
  const firstPrompt = info.firstMessage.trim();
  return firstPrompt && firstPrompt !== "(no messages)"
    ? firstPrompt
    : UNTITLED_CONVERSATION;
}

function summaryStatus(
  liveStatus: SessionHistoryLiveStatus | undefined,
): ConversationSummary["status"] {
  if (liveStatus === undefined) return "closed";
  // Aborting remains an active run in history even though summaries intentionally
  // expose the smaller closed/idle/streaming/error state set.
  return liveStatus === "aborting" ? "streaming" : liveStatus;
}

function compareListed(
  left: ListedConversation,
  right: ListedConversation,
): number {
  const modified = right.summary.modifiedAt - left.summary.modifiedAt;
  if (modified !== 0) return modified;
  const id = left.summary.id.localeCompare(right.summary.id);
  if (id !== 0) return id;
  return left.summary.sessionFile.localeCompare(right.summary.sessionFile);
}

/**
 * Pi-native, strictly workspace-scoped session discovery and guarded deletion.
 *
 * Every operation requires an available canonical workspace. Every open/delete
 * authorization performs a fresh SessionManager.list(workspace.path), verifies
 * each listed session's canonical stored CWD, and admits only canonical files
 * from that exact result. No global Pi history listing is used.
 */
export class SessionHistory {
  readonly #listSessions: (cwd: string) => Promise<readonly SessionInfo[]>;
  readonly #getLiveStatus: SessionHistoryLiveStatusLookup;
  readonly #latestByWorkspace = new Map<string, HistoryIndex>();

  constructor(options: SessionHistoryOptions = {}) {
    this.#listSessions =
      options.listSessions ??
      ((cwd) => SessionManager.list(cwd, options.sessionDir));
    this.#getLiveStatus = options.getLiveStatus ?? (() => undefined);
  }

  /** Return summaries from a fresh workspace-scoped Pi listing, newest first. */
  async list(
    workspace: SessionHistoryWorkspace,
  ): Promise<readonly ConversationSummary[]> {
    return (await this.#refreshIndex(workspace)).snapshot.conversations;
  }

  /** Refresh one workspace's summaries and canonical file allow-set atomically. */
  async refresh(
    workspace: SessionHistoryWorkspace,
  ): Promise<SessionHistorySnapshot> {
    return (await this.#refreshIndex(workspace)).snapshot;
  }

  /** Last completed snapshot for one workspace; never use this for authorization. */
  latest(workspaceId: string): SessionHistorySnapshot {
    return (this.#latestByWorkspace.get(workspaceId) ?? emptyIndex()).snapshot;
  }

  /** Resolve a conversation through a fresh scoped canonical Pi-listing allow-set. */
  async resolve(
    workspace: SessionHistoryWorkspace,
    conversationId: string,
  ): Promise<ListedConversation> {
    const index = await this.#refreshIndex(workspace);
    const listed = index.byId.get(conversationId);
    if (listed === undefined) {
      throw new AppError(ERROR_CODES.SESSION_NOT_LISTED);
    }
    return listed;
  }

  /**
   * Delete a freshly listed, non-live Pi session and return refreshed scoped history.
   * The path passed to unlink is the canonical path admitted by that fresh list.
   */
  async delete(
    workspace: SessionHistoryWorkspace,
    conversationId: string,
  ): Promise<readonly ConversationSummary[]> {
    const listed = await this.resolve(workspace, conversationId);
    const identity = {
      id: listed.summary.id,
      workspaceId: workspace.id,
      sessionFile: listed.summary.sessionFile,
    };
    // Block deletion of a matching live writer even if inconsistent registry
    // ownership is detected; decoration below is stricter and requires agreement.
    if (this.#getLiveStatus(identity) !== undefined) {
      throw new AppError(ERROR_CODES.LIVE_SESSION_DELETE);
    }

    try {
      await unlink(listed.summary.sessionFile);
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }

    return this.list(workspace);
  }

  async #refreshIndex(
    workspace: SessionHistoryWorkspace,
  ): Promise<HistoryIndex> {
    const canonicalWorkspace = await this.#requireCanonicalWorkspace(workspace);
    let sessions: readonly SessionInfo[];
    try {
      sessions = await this.#listSessions(canonicalWorkspace.path);
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }

    const listed = await Promise.all(
      sessions.map((info) =>
        this.#normalizeListedSession(canonicalWorkspace, info)
      ),
    );
    const available = listed.filter(
      (item): item is ListedConversation => item !== undefined,
    );
    available.sort(compareListed);

    const byId = new Map<string, ListedConversation>();
    const allowedSessionFiles = new Set<string>();
    const conversations: ConversationSummary[] = [];
    for (const item of available) {
      // Session IDs are UUIDs in Pi. If corrupt history repeats an ID, retain
      // only the deterministic newest item in both the projection and allow-map.
      if (byId.has(item.summary.id)) continue;
      byId.set(item.summary.id, item);
      allowedSessionFiles.add(item.summary.sessionFile);
      conversations.push(item.summary);
    }

    const index: HistoryIndex = {
      snapshot: { conversations, allowedSessionFiles },
      byId,
    };
    this.#latestByWorkspace.set(workspace.id, index);
    return index;
  }

  async #requireCanonicalWorkspace(
    workspace: SessionHistoryWorkspace,
  ): Promise<SessionHistoryWorkspace> {
    try {
      const canonicalPath = await resolveConversationCwd(workspace.path);
      if (path.resolve(canonicalPath) !== path.resolve(workspace.path)) {
        throw new Error("Workspace path was not canonical");
      }
      return { id: workspace.id, path: canonicalPath };
    } catch (error) {
      throw new AppError(ERROR_CODES.WORKSPACE_UNAVAILABLE, { cause: error });
    }
  }

  async #normalizeListedSession(
    workspace: SessionHistoryWorkspace,
    info: SessionInfo,
  ): Promise<ListedConversation | undefined> {
    let canonicalFile: string;
    try {
      // A listing/open race removes the item from this allow-set. It will either
      // reappear on a later refresh or resolve() will return session_not_listed.
      canonicalFile = await realpath(info.path);
    } catch {
      return undefined;
    }

    const cwdInspection = await inspectStoredCwd(info.cwd);
    if (
      !cwdInspection.runnable ||
      path.resolve(cwdInspection.canonicalCwd) !== path.resolve(workspace.path)
    ) {
      // SessionManager.list() is treated as discovery, not authority. A corrupt
      // or injected cross-workspace result cannot enter this workspace's cache.
      return undefined;
    }

    const liveRecord = this.#getLiveStatus({
      id: info.id,
      workspaceId: workspace.id,
      sessionFile: canonicalFile,
    });
    const liveStatus =
      liveRecord?.workspaceId === workspace.id
        ? liveRecord.status
        : undefined;
    const createdAt = timestamp(info.created);
    const modifiedAt = timestamp(info.modified) ?? createdAt ?? 0;
    const summary: ConversationSummary = {
      id: info.id,
      workspaceId: workspace.id,
      sessionFile: canonicalFile,
      title: titleOf(info),
      cwd: info.cwd,
      ...(createdAt === undefined ? {} : { createdAt }),
      modifiedAt,
      messageCount: Math.max(0, Math.trunc(info.messageCount)),
      status: summaryStatus(liveStatus),
      runnable: true,
    };
    return { info, summary };
  }
}
