import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";

import type {
  CompactionNotice,
  ConversationEvent,
  NormalizedMessage,
  RetryNotice,
} from "../shared/protocol.js";
import {
  serializeLiveMessage,
  serializeLiveToolResult,
} from "./serialize.js";

/** A normalized event before the registry assigns identity and revision. */
export type NormalizedPiEvent = ConversationEvent extends infer TEvent
  ? TEvent extends ConversationEvent
    ? Pick<TEvent, "type" | "payload">
    : never
  : never;

export interface PiEventNormalizerOptions {
  readonly sessionId: string;
  readonly getSession: () => AgentSession;
  readonly emit: (event: NormalizedPiEvent) => void;
  /** Called after a message_end has been persisted and normalized. */
  readonly onMessagePersisted?: (message: unknown) => void;
  /** Called when Pi metadata changed but has no delta event in the wire protocol. */
  readonly onMetadataChanged?: () => void;
}

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function roleAndTimestamp(message: unknown): {
  readonly role: unknown;
  readonly timestamp: unknown;
} {
  const source = record(message);
  return { role: source?.role, timestamp: source?.timestamp };
}

function persistedEntryId(session: AgentSession, message: unknown): string | undefined {
  const branch = session.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const candidate = branch[index];
    if (candidate?.type !== "message") continue;
    if (candidate.message === message) return candidate.id;
  }

  // Pi currently stores the same object passed by message_end. The fallback is
  // defensive for an SDK that clones messages while retaining their timestamp.
  const expected = roleAndTimestamp(message);
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const candidate = branch[index];
    if (candidate?.type !== "message") continue;
    const actual = roleAndTimestamp(candidate.message);
    if (
      actual.role === expected.role &&
      actual.timestamp === expected.timestamp &&
      typeof candidate.id === "string"
    ) {
      return candidate.id;
    }
  }
  return undefined;
}

function retryNotice(
  phase: RetryNotice["phase"],
  message: string,
  details: Partial<Omit<RetryNotice, "kind" | "phase" | "message">> = {},
): NormalizedPiEvent {
  return {
    type: "conversation.notice",
    payload: { notice: { kind: "retry", phase, message, ...details } },
  };
}

function compactionNotice(
  phase: CompactionNotice["phase"],
  message: string,
): NormalizedPiEvent {
  return {
    type: "conversation.notice",
    payload: { notice: { kind: "compaction", phase, message } },
  };
}

/**
 * Stateful, SDK-facing event adapter for one live conversation.
 *
 * Pi assigns canonical session entry IDs immediately after notifying listeners
 * of message_end. Completion normalization is therefore deferred by one
 * microtask; start/delta events use a short-lived stream ID, while completed
 * messages always use the persisted Pi ID when available. Authoritative
 * snapshots contain only canonical IDs and replace any in-progress projection.
 */
export class PiEventNormalizer {
  readonly #getSession: () => AgentSession;
  readonly #emit: (event: NormalizedPiEvent) => void;
  readonly #onMessagePersisted: (message: unknown) => void;
  readonly #onMetadataChanged: () => void;
  readonly #streamIds = new WeakMap<object, string>();
  readonly #streamIdsByKey = new Map<string, string>();
  readonly #sessionId: string;
  #nextStreamId = 0;
  #lastAssistantEntryId: string | undefined;
  #active = true;

  constructor(options: PiEventNormalizerOptions) {
    this.#sessionId = options.sessionId;
    this.#getSession = options.getSession;
    this.#emit = options.emit;
    this.#onMessagePersisted = options.onMessagePersisted ?? (() => undefined);
    this.#onMetadataChanged = options.onMetadataChanged ?? (() => undefined);
  }

  dispose(): void {
    this.#active = false;
  }

  handle(event: AgentSessionEvent): void {
    if (!this.#active) return;

    switch (event.type) {
      case "agent_start":
        this.#emit({
          type: "conversation.status",
          payload: { status: "streaming" },
        });
        return;
      case "agent_end":
        this.#emit({
          type: "conversation.status",
          payload: { status: "idle" },
        });
        return;
      case "message_start": {
        const entryId = this.#streamId(event.message);
        const message = serializeLiveMessage(event.message, entryId);
        if (message !== undefined) {
          this.#emit({ type: "message.started", payload: { message } });
        }
        return;
      }
      case "message_update": {
        const update = event.assistantMessageEvent;
        if (update.type !== "text_delta" && update.type !== "thinking_delta") {
          return;
        }
        this.#emit({
          type: "message.delta",
          payload: {
            entryId: this.#streamId(event.message),
            blockIndex: update.contentIndex,
            blockType: update.type === "text_delta" ? "text" : "thinking",
            delta: update.delta,
          },
        });
        return;
      }
      case "message_end": {
        const streamId = this.#streamId(event.message);
        queueMicrotask(() => {
          if (!this.#active) return;
          const entryId = persistedEntryId(this.#getSession(), event.message) ?? streamId;
          const message = serializeLiveMessage(event.message, entryId);
          if (message !== undefined) {
            if (message.role === "assistant" && record(event.message)?.role === "assistant") {
              this.#lastAssistantEntryId = entryId;
            }
            this.#emit({ type: "message.completed", payload: { message } });
          }
          this.#onMessagePersisted(event.message);
        });
        return;
      }
      case "tool_execution_start":
        this.#emit({
          type: "tool.started",
          payload: {
            ...(this.#lastAssistantEntryId === undefined
              ? {}
              : { entryId: this.#lastAssistantEntryId }),
            tool: {
              type: "tool-call",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              arguments: event.args,
              status: "running",
            },
          },
        });
        return;
      case "tool_execution_update": {
        const result = serializeLiveToolResult(
          event.toolCallId,
          event.toolName,
          event.partialResult,
          false,
        );
        this.#emit({
          type: "tool.updated",
          payload: {
            toolCallId: event.toolCallId,
            content: result.content,
            truncated: result.truncated,
          },
        });
        return;
      }
      case "tool_execution_end":
        this.#emit({
          type: "tool.completed",
          payload: {
            result: serializeLiveToolResult(
              event.toolCallId,
              event.toolName,
              event.result,
              event.isError,
            ),
          },
        });
        return;
      case "queue_update":
        this.#emit({
          type: "conversation.queue",
          payload: {
            steering: event.steering.map((text) => ({ text, imageCount: 0 })),
            followUp: event.followUp.map((text) => ({ text, imageCount: 0 })),
          },
        });
        return;
      case "auto_retry_start":
        this.#emit(
          retryNotice("scheduled", "A model retry has been scheduled.", {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
          }),
        );
        return;
      case "auto_retry_end":
        this.#emit(
          retryNotice(
            "completed",
            event.success
              ? "The model retry completed."
              : "The model retry did not recover.",
            { attempt: event.attempt },
          ),
        );
        return;
      case "summarization_retry_scheduled":
        this.#emit(
          retryNotice("scheduled", "A summarization retry has been scheduled.", {
            attempt: event.attempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
          }),
        );
        return;
      case "summarization_retry_attempt_start":
        this.#emit(retryNotice("started", "A summarization retry has started."));
        return;
      case "summarization_retry_finished":
        this.#emit(retryNotice("completed", "The summarization retry completed."));
        return;
      case "compaction_start":
        this.#emit(compactionNotice("started", "Conversation compaction started."));
        return;
      case "compaction_end":
        this.#emit(
          event.aborted
            ? compactionNotice("aborted", "Conversation compaction was aborted.")
            : event.errorMessage !== undefined
              ? compactionNotice("failed", "Conversation compaction failed.")
              : compactionNotice("completed", "Conversation compaction completed."),
        );
        return;
      case "session_info_changed":
      case "thinking_level_changed":
        this.#onMetadataChanged();
        return;
      default:
        // turn, settled, entry, and bash events either duplicate a more useful
        // normalized event or have no stable v1 browser representation.
        return;
    }
  }

  #streamId(message: object): string {
    const existing = this.#streamIds.get(message);
    if (existing !== undefined) return existing;

    // Provider adapters may replace the partial message object between deltas.
    // Role + timestamp (+ tool call identity) is stable across those copies.
    const source = record(message);
    const key =
      typeof source?.timestamp === "number" && typeof source.role === "string"
        ? `${source.role}:${source.timestamp}:${
            typeof source.toolCallId === "string" ? source.toolCallId : ""
          }`
        : undefined;
    const keyed = key === undefined ? undefined : this.#streamIdsByKey.get(key);
    if (keyed !== undefined) {
      this.#streamIds.set(message, keyed);
      return keyed;
    }

    this.#nextStreamId += 1;
    const id = `stream:${this.#sessionId}:${this.#nextStreamId}`;
    this.#streamIds.set(message, id);
    if (key !== undefined) this.#streamIdsByKey.set(key, id);
    return id;
  }
}
