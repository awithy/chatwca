import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationState, ServerMessage } from "../../src/shared/protocol.js";
import {
  ChatCommandError,
  ChatSocketClient,
  ChatTransportError,
} from "../../src/web/src/api/client.js";

class FakeSocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly #listeners = new Map<string, Set<(event: { data?: unknown }) => void>>();

  addEventListener(type: string, listener: (event: { data?: unknown }) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit("close", {});
  }

  server(message: ServerMessage): void {
    this.#emit("message", { data: JSON.stringify(message) });
  }

  fail(): void {
    this.#emit("error", {});
  }

  remoteClose(): void {
    this.readyState = 3;
    this.#emit("close", {});
  }

  commands(): Array<Record<string, unknown>> {
    return this.sent.map((data) => JSON.parse(data) as Record<string, unknown>);
  }

  #emit(type: string, event: { data?: unknown }): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function conversation(revision = 0): ConversationState {
  return {
    id: "conversation-1",
    sessionFile: "/sessions/one.jsonl",
    title: "One",
    cwd: "/workspace",
    model: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    revision,
    durable: true,
    messages: [],
    queue: { steering: [], followUp: [] },
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatSocketClient", () => {
  it("correlates commands and surfaces stable server errors", async () => {
    let request = 0;
    const socket = new FakeSocket();
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => socket as unknown as WebSocket,
      requestId: () => `id-${++request}`,
    });
    client.connect();
    socket.server({ type: "ready", serverVersion: "1.0.0" });

    const historyCommand = socket.commands()[0];
    expect(historyCommand).toEqual({ type: "history.list", requestId: "id-1" });
    socket.server({
      type: "history",
      requestId: "id-1",
      conversations: [],
    });
    await flush();

    const create = client.send({ type: "conversation.create", cwd: "/workspace" });
    expect(socket.commands().at(-1)).toEqual({
      type: "conversation.create",
      cwd: "/workspace",
      requestId: "id-2",
    });
    socket.server({
      type: "state",
      requestId: "id-2",
      conversation: conversation(),
    });
    await expect(create).resolves.toMatchObject({ type: "state" });
    expect(client.getState().conversations["conversation-1"]).toBeDefined();

    const close = client.send({
      type: "conversation.close",
      conversationId: "conversation-1",
    });
    socket.server({
      type: "error",
      requestId: "id-3",
      code: "conversation_busy",
      message: "The conversation is busy.",
    });
    await expect(close).rejects.toMatchObject<Partial<ChatCommandError>>({
      code: "conversation_busy",
      message: "The conversation is busy.",
    });
    client.disconnect();
  });

  it("reconnects with bounded backoff and reloads history plus selected state", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    let request = 0;
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      requestId: () => `id-${++request}`,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
    });
    client.selectConversation("conversation-1");
    client.setDraft("conversation-1", "local draft");
    client.connect();

    sockets[0]?.server({ type: "ready", serverVersion: "1" });
    expect(sockets[0]?.commands()[0]?.type).toBe("history.list");
    sockets[0]?.remoteClose();
    expect(client.getState().connection).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(2);
    sockets[1]?.server({ type: "ready", serverVersion: "1" });
    const history = sockets[1]?.commands()[0];
    expect(history?.type).toBe("history.list");
    sockets[1]?.server({
      type: "history",
      requestId: String(history?.requestId),
      conversations: [{
        id: "conversation-1",
        sessionFile: "/sessions/one.jsonl",
        title: "One",
        cwd: "/workspace",
        modifiedAt: 2,
        messageCount: 0,
        status: "idle",
        runnable: true,
      }],
    });
    await flush();

    const stateCommand = sockets[1]?.commands()[1];
    expect(stateCommand).toMatchObject({
      type: "conversation.state",
      conversationId: "conversation-1",
    });
    sockets[1]?.server({
      type: "state",
      requestId: String(stateCommand?.requestId),
      conversation: conversation(4),
    });
    await flush();

    expect(client.getState()).toMatchObject({
      connection: "connected",
      selectedConversationId: "conversation-1",
      drafts: { "conversation-1": "local draft" },
    });
    expect(
      client.getState().conversations["conversation-1"]?.conversation.revision,
    ).toBe(4);
    client.disconnect();
  });

  it("requests an authoritative state when an event revision has a gap", async () => {
    const socket = new FakeSocket();
    let request = 0;
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => socket as unknown as WebSocket,
      requestId: () => `id-${++request}`,
    });
    client.connect();
    socket.server({ type: "ready", serverVersion: "1" });
    socket.server({
      type: "history",
      requestId: "id-1",
      conversations: [],
    });
    await flush();

    const create = client.send({ type: "conversation.create", cwd: "/workspace" });
    socket.server({
      type: "state",
      requestId: "id-2",
      conversation: conversation(2),
    });
    await create;
    socket.server({
      type: "conversation.status",
      conversationId: "conversation-1",
      revision: 4,
      payload: { status: "streaming" },
    });

    expect(socket.commands().at(-1)).toMatchObject({
      type: "conversation.state",
      conversationId: "conversation-1",
    });
    expect(client.getState().resyncConversationIds).toEqual(["conversation-1"]);
    client.disconnect();
  });

  it("times out commands and rejects pending work when disconnected", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    let request = 0;
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => socket as unknown as WebSocket,
      requestId: () => `request-${++request}`,
      commandTimeoutMs: 50,
    });
    client.connect();
    socket.server({ type: "ready", serverVersion: "1" });
    const pending = client.send({ type: "history.list" });
    const rejection = expect(pending).rejects.toBeInstanceOf(ChatTransportError);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    const interrupted = client.send({ type: "history.list" });
    const disconnected = expect(interrupted).rejects.toBeInstanceOf(ChatTransportError);
    socket.remoteClose();
    await disconnected;
    client.disconnect();
  });
});
