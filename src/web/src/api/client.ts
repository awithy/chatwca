import { Value } from "@sinclair/typebox/value";

import type { ErrorCode } from "../../../shared/errors.js";
import {
  ServerMessageSchema,
  type ClientCommand,
  type ClientCommandType,
  type CommandSuccessByType,
  type ConversationEvent,
  type ErrorMessage,
  type ServerMessage,
} from "../../../shared/protocol.js";
import {
  createInitialChatClientState,
  reduceChatClientState,
  type ChatClientAction,
  type ChatClientState,
} from "./state.js";

type CommandFor<T extends ClientCommandType> = Extract<
  ClientCommand,
  { type: T }
>;
export type ClientCommandInput<T extends ClientCommandType> =
  CommandFor<T> extends infer TCommand
    ? TCommand extends ClientCommand
      ? Omit<TCommand, "requestId">
      : never
    : never;

interface PendingCommand {
  readonly commandType: ClientCommandType;
  readonly resolve: (message: CommandSuccessByType[ClientCommandType]) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ChatSocketClientOptions {
  readonly url?: string;
  readonly webSocketFactory?: (url: string) => WebSocket;
  readonly commandTimeoutMs?: number;
  readonly initialReconnectDelayMs?: number;
  readonly maxReconnectDelayMs?: number;
  readonly requestId?: () => string;
}

export class ChatCommandError extends Error {
  override readonly name = "ChatCommandError";
  readonly code: ErrorCode;
  readonly requestId: string | undefined;

  constructor(message: ErrorMessage) {
    super(message.message);
    this.code = message.code;
    this.requestId = message.requestId;
  }
}

export class ChatTransportError extends Error {
  override readonly name = "ChatTransportError";
}

function defaultSocketUrl(): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function isConversationEvent(message: ServerMessage): message is ConversationEvent {
  return "conversationId" in message && "revision" in message;
}

function isExpectedResponse(
  commandType: ClientCommandType,
  message: ServerMessage,
): message is CommandSuccessByType[ClientCommandType] {
  switch (commandType) {
    case "history.list":
      return message.type === "history";
    case "conversation.create":
    case "conversation.open":
    case "conversation.state":
    case "conversation.fork":
      return message.type === "state";
    case "conversation.close":
    case "conversation.delete":
    case "prompt.submit":
    case "prompt.steer":
    case "prompt.followUp":
    case "conversation.abort":
      return message.type === "ack" && message.command === commandType;
  }
}

/**
 * Browser WebSocket owner with request correlation and authoritative recovery.
 * It deliberately owns no server lifecycle: disconnecting never closes a Pi
 * conversation, and reconnect asks the server for fresh history/state.
 */
export class ChatSocketClient {
  readonly #url: string;
  readonly #webSocketFactory: (url: string) => WebSocket;
  readonly #commandTimeoutMs: number;
  readonly #initialReconnectDelayMs: number;
  readonly #maxReconnectDelayMs: number;
  readonly #requestId: () => string;
  readonly #listeners = new Set<() => void>();
  readonly #pending = new Map<string, PendingCommand>();
  readonly #resyncing = new Set<string>();
  #state = createInitialChatClientState();
  #socket: WebSocket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #requestCounter = 0;
  #stopped = true;
  #generation = 0;

  constructor(options: ChatSocketClientOptions = {}) {
    this.#url = options.url ?? defaultSocketUrl();
    this.#webSocketFactory =
      options.webSocketFactory ?? ((url) => new WebSocket(url));
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 15_000;
    this.#initialReconnectDelayMs = options.initialReconnectDelayMs ?? 250;
    this.#maxReconnectDelayMs = options.maxReconnectDelayMs ?? 5_000;
    this.#requestId = options.requestId ?? (() => {
      this.#requestCounter += 1;
      return `request-${Date.now().toString(36)}-${this.#requestCounter.toString(36)}`;
    });

    if (this.#commandTimeoutMs <= 0) {
      throw new RangeError("commandTimeoutMs must be positive");
    }
    if (
      this.#initialReconnectDelayMs < 0 ||
      this.#maxReconnectDelayMs < this.#initialReconnectDelayMs
    ) {
      throw new RangeError("Reconnect delays are invalid");
    }
  }

  getState = (): ChatClientState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  connect(): void {
    if (!this.#stopped && this.#socket !== null) return;
    this.#stopped = false;
    this.#reconnectAttempt = 0;
    this.#clearReconnectTimer();
    this.#open(false);
  }

  disconnect(): void {
    this.#stopped = true;
    this.#clearReconnectTimer();
    this.#generation += 1;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) socket.close();
    this.#rejectPending(new ChatTransportError("The server connection closed."));
    this.#dispatch({ type: "connection", status: "disconnected" });
  }

  send<T extends ClientCommandType>(
    input: ClientCommandInput<T>,
  ): Promise<CommandSuccessByType[T]> {
    const socket = this.#socket;
    if (
      socket === null ||
      socket.readyState !== 1 ||
      this.#state.connection !== "connected"
    ) {
      return Promise.reject(
        new ChatTransportError("The server connection is not ready."),
      );
    }

    const requestId = this.#requestId();
    const command = { ...(input as object), requestId } as CommandFor<T>;
    const commandType = (input as { readonly type: ClientCommandType }).type;
    return new Promise<CommandSuccessByType[T]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new ChatTransportError("The server command timed out."));
      }, this.#commandTimeoutMs);
      this.#pending.set(requestId, {
        commandType,
        resolve: resolve as PendingCommand["resolve"],
        reject,
        timer,
      });
      try {
        socket.send(JSON.stringify(command));
      } catch (error) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(error);
      }
    });
  }

  selectConversation(conversationId: string | null): void {
    this.#dispatch({ type: "select", conversationId });
  }

  setDraft(conversationId: string, text: string): void {
    this.#dispatch({ type: "draft", conversationId, text });
  }

  /**
   * Create a server-side fork, then make its returned editor text a local,
   * conversation-specific draft. Selection and draft changes happen only after
   * the authoritative fork snapshot has been accepted; no prompt is submitted.
   */
  async forkConversation(
    conversationId: string,
    entryId: string,
  ): Promise<CommandSuccessByType["conversation.fork"]> {
    const result = await this.send<"conversation.fork">({
      type: "conversation.fork",
      conversationId,
      entryId,
    });
    this.setDraft(result.conversation.id, result.editorText);
    this.selectConversation(result.conversation.id);
    return result;
  }

  async reload(): Promise<void> {
    await this.#recover(this.#generation);
  }

  #open(reconnecting: boolean): void {
    if (this.#stopped) return;
    this.#dispatch({
      type: "connection",
      status: reconnecting ? "reconnecting" : "connecting",
    });
    const generation = ++this.#generation;
    let socket: WebSocket;
    try {
      socket = this.#webSocketFactory(this.#url);
    } catch (error) {
      this.#setTransportError(error);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener("message", (event) => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      this.#handleMessage(event.data);
    });
    socket.addEventListener("close", () => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      this.#socket = null;
      this.#rejectPending(new ChatTransportError("The server connection closed."));
      if (this.#stopped) {
        this.#dispatch({ type: "connection", status: "disconnected" });
      } else {
        this.#scheduleReconnect();
      }
    });
    socket.addEventListener("error", () => {
      if (generation !== this.#generation || socket !== this.#socket) return;
      this.#setTransportError(new Error("Unable to reach the ChatWCA server."));
    });
  }

  #scheduleReconnect(): void {
    if (this.#stopped || this.#reconnectTimer !== undefined) return;
    this.#dispatch({ type: "connection", status: "reconnecting" });
    const delay = Math.min(
      this.#maxReconnectDelayMs,
      this.#initialReconnectDelayMs * 2 ** this.#reconnectAttempt,
    );
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      this.#open(true);
    }, delay);
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #handleMessage(data: unknown): void {
    if (typeof data !== "string") {
      this.#setTransportError(new Error("The server sent a non-text message."));
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(data) as unknown;
    } catch {
      this.#setTransportError(new Error("The server sent invalid JSON."));
      return;
    }
    if (!Value.Check(ServerMessageSchema, message)) {
      this.#setTransportError(new Error("The server sent an invalid message."));
      return;
    }
    this.#acceptMessage(message);
  }

  #acceptMessage(message: ServerMessage): void {
    if (message.type === "ready") {
      this.#reconnectAttempt = 0;
      this.#dispatch({ type: "ready", serverVersion: message.serverVersion });
      void this.#recover(this.#generation);
      return;
    }

    if (message.type === "history") {
      this.#dispatch({ type: "history", conversations: message.conversations });
    } else if (message.type === "state") {
      this.#dispatch({ type: "snapshot", conversation: message.conversation });
    } else if (isConversationEvent(message)) {
      this.#dispatch({ type: "event", event: message });
    } else if (message.type === "error" && message.requestId === undefined) {
      this.#dispatch({
        type: "error",
        error: { code: message.code, message: message.message },
      });
    }

    if (!("requestId" in message) || message.requestId === undefined) return;
    const pending = this.#pending.get(message.requestId);
    if (pending === undefined) return;
    this.#pending.delete(message.requestId);
    clearTimeout(pending.timer);

    if (message.type === "error") {
      pending.reject(new ChatCommandError(message));
    } else if (isExpectedResponse(pending.commandType, message)) {
      pending.resolve(message);
    } else {
      pending.reject(new ChatTransportError("The server response did not match the command."));
    }
  }

  async #recover(generation: number): Promise<void> {
    if (generation !== this.#generation || this.#state.connection !== "connected") return;
    try {
      await this.send({ type: "history.list" });
      const selected = this.#state.selectedConversationId;
      if (
        selected !== null &&
        generation === this.#generation &&
        this.#state.connection === "connected"
      ) {
        const summary = this.#state.history.find((item) => item.id === selected);
        if (summary?.status === "closed") {
          await this.send({ type: "conversation.open", conversationId: selected });
        } else if (summary !== undefined) {
          await this.send({ type: "conversation.state", conversationId: selected });
        }
      }
    } catch (error) {
      if (generation === this.#generation) this.#setTransportError(error);
    }
  }

  #syncRevisionGaps(): void {
    if (this.#state.connection !== "connected") return;
    for (const conversationId of this.#state.resyncConversationIds) {
      if (this.#resyncing.has(conversationId)) continue;
      this.#resyncing.add(conversationId);
      void this.send({ type: "conversation.state", conversationId })
        .catch((error: unknown) => this.#setTransportError(error))
        .finally(() => this.#resyncing.delete(conversationId));
    }
  }

  #setTransportError(error: unknown): void {
    this.#dispatch({
      type: "error",
      error: {
        code: "transport_error",
        message: error instanceof Error ? error.message : "A connection error occurred.",
      },
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#resyncing.clear();
  }

  #dispatch(action: ChatClientAction): void {
    const next = reduceChatClientState(this.#state, action);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
    this.#syncRevisionGaps();
  }
}
