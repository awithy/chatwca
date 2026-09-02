import { access, readFile, realpath, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type {
  AgentSession,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";

import { AppError, ERROR_CODES, toAppError } from "../shared/errors.js";
import { nextRevision } from "../shared/revisions.js";
import {
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGES,
  DEFAULT_MAX_LIVE_CONVERSATIONS,
  DEFAULT_MAX_TOTAL_IMAGE_BYTES,
} from "./config.js";
import {
  MAX_CONVERSATION_TITLE_LENGTH,
  NETWORK_POLICY_SET_ID_MAX_LENGTH,
  NETWORK_POLICY_SET_ID_PATTERN,
} from "../shared/protocol.js";
import type {
  AssistantMessage,
  ConversationEvent,
  ConversationOwner,
  ConversationState,
  ImageMimeType,
  LiveConversationStatus,
  ModelInfo,
  NetworkBlockedPayload,
  QueueState,
  UiImage,
  SandboxNetworkPolicy,
  WorkspaceSecurityProfile,
} from "../shared/protocol.js";
import {
  PiEventNormalizer,
  type NormalizedPiEvent,
} from "./normalize-events.js";
import {
  validatePromptImages,
  type ImageValidationLimits,
} from "./images.js";
import { isActiveBranchUserEntry } from "./fork-target.js";
import {
  conversationImageUrl,
  type ConversationImage,
} from "./conversation-images.js";
import {
  serializeActiveBranch,
  serializeSessionContextUsage,
} from "./serialize.js";
import type {
  PiConversationRuntimePort,
  PiRuntimeFactoryPort,
  PiRuntimeIdentity,
  PiRuntimeReplacement,
} from "./pi-runtime.js";
import type { NetworkBlockedNotification } from "./network/audit.js";
import type { RuntimeWorkspacePolicy } from "./workspace-repository.js";
import {
  DEFAULT_NETWORK_POLICY_SET_ID,
  type CompiledNetworkPolicySet,
} from "./network/config.js";

const UNTITLED_CONVERSATION = "Untitled conversation";

type RegistryConversationEvent = NormalizedPiEvent | {
  readonly type: "network.blocked";
  readonly payload: NetworkBlockedPayload;
};

export type ConversationRegistrationSource = "create" | "open" | "fork" | "job";

/** Opaque reservation counted against the process-global live-runtime limit. */
export interface RuntimeCapacityLease {
  /** Convert this reservation into one registered runtime. Idempotent. */
  promote(): void;
  /** Release an unpromoted reservation. Idempotent. */
  release(): void;
}

export type JobPromptCompletion =
  | { readonly kind: "succeeded"; readonly assistant: AssistantMessage }
  | { readonly kind: "failed"; readonly assistant: AssistantMessage }
  | { readonly kind: "aborted"; readonly assistant?: AssistantMessage }
  | { readonly kind: "runtime-failure"; readonly error: AppError };

export type JobConversationAbortListener = (owner: ConversationOwner) => void;

/** Repository-resolved, canonical ownership supplied by trusted server code. */
export type ConversationWorkspace = Readonly<RuntimeWorkspacePolicy>;

/**
 * A slot held for T9.2's source-preserving fork construction. The caller must
 * release it in a `finally` block after promoting or disposing the temporary
 * runtime. No Pi fork operation is performed by this T9.1 interface.
 */
export interface ForkCapacityReservation {
  readonly sourceConversationId: string;
  readonly sourceSessionFile: string;
  readonly sourceCwd: string;
  /** Convert the temporary-runtime slot to registered ownership. */
  promote(): void;
  /** Release any remaining capacity and source protection. */
  release(): void;
}

export interface ForkConversationResult {
  readonly conversation: ConversationState;
  readonly editorText: string;
}

/** Mutable server-owned state for one live Pi runtime. */
export interface ConversationRecord {
  id: string;
  /** Immutable ChatWCA ownership, independent of replaceable Pi identity. */
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly sessionDirectory: string | null;
  readonly securityProfile: WorkspaceSecurityProfile;
  readonly networkPolicy: SandboxNetworkPolicy | null;
  readonly networkPolicySetId: string;
  readonly effectiveNetworkPolicySetId: string | null;
  /** Exact immutable compiled grant owned by this live runtime. Never projected. */
  readonly networkPolicySet: Readonly<CompiledNetworkPolicySet> | null;
  /** Live trusted-service ownership. It is attached before registration emits. */
  readonly owner?: ConversationOwner;
  /** Locks terminal runtime failures against later Pi idle events. */
  runtimeFailureTerminal: boolean;
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
  /** Authoritative decoded image limits applied before prompts reach Pi. */
  readonly imageLimits?: Readonly<ImageValidationLimits>;
  /** Registry observers are isolated from Pi callbacks; failures are reported here. */
  readonly onListenerError?: (error: unknown) => void;
  /** Refreshes the Pi-native history projection after lifecycle changes. */
  readonly refreshHistory?: (workspaceId: string) => void | Promise<void>;
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
  readonly #imageLimits: Readonly<ImageValidationLimits>;
  readonly #onListenerError: (error: unknown) => void;
  readonly #refreshHistoryCallback: (workspaceId: string) => void | Promise<void>;
  readonly #byId = new Map<string, ConversationRecord>();
  readonly #bySessionFile = new Map<string, ConversationRecord>();
  readonly #pendingOpens = new Map<string, Promise<ConversationRecord>>();
  readonly #pendingCloses = new WeakMap<ConversationRecord, Promise<void>>();
  readonly #pendingAborts = new WeakMap<ConversationRecord, Promise<void>>();
  readonly #forkSourceReservations = new WeakMap<ConversationRecord, number>();
  /** Fork runtimes exist before registration and must still be owned at shutdown. */
  readonly #temporaryRuntimes = new Set<PiConversationRuntimePort>();
  readonly #listeners = new Set<ConversationRegistryListener>();
  readonly #replacementUnsubscribes = new WeakMap<
    ConversationRecord,
    () => void
  >();
  readonly #fatalUnsubscribes = new WeakMap<ConversationRecord, () => void>();
  readonly #blockedUnsubscribes = new WeakMap<ConversationRecord, () => void>();
  readonly #normalizers = new WeakMap<ConversationRecord, PiEventNormalizer>();
  readonly #capacityLeases = new WeakMap<RuntimeCapacityLease, {
    state: "reserved" | "promoted" | "released";
    readonly releaseCapacity: () => void;
  }>();
  readonly #jobAbortListeners = new Set<JobConversationAbortListener>();
  readonly #jobAbortRequested = new WeakSet<ConversationRecord>();
  #capacityReservations = 0;
  #capacityTail = Promise.resolve();
  #shuttingDown = false;
  #abortActivePromise: Promise<void> | undefined;
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
    this.#imageLimits = options.imageLimits ?? {
      maxImages: DEFAULT_MAX_IMAGES,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      maxTotalImageBytes: DEFAULT_MAX_TOTAL_IMAGE_BYTES,
    };
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

  hasLiveWorkspace(workspaceId: string): boolean {
    for (const record of this.#byId.values()) {
      if (record.workspaceId === workspaceId) return true;
    }
    return false;
  }

  subscribe(listener: ConversationRegistryListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Observe browser/operator aborts of active job-owned conversations. */
  subscribeJobAborts(listener: JobConversationAbortListener): () => void {
    this.#jobAbortListeners.add(listener);
    return () => this.#jobAbortListeners.delete(listener);
  }

  /** Return only the safe live owner identifiers. */
  getActiveOwner(conversationId: string): ConversationOwner | undefined {
    return this.#byId.get(conversationId)?.owner;
  }

  get shuttingDown(): boolean {
    return this.#shuttingDown;
  }

  /** Close the runtime-work admission boundary synchronously. */
  beginShutdown(): void {
    this.#shuttingDown = true;
  }

  /** Abort all sessions active when shutdown begins; repeated calls coalesce. */
  abortActive(): Promise<void> {
    this.beginShutdown();
    this.#abortActivePromise ??= Promise.allSettled(
      this.records.filter(isBusy).map((record) => this.abort(record.id)),
    ).then(() => undefined);
    return this.#abortActivePromise;
  }

  /** Reserve capacity before a job performs any host-side hook effects. */
  async reserveRuntimeCapacity(): Promise<RuntimeCapacityLease> {
    this.#assertAcceptingWork();
    const releaseCapacity = await this.#reserveCapacity();
    let lease!: RuntimeCapacityLease;
    lease = Object.freeze({
      promote: () => this.#settleCapacityLease(lease, "promoted"),
      release: () => this.#settleCapacityLease(lease, "released"),
    });
    this.#capacityLeases.set(lease, { state: "reserved", releaseCapacity });
    return lease;
  }

  /**
   * Consume a capacity lease and atomically register a fresh persistent runtime
   * with its scheduled-run owner before observers can see it.
   */
  async createJobConversation(
    workspace: ConversationWorkspace,
    ownerInput: ConversationOwner,
    lease: RuntimeCapacityLease,
  ): Promise<ConversationRecord> {
    this.#assertAcceptingWork();
    const ownership = this.#normalizePolicy(workspace);
    const owner = this.#normalizeOwner(ownerInput);
    this.#requireReservedLease(lease);
    let runtime: PiConversationRuntimePort | undefined;
    try {
      runtime = await this.#runtimeFactory.createPersistent(ownership);
      this.#assertAcceptingWork();
      const record = await this.#register(
        runtime,
        ownership,
        "job",
        () => lease.promote(),
        owner,
      );
      await this.#refreshHistory(record.workspaceId);
      return record;
    } catch (error) {
      lease.release();
      if (runtime !== undefined && !runtime.disposed) {
        await this.#disposeRuntime(runtime).catch(() => undefined);
      }
      throw error;
    }
  }

  async create(workspace: ConversationWorkspace): Promise<ConversationRecord> {
    this.#assertAcceptingWork();
    const ownership = this.#normalizePolicy(workspace);
    const releaseCapacity = await this.#reserveCapacity();
    let runtime: PiConversationRuntimePort | undefined;
    try {
      runtime = await this.#runtimeFactory.createPersistent(ownership);
      this.#assertAcceptingWork();
      const record = await this.#register(runtime, ownership, "create");
      await this.#refreshHistory(record.workspaceId);
      return record;
    } catch (error) {
      if (runtime !== undefined) {
        await this.#disposeRuntime(runtime).catch(() => undefined);
      }
      throw error;
    } finally {
      releaseCapacity();
    }
  }

  async open(
    workspace: ConversationWorkspace,
    sessionFile: string,
  ): Promise<ConversationRecord> {
    this.#assertAcceptingWork();
    const ownership = this.#normalizePolicy(workspace);
    let canonical: string;
    try {
      canonical = await canonicalFile(sessionFile);
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === ERROR_CODES.SESSION_FILE_MISSING
      ) {
        await this.#refreshHistory(ownership.workspaceId);
      }
      throw error;
    }

    this.#assertAcceptingWork();
    const existing = this.#bySessionFile.get(canonical);
    if (existing !== undefined) {
      const closing = this.#pendingCloses.get(existing);
      if (closing !== undefined) {
        await closing;
        return this.open(ownership, canonical);
      }
      this.#assertWorkspaceOwner(existing, ownership);
      this.#touch(existing);
      return existing;
    }

    const pending = this.#pendingOpens.get(canonical);
    if (pending !== undefined) {
      const record = await pending;
      this.#assertWorkspaceOwner(record, ownership);
      this.#touch(record);
      return record;
    }

    const opening = this.#openAndRegister(ownership, canonical);
    this.#pendingOpens.set(canonical, opening);
    try {
      const record = await opening;
      await this.#refreshHistory(record.workspaceId);
      return record;
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === ERROR_CODES.SESSION_FILE_MISSING
      ) {
        await this.#refreshHistory(ownership.workspaceId);
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
      workspaceId: record.workspaceId,
      sessionFile: record.sessionFile,
      title: record.title,
      cwd: record.cwd,
      model: modelInfoOf(record.runtime.model),
      status: record.status,
      createdAt: record.createdAt,
      lastActiveAt: record.lastActiveAt,
      revision: record.revision,
      durable: record.durable,
      contextUsage: serializeSessionContextUsage(record.session),
      messages: serializeActiveBranch(record.session.sessionManager, {
        toolImageUrl: (entryId, imageIndex) =>
          conversationImageUrl(record.id, entryId, imageIndex),
      }),
      queue: queueOf(record.session),
      securityProfile: record.securityProfile,
      networkPolicy: record.networkPolicy,
      networkPolicySetId: record.networkPolicySetId,
      effectiveNetworkPolicySetId: record.effectiveNetworkPolicySetId,
      ...(record.owner === undefined ? {} : { owner: record.owner }),
    };
  }

  /** Persist a user-defined Pi session name and return the updated snapshot. */
  async rename(conversationId: string, title: string): Promise<ConversationState> {
    this.#assertAcceptingWork();
    const record = this.#required(conversationId);
    this.#assertInteractiveMutation(record);
    if (this.#pendingCloses.has(record)) {
      throw new AppError(ERROR_CODES.CONVERSATION_BUSY);
    }

    const normalized = title.trim();
    if (
      normalized.length === 0 ||
      normalized.length > MAX_CONVERSATION_TITLE_LENGTH
    ) {
      throw new AppError(ERROR_CODES.INVALID_CONVERSATION_TITLE);
    }
    if (record.session.sessionManager.getSessionName()?.trim() === normalized) {
      return this.getState(conversationId);
    }

    const previousTitle = record.title;
    try {
      record.session.sessionManager.appendSessionInfo(normalized);
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }

    this.#touch(record);
    await this.#refreshDurability(record);
    if (record.title === previousTitle) {
      await this.#refreshHistory(record.workspaceId);
    }
    return this.getState(conversationId);
  }

  /** Resolve a browser image reference from this runtime's canonical active branch. */
  getImage(
    conversationId: string,
    entryId: string,
    imageIndex: number,
  ): ConversationImage | undefined {
    if (!Number.isSafeInteger(imageIndex) || imageIndex < 0) return undefined;
    const conversation = this.#byId.get(conversationId);
    if (conversation === undefined || this.#pendingCloses.has(conversation)) {
      return undefined;
    }

    const entry = conversation.session.sessionManager.getBranch().find(
      (candidate) => candidate.type === "message" && candidate.id === entryId,
    );
    const message = entry?.type === "message"
      ? entry.message as unknown as {
          readonly role?: unknown;
          readonly content?: unknown;
        }
      : undefined;
    if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
      return undefined;
    }

    let currentIndex = 0;
    for (const value of message.content) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        continue;
      }
      const part = value as {
        readonly type?: unknown;
        readonly mimeType?: unknown;
        readonly data?: unknown;
      };
      if (part.type !== "image") continue;
      if (currentIndex !== imageIndex) {
        currentIndex += 1;
        continue;
      }
      if (
        (part.mimeType !== "image/png" &&
          part.mimeType !== "image/jpeg" &&
          part.mimeType !== "image/webp") ||
        typeof part.data !== "string"
      ) {
        return undefined;
      }

      try {
        const [validated] = validatePromptImages(
          [{
            mimeType: part.mimeType as ImageMimeType,
            encoding: "base64",
            data: part.data,
          }],
          { supportsImages: true, limits: this.#imageLimits },
        );
        if (validated === undefined) return undefined;
        return {
          mimeType: part.mimeType as ImageMimeType,
          data: Buffer.from(validated.data, "base64"),
        };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** Resolve a Markdown image path without exposing files outside the workspace. */
  async getWorkspaceImage(
    conversationId: string,
    filePath: string,
  ): Promise<ConversationImage | undefined> {
    const conversation = this.#byId.get(conversationId);
    if (
      conversation === undefined ||
      this.#pendingCloses.has(conversation) ||
      filePath.length === 0 ||
      filePath.includes("\0")
    ) {
      return undefined;
    }

    if (conversation.securityProfile === "workspace-sandboxed") {
      // A sandboxed assistant-selected path is never resolved, statted, or opened
      // in the parent. A missing worker reader is a fail-closed unavailable image.
      const reader = conversation.runtime.sandboxFileReader;
      if (reader === undefined) return undefined;
      try {
        const result = await reader.readFile({
          path: filePath,
          maxBytes: Math.min(this.#imageLimits.maxImageBytes, 16 * 1024 * 1024),
          detectMime: true,
        });
        if (
          result.mimeType !== "image/png" &&
          result.mimeType !== "image/jpeg" &&
          result.mimeType !== "image/webp"
        ) return undefined;
        const [validated] = validatePromptImages(
          [{ mimeType: result.mimeType, encoding: "base64", data: result.data.toString("base64") }],
          { supportsImages: true, limits: this.#imageLimits },
        );
        return validated === undefined
          ? undefined
          : { mimeType: result.mimeType, data: result.data };
      } catch {
        return undefined;
      }
    }

    let mimeType: ImageMimeType;
    switch (path.extname(filePath).toLowerCase()) {
      case ".png":
        mimeType = "image/png";
        break;
      case ".jpg":
      case ".jpeg":
        mimeType = "image/jpeg";
        break;
      case ".webp":
        mimeType = "image/webp";
        break;
      default:
        return undefined;
    }

    try {
      const candidate = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(conversation.workspacePath, filePath);
      const canonical = await realpath(candidate);
      const relative = path.relative(conversation.workspacePath, canonical);
      if (
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative)
      ) {
        return undefined;
      }

      const metadata = await stat(canonical);
      if (!metadata.isFile() || metadata.size > this.#imageLimits.maxImageBytes) {
        return undefined;
      }
      const bytes = await readFile(canonical);
      const [validated] = validatePromptImages(
        [{ mimeType, encoding: "base64", data: bytes.toString("base64") }],
        { supportsImages: true, limits: this.#imageLimits },
      );
      if (validated === undefined) return undefined;
      return { mimeType, data: bytes };
    } catch {
      return undefined;
    }
  }

  /** Persist the server-generated title for exactly the owning job run. */
  async setJobConversationTitle(
    conversationId: string,
    owner: ConversationOwner,
    title: string,
  ): Promise<void> {
    this.#assertAcceptingWork();
    const record = this.#requiredOwned(conversationId, owner);
    const normalized = title.trim();
    if (normalized.length === 0) throw new AppError(ERROR_CODES.JOB_INVALID);
    const previousTitle = record.title;
    try {
      record.session.sessionManager.appendSessionInfo(normalized);
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }
    this.#touch(record);
    await this.#refreshDurability(record);
    if (record.title === previousTitle) await this.#refreshHistory(record.workspaceId);
  }

  /**
   * Run the saved prompt for exactly the owning run and await Pi completion.
   * Unlike browser prompt(), this deliberately does not acknowledge at preflight.
   */
  async runJobPrompt(
    conversationId: string,
    owner: ConversationOwner,
    text: string,
  ): Promise<JobPromptCompletion> {
    this.#assertAcceptingWork();
    const record = this.#requiredOwned(conversationId, owner);
    if (record.status !== "idle" || record.session.isStreaming || !text.trim()) {
      throw new AppError(ERROR_CODES.CONVERSATION_BUSY);
    }
    this.#touch(record);
    try {
      await record.runtime.prompt(text);
    } catch (error) {
      if (this.#jobAbortRequested.has(record)) return { kind: "aborted" };
      return {
        kind: "runtime-failure",
        error: toAppError(error, { source: "pi", operation: "model" }),
      };
    }

    const assistant = serializeActiveBranch(record.session.sessionManager)
      .filter((message): message is AssistantMessage => message.role === "assistant")
      .findLast((message) => message.stopReason !== undefined || message.error !== undefined);
    if (this.#jobAbortRequested.has(record) || assistant?.stopReason === "aborted") {
      return assistant === undefined ? { kind: "aborted" } : { kind: "aborted", assistant };
    }
    if (assistant?.error !== undefined || assistant?.stopReason === "error") {
      return { kind: "failed", assistant };
    }
    if (
      record.runtimeFailureTerminal ||
      assistant === undefined ||
      (assistant.stopReason !== "stop" && assistant.stopReason !== "length")
    ) {
      return {
        kind: "runtime-failure",
        error: new AppError(ERROR_CODES.JOB_PROMPT_FAILED),
      };
    }
    return { kind: "succeeded", assistant };
  }

  /** Release ownership by disposing the runtime while retaining Pi history. */
  async releaseJobConversation(
    conversationId: string,
    owner: ConversationOwner,
  ): Promise<void> {
    const record = this.#requiredOwned(conversationId, owner);
    await this.#disposeRecord(record, "close");
  }

  /** Deliver a validated text/image prompt using Pi's explicit streaming behavior. */
  async prompt(
    conversationId: string,
    text: string,
    images: readonly UiImage[],
    streamingBehavior?: "steer" | "followUp",
  ): Promise<void> {
    this.#assertAcceptingWork();
    const record = this.#required(conversationId);
    this.#assertInteractiveMutation(record);
    const streaming =
      record.status === "streaming" || record.session.isStreaming;
    if (
      this.#hasForkReservation(record) ||
      record.status === "aborting" ||
      record.status === "error" ||
      (streamingBehavior === undefined ? record.status !== "idle" || streaming : !streaming)
    ) {
      throw new AppError(ERROR_CODES.CONVERSATION_BUSY);
    }
    if (!text.trim() && images.length === 0) {
      throw new AppError(ERROR_CODES.INVALID_PROMPT);
    }
    const piImages = validatePromptImages(images, {
      supportsImages: record.runtime.supportsImages,
      limits: this.#imageLimits,
    });

    this.#touch(record);

    // Pi's prompt promise covers the entire run. Resolve this command at the
    // preflight acceptance boundary instead, so the socket can acknowledge it
    // immediately while completion and model failures continue through events.
    await new Promise<void>((resolve, reject) => {
      let accepted = false;
      let settled = false;
      const options: PromptOptions = {
        ...(piImages.length === 0 ? {} : { images: piImages }),
        ...(streamingBehavior === undefined ? {} : { streamingBehavior }),
        preflightResult: (success) => {
          if (!success || settled) return;
          accepted = true;
          settled = true;
          resolve();
        },
      };

      const completion = record.runtime.prompt(text, options);
      void completion.then(
        () => {
          // The pinned SDK invokes preflightResult exactly once. Fail closed if
          // a custom adapter violates that contract instead of hanging forever.
          if (!settled) {
            settled = true;
            reject(new AppError(ERROR_CODES.MODEL_UNAVAILABLE));
          }
        },
        (error: unknown) => {
          if (!settled) {
            settled = true;
            reject(toAppError(error, { source: "pi", operation: "model" }));
          } else if (accepted) {
            // This is defensive: Pi reports post-acceptance model failures in
            // message/events and normally resolves the prompt promise.
            this.#handleRuntimeFailure(record, error);
          }
        },
      );
    });
  }

  /**
   * Validate a fork source/target and reserve one live-runtime slot before any
   * temporary fork runtime is created. The reservation also protects the idle
   * source from prompting, closing, and LRU eviction until released.
   */
  async reserveFork(
    conversationId: string,
    entryId: string,
  ): Promise<ForkCapacityReservation> {
    this.#assertAcceptingWork();
    const record = this.#required(conversationId);
    this.#assertForkSource(record, entryId);
    this.#incrementForkReservation(record);

    let releaseCapacity: (() => void) | undefined;
    try {
      releaseCapacity = await this.#reserveCapacity(record, () => {
        // Recheck after waiting for the serialized capacity decision. This
        // closes the window with a prompt that started immediately beforehand.
        this.#assertForkSource(record, entryId);
      });
    } catch (error) {
      this.#decrementForkReservation(record);
      throw error;
    }

    let capacityHeld = true;
    let sourceHeld = true;
    const promote = () => {
      if (!capacityHeld) return;
      capacityHeld = false;
      releaseCapacity?.();
    };
    return {
      sourceConversationId: record.id,
      sourceSessionFile: record.sessionFile,
      sourceCwd: record.cwd,
      promote,
      release: () => {
        promote();
        if (!sourceHeld) return;
        sourceHeld = false;
        this.#decrementForkReservation(record);
      },
    };
  }

  /**
   * Create a source-preserving fork in an unregistered temporary runtime.
   *
   * The reserved slot accounts for that temporary runtime. It is converted to
   * registry ownership only after Pi has replaced the temporary session with a
   * distinct fork. Any failed replacement, registration, or snapshot rolls the
   * fork artifact back and leaves the live source untouched.
   */
  async fork(
    conversationId: string,
    entryId: string,
    policy: ConversationWorkspace,
  ): Promise<ForkConversationResult> {
    const forkPolicy = this.#normalizePolicy(policy);
    const ownedSource = this.#required(conversationId);
    this.#assertWorkspaceOwner(ownedSource, forkPolicy);
    const reservation = await this.reserveFork(conversationId, entryId);
    const source = this.#required(reservation.sourceConversationId);
    this.#assertWorkspaceOwner(source, forkPolicy);
    let temporary: PiConversationRuntimePort | undefined;
    let registered: ConversationRecord | undefined;
    let promoted = false;
    let forkSessionFile: string | undefined;

    try {
      temporary = await this.#runtimeFactory.openPersistent(
        forkPolicy,
        reservation.sourceSessionFile,
      );
      this.#temporaryRuntimes.add(temporary);
      this.#assertAcceptingWork();
      if (
        temporary.securityProfile !== forkPolicy.securityProfile ||
        temporary.networkPolicy !== forkPolicy.networkPolicy ||
        temporary.networkPolicySetId !== forkPolicy.effectiveNetworkPolicySetId ||
        temporary.networkPolicySet !== forkPolicy.networkPolicySet ||
        path.resolve(temporary.identity.sessionFile) !==
          reservation.sourceSessionFile ||
        path.resolve(temporary.identity.cwd) !== reservation.sourceCwd
      ) {
        throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
      }

      const result = await temporary.fork(entryId, {
        ...(source.session.model === undefined
          ? {}
          : { inheritModel: source.session.model }),
      });
      if (result.cancelled) {
        throw new AppError(ERROR_CODES.PI_RUNTIME_REPLACE_FAILED);
      }

      const forkIdentity = temporary.identity;
      forkSessionFile = path.resolve(forkIdentity.sessionFile);
      if (
        forkIdentity.sessionId === reservation.sourceConversationId ||
        forkSessionFile === reservation.sourceSessionFile
      ) {
        throw new AppError(ERROR_CODES.PI_RUNTIME_REPLACE_FAILED);
      }

      registered = await this.#register(
        temporary,
        forkPolicy,
        "fork",
        reservation.promote,
      );
      if (registered.runtime !== temporary) {
        throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
      }
      promoted = true;
      this.#temporaryRuntimes.delete(temporary);
      temporary = undefined; // Registry ownership starts only here.

      const conversation = await this.getState(registered.id);
      await this.#refreshHistory(registered.workspaceId);
      return { conversation, editorText: result.editorText ?? "" };
    } catch (error) {
      const failedForkFile =
        forkSessionFile ?? this.#forkFileAfterReplacement(temporary, reservation);
      if (
        promoted &&
        registered !== undefined &&
        this.#byId.get(registered.id) === registered
      ) {
        await this.#disposeRecord(registered, "close").catch(() => undefined);
      }
      if (temporary !== undefined && !temporary.disposed) {
        await this.#disposeRuntime(temporary).catch(() => undefined);
      }
      await this.#cleanupFailedForkFile(
        failedForkFile,
        reservation.sourceSessionFile,
      );
      throw error;
    } finally {
      if (temporary !== undefined) this.#temporaryRuntimes.delete(temporary);
      reservation.release();
    }
  }

  /** Request cancellation of an active run. Concurrent repeats share one abort. */
  async abort(conversationId: string): Promise<void> {
    const record = this.#required(conversationId);
    if (record.owner !== undefined && !this.#jobAbortRequested.has(record)) {
      this.#jobAbortRequested.add(record);
      for (const listener of this.#jobAbortListeners) {
        try { listener(record.owner); } catch (error) { this.#onListenerError(error); }
      }
    }
    const pending = this.#pendingAborts.get(record);
    if (pending !== undefined) return pending;
    if (!isBusy(record)) return;

    const aborting = (async () => {
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
    })();
    this.#pendingAborts.set(record, aborting);

    try {
      await aborting;
    } finally {
      if (this.#pendingAborts.get(record) === aborting) {
        this.#pendingAborts.delete(record);
      }
    }
  }

  /** Close one idle/error conversation while retaining its persisted history. */
  async close(conversationId: string): Promise<void> {
    const record = this.#required(conversationId);
    this.#assertInteractiveMutation(record);
    if (isBusy(record) || this.#hasForkReservation(record)) {
      throw new AppError(ERROR_CODES.CONVERSATION_BUSY);
    }
    await this.#disposeRecord(record, "close");
  }

  /** Dispose every owned runtime. Active runs are allowed for shutdown cleanup. */
  dispose(): Promise<void> {
    this.beginShutdown();
    this.#disposePromise ??= (async () => {
      const records = this.records;
      const workspaceIds = new Set(records.map((record) => record.workspaceId));
      const disposals = records.map((record) =>
        this.#disposeRecord(record, "dispose")
      );
      for (const runtime of this.#temporaryRuntimes) {
        disposals.push(this.#disposeRuntime(runtime));
      }
      this.#temporaryRuntimes.clear();
      // Runtime/replacement subscriptions were detached synchronously by
      // #disposeRecord. Registry observers are no longer useful during process
      // teardown and must not retain protocol/client objects if an SDK dispose
      // promise stalls.
      this.#listeners.clear();
      this.#jobAbortListeners.clear();
      await Promise.allSettled(disposals);
      for (const workspaceId of workspaceIds) {
        await this.#refreshHistory(workspaceId);
      }
    })();
    return this.#disposePromise;
  }

  async #openAndRegister(
    workspace: ConversationWorkspace,
    canonical: string,
  ): Promise<ConversationRecord> {
    const releaseCapacity = await this.#reserveCapacity();
    let runtime: PiConversationRuntimePort | undefined;
    try {
      runtime = await this.#runtimeFactory.openPersistent(workspace, canonical);
      this.#assertAcceptingWork();
      return await this.#register(runtime, workspace, "open");
    } catch (error) {
      if (runtime !== undefined) {
        await this.#disposeRuntime(runtime).catch(() => undefined);
      }
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
  async #reserveCapacity(
    protectedRecord?: ConversationRecord,
    validate?: () => void,
  ): Promise<() => void> {
    let unlock: () => void = () => undefined;
    const previous = this.#capacityTail;
    this.#capacityTail = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    await previous;

    try {
      this.#assertAcceptingWork();
      validate?.();
      while (
        this.#byId.size + this.#capacityReservations >=
        this.#maxLiveConversations
      ) {
        const candidate = this.#leastRecentlyUsedIdle(protectedRecord);
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

  #leastRecentlyUsedIdle(
    protectedRecord?: ConversationRecord,
  ): ConversationRecord | undefined {
    let candidate: ConversationRecord | undefined;
    for (const record of this.#byId.values()) {
      if (
        record === protectedRecord ||
        record.status !== "idle" ||
        record.session.isStreaming ||
        this.#pendingCloses.has(record) ||
        this.#hasForkReservation(record)
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
    workspace: ConversationWorkspace,
    source: ConversationRegistrationSource,
    onRegistered?: () => void,
    owner?: ConversationOwner,
  ): Promise<ConversationRecord> {
    this.#assertAcceptingWork();
    const identity = runtime.identity;
    this.#assertIdentityInWorkspace(identity, workspace);
    if (
      runtime.securityProfile !== workspace.securityProfile ||
      runtime.networkPolicy !== workspace.networkPolicy ||
      runtime.networkPolicySetId !== workspace.effectiveNetworkPolicySetId ||
      runtime.networkPolicySet !== workspace.networkPolicySet
    ) {
      throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    }
    const sessionFile = await canonicalFile(identity.sessionFile);
    this.#assertAcceptingWork();
    const duplicate =
      this.#byId.get(identity.sessionId) ?? this.#bySessionFile.get(sessionFile);
    if (duplicate !== undefined) {
      await this.#disposeRuntime(runtime);
      if (owner !== undefined) throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
      this.#assertWorkspaceOwner(duplicate, workspace);
      this.#touch(duplicate);
      return duplicate;
    }

    const now = safeNow(this.#now);
    const record: ConversationRecord = {
      id: identity.sessionId,
      workspaceId: workspace.workspaceId,
      workspacePath: workspace.cwd,
      sessionDirectory: workspace.sessionDirectory,
      securityProfile: workspace.securityProfile,
      networkPolicy: workspace.networkPolicy,
      networkPolicySetId: workspace.networkPolicySetId,
      effectiveNetworkPolicySetId: workspace.effectiveNetworkPolicySetId,
      networkPolicySet: workspace.networkPolicySet,
      ...(owner === undefined ? {} : { owner }),
      runtimeFailureTerminal: false,
      sessionFile,
      cwd: workspace.cwd,
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
      await this.#disposeRuntime(runtime);
      if (owner !== undefined) throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
      this.#assertWorkspaceOwner(raced, workspace);
      this.#touch(raced);
      return raced;
    }

    this.#byId.set(record.id, record);
    this.#bySessionFile.set(record.sessionFile, record);
    try {
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
      this.#fatalUnsubscribes.set(
        record,
        runtime.onFatalFailure((error) => this.#handleRuntimeFailure(record, error)),
      );
      this.#blockedUnsubscribes.set(
        record,
        runtime.onNetworkBlocked((event) => this.#handleNetworkBlocked(record, event)),
      );
    } catch (error) {
      record.unsubscribe();
      this.#normalizers.get(record)?.dispose();
      this.#normalizers.delete(record);
      this.#replacementUnsubscribes.get(record)?.();
      this.#replacementUnsubscribes.delete(record);
      this.#fatalUnsubscribes.get(record)?.();
      this.#fatalUnsubscribes.delete(record);
      this.#blockedUnsubscribes.get(record)?.();
      this.#blockedUnsubscribes.delete(record);
      if (this.#byId.get(record.id) === record) this.#byId.delete(record.id);
      if (this.#bySessionFile.get(record.sessionFile) === record) {
        this.#bySessionFile.delete(record.sessionFile);
      }
      throw error;
    }

    // Convert a fork's in-flight capacity reservation to a registered runtime
    // before another serialized capacity decision can observe both counts.
    onRegistered?.();
    this.#emit({ type: "conversation.registered", source, record });
    return record;
  }

  #normalizePolicy(policy: ConversationWorkspace): ConversationWorkspace {
    const networkPolicy = policy.networkPolicy ??
      (policy.securityProfile === "workspace-sandboxed" ? "isolated" : null);
    const networkPolicySetId = policy.networkPolicySetId ?? DEFAULT_NETWORK_POLICY_SET_ID;
    const effectiveNetworkPolicySetId = networkPolicy === "managed-egress"
      ? policy.effectiveNetworkPolicySetId
      : null;
    const networkPolicySet = networkPolicy === "managed-egress"
      ? policy.networkPolicySet
      : null;
    if (
      typeof policy.workspaceId !== "string" ||
      policy.workspaceId.length === 0 ||
      typeof policy.cwd !== "string" ||
      !path.isAbsolute(policy.cwd) ||
      (policy.securityProfile !== "unrestricted" &&
        policy.securityProfile !== "workspace-sandboxed") ||
      (policy.securityProfile === "unrestricted"
        ? networkPolicy !== null
        : networkPolicy !== "isolated" &&
          networkPolicy !== "managed-egress") ||
      (networkPolicySetId.length > NETWORK_POLICY_SET_ID_MAX_LENGTH ||
        !new RegExp(NETWORK_POLICY_SET_ID_PATTERN, "u").test(networkPolicySetId)) ||
      (networkPolicy === "managed-egress"
        ? policy.networkPolicySetId === undefined ||
          effectiveNetworkPolicySetId !== networkPolicySetId ||
          networkPolicySet === null || networkPolicySet === undefined ||
          networkPolicySet.id !== effectiveNetworkPolicySetId ||
          !Object.isFrozen(networkPolicySet) ||
          !Object.isFrozen(networkPolicySet.allowedDomainPatterns) ||
          !Object.isFrozen(networkPolicySet.allowedPorts) ||
          !Object.isFrozen(networkPolicySet.destinationPolicy)
        : (policy.effectiveNetworkPolicySetId ?? null) !== null ||
          (policy.networkPolicySet ?? null) !== null) ||
      (policy.sessionDirectory !== null &&
        (typeof policy.sessionDirectory !== "string" ||
          !path.isAbsolute(policy.sessionDirectory)))
    ) {
      throw new AppError(ERROR_CODES.WORKSPACE_UNAVAILABLE);
    }
    return Object.freeze({
      workspaceId: policy.workspaceId,
      cwd: path.resolve(policy.cwd),
      sessionDirectory: policy.sessionDirectory === null
        ? null
        : path.resolve(policy.sessionDirectory),
      securityProfile: policy.securityProfile,
      networkPolicy,
      networkPolicySetId,
      effectiveNetworkPolicySetId,
      networkPolicySet,
    });
  }

  #assertWorkspaceOwner(
    record: ConversationRecord,
    workspace: ConversationWorkspace,
  ): void {
    if (
      record.workspaceId !== workspace.workspaceId ||
      record.workspacePath !== workspace.cwd ||
      record.sessionDirectory !== workspace.sessionDirectory ||
      record.securityProfile !== workspace.securityProfile ||
      record.networkPolicy !== workspace.networkPolicy ||
      record.networkPolicySetId !== workspace.networkPolicySetId ||
      record.effectiveNetworkPolicySetId !== workspace.effectiveNetworkPolicySetId ||
      record.networkPolicySet !== workspace.networkPolicySet
    ) {
      throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    }
  }

  #assertIdentityInWorkspace(
    identity: PiRuntimeIdentity,
    workspace: Pick<ConversationWorkspace, "cwd">,
  ): void {
    if (path.resolve(identity.cwd) !== workspace.cwd) {
      throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    }
  }

  #normalizeOwner(owner: ConversationOwner): ConversationOwner {
    if (
      owner.kind !== "scheduled-job" || typeof owner.jobId !== "string" ||
      owner.jobId.length === 0 || owner.jobId.length > 512 ||
      typeof owner.runId !== "string" || owner.runId.length === 0 || owner.runId.length > 512
    ) {
      throw new AppError(ERROR_CODES.JOB_INVALID);
    }
    return Object.freeze({ kind: "scheduled-job", jobId: owner.jobId, runId: owner.runId });
  }

  #settleCapacityLease(
    lease: RuntimeCapacityLease,
    state: "promoted" | "released",
  ): void {
    const tracked = this.#capacityLeases.get(lease);
    if (tracked === undefined) throw new AppError(ERROR_CODES.INTERNAL_ERROR);
    if (tracked.state !== "reserved") return;
    tracked.state = state;
    tracked.releaseCapacity();
  }

  #requireReservedLease(lease: RuntimeCapacityLease): void {
    if (this.#capacityLeases.get(lease)?.state !== "reserved") {
      throw new AppError(ERROR_CODES.LIVE_RUNTIME_LIMIT);
    }
  }

  #assertInteractiveMutation(record: ConversationRecord): void {
    if (record.owner !== undefined) throw new AppError(ERROR_CODES.CONVERSATION_BUSY);
  }

  #requiredOwned(
    conversationId: string,
    ownerInput: ConversationOwner,
  ): ConversationRecord {
    const record = this.#required(conversationId);
    const owner = this.#normalizeOwner(ownerInput);
    if (
      record.owner?.kind !== "scheduled-job" ||
      record.owner.jobId !== owner.jobId || record.owner.runId !== owner.runId ||
      this.#pendingCloses.has(record)
    ) {
      throw new AppError(ERROR_CODES.JOB_BUSY);
    }
    return record;
  }

  #assertAcceptingWork(): void {
    if (this.#shuttingDown) {
      throw new AppError(ERROR_CODES.SHUTTING_DOWN);
    }
  }

  #required(conversationId: string): ConversationRecord {
    const record = this.#byId.get(conversationId);
    if (record === undefined) {
      throw new AppError(ERROR_CODES.CONVERSATION_NOT_FOUND);
    }
    return record;
  }

  async #disposeRuntime(runtime: PiConversationRuntimePort): Promise<void> {
    await runtime.dispose();
    if (!runtime.teardownComplete) {
      throw new AppError(ERROR_CODES.INTERNAL_ERROR);
    }
  }

  #forkFileAfterReplacement(
    runtime: PiConversationRuntimePort | undefined,
    reservation: ForkCapacityReservation,
  ): string | undefined {
    if (runtime === undefined) return undefined;
    try {
      const identity = runtime.identity;
      return identity.sessionId !== reservation.sourceConversationId
        ? path.resolve(identity.sessionFile)
        : undefined;
    } catch {
      return undefined;
    }
  }

  async #cleanupFailedForkFile(
    sessionFile: string | undefined,
    sourceSessionFile: string,
  ): Promise<void> {
    if (sessionFile === undefined) return;
    const candidate = path.resolve(sessionFile);
    if (
      candidate === sourceSessionFile ||
      this.#bySessionFile.has(candidate)
    ) {
      return;
    }

    try {
      await unlink(candidate);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
      if (code !== "ENOENT") this.#onListenerError(error);
    }
  }

  #assertForkSource(record: ConversationRecord, entryId: string): void {
    this.#assertInteractiveMutation(record);
    if (
      record.status !== "idle" ||
      record.session.isStreaming ||
      this.#pendingCloses.has(record)
    ) {
      throw new AppError(ERROR_CODES.FORK_SOURCE_BUSY);
    }
    if (
      !isActiveBranchUserEntry(
        record.session.sessionManager.getBranch(),
        entryId,
      )
    ) {
      throw new AppError(ERROR_CODES.INVALID_FORK_TARGET);
    }
  }

  #hasForkReservation(record: ConversationRecord): boolean {
    return (this.#forkSourceReservations.get(record) ?? 0) > 0;
  }

  #incrementForkReservation(record: ConversationRecord): void {
    this.#forkSourceReservations.set(
      record,
      (this.#forkSourceReservations.get(record) ?? 0) + 1,
    );
  }

  #decrementForkReservation(record: ConversationRecord): void {
    const remaining = (this.#forkSourceReservations.get(record) ?? 1) - 1;
    if (remaining <= 0) this.#forkSourceReservations.delete(record);
    else this.#forkSourceReservations.set(record, remaining);
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
      record.runtimeFailureTerminal = true;
      if (record.status !== "error") {
        record.status = "error";
        record.revision = nextRevision(record.revision);
        this.#emit({ type: "conversation.state-changed", record });
      }
      await this.#refreshHistory(record.workspaceId);
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
    await this.#refreshHistory(record.workspaceId);
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
      this.#fatalUnsubscribes.get(record)?.();
      this.#fatalUnsubscribes.delete(record);
      this.#blockedUnsubscribes.get(record)?.();
      this.#blockedUnsubscribes.delete(record);

      try {
        await this.#disposeRuntime(record.runtime);
      } catch (error) {
        disposalError = error;
      } finally {
        if (this.#byId.get(record.id) === record) this.#byId.delete(record.id);
        if (this.#bySessionFile.get(record.sessionFile) === record) {
          this.#bySessionFile.delete(record.sessionFile);
        }
        this.#emit({ type: "conversation.closed", record, reason });
        if (reason !== "dispose") await this.#refreshHistory(record.workspaceId);
      }

      if (disposalError !== undefined) {
        throw toAppError(disposalError, { source: "internal" });
      }
    })();
    this.#pendingCloses.set(record, closing);
    return closing;
  }

  async #refreshHistory(workspaceId: string): Promise<void> {
    try {
      await this.#refreshHistoryCallback(workspaceId);
    } catch (error) {
      this.#onListenerError(error);
    }
  }

  #replaceIdentity(
    record: ConversationRecord,
    replacement: PiRuntimeReplacement,
  ): void {
    if (
      record.runtime.securityProfile !== record.securityProfile ||
      record.runtime.networkPolicy !== record.networkPolicy ||
      record.runtime.networkPolicySetId !== record.effectiveNetworkPolicySetId ||
      record.runtime.networkPolicySet !== record.networkPolicySet
    ) {
      this.#handleRuntimeFailure(record, new AppError(ERROR_CODES.SESSION_UNAVAILABLE));
      return;
    }
    const current = record.runtime.identity;
    this.#assertIdentityInWorkspace(current, { cwd: record.workspacePath });
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
    record.cwd = record.workspacePath;
    record.session = record.runtime.session;
    record.title = titleOf(record.session);
    this.#normalizers.get(record)?.dispose();
    this.#normalizers.set(record, this.#createNormalizer(record));
    record.revision = nextRevision(record.revision);
    this.#touch(record);
    this.#byId.set(record.id, record);
    this.#bySessionFile.set(record.sessionFile, record);
    this.#emit({ type: "conversation.replaced", record, replacement });
    void this.#refreshHistory(record.workspaceId);
  }

  #createNormalizer(record: ConversationRecord): PiEventNormalizer {
    return new PiEventNormalizer({
      sessionId: record.id,
      getSession: () => record.session,
      emit: (event) => this.#emitConversationEvent(record, event),
      onMessagePersisted: (message) => this.#messagePersisted(record, message),
      onMetadataChanged: () => this.#metadataChanged(record),
      toolImageUrl: (entryId, imageIndex) =>
        conversationImageUrl(record.id, entryId, imageIndex),
    });
  }

  #emitConversationEvent(
    record: ConversationRecord,
    event: RegistryConversationEvent,
  ): void {
    if (this.#byId.get(record.id) !== record || this.#pendingCloses.has(record)) {
      return;
    }

    if (event.type === "conversation.status") {
      if (record.runtimeFailureTerminal && event.payload.status !== "error") return;
      if (event.payload.status === "error") record.runtimeFailureTerminal = true;
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
        workspaceId: record.workspaceId,
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
    void this.#refreshHistory(record.workspaceId);
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
    void this.#refreshHistory(record.workspaceId);
  }

  #handleNetworkBlocked(
    record: ConversationRecord,
    event: Readonly<NetworkBlockedNotification>,
  ): void {
    if (record.networkPolicy !== "managed-egress") {
      this.#handleRuntimeFailure(record, new AppError(ERROR_CODES.SESSION_UNAVAILABLE));
      return;
    }
    this.#emitConversationEvent(record, {
      type: "network.blocked",
      payload: {
        host: event.host,
        port: event.port,
        protocol: event.protocol,
        reason: event.reason,
        ...(event.occurrenceCount === undefined
          ? {}
          : { occurrenceCount: event.occurrenceCount }),
      },
    });
  }

  #handleRuntimeFailure(record: ConversationRecord, error: unknown): void {
    this.#onListenerError(error);
    if (this.#byId.get(record.id) !== record) return;
    record.runtimeFailureTerminal = true;
    if (record.status !== "error") {
      this.#emitConversationEvent(record, {
        type: "conversation.status",
        payload: { status: "error" },
      });
    }
    // A terminal record remains available for its error snapshot, but none of
    // its Pi, worker/bridge, or managed proxy resources remain live.
    void this.#disposeRuntime(record.runtime).catch(this.#onListenerError);
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
