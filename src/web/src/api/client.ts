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
  readonly command: ClientCommand;
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
  command: ClientCommand,
  message: ServerMessage,
): message is CommandSuccessByType[ClientCommandType] {
  switch (command.type) {
    case "workspace.list":
    case "workspace.create":
    case "workspace.update":
      return message.type === "workspaces";
    case "job.list":
    case "job.create":
    case "job.update":
      return message.type === "jobs";
    case "job.run":
      return message.type === "job.run.state" && message.run.jobId === command.jobId;
    case "job.runs":
      return message.type === "job.runs" &&
        message.jobId === command.jobId &&
        message.runs.every((run) => run.jobId === command.jobId);
    case "job.run.state":
      return message.type === "job.run.state" &&
        message.run.jobId === command.jobId && message.run.id === command.runId;
    case "history.list":
      return message.type === "history" &&
        message.workspaceId === command.workspaceId &&
        message.conversations.every(
          (conversation) => conversation.workspaceId === command.workspaceId,
        );
    case "conversation.create":
      return message.type === "state" &&
        message.conversation.workspaceId === command.workspaceId;
    case "conversation.open":
      return message.type === "state" &&
        message.conversation.workspaceId === command.workspaceId &&
        message.conversation.id === command.conversationId;
    case "conversation.state":
    case "conversation.rename":
      return message.type === "state" &&
        message.conversation.id === command.conversationId;
    case "conversation.fork":
    case "conversation.rewind":
      return message.type === "state" && message.editorText !== undefined;
    case "workspace.delete":
    case "conversation.close":
    case "conversation.delete":
    case "prompt.submit":
    case "prompt.steer":
    case "prompt.followUp":
    case "conversation.abort":
    case "job.delete":
    case "job.abort":
      return message.type === "ack" && message.command === command.type;
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
  readonly #resyncingJobRuns = new Set<string>();
  #state = createInitialChatClientState();
  #socket: WebSocket | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectAttempt = 0;
  #requestCounter = 0;
  #stopped = true;
  #generation = 0;
  #workspaceSelectionRevision = 0;

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
    return this.#sendWithRequestId(input, this.#requestId());
  }

  #sendWithRequestId<T extends ClientCommandType>(
    input: ClientCommandInput<T>,
    requestId: string,
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

    const command = { ...(input as object), requestId } as CommandFor<T>;
    return new Promise<CommandSuccessByType[T]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new ChatTransportError("The server command timed out."));
      }, this.#commandTimeoutMs);
      this.#pending.set(requestId, {
        command,
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

  /**
   * Change the browser-local workspace selection. The selection is immediate;
   * only a connected, non-null selection causes a scoped Pi history request.
   */
  async selectWorkspace(workspaceId: string | null): Promise<void> {
    this.#workspaceSelectionRevision += 1;
    const selectionRevision = this.#workspaceSelectionRevision;
    this.#dispatch({ type: "workspace.select", workspaceId });
    if (workspaceId === null || this.#state.connection !== "connected") return;
    await this.#requestHistory(workspaceId, selectionRevision);
  }

  selectJob(jobId: string | null): void {
    this.#dispatch({ type: "job.select", jobId });
  }

  selectJobRun(runId: string | null): void {
    this.#dispatch({ type: "job.run.select", runId });
  }

  async loadJobRuns(jobId: string, cursor?: string): Promise<void> {
    this.#dispatch({ type: "job.runs.pending", jobId });
    try {
      await this.send({ type: "job.runs", jobId, ...(cursor === undefined ? {} : { cursor }) });
    } catch (error) {
      this.#dispatch({ type: "job.runs.failed", jobId });
      throw error;
    }
  }

  async loadJobRun(jobId: string, runId: string): Promise<void> {
    await this.send({ type: "job.run.state", jobId, runId });
  }

  /** Resolve a generated session through authoritative workspace history. */
  async openGeneratedConversation(workspaceId: string, conversationId: string): Promise<boolean> {
    try {
      await this.selectWorkspace(workspaceId);
      const projection = this.#state.conversations[conversationId];
      const summary = this.#state.history.find((item) => item.id === conversationId);
      if (summary?.status !== "closed" && (summary !== undefined || projection !== undefined)) {
        await this.send({ type: "conversation.state", conversationId });
      } else if (summary?.runnable === true) {
        await this.send({
          type: "conversation.open",
          workspaceId,
          conversationId,
        });
      } else {
        return false;
      }
      this.selectConversation(conversationId);
      return true;
    } catch {
      return false;
    }
  }

  selectConversation(conversationId: string | null): void {
    if (conversationId !== null) {
      const summary = this.#state.history.find((item) => item.id === conversationId);
      const projection = this.#state.conversations[conversationId];
      const workspaceId = projection?.conversation.workspaceId ?? summary?.workspaceId;
      if (
        workspaceId === undefined ||
        workspaceId !== this.#state.selectedWorkspaceId
      ) {
        return;
      }
    }
    this.#dispatch({ type: "select", conversationId });
  }

  setDraft(conversationId: string, text: string): void {
    this.#dispatch({ type: "draft", conversationId, text });
  }

  clearDraft(conversationId: string): void {
    this.#dispatch({ type: "draft.delete", conversationId });
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

  /**
   * Replace a conversation with a fork ending immediately before the selected
   * user message. The server deletes the source only after creating the fork.
   */
  async rewindConversation(
    conversationId: string,
    entryId: string,
  ): Promise<CommandSuccessByType["conversation.rewind"]> {
    const result = await this.send<"conversation.rewind">({
      type: "conversation.rewind",
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
    if (
      message.type === "job.run.updated" &&
      (message.jobId !== message.run.jobId || message.runId !== message.run.id ||
        message.revision !== message.run.revision)
    ) {
      this.#setTransportError(new Error("The server sent an inconsistent job revision."));
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

    if (message.type === "server.shutdown") {
      this.#stopped = true;
      this.#clearReconnectTimer();
      this.#rejectPending(
        new ChatTransportError("The server is shutting down."),
      );
      this.#dispatch({
        type: "error",
        error: {
          code: "shutting_down",
          message: "The server is shutting down.",
        },
      });
      return;
    }

    const requestId = "requestId" in message ? message.requestId : undefined;
    if (requestId !== undefined) {
      const pending = this.#pending.get(requestId);
      if (pending !== undefined) {
        this.#pending.delete(requestId);
        clearTimeout(pending.timer);
        if (message.type === "error") {
          pending.reject(new ChatCommandError(message));
          return;
        }
        if (!isExpectedResponse(pending.command, message)) {
          pending.reject(
            new ChatTransportError("The server response did not match the command."),
          );
          return;
        }
        this.#projectMessage(message, pending.command);
        this.#applyCommandSuccess(pending.command);
        pending.resolve(message);
        return;
      }
    }

    // Unknown correlated responses are stale and cannot mutate projections.
    if (requestId !== undefined) return;
    this.#projectMessage(message);
  }

  #projectMessage(message: ServerMessage, command?: ClientCommand): void {
    if (message.type === "workspaces") {
      this.#dispatch({ type: "workspaces", workspaces: message.workspaces });
    } else if (message.type === "history") {
      this.#dispatch({
        type: "history",
        workspaceId: message.workspaceId,
        conversations: message.conversations,
      });
    } else if (message.type === "state") {
      this.#dispatch({ type: "snapshot", conversation: message.conversation });
    } else if (message.type === "jobs") {
      this.#dispatch({ type: "jobs", jobs: message.jobs });
    } else if (message.type === "job.runs") {
      this.#dispatch({
        type: "job.runs",
        jobId: message.jobId,
        runs: message.runs,
        ...(message.nextCursor === undefined ? {} : { nextCursor: message.nextCursor }),
        append: command?.type === "job.runs" && command.cursor !== undefined,
      });
    } else if (message.type === "job.run.state") {
      this.#dispatch({ type: "job.run.state", run: message.run });
    } else if (message.type === "job.run.updated") {
      this.#dispatch({ type: "job.run.updated", run: message.run });
    } else if (isConversationEvent(message)) {
      this.#dispatch({ type: "event", event: message });
    } else if (message.type === "error") {
      this.#dispatch({
        type: "error",
        error: { code: message.code, message: message.message },
      });
    }
  }

  #applyCommandSuccess(command: ClientCommand): void {
    if (command.type === "conversation.close") {
      this.#dispatch({
        type: "conversation.closed",
        conversationId: command.conversationId,
      });
    } else if (
      command.type === "conversation.delete" ||
      command.type === "conversation.rewind"
    ) {
      this.#dispatch({
        type: "conversation.deleted",
        conversationId: command.conversationId,
      });
    }
  }

  async #requestHistory(
    workspaceId: string,
    selectionRevision: number,
  ): Promise<void> {
    if (
      selectionRevision !== this.#workspaceSelectionRevision ||
      workspaceId !== this.#state.selectedWorkspaceId ||
      this.#state.connection !== "connected"
    ) return;

    this.#dispatch({ type: "history.pending", workspaceId });
    try {
      await this.send({ type: "history.list", workspaceId });
    } catch (error) {
      if (
        selectionRevision === this.#workspaceSelectionRevision &&
        workspaceId === this.#state.selectedWorkspaceId
      ) {
        this.#dispatch({
          type: "history.failed",
          error: {
            workspaceId,
            code: error instanceof ChatCommandError ? error.code : "transport_error",
            message: error instanceof Error
              ? error.message
              : "Unable to load workspace history.",
          },
        });
      }
      throw error;
    }
  }

  async #recover(generation: number): Promise<void> {
    if (generation !== this.#generation || this.#state.connection !== "connected") return;
    const selectionRevision = this.#workspaceSelectionRevision;
    const selectedWorkspaceId = this.#state.selectedWorkspaceId;
    const selectedConversationId = this.#state.selectedConversationId;
    const selectedJobId = this.#state.selectedJobId;
    const selectedJobRunId = this.#state.selectedJobRunId;
    try {
      // Definitions are always recovered first. Reconnect then restores only
      // the selected conversation and run-history scopes held in browser memory.
      await this.send({ type: "workspace.list" });
      if (generation !== this.#generation || this.#state.connection !== "connected") return;
      await this.#sendWithRequestId(
        { type: "job.list" },
        `recovery-jobs-${String(generation)}`,
      );
      if (generation !== this.#generation || this.#state.connection !== "connected") return;
      if (selectedJobId !== null && this.#state.jobs.some((job) => job.id === selectedJobId)) {
        await this.loadJobRuns(selectedJobId);
        if (selectedJobRunId !== null) {
          await this.loadJobRun(selectedJobId, selectedJobRunId);
        }
      }
      if (
        generation !== this.#generation ||
        selectionRevision !== this.#workspaceSelectionRevision ||
        this.#state.connection !== "connected" ||
        selectedWorkspaceId === null ||
        this.#state.selectedWorkspaceId !== selectedWorkspaceId
      ) return;

      await this.#requestHistory(selectedWorkspaceId, selectionRevision);
      if (
        generation !== this.#generation ||
        selectionRevision !== this.#workspaceSelectionRevision ||
        this.#state.connection !== "connected" ||
        selectedConversationId === null ||
        this.#state.selectedConversationId !== selectedConversationId
      ) return;

      const summary = this.#state.historyWorkspaceId === selectedWorkspaceId
        ? this.#state.history.find((item) => item.id === selectedConversationId)
        : undefined;
      const projection = this.#state.conversations[selectedConversationId];
      const conversationWorkspaceId = projection?.conversation.workspaceId ??
        summary?.workspaceId;
      if (conversationWorkspaceId !== selectedWorkspaceId) {
        this.#dispatch({ type: "select", conversationId: null });
        return;
      }

      if (summary?.status === "closed") {
        await this.send({
          type: "conversation.open",
          workspaceId: selectedWorkspaceId,
          conversationId: selectedConversationId,
        });
      } else {
        await this.send({
          type: "conversation.state",
          conversationId: selectedConversationId,
        });
      }
    } catch (error) {
      if (
        generation === this.#generation &&
        !this.#stopped &&
        !(error instanceof ChatCommandError && selectedWorkspaceId !== null)
      ) {
        this.#setTransportError(error);
      }
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

  #syncJobRunRevisionGaps(): void {
    if (this.#state.connection !== "connected") return;
    for (const key of this.#state.resyncJobRunIds) {
      if (this.#resyncingJobRuns.has(key)) continue;
      const separator = key.indexOf("\0");
      if (separator < 1 || separator === key.length - 1) continue;
      const jobId = key.slice(0, separator);
      const runId = key.slice(separator + 1);
      this.#resyncingJobRuns.add(key);
      void this.send({ type: "job.run.state", jobId, runId })
        .catch((error: unknown) => this.#setTransportError(error))
        .finally(() => this.#resyncingJobRuns.delete(key));
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
    this.#resyncingJobRuns.clear();
  }

  #dispatch(action: ChatClientAction): void {
    const next = reduceChatClientState(this.#state, action);
    if (next === this.#state) return;
    this.#state = next;
    for (const listener of this.#listeners) listener();
    this.#syncRevisionGaps();
    this.#syncJobRunRevisionGaps();
  }
}
