import { Value } from "@sinclair/typebox/value";
import { TextDecoder } from "node:util";
import WebSocket, { type RawData, type WebSocketServer } from "ws";

import { AppError, ERROR_CODES, toErrorResponse } from "../shared/errors.js";
import {
  ClientCommandSchema,
  type ClientCommand,
  type ConversationState,
  type ConversationSummary,
  type ServerMessage,
  type UiImage,
  type WorkspaceSummary,
} from "../shared/protocol.js";
import type {
  ConversationRegistryEvent,
  ConversationRegistryListener,
} from "./conversation-registry.js";
import { OutboundFlowController, type OutboundFlowOptions } from "./outbound-flow.js";
import {
  WEBSOCKET_RESTART_CLOSE_CODE,
  WEBSOCKET_RESTART_CLOSE_REASON,
} from "./shutdown.js";
import type { SessionHistoryWorkspace } from "./session-history.js";
import type {
  RuntimeWorkspacePolicy,
  UpdateWorkspaceInput,
} from "./workspace-repository.js";

export const DEFAULT_MAX_INBOUND_MESSAGE_BYTES = 40 * 1024 * 1024;

export interface ProtocolRegistry {
  create(workspace: SessionHistoryWorkspace): Promise<{ readonly id: string }>;
  open(
    workspace: SessionHistoryWorkspace,
    sessionFile: string,
  ): Promise<{ readonly id: string }>;
  getState(conversationId: string): Promise<ConversationState>;
  rename(conversationId: string, title: string): Promise<ConversationState>;
  close(conversationId: string): Promise<void>;
  fork(conversationId: string, entryId: string): Promise<{
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
  hasLiveWorkspace(workspaceId: string): boolean;
  subscribe(listener: ConversationRegistryListener): () => void;
}

export interface ProtocolHistory {
  list(
    workspace: SessionHistoryWorkspace,
  ): Promise<readonly ConversationSummary[]>;
  resolve(workspace: SessionHistoryWorkspace, conversationId: string): Promise<{
    readonly summary: { readonly sessionFile: string };
  }>;
  delete(
    workspace: SessionHistoryWorkspace,
    conversationId: string,
  ): Promise<readonly ConversationSummary[]>;
}

export interface ProtocolWorkspaceRepository {
  list(): WorkspaceSummary[];
  requireAvailable(workspaceId: string): SessionHistoryWorkspace;
  requireUsable(workspaceId: string): RuntimeWorkspacePolicy;
  create(input: {
    readonly name: string;
    readonly path: string;
    readonly sessionStorage: WorkspaceSummary["sessionStorage"];
    readonly securityProfile: WorkspaceSummary["securityProfile"];
  }): WorkspaceSummary;
  update(workspaceId: string, changes: UpdateWorkspaceInput): WorkspaceSummary;
  delete(workspaceId: string): void;
}

export interface WebSocketProtocolOptions {
  readonly webSocketServer: WebSocketServer;
  readonly serverVersion: string;
  readonly registry: ProtocolRegistry;
  readonly history: ProtocolHistory;
  readonly workspaces: ProtocolWorkspaceRepository;
  readonly maxInboundMessageBytes?: number;
  readonly outboundFlow?: OutboundFlowOptions;
  readonly onInternalError?: (error: unknown) => void;
}

export interface DispatchResult {
  readonly response: ServerMessage;
  readonly affectedWorkspaceId?: string;
  readonly history?: readonly ConversationSummary[];
  readonly workspaces?: readonly WorkspaceSummary[];
  readonly workspaceBroadcastIncludesSender?: boolean;
}

class CommandDecodeError extends AppError {
  readonly requestId: string | undefined;
  constructor(
    code: typeof ERROR_CODES.INVALID_COMMAND | typeof ERROR_CODES.MESSAGE_TOO_LARGE,
    requestId?: string,
  ) {
    super(code);
    this.requestId = requestId;
  }
}

function byteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}

function rawBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return data;
}

function requestIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("requestId" in value)) return undefined;
  const requestId = (value as { readonly requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length >= 1 && requestId.length <= 128
    ? requestId
    : undefined;
}

export function decodeClientCommand(
  data: RawData,
  isBinary: boolean,
  maxBytes = DEFAULT_MAX_INBOUND_MESSAGE_BYTES,
): ClientCommand {
  if (byteLength(data) > maxBytes) throw new CommandDecodeError(ERROR_CODES.MESSAGE_TOO_LARGE);
  if (isBinary) throw new CommandDecodeError(ERROR_CODES.INVALID_COMMAND);

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(rawBytes(data))) as unknown;
  } catch {
    throw new CommandDecodeError(ERROR_CODES.INVALID_COMMAND);
  }
  if (!Value.Check(ClientCommandSchema, value)) {
    throw new CommandDecodeError(ERROR_CODES.INVALID_COMMAND, requestIdOf(value));
  }
  return value;
}

function runtimeWorkspace(
  policy: RuntimeWorkspacePolicy,
): SessionHistoryWorkspace & { readonly securityProfile: WorkspaceSummary["securityProfile"] } {
  return {
    id: policy.workspaceId,
    path: policy.cwd,
    sessionDirectory: policy.sessionDirectory,
    securityProfile: policy.securityProfile,
  };
}

export async function dispatchClientCommand(
  command: ClientCommand,
  registry: ProtocolRegistry,
  history: ProtocolHistory,
  workspaces: ProtocolWorkspaceRepository,
  shuttingDown = false,
): Promise<DispatchResult> {
  if (shuttingDown) throw new AppError(ERROR_CODES.SHUTTING_DOWN);

  switch (command.type) {
    case "workspace.list": {
      const authoritative = workspaces.list();
      return {
        response: { type: "workspaces", requestId: command.requestId, workspaces: authoritative },
      };
    }
    case "workspace.create": {
      workspaces.create({
        name: command.name,
        path: command.path,
        sessionStorage: command.sessionStorage,
        securityProfile: command.securityProfile,
      });
      const authoritative = workspaces.list();
      return {
        response: { type: "workspaces", requestId: command.requestId, workspaces: authoritative },
        workspaces: authoritative,
      };
    }
    case "workspace.update": {
      const securityProfile = "securityProfile" in command
        ? command.securityProfile
        : undefined;
      if (
        (command.path !== undefined || securityProfile !== undefined) &&
        registry.hasLiveWorkspace(command.workspaceId)
      ) {
        throw new AppError(ERROR_CODES.WORKSPACE_BUSY);
      }
      workspaces.update(command.workspaceId, {
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.path === undefined ? {} : { path: command.path }),
        ...(securityProfile === undefined
          ? {}
          : { securityProfile }),
        ...("acknowledgeSecurityDowngrade" in command
          ? { acknowledgeSecurityDowngrade: command.acknowledgeSecurityDowngrade }
          : {}),
      });
      const authoritative = workspaces.list();
      return {
        response: { type: "workspaces", requestId: command.requestId, workspaces: authoritative },
        workspaces: authoritative,
      };
    }
    case "workspace.delete": {
      if (registry.hasLiveWorkspace(command.workspaceId)) {
        throw new AppError(ERROR_CODES.WORKSPACE_BUSY);
      }
      workspaces.delete(command.workspaceId);
      return {
        response: { type: "ack", requestId: command.requestId, command: command.type },
        workspaces: workspaces.list(),
        workspaceBroadcastIncludesSender: true,
      };
    }
    case "history.list": {
      const workspace = workspaces.requireAvailable(command.workspaceId);
      return {
        response: {
          type: "history",
          requestId: command.requestId,
          workspaceId: workspace.id,
          conversations: [...(await history.list(workspace))],
        },
      };
    }
    case "conversation.create": {
      const workspace = runtimeWorkspace(workspaces.requireUsable(command.workspaceId));
      const record = await registry.create(workspace);
      return {
        response: {
          type: "state",
          requestId: command.requestId,
          conversation: await registry.getState(record.id),
        },
        affectedWorkspaceId: command.workspaceId,
      };
    }
    case "conversation.open": {
      const availableWorkspace = workspaces.requireAvailable(command.workspaceId);
      const listed = await history.resolve(availableWorkspace, command.conversationId);
      const workspace = runtimeWorkspace(workspaces.requireUsable(command.workspaceId));
      const record = await registry.open(workspace, listed.summary.sessionFile);
      return {
        response: {
          type: "state",
          requestId: command.requestId,
          conversation: await registry.getState(record.id),
        },
        affectedWorkspaceId: command.workspaceId,
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
    case "conversation.rename": {
      const conversation = await registry.rename(
        command.conversationId,
        command.title,
      );
      return {
        response: {
          type: "state",
          requestId: command.requestId,
          conversation,
        },
        affectedWorkspaceId: conversation.workspaceId,
      };
    }
    case "conversation.close": {
      const workspaceId = (await registry.getState(command.conversationId)).workspaceId;
      await registry.close(command.conversationId);
      return {
        response: { type: "ack", requestId: command.requestId, command: command.type },
        affectedWorkspaceId: workspaceId,
      };
    }
    case "conversation.delete": {
      const workspace = workspaces.requireAvailable(command.workspaceId);
      const conversations = await history.delete(workspace, command.conversationId);
      return {
        response: { type: "ack", requestId: command.requestId, command: command.type },
        affectedWorkspaceId: command.workspaceId,
        history: conversations,
      };
    }
    case "prompt.submit":
      await registry.prompt(command.conversationId, command.text, command.images);
      return { response: { type: "ack", requestId: command.requestId, command: command.type } };
    case "prompt.steer":
    case "prompt.followUp":
      await registry.prompt(
        command.conversationId,
        command.text,
        command.images,
        command.type === "prompt.steer" ? "steer" : "followUp",
      );
      return { response: { type: "ack", requestId: command.requestId, command: command.type } };
    case "conversation.abort":
      await registry.abort(command.conversationId);
      return { response: { type: "ack", requestId: command.requestId, command: command.type } };
    case "conversation.fork": {
      const source = await registry.getState(command.conversationId);
      workspaces.requireUsable(source.workspaceId);
      const fork = await registry.fork(command.conversationId, command.entryId);
      return {
        response: {
          type: "state",
          requestId: command.requestId,
          conversation: fork.conversation,
          editorText: fork.editorText,
        },
        affectedWorkspaceId: fork.conversation.workspaceId,
      };
    }
    case "conversation.rewind": {
      // Rewind is deliberately server-orchestrated: the source is retained if
      // fork construction fails, and is closed/deleted only after the distinct
      // fork snapshot is available.
      const source = await registry.getState(command.conversationId);
      const workspace = workspaces.requireAvailable(source.workspaceId);
      await history.resolve(workspace, source.id);
      workspaces.requireUsable(source.workspaceId);
      const fork = await registry.fork(command.conversationId, command.entryId);
      await registry.close(source.id);
      const conversations = await history.delete(workspace, source.id);
      return {
        response: {
          type: "state",
          requestId: command.requestId,
          conversation: fork.conversation,
          editorText: fork.editorText,
        },
        affectedWorkspaceId: source.workspaceId,
        history: conversations,
      };
    }
  }
}

interface WorkspaceRefreshState {
  running: boolean;
  requested: boolean;
}

export class WebSocketProtocol {
  readonly #webSocketServer: WebSocketServer;
  readonly #serverVersion: string;
  readonly #registry: ProtocolRegistry;
  readonly #history: ProtocolHistory;
  readonly #workspaces: ProtocolWorkspaceRepository;
  readonly #maxInboundMessageBytes: number;
  readonly #outboundFlowOptions: OutboundFlowOptions;
  readonly #onInternalError: (error: unknown) => void;
  readonly #flows = new Map<WebSocket, OutboundFlowController>();
  readonly #historySubscriptions = new Map<WebSocket, string>();
  readonly #historyRefreshes = new Map<string, WorkspaceRefreshState>();
  readonly #unsubscribeRegistry: () => void;
  readonly #onConnection: (socket: WebSocket) => void;
  #shuttingDown = false;
  #shutdownGraceMs = 1;
  #disposed = false;

  constructor(options: WebSocketProtocolOptions) {
    this.#webSocketServer = options.webSocketServer;
    this.#serverVersion = options.serverVersion;
    this.#registry = options.registry;
    this.#history = options.history;
    this.#workspaces = options.workspaces;
    this.#maxInboundMessageBytes = options.maxInboundMessageBytes ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES;
    if (!Number.isSafeInteger(this.#maxInboundMessageBytes) || this.#maxInboundMessageBytes <= 0) {
      throw new RangeError("maxInboundMessageBytes must be a positive integer");
    }
    this.#outboundFlowOptions = options.outboundFlow ?? {};
    this.#onInternalError = options.onInternalError ?? (() => undefined);
    this.#onConnection = (socket) => this.#handleConnection(socket);
    this.#webSocketServer.on("connection", this.#onConnection);
    this.#unsubscribeRegistry = this.#registry.subscribe((event) => this.#handleRegistryEvent(event));
  }

  beginShutdown(gracePeriodMs: number): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    this.#shutdownGraceMs = gracePeriodMs;
    for (const socket of this.#webSocketServer.clients) this.#closeForShutdown(socket, gracePeriodMs);
  }

  terminateClients(): void {
    for (const socket of this.#webSocketServer.clients) {
      try { socket.terminate(); } catch (error) { this.#onInternalError(error); }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#webSocketServer.off("connection", this.#onConnection);
    this.#unsubscribeRegistry();
    for (const flow of this.#flows.values()) flow.dispose();
    this.#flows.clear();
    this.#historySubscriptions.clear();
    this.#historyRefreshes.clear();
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
      this.#historySubscriptions.delete(socket);
    });
    socket.on("error", this.#onInternalError);
    if (this.#shuttingDown) {
      this.#closeForShutdown(socket, this.#shutdownGraceMs);
      return;
    }
    this.#send(socket, { type: "ready", serverVersion: this.#serverVersion });

    let tail = Promise.resolve();
    socket.on("message", (data, isBinary) => {
      tail = tail
        .then(() => this.#handleMessage(socket, data, isBinary))
        .catch((error: unknown) => this.#onInternalError(error));
    });
  }

  async #handleMessage(socket: WebSocket, data: RawData, isBinary: boolean): Promise<void> {
    // Shutdown owns aborting active runs. Once protocol admission closes, no
    // queued socket command (including workspace CRUD) may reach SQLite.
    if (this.#shuttingDown || this.#disposed) return;

    let command: ClientCommand;
    try {
      command = decodeClientCommand(data, isBinary, this.#maxInboundMessageBytes);
    } catch (error) {
      const requestId = error instanceof CommandDecodeError ? error.requestId : undefined;
      this.#send(socket, toErrorResponse(error, undefined, requestId));
      return;
    }

    try {
      const result = await dispatchClientCommand(
        command,
        this.#registry,
        this.#history,
        this.#workspaces,
        this.#shuttingDown,
      );
      this.#send(socket, result.response);
      if (command.type === "history.list") {
        // Only a successful correlated listing changes this socket's subscription.
        this.#historySubscriptions.set(socket, command.workspaceId);
      }
      if (result.workspaces !== undefined) {
        this.#broadcast(
          { type: "workspaces", workspaces: [...result.workspaces] },
          result.workspaceBroadcastIncludesSender === true ? undefined : socket,
        );
      }
      if (result.affectedWorkspaceId !== undefined) {
        if (result.history !== undefined) {
          this.#broadcastHistory(result.affectedWorkspaceId, result.history);
        } else {
          this.#scheduleHistoryBroadcast(result.affectedWorkspaceId);
        }
      }
    } catch (error) {
      this.#send(socket, toErrorResponse(error, undefined, command.requestId));
    }
  }

  #handleRegistryEvent(event: ConversationRegistryEvent): void {
    if (event.type === "conversation.event") {
      this.#broadcast(event.event);
      if (event.event.type === "conversation.status") {
        this.#scheduleHistoryBroadcast(event.record.workspaceId);
      }
      return;
    }
    this.#scheduleHistoryBroadcast(event.record.workspaceId);
  }

  #hasHistorySubscriber(workspaceId: string): boolean {
    for (const subscribed of this.#historySubscriptions.values()) {
      if (subscribed === workspaceId) return true;
    }
    return false;
  }

  #scheduleHistoryBroadcast(workspaceId: string): void {
    if (this.#disposed || !this.#hasHistorySubscriber(workspaceId)) return;
    const current = this.#historyRefreshes.get(workspaceId) ?? { running: false, requested: false };
    current.requested = true;
    this.#historyRefreshes.set(workspaceId, current);
    if (current.running) return;
    current.running = true;

    void (async () => {
      try {
        while (current.requested && !this.#disposed) {
          current.requested = false;
          const workspace = this.#workspaces.requireAvailable(workspaceId);
          const conversations = await this.#history.list(workspace);
          this.#broadcastHistory(workspace.id, conversations);
        }
      } catch (error) {
        this.#onInternalError(error);
      } finally {
        current.running = false;
        if (!current.requested || !this.#hasHistorySubscriber(workspaceId)) {
          this.#historyRefreshes.delete(workspaceId);
        } else {
          this.#scheduleHistoryBroadcast(workspaceId);
        }
      }
    })();
  }

  #broadcastHistory(workspaceId: string, conversations: readonly ConversationSummary[]): void {
    const message: ServerMessage = {
      type: "history",
      workspaceId,
      conversations: [...conversations],
    };
    for (const [socket, subscribed] of this.#historySubscriptions) {
      if (subscribed === workspaceId) this.#send(socket, message);
    }
  }

  #broadcast(message: ServerMessage, except?: WebSocket): void {
    for (const socket of this.#webSocketServer.clients) {
      if (socket !== except) this.#send(socket, message);
    }
  }

  #closeForShutdown(socket: WebSocket, gracePeriodMs: number): void {
    this.#flows.get(socket)?.dispose();
    if (socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.send(JSON.stringify({ type: "server.shutdown", gracePeriodMs } satisfies ServerMessage), (error) => {
        if (error !== undefined && error !== null) this.#onInternalError(error);
      });
      socket.close(WEBSOCKET_RESTART_CLOSE_CODE, WEBSOCKET_RESTART_CLOSE_REASON);
    } catch (error) {
      this.#onInternalError(error);
    }
  }

  #send(socket: WebSocket, message: ServerMessage): void {
    this.#flows.get(socket)?.send(message);
  }
}
