import { Value } from "@sinclair/typebox/value";
import { TextDecoder } from "node:util";
import WebSocket, {
  type RawData,
  type WebSocketServer,
} from "ws";

import {
  AppError,
  ERROR_CODES,
  toErrorResponse,
} from "../shared/errors.js";
import {
  ClientCommandSchema,
  type ClientCommand,
  type ConversationState,
  type ConversationSummary,
  type ServerMessage,
  type UiImage,
} from "../shared/protocol.js";
import type {
  ConversationRegistryEvent,
  ConversationRegistryListener,
} from "./conversation-registry.js";
import {
  OutboundFlowController,
  type OutboundFlowOptions,
} from "./outbound-flow.js";
import {
  WEBSOCKET_RESTART_CLOSE_CODE,
  WEBSOCKET_RESTART_CLOSE_REASON,
} from "./shutdown.js";

/**
 * Covers the default 24 MiB decoded-image aggregate after base64 expansion,
 * plus JSON metadata. Per-image decoded limits are enforced separately.
 */
export const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 40 * 1024 * 1024;

export interface ProtocolRegistry {
  create(cwd: string): Promise<{ readonly id: string }>;
  open(sessionFile: string): Promise<{ readonly id: string }>;
  getState(conversationId: string): Promise<ConversationState>;
  close(conversationId: string): Promise<void>;
  fork(
    conversationId: string,
    entryId: string,
  ): Promise<{
    readonly conversation: ConversationState;
    readonly editorText: string;
  }>;
  prompt(
    conversationId: string,
    text: string,
    images: readonly UiImage[],
    streamingBehavior?: "steer" | "followUp",
  ): Promise<void>;
  abort(conversationId: string): Promise<void>;
  subscribe(listener: ConversationRegistryListener): () => void;
}

export interface ProtocolHistory {
  list(): Promise<readonly ConversationSummary[]>;
  resolve(conversationId: string): Promise<{
    readonly summary: { readonly sessionFile: string };
  }>;
  delete(conversationId: string): Promise<readonly ConversationSummary[]>;
}

export interface WebSocketProtocolOptions {
  readonly webSocketServer: WebSocketServer;
  readonly serverVersion: string;
  readonly registry: ProtocolRegistry;
  readonly history: ProtocolHistory;
  readonly maxInboundMessageBytes?: number;
  readonly outboundFlow?: OutboundFlowOptions;
  readonly onInternalError?: (error: unknown) => void;
}

export interface DispatchResult {
  readonly response: ServerMessage;
  readonly historyChanged?: boolean;
  readonly history?: readonly ConversationSummary[];
}

const SHUTDOWN_REJECTED_COMMANDS: ReadonlySet<ClientCommand["type"]> = new Set([
  "conversation.create",
  "conversation.open",
  "conversation.fork",
  "prompt.submit",
  "prompt.steer",
  "prompt.followUp",
]);

class CommandDecodeError extends AppError {
  readonly requestId: string | undefined;

  constructor(
    code:
      | typeof ERROR_CODES.INVALID_COMMAND
      | typeof ERROR_CODES.MESSAGE_TOO_LARGE,
    requestId?: string,
  ) {
    super(code);
    this.requestId = requestId;
  }
}

function byteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + part.byteLength, 0);
  }
  return data.byteLength;
}

function rawBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function requestIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("requestId" in value)) {
    return undefined;
  }
  const requestId = (value as { readonly requestId?: unknown }).requestId;
  return typeof requestId === "string" &&
    requestId.length >= 1 &&
    requestId.length <= 128
    ? requestId
    : undefined;
}

/** Decode one text frame and apply the shared closed-object TypeBox contract. */
export function decodeClientCommand(
  data: RawData,
  isBinary: boolean,
  maxBytes = DEFAULT_MAX_INBOUND_MESSAGE_BYTES,
): ClientCommand {
  if (byteLength(data) > maxBytes) {
    throw new CommandDecodeError(ERROR_CODES.MESSAGE_TOO_LARGE);
  }
  if (isBinary) throw new CommandDecodeError(ERROR_CODES.INVALID_COMMAND);

  let value: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes(data));
    value = JSON.parse(json) as unknown;
  } catch {
    throw new CommandDecodeError(ERROR_CODES.INVALID_COMMAND);
  }

  if (!Value.Check(ClientCommandSchema, value)) {
    throw new CommandDecodeError(ERROR_CODES.INVALID_COMMAND, requestIdOf(value));
  }
  return value;
}

/** Execute a validated command against the authoritative registry/history services. */
export async function dispatchClientCommand(
  command: ClientCommand,
  registry: ProtocolRegistry,
  history: ProtocolHistory,
  shuttingDown = false,
): Promise<DispatchResult> {
  if (shuttingDown && SHUTDOWN_REJECTED_COMMANDS.has(command.type)) {
    throw new AppError(ERROR_CODES.SHUTTING_DOWN);
  }

  switch (command.type) {
    // Workspace dispatch is wired in Phase 3. Keeping the newly validated
    // commands behind a safe error preserves exhaustive compilation without
    // exposing an unimplemented persistence path through this legacy handler.
    case "workspace.list":
    case "workspace.create":
    case "workspace.update":
    case "workspace.delete":
      throw new AppError(ERROR_CODES.INTERNAL_ERROR);

    case "history.list":
      return {
        response: {
          type: "history",
          requestId: command.requestId,
          conversations: [...(await history.list())],
        },
      };

    case "conversation.create": {
      const record = await registry.create(command.cwd);
      return {
        response: {
          type: "state",
          requestId: command.requestId,
          conversation: await registry.getState(record.id),
        },
        historyChanged: true,
      };
    }

    case "conversation.open": {
      const listed = await history.resolve(command.conversationId);
      const record = await registry.open(listed.summary.sessionFile);
      return {
        response: {
          type: "state",
          requestId: command.requestId,
          conversation: await registry.getState(record.id),
        },
        historyChanged: true,
      };
    }

    case "conversation.state":
      return {
        response: {
          type: "state",
          requestId: command.requestId,
          conversation: await registry.getState(command.conversationId),
        },
      };

    case "conversation.close":
      await registry.close(command.conversationId);
      return {
        response: {
          type: "ack",
          requestId: command.requestId,
          command: command.type,
        },
        historyChanged: true,
      };

    case "conversation.delete": {
      const conversations = await history.delete(command.conversationId);
      return {
        response: {
          type: "ack",
          requestId: command.requestId,
          command: command.type,
        },
        history: conversations,
      };
    }

    case "prompt.submit":
      await registry.prompt(
        command.conversationId,
        command.text,
        command.images,
      );
      return {
        response: {
          type: "ack",
          requestId: command.requestId,
          command: command.type,
        },
      };

    case "prompt.steer":
    case "prompt.followUp":
      await registry.prompt(
        command.conversationId,
        command.text,
        command.images,
        command.type === "prompt.steer" ? "steer" : "followUp",
      );
      return {
        response: {
          type: "ack",
          requestId: command.requestId,
          command: command.type,
        },
      };

    case "conversation.abort":
      await registry.abort(command.conversationId);
      return {
        response: {
          type: "ack",
          requestId: command.requestId,
          command: command.type,
        },
      };

    case "conversation.fork": {
      const fork = await registry.fork(
        command.conversationId,
        command.entryId,
      );
      return {
        response: {
          type: "state",
          requestId: command.requestId,
          conversation: fork.conversation,
          editorText: fork.editorText,
        },
        historyChanged: true,
      };
    }
  }
}

/**
 * Owns WebSocket command parsing, response correlation, and registry broadcasts.
 * Socket failures are intentionally swallowed: browser transport must never
 * influence a Pi run or another connected browser.
 */
export class WebSocketProtocol {
  readonly #webSocketServer: WebSocketServer;
  readonly #serverVersion: string;
  readonly #registry: ProtocolRegistry;
  readonly #history: ProtocolHistory;
  readonly #maxInboundMessageBytes: number;
  readonly #outboundFlowOptions: OutboundFlowOptions;
  readonly #onInternalError: (error: unknown) => void;
  readonly #flows = new Map<WebSocket, OutboundFlowController>();
  readonly #unsubscribeRegistry: () => void;
  readonly #onConnection: (socket: WebSocket) => void;
  #historyBroadcastRunning = false;
  #historyBroadcastRequested = false;
  #shuttingDown = false;
  #shutdownGraceMs = 1;
  #disposed = false;

  constructor(options: WebSocketProtocolOptions) {
    this.#webSocketServer = options.webSocketServer;
    this.#serverVersion = options.serverVersion;
    this.#registry = options.registry;
    this.#history = options.history;
    this.#maxInboundMessageBytes =
      options.maxInboundMessageBytes ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES;
    if (
      !Number.isSafeInteger(this.#maxInboundMessageBytes) ||
      this.#maxInboundMessageBytes <= 0
    ) {
      throw new RangeError("maxInboundMessageBytes must be a positive integer");
    }
    this.#outboundFlowOptions = options.outboundFlow ?? {};
    this.#onInternalError = options.onInternalError ?? (() => undefined);

    this.#onConnection = (socket) => this.#handleConnection(socket);
    this.#webSocketServer.on("connection", this.#onConnection);
    this.#unsubscribeRegistry = this.#registry.subscribe((event) => {
      this.#handleRegistryEvent(event);
    });
  }

  /** Reject new work, notify clients, and start a restart-style close handshake. */
  beginShutdown(gracePeriodMs: number): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#shutdownGraceMs = gracePeriodMs;
    for (const socket of this.#webSocketServer.clients) {
      this.#closeForShutdown(socket, gracePeriodMs);
    }
  }

  terminateClients(): void {
    for (const socket of this.#webSocketServer.clients) {
      try {
        socket.terminate();
      } catch (error) {
        this.#onInternalError(error);
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#webSocketServer.off("connection", this.#onConnection);
    this.#unsubscribeRegistry();
    for (const flow of this.#flows.values()) flow.dispose();
    this.#flows.clear();
  }

  #handleConnection(socket: WebSocket): void {
    const flow = new OutboundFlowController(socket, {
      ...this.#outboundFlowOptions,
      onError: this.#onInternalError,
    });
    this.#flows.set(socket, flow);
    socket.once("close", () => {
      flow.dispose();
      this.#flows.delete(socket);
    });
    socket.on("error", this.#onInternalError);

    if (this.#shuttingDown) {
      this.#closeForShutdown(socket, this.#shutdownGraceMs);
      return;
    }

    this.#send(socket, {
      type: "ready",
      serverVersion: this.#serverVersion,
    });

    // Preserve command ordering per socket even though separate clients remain
    // independent and can issue commands concurrently.
    let tail = Promise.resolve();
    socket.on("message", (data, isBinary) => {
      tail = tail
        .then(() => this.#handleMessage(socket, data, isBinary))
        .catch((error: unknown) => this.#onInternalError(error));
    });
  }

  async #handleMessage(
    socket: WebSocket,
    data: RawData,
    isBinary: boolean,
  ): Promise<void> {
    let command: ClientCommand;
    try {
      command = decodeClientCommand(
        data,
        isBinary,
        this.#maxInboundMessageBytes,
      );
    } catch (error) {
      const requestId =
        error instanceof CommandDecodeError ? error.requestId : undefined;
      this.#send(socket, toErrorResponse(error, undefined, requestId));
      return;
    }

    try {
      const result = await dispatchClientCommand(
        command,
        this.#registry,
        this.#history,
        this.#shuttingDown,
      );
      this.#send(socket, result.response);
      if (result.history !== undefined) {
        this.#broadcast({
          type: "history",
          conversations: [...result.history],
        });
      } else if (result.historyChanged) {
        this.#scheduleHistoryBroadcast();
      }
    } catch (error) {
      this.#send(socket, toErrorResponse(error, undefined, command.requestId));
    }
  }

  #handleRegistryEvent(event: ConversationRegistryEvent): void {
    if (event.type === "conversation.event") {
      this.#broadcast(event.event);
      if (event.event.type === "conversation.status") {
        this.#scheduleHistoryBroadcast();
      }
      return;
    }

    // Registry lifecycle/metadata changes alter sidebar summaries. The
    // coalescing refresh avoids listing Pi history once per simultaneous event.
    this.#scheduleHistoryBroadcast();
  }

  #scheduleHistoryBroadcast(): void {
    if (this.#disposed) return;
    this.#historyBroadcastRequested = true;
    if (this.#historyBroadcastRunning) return;
    this.#historyBroadcastRunning = true;

    void (async () => {
      try {
        while (this.#historyBroadcastRequested && !this.#disposed) {
          this.#historyBroadcastRequested = false;
          const conversations = await this.#history.list();
          this.#broadcast({
            type: "history",
            conversations: [...conversations],
          });
        }
      } catch (error) {
        this.#onInternalError(error);
      } finally {
        this.#historyBroadcastRunning = false;
        if (this.#historyBroadcastRequested) this.#scheduleHistoryBroadcast();
      }
    })();
  }

  #broadcast(message: ServerMessage): void {
    for (const socket of this.#webSocketServer.clients) {
      this.#send(socket, message);
    }
  }

  #closeForShutdown(socket: WebSocket, gracePeriodMs: number): void {
    this.#flows.get(socket)?.dispose();
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      // Bypass application queues so even a pressured client receives the
      // process-level notice before the close frame queued immediately after.
      socket.send(
        JSON.stringify({
          type: "server.shutdown",
          gracePeriodMs,
        } satisfies ServerMessage),
        (error) => {
          if (error !== undefined) this.#onInternalError(error);
        },
      );
      socket.close(
        WEBSOCKET_RESTART_CLOSE_CODE,
        WEBSOCKET_RESTART_CLOSE_REASON,
      );
    } catch (error) {
      this.#onInternalError(error);
    }
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    this.#flows.get(socket)?.send(message);
  }
}
