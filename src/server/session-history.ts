import { unlink } from "node:fs/promises";
import { realpath } from "node:fs/promises";

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
import { inspectStoredCwd } from "./cwd.js";

const UNTITLED_CONVERSATION = "Untitled conversation";
const UNKNOWN_CWD = "(unknown working directory)";

export interface SessionHistoryIdentity {
  readonly id: string;
  readonly sessionFile: string;
}

/** Registry state needed to decorate history without coupling history to the registry. */
export type SessionHistoryLiveStatus = LiveConversationStatus;
export type SessionHistoryLiveStatusLookup = (
  identity: SessionHistoryIdentity,
) => SessionHistoryLiveStatus | undefined;

export interface SessionHistoryOptions {
  /** Omit to scan Pi's normal per-workspace session root. */
  readonly sessionDir?: string;
  /** Injectable listing boundary for focused tests. */
  readonly listSessions?: () => Promise<readonly SessionInfo[]>;
  /** A defined result means that the session currently owns a live runtime. */
  readonly getLiveStatus?: SessionHistoryLiveStatusLookup;
}

export interface ListedConversation {
  readonly info: SessionInfo;
  readonly summary: ConversationSummary;
}

export interface SessionHistorySnapshot {
  readonly conversations: readonly ConversationSummary[];
  /** Canonical paths from this exact Pi listing, used as the open/delete allow-set. */
  readonly allowedSessionFiles: ReadonlySet<string>;
}

interface HistoryIndex {
  readonly snapshot: SessionHistorySnapshot;
  readonly byId: ReadonlyMap<string, ListedConversation>;
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

/**
 * Pi-native session discovery and guarded deletion.
 *
 * This service only discovers sessions through SessionManager listing APIs. It
 * canonicalizes the files returned by that listing and never scans or parses
 * JSONL itself. Every open/delete resolution performs a fresh listing so an old
 * browser-provided path can never expand the allow-set.
 */
export class SessionHistory {
  readonly #listSessions: () => Promise<readonly SessionInfo[]>;
  readonly #getLiveStatus: SessionHistoryLiveStatusLookup;
  #latest: HistoryIndex = {
    snapshot: { conversations: [], allowedSessionFiles: new Set() },
    byId: new Map(),
  };

  constructor(options: SessionHistoryOptions = {}) {
    this.#listSessions =
      options.listSessions ??
      (options.sessionDir === undefined
        ? () => SessionManager.listAll()
        : () => SessionManager.listAll(options.sessionDir));
    this.#getLiveStatus = options.getLiveStatus ?? (() => undefined);
  }

  /** Return summaries from a fresh Pi listing, newest first. */
  async list(): Promise<readonly ConversationSummary[]> {
    return (await this.refresh()).conversations;
  }

  /** Refresh summaries and the canonical file allow-set as one snapshot. */
  async refresh(): Promise<SessionHistorySnapshot> {
    let sessions: readonly SessionInfo[];
    try {
      sessions = await this.#listSessions();
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }

    const listed = await Promise.all(
      sessions.map((info) => this.#normalizeListedSession(info)),
    );
    const available = listed.filter(
      (item): item is ListedConversation => item !== undefined,
    );
    available.sort(
      (left, right) => right.summary.modifiedAt - left.summary.modifiedAt,
    );

    const byId = new Map<string, ListedConversation>();
    const allowedSessionFiles = new Set<string>();
    for (const item of available) {
      // Session IDs are UUIDs in Pi. If corrupt history repeats an ID, retain
      // the newest item deterministically rather than changing selection order.
      if (!byId.has(item.summary.id)) byId.set(item.summary.id, item);
      allowedSessionFiles.add(item.summary.sessionFile);
    }

    const snapshot: SessionHistorySnapshot = {
      conversations: available.map(({ summary }) => summary),
      allowedSessionFiles,
    };
    this.#latest = { snapshot, byId };
    return snapshot;
  }

  /** Last completed snapshot; callers that need authorization must use resolve(). */
  get latest(): SessionHistorySnapshot {
    return this.#latest.snapshot;
  }

  /** Resolve a conversation through a fresh canonical Pi-listing allow-set. */
  async resolve(conversationId: string): Promise<ListedConversation> {
    await this.refresh();
    const listed = this.#latest.byId.get(conversationId);
    if (listed === undefined) {
      throw new AppError(ERROR_CODES.SESSION_NOT_LISTED);
    }
    return listed;
  }

  /**
   * Delete a currently listed, non-live Pi session and return refreshed history.
   * The path passed to unlink is the canonical path admitted by the fresh list.
   */
  async delete(
    conversationId: string,
  ): Promise<readonly ConversationSummary[]> {
    const listed = await this.resolve(conversationId);
    const identity = {
      id: listed.summary.id,
      sessionFile: listed.summary.sessionFile,
    };
    if (this.#getLiveStatus(identity) !== undefined) {
      throw new AppError(ERROR_CODES.LIVE_SESSION_DELETE);
    }

    try {
      await unlink(listed.summary.sessionFile);
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }

    return this.list();
  }

  async #normalizeListedSession(
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
    const liveStatus = this.#getLiveStatus({
      id: info.id,
      sessionFile: canonicalFile,
    });
    const createdAt = timestamp(info.created);
    const modifiedAt = timestamp(info.modified) ?? createdAt ?? 0;
    const summary: ConversationSummary = {
      id: info.id,
      sessionFile: canonicalFile,
      title: titleOf(info),
      cwd: info.cwd.trim() ? info.cwd : UNKNOWN_CWD,
      ...(createdAt === undefined ? {} : { createdAt }),
      modifiedAt,
      messageCount: Math.max(0, Math.trunc(info.messageCount)),
      status: summaryStatus(liveStatus),
      runnable: cwdInspection.runnable,
    };
    return { info, summary };
  }
}
