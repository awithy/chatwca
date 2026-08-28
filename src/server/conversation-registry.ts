import { access, realpath } from "node:fs/promises";
import path from "node:path";

import type { AgentSession } from "@earendil-works/pi-coding-agent";

import { AppError, ERROR_CODES, toAppError } from "../shared/errors.js";
import { nextRevision } from "../shared/revisions.js";
import { DEFAULT_MAX_LIVE_CONVERSATIONS } from "./config.js";
import type {
  ConversationEvent,
  ConversationState,
  LiveConversationStatus,
  ModelInfo,
  QueueState,
} from "../shared/protocol.js";
import {
  PiEventNormalizer,
  type NormalizedPiEvent,
} from "./normalize-events.js";
import { serializeActiveBranch } from "./serialize.js";
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
  /** Whether Pi has materialized this session's JSONL file at least once. */
  durable: boolean;
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
      readonly type: "conversation.event";
      readonly record: ConversationRecord;
      readonly event: ConversationEvent;
    }
  | {
      readonly type: "conversation.replaced";
      readonly record: ConversationRecord;
      readonly replacement: PiRuntimeReplacement;
    }
  | {
      readonly type: "conversation.closed";
      readonly record: ConversationRecord;
      readonly reason: "close" | "evict" | "dispose";
    }
  | {
      readonly type: "conversation.state-changed";
      readonly record: ConversationRecord;
    };

export type ConversationRegistryListener = (
  event: ConversationRegistryEvent,
) => void;

export interface ConversationRegistryOptions {
  readonly runtimeFactory: PiRuntimeFactoryPort;
  /** Injectable wall clock for deterministic ownership/LRU tests. */
  readonly now?: () => number;
  /** Maximum number of runtime records owned at once. */
  readonly maxLiveConversations?: number;
  /** Registry observers are isolated from Pi callbacks; failures are reported here. */
  readonly onListenerError?: (error: unknown) => void;
  /** Refreshes the Pi-native history projection after lifecycle changes. */
  readonly refreshHistory?: () => void | Promise<void>;
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

function modelInfoOf(
  model: PiConversationRuntimePort["model"],
): ModelInfo | null {
  if (model === undefined) return null;
  return {
    id: model.id,
    provider: model.provider,
    ...(model.name.trim() ? { name: model.name } : {}),
    supportsImages: model.supportsImages,
  };
}

function queueOf(session: AgentSession): QueueState {
  return {
    steering: session.getSteeringMessages().map((text) => ({
      text,
      imageCount: 0,
    })),
    followUp: session.getFollowUpMessages().map((text) => ({
      text,
      imageCount: 0,
    })),
  };
}

function isBusy(record: ConversationRecord): boolean {
  return (
    record.status === "streaming" ||
    record.status === "aborting" ||
    record.session.isStreaming
  );
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
  readonly #maxLiveConversations: number;
  readonly #onListenerError: (error: unknown) => void;
  readonly #refreshHistoryCallback: () => void | Promise<void>;
  readonly #byId = new Map<string, ConversationRecord>();
  readonly #bySessionFile = new Map<string, ConversationRecord>();
  readonly #pendingOpens = new Map<string, Promise<ConversationRecord>>();
  readonly #pendingCloses = new WeakMap<ConversationRecord, Promise<void>>();
  readonly #listeners = new Set<ConversationRegistryListener>();
  readonly #replacementUnsubscribes = new WeakMap<
    ConversationRecord,
    () => void
  >();
  readonly #normalizers = new WeakMap<ConversationRecord, PiEventNormalizer>();
  #capacityReservations = 0;
  #capacityTail = Promise.resolve();
  #disposePromise: Promise<void> | undefined;

  constructor(options: ConversationRegistryOptions) {
    this.#runtimeFactory = options.runtimeFactory;
    this.#now = options.now ?? Date.now;
    this.#maxLiveConversations =
      options.maxLiveConversations ?? DEFAULT_MAX_LIVE_CONVERSATIONS;
    if (
      !Number.isSafeInteger(this.#maxLiveConversations) ||
      this.#maxLiveConversations <= 0
    ) {
      throw new RangeError("maxLiveConversations must be a positive integer");
    }
    this.#onListenerError = options.onListenerError ?? (() => undefined);
    this.#refreshHistoryCallback = options.refreshHistory ?? (() => undefined);
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
    const releaseCapacity = await this.#reserveCapacity();
    let runtime: PiConversationRuntimePort | undefined;
    try {
      runtime = await this.#runtimeFactory.createPersistent(cwd);
      const record = await this.#register(runtime, "create");
      await this.#refreshHistory();
      return record;
    } catch (error) {
      await runtime?.dispose().catch(() => undefined);
      throw error;
    } finally {
      releaseCapacity();
    }
  }

  async open(sessionFile: string): Promise<ConversationRecord> {
    let canonical: string;
    try {
      canonical = await canonicalFile(sessionFile);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === ERROR_CODES.SESSION_FILE_MISSING
      ) {
        await this.#refreshHistory();
      }
      throw error;
    }

    const existing = this.#bySessionFile.get(canonical);
    if (existing !== undefined) {
      const closing = this.#pendingCloses.get(existing);
      if (closing !== undefined) {
        await closing;
        return this.open(canonical);
      }
      this.#touch(existing);
      return existing;
    }

    const pending = this.#pendingOpens.get(canonical);
    if (pending !== undefined) return pending;

    const opening = this.#openAndRegister(canonical);
    this.#pendingOpens.set(canonical, opening);
    try {
      const record = await opening;
      await this.#refreshHistory();
      return record;
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === ERROR_CODES.SESSION_FILE_MISSING
      ) {
        await this.#refreshHistory();
      }
      throw error;
    } finally {
      if (this.#pendingOpens.get(canonical) === opening) {
        this.#pendingOpens.delete(canonical);
      }
    }
  }

  /** Build an authoritative snapshot and update access/LRU bookkeeping. */
  async getState(conversationId: string): Promise<ConversationState> {
    const record = this.#required(conversationId);
    if (this.#pendingCloses.has(record)) {
      throw new AppError(ERROR_CODES.CONVERSATION_BUSY);
    }

    await this.#refreshDurability(record);
    this.#touch(record);
    return {
      id: record.id,
      sessionFile: record.sessionFile,
      title: record.title,
      cwd: record.cwd,
      model: modelInfoOf(record.runtime.model),
      status: record.status,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      revision: record.revision,
      durable: record.durable,
      messages: serializeActiveBranch(record.session.sessionManager),
      queue: queueOf(record.session),
    };
  }

  /** Request cancellation of an active run. Repeated idle aborts are no-ops. */
  async abort(conversationId: string): Promise<void> {
    const record = this.#required(conversationId);
    if (!isBusy(record)) return;
    if (record.status !== "aborting") {
      this.#emitConversationEvent(record, {
        type: "conversation.status",
        payload: { status: "aborting" },
      });
    }

    try {
      await record.runtime.abort();
      // Pi normally emits agent_end before abort() resolves. Keep the registry
      // deterministic if an injected/custom runtime does not emit lifecycle.
      if (record.status === "aborting") {
        this.#emitConversationEvent(record, {
          type: "conversation.status",
          payload: { status: "idle" },
        });
      }
    } catch (error) {
      this.#handleRuntimeFailure(record, error);
      throw toAppError(error, { source: "internal" });
    }
  }

  /** Close one idle/error conversation while retaining its persisted history. */
  async close(conversationId: string): Promise<void> {
    const record = this.#required(conversationId);
    if (isBusy(record)) {
      throw new AppError(ERROR_CODES.CONVERSATION_BUSY);
    }
    await this.#disposeRecord(record, "close");
  }

  /** Dispose every owned runtime. Active runs are allowed for shutdown cleanup. */
  dispose(): Promise<void> {
    this.#disposePromise ??= (async () => {
      await Promise.allSettled(
        this.records.map((record) => this.#disposeRecord(record, "dispose")),
      );
      await this.#refreshHistory();
    })();
    return this.#disposePromise;
  }

  async #openAndRegister(canonical: string): Promise<ConversationRecord> {
    const releaseCapacity = await this.#reserveCapacity();
    let runtime: PiConversationRuntimePort | undefined;
    try {
      runtime = await this.#runtimeFactory.openPersistent(canonical);
      return await this.#register(runtime, "open");
    } catch (error) {
      await runtime?.dispose().catch(() => undefined);
      throw error;
    } finally {
      releaseCapacity();
    }
  }

  /**
   * Reserve a slot before constructing a runtime. Capacity decisions are
   * serialized and in-flight constructions count toward the limit, preventing
   * concurrent create/open requests from temporarily exceeding it.
   */
  async #reserveCapacity(): Promise<() => void> {
    let unlock: () => void = () => undefined;
    const previous = this.#capacityTail;
    this.#capacityTail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;

    try {
      while (
        this.#byId.size + this.#capacityReservations >=
        this.#maxLiveConversations
      ) {
        const candidate = this.#leastRecentlyUsedIdle();
        if (candidate === undefined) {
          throw new AppError(ERROR_CODES.LIVE_RUNTIME_LIMIT);
        }
        await this.#disposeRecord(candidate, "evict");
      }

      this.#capacityReservations += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.#capacityReservations -= 1;
      };
    } finally {
      unlock();
    }
  }

  #leastRecentlyUsedIdle(): ConversationRecord | undefined {
    let candidate: ConversationRecord | undefined;
    for (const record of this.#byId.values()) {
      if (
        record.status !== "idle" ||
        record.session.isStreaming ||
        this.#pendingCloses.has(record)
      ) {
        continue;
      }
      if (
        candidate === undefined ||
        record.lastActiveAt < candidate.lastActiveAt ||
        (record.lastActiveAt === candidate.lastActiveAt &&
          (record.createdAt < candidate.createdAt ||
            (record.createdAt === candidate.createdAt &&
              record.id.localeCompare(candidate.id) < 0)))
      ) {
        candidate = record;
      }
    }
    return candidate;
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
      durable: source === "open",
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
    this.#normalizers.set(record, this.#createNormalizer(record));
    record.unsubscribe = runtime.subscribe((event) => {
      this.#touch(record);
      try {
        this.#normalizers.get(record)?.handle(event);
      } catch (error) {
        this.#handleRuntimeFailure(record, error);
      }
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

  #required(conversationId: string): ConversationRecord {
    const record = this.#byId.get(conversationId);
    if (record === undefined) {
      throw new AppError(ERROR_CODES.CONVERSATION_NOT_FOUND);
    }
    return record;
  }

  async #refreshDurability(record: ConversationRecord): Promise<void> {
    let exists = true;
    try {
      await access(record.sessionFile);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") {
        throw toAppError(error, { source: "filesystem", target: "session" });
      }
      exists = false;
    }

    if (!exists && record.durable) {
      if (record.status !== "error") {
        record.status = "error";
        record.revision = nextRevision(record.revision);
        this.#emit({ type: "conversation.state-changed", record });
      }
      await this.#refreshHistory();
      throw new AppError(ERROR_CODES.SESSION_FILE_MISSING);
    }

    const currentTitle = titleOf(record.session);
    const changed =
      currentTitle !== record.title || (exists && !record.durable);
    if (!changed) return;

    record.title = currentTitle;
    if (exists) record.durable = true;
    record.revision = nextRevision(record.revision);
    this.#emit({ type: "conversation.state-changed", record });
    await this.#refreshHistory();
  }

  #disposeRecord(
    record: ConversationRecord,
    reason: "close" | "evict" | "dispose",
  ): Promise<void> {
    const existing = this.#pendingCloses.get(record);
    if (existing !== undefined) return existing;

    const closing = (async () => {
      let disposalError: unknown;
      record.unsubscribe();
      record.unsubscribe = () => undefined;
      this.#normalizers.get(record)?.dispose();
      this.#normalizers.delete(record);
      this.#replacementUnsubscribes.get(record)?.();
      this.#replacementUnsubscribes.delete(record);

      try {
        await record.runtime.dispose();
      } catch (error) {
        disposalError = error;
      } finally {
        if (this.#byId.get(record.id) === record) this.#byId.delete(record.id);
        if (this.#bySessionFile.get(record.sessionFile) === record) {
          this.#bySessionFile.delete(record.sessionFile);
        }
        this.#emit({ type: "conversation.closed", record, reason });
        if (reason !== "dispose") await this.#refreshHistory();
      }

      if (disposalError !== undefined) {
        throw toAppError(disposalError, { source: "internal" });
      }
    })();
    this.#pendingCloses.set(record, closing);
    return closing;
  }

  async #refreshHistory(): Promise<void> {
    try {
      await this.#refreshHistoryCallback();
    } catch (error) {
      this.#onListenerError(error);
    }
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
    this.#normalizers.get(record)?.dispose();
    this.#normalizers.set(record, this.#createNormalizer(record));
    record.revision = nextRevision(record.revision);
    this.#touch(record);
    this.#byId.set(record.id, record);
    this.#bySessionFile.set(record.sessionFile, record);
    this.#emit({ type: "conversation.replaced", record, replacement });
  }

  #createNormalizer(record: ConversationRecord): PiEventNormalizer {
    return new PiEventNormalizer({
      sessionId: record.id,
      getSession: () => record.session,
      emit: (event) => this.#emitConversationEvent(record, event),
      onMessagePersisted: (message) => this.#messagePersisted(record, message),
      onMetadataChanged: () => this.#metadataChanged(record),
    });
  }

  #emitConversationEvent(
    record: ConversationRecord,
    event: NormalizedPiEvent,
  ): void {
    if (this.#byId.get(record.id) !== record || this.#pendingCloses.has(record)) {
      return;
    }

    if (event.type === "conversation.status") {
      if (record.status === event.payload.status) return;
      record.status = event.payload.status;
    }

    record.revision = nextRevision(record.revision);
    this.#touch(record);
    this.#emit({
      type: "conversation.event",
      record,
      event: {
        ...event,
        conversationId: record.id,
        revision: record.revision,
      } as ConversationEvent,
    });
  }

  #messagePersisted(record: ConversationRecord, message: unknown): void {
    if (this.#byId.get(record.id) !== record || this.#pendingCloses.has(record)) {
      return;
    }
    const source =
      typeof message === "object" && message !== null
        ? (message as { readonly role?: unknown })
        : undefined;
    const title = titleOf(record.session);
    const becameDurable = source?.role === "assistant" && !record.durable;
    if (title === record.title && !becameDurable) return;

    record.title = title;
    if (becameDurable) record.durable = true;
    record.revision = nextRevision(record.revision);
    this.#emit({ type: "conversation.state-changed", record });
    void this.#refreshHistory();
  }

  #metadataChanged(record: ConversationRecord): void {
    if (this.#byId.get(record.id) !== record || this.#pendingCloses.has(record)) {
      return;
    }
    const title = titleOf(record.session);
    if (title === record.title) return;
    record.title = title;
    record.revision = nextRevision(record.revision);
    this.#emit({ type: "conversation.state-changed", record });
    void this.#refreshHistory();
  }

  #handleRuntimeFailure(record: ConversationRecord, error: unknown): void {
    this.#onListenerError(error);
    if (record.status === "error" || this.#byId.get(record.id) !== record) return;
    this.#emitConversationEvent(record, {
      type: "conversation.status",
      payload: { status: "error" },
    });
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
