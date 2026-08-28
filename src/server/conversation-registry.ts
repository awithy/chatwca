import { realpath } from "node:fs/promises";
import path from "node:path";

import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import { AppError, ERROR_CODES, toAppError } from "../shared/errors.js";
import { nextRevision } from "../shared/revisions.js";
import type { LiveConversationStatus } from "../shared/protocol.js";
import type {
  PiConversationRuntimePort,
  PiRuntimeFactoryPort,
  PiRuntimeIdentity,
  PiRuntimeReplacement,
} from "./pi-runtime.js";

const UNTITLED_CONVERSATION = "Untitled conversation";

export type ConversationRegistrationSource = "create" | "open";

/** Mutable server-owned state for one live Pi runtime. */
export interface ConversationRecord {
  id: string;
  sessionFile: string;
  cwd: string;
  title: string;
  readonly runtime: PiConversationRuntimePort;
  session: AgentSession;
  status: LiveConversationStatus;
  readonly createdAt: number;
  lastActiveAt: number;
  revision: number;
  /** The registry-owned Pi event subscription. */
  unsubscribe: () => void;
}

export type ConversationRegistryEvent =
  | {
      readonly type: "conversation.registered";
      readonly source: ConversationRegistrationSource;
      readonly record: ConversationRecord;
    }
  | {
      readonly type: "conversation.session-event";
      readonly record: ConversationRecord;
      readonly event: AgentSessionEvent;
    }
  | {
      readonly type: "conversation.replaced";
      readonly record: ConversationRecord;
      readonly replacement: PiRuntimeReplacement;
    };

export type ConversationRegistryListener = (
  event: ConversationRegistryEvent,
) => void;

export interface ConversationRegistryOptions {
  readonly runtimeFactory: PiRuntimeFactoryPort;
  /** Injectable wall clock for deterministic ownership/LRU tests. */
  readonly now?: () => number;
  /** Registry observers are isolated from Pi callbacks; failures are reported here. */
  readonly onListenerError?: (error: unknown) => void;
}

function firstUserText(session: AgentSession): string | undefined {
  for (const entry of session.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;
    const { content } = entry.message;
    if (typeof content === "string") {
      const text = content.trim();
      if (text) return text;
      continue;
    }

    const text = content
      .filter(
        (block): block is Extract<(typeof content)[number], { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}

function titleOf(session: AgentSession): string {
  return (
    session.sessionManager.getSessionName()?.trim() ||
    firstUserText(session) ||
    UNTITLED_CONVERSATION
  );
}

function createdAtOf(session: AgentSession, fallback: number): number {
  const timestamp = session.sessionManager.getHeader()?.timestamp;
  if (timestamp === undefined) return fallback;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function safeNow(now: () => number): number {
  const value = now();
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError("Conversation registry clock must be non-negative");
  }
  return value;
}

function unresolvedCanonicalFile(sessionFile: string): Promise<string> {
  const absolute = path.resolve(sessionFile);
  return realpath(absolute).catch(async (error: unknown) => {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") throw error;

    // A new persistent Pi session has an identity before its JSONL file is
    // written. Canonicalizing its existing parent still prevents path aliases.
    const canonicalParent = await realpath(path.dirname(absolute));
    return path.join(canonicalParent, path.basename(absolute));
  });
}

async function canonicalFile(sessionFile: string): Promise<string> {
  try {
    return await unresolvedCanonicalFile(sessionFile);
  } catch (error) {
    throw toAppError(error, { source: "filesystem", target: "session" });
  }
}

/**
 * Process-wide owner of live conversation runtimes.
 *
 * Registration has no asynchronous gap between its duplicate check and index
 * insertion. Opens additionally share an in-flight promise by canonical file,
 * so concurrent callers cannot construct two writers for one Pi JSONL file.
 */
export class ConversationRegistry {
  readonly #runtimeFactory: PiRuntimeFactoryPort;
  readonly #now: () => number;
  readonly #onListenerError: (error: unknown) => void;
  readonly #byId = new Map<string, ConversationRecord>();
  readonly #bySessionFile = new Map<string, ConversationRecord>();
  readonly #pendingOpens = new Map<string, Promise<ConversationRecord>>();
  readonly #listeners = new Set<ConversationRegistryListener>();
  readonly #replacementUnsubscribes = new WeakMap<
    ConversationRecord,
    () => void
  >();

  constructor(options: ConversationRegistryOptions) {
    this.#runtimeFactory = options.runtimeFactory;
    this.#now = options.now ?? Date.now;
    this.#onListenerError = options.onListenerError ?? (() => undefined);
  }

  get size(): number {
    return this.#byId.size;
  }

  get records(): readonly ConversationRecord[] {
    return [...this.#byId.values()];
  }

  get(conversationId: string): ConversationRecord | undefined {
    return this.#byId.get(conversationId);
  }

  /** The input must already be canonical (as it is in SessionHistory). */
  getBySessionFile(sessionFile: string): ConversationRecord | undefined {
    return this.#bySessionFile.get(path.resolve(sessionFile));
  }

  subscribe(listener: ConversationRegistryListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async create(cwd: string): Promise<ConversationRecord> {
    const runtime = await this.#runtimeFactory.createPersistent(cwd);
    try {
      return await this.#register(runtime, "create");
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  async open(sessionFile: string): Promise<ConversationRecord> {
    const canonical = await canonicalFile(sessionFile);
    const existing = this.#bySessionFile.get(canonical);
    if (existing !== undefined) {
      this.#touch(existing);
      return existing;
    }

    const pending = this.#pendingOpens.get(canonical);
    if (pending !== undefined) return pending;

    const opening = this.#openAndRegister(canonical);
    this.#pendingOpens.set(canonical, opening);
    try {
      return await opening;
    } finally {
      if (this.#pendingOpens.get(canonical) === opening) {
        this.#pendingOpens.delete(canonical);
      }
    }
  }

  async #openAndRegister(canonical: string): Promise<ConversationRecord> {
    const runtime = await this.#runtimeFactory.openPersistent(canonical);
    try {
      return await this.#register(runtime, "open");
    } catch (error) {
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  async #register(
    runtime: PiConversationRuntimePort,
    source: ConversationRegistrationSource,
  ): Promise<ConversationRecord> {
    const identity = runtime.identity;
    const sessionFile = await canonicalFile(identity.sessionFile);
    const duplicate =
      this.#byId.get(identity.sessionId) ?? this.#bySessionFile.get(sessionFile);
    if (duplicate !== undefined) {
      await runtime.dispose();
      this.#touch(duplicate);
      return duplicate;
    }

    const now = safeNow(this.#now);
    const record: ConversationRecord = {
      id: identity.sessionId,
      sessionFile,
      cwd: path.resolve(identity.cwd),
      title: titleOf(runtime.session),
      runtime,
      session: runtime.session,
      status: runtime.session.isStreaming ? "streaming" : "idle",
      createdAt: createdAtOf(runtime.session, now),
      lastActiveAt: now,
      revision: 0,
      unsubscribe: () => undefined,
    };

    // No await is permitted between this final duplicate check and insertion.
    // It closes the race between create candidates whose identities only become
    // known after the factory has done its asynchronous work.
    const raced =
      this.#byId.get(record.id) ?? this.#bySessionFile.get(record.sessionFile);
    if (raced !== undefined) {
      await runtime.dispose();
      this.#touch(raced);
      return raced;
    }

    this.#byId.set(record.id, record);
    this.#bySessionFile.set(record.sessionFile, record);
    record.unsubscribe = runtime.subscribe((event) => {
      this.#touch(record);
      this.#emit({ type: "conversation.session-event", record, event });
    });
    this.#replacementUnsubscribes.set(
      record,
      runtime.onSessionReplaced((replacement) => {
        this.#replaceIdentity(record, replacement);
      }),
    );
    this.#emit({ type: "conversation.registered", source, record });
    return record;
  }

  #replaceIdentity(
    record: ConversationRecord,
    replacement: PiRuntimeReplacement,
  ): void {
    const current = record.runtime.identity;
    const sessionFile = path.resolve(current.sessionFile);
    const idOwner = this.#byId.get(current.sessionId);
    const fileOwner = this.#bySessionFile.get(sessionFile);
    if (
      (idOwner !== undefined && idOwner !== record) ||
      (fileOwner !== undefined && fileOwner !== record)
    ) {
      record.status = "error";
      throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    }

    if (this.#byId.get(record.id) === record) this.#byId.delete(record.id);
    if (this.#bySessionFile.get(record.sessionFile) === record) {
      this.#bySessionFile.delete(record.sessionFile);
    }

    record.id = current.sessionId;
    record.sessionFile = sessionFile;
    record.cwd = path.resolve(current.cwd);
    record.session = record.runtime.session;
    record.title = titleOf(record.session);
    record.revision = nextRevision(record.revision);
    this.#touch(record);
    this.#byId.set(record.id, record);
    this.#bySessionFile.set(record.sessionFile, record);
    this.#emit({ type: "conversation.replaced", record, replacement });
  }

  #touch(record: ConversationRecord): void {
    record.lastActiveAt = safeNow(this.#now);
  }

  #emit(event: ConversationRegistryEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#onListenerError(error);
      }
    }
  }
}
