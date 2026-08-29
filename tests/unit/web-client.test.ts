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

const workspace = {
  id: "workspace-1",
  name: "Workspace",
  path: "/workspace",
  sessionStorage: "pi-default",
  sessionDirectory: null,
  createdAt: 1,
  updatedAt: 1,
  available: true,
} as const;

function conversation(revision = 0): ConversationState {
  return {
    id: "conversation-1",
    workspaceId: "workspace-1",
    sessionFile: "/sessions/one.jsonl",
    title: "One",
    cwd: "/workspace",
    model: null,
    status: "idle",
    createdAt: 1,
    lastActiveAt: 1,
    revision,
    durable: true,
    contextUsage: null,
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
  it("stops reconnecting and reports an announced server shutdown", async () => {
    const sockets: FakeSocket[] = [];
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      initialReconnectDelayMs: 0,
      maxReconnectDelayMs: 0,
    });
    client.connect();
    const socket = sockets[0];
    socket?.server({ type: "ready", serverVersion: "1" });

    socket?.server({ type: "server.shutdown", gracePeriodMs: 1000 });
    socket?.remoteClose();
    await flush();

    expect(client.getState()).toMatchObject({
      connection: "disconnected",
      lastError: {
        code: "shutting_down",
        message: "The server is shutting down.",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sockets).toHaveLength(1);
  });

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

    const workspaceCommand = socket.commands()[0];
    expect(workspaceCommand).toEqual({ type: "workspace.list", requestId: "id-1" });
    socket.server({
      type: "workspaces",
      requestId: "id-1",
      workspaces: [],
    });
    await flush();

    const create = client.send({
      type: "conversation.create",
      workspaceId: "workspace-1",
    });
    expect(socket.commands().at(-1)).toEqual({
      type: "conversation.create",
      workspaceId: "workspace-1",
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

  it("requests history only on selection and ignores an out-of-order stale workspace", async () => {
    let request = 0;
    const socket = new FakeSocket();
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => socket as unknown as WebSocket,
      requestId: () => `switch-${++request}`,
    });
    const workspaceTwo = {
      ...workspace,
      id: "workspace-2",
      name: "Other",
      path: "/other",
    };
    client.connect();
    socket.server({ type: "ready", serverVersion: "1" });
    socket.server({
      type: "workspaces",
      requestId: "switch-1",
      workspaces: [workspace, workspaceTwo],
    });
    await flush();
    expect(socket.commands()).toHaveLength(1);

    const selectOne = client.selectWorkspace("workspace-1");
    const selectTwo = client.selectWorkspace("workspace-2");
    expect(socket.commands().slice(1)).toMatchObject([
      { type: "history.list", workspaceId: "workspace-1" },
      { type: "history.list", workspaceId: "workspace-2" },
    ]);
    socket.server({
      type: "history",
      requestId: "switch-3",
      workspaceId: "workspace-2",
      conversations: [],
    });
    socket.server({
      type: "history",
      requestId: "switch-2",
      workspaceId: "workspace-1",
      conversations: [{
        id: "stale",
        workspaceId: "workspace-1",
        sessionFile: "/sessions/stale.jsonl",
        title: "Stale",
        cwd: "/workspace",
        modifiedAt: 1,
        messageCount: 1,
        status: "closed",
        runnable: true,
      }],
    });
    await Promise.all([selectOne, selectTwo]);

    expect(client.getState()).toMatchObject({
      selectedWorkspaceId: "workspace-2",
      historyWorkspaceId: "workspace-2",
      history: [],
    });
    client.disconnect();
  });

  it("rejects a correlated history response for the wrong workspace", async () => {
    const socket = new FakeSocket();
    let request = 0;
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => socket as unknown as WebSocket,
      requestId: () => `match-${++request}`,
    });
    client.connect();
    socket.server({ type: "ready", serverVersion: "1" });
    socket.server({ type: "workspaces", requestId: "match-1", workspaces: [workspace] });
    await flush();

    const selected = client.selectWorkspace("workspace-1");
    socket.server({
      type: "history",
      requestId: "match-2",
      workspaceId: "workspace-other",
      conversations: [],
    });
    await expect(selected).rejects.toBeInstanceOf(ChatTransportError);
    expect(client.getState().historyWorkspaceId).toBeNull();
    client.disconnect();
  });

  it("selects a successful fork and prefills only its local draft without submitting", async () => {
    let request = 0;
    const socket = new FakeSocket();
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => socket as unknown as WebSocket,
      requestId: () => `fork-${++request}`,
    });
    client.connect();
    socket.server({ type: "ready", serverVersion: "1" });
    socket.server({ type: "workspaces", requestId: "fork-1", workspaces: [workspace] });
    await flush();
    const selection = client.selectWorkspace("workspace-1");
    socket.server({
      type: "history",
      requestId: "fork-2",
      workspaceId: "workspace-1",
      conversations: [{
        id: "conversation-1",
        workspaceId: "workspace-1",
        sessionFile: "/sessions/one.jsonl",
        title: "One",
        cwd: "/workspace",
        modifiedAt: 2,
        messageCount: 1,
        status: "idle",
        runnable: true,
      }],
    });
    await selection;
    socket.server({
      type: "state",
      conversation: {
        ...conversation(2),
        messages: [{
          entryId: "user-entry-1",
          role: "user",
          blocks: [{ type: "text", text: "Keep the source" }],
          forkEligible: true,
        }],
      },
    });
    client.selectConversation("conversation-1");
    client.setDraft("conversation-1", "source draft");

    const pending = client.forkConversation("conversation-1", "user-entry-1");
    expect(socket.commands().at(-1)).toEqual({
      type: "conversation.fork",
      requestId: "fork-3",
      conversationId: "conversation-1",
      entryId: "user-entry-1",
    });

    const forked = {
      ...conversation(0),
      id: "conversation-2",
      sessionFile: "/sessions/two.jsonl",
      title: "Forked",
      messages: [],
    };
    socket.server({
      type: "state",
      requestId: "fork-3",
      conversation: forked,
      editorText: "Keep the source",
    });
    await expect(pending).resolves.toMatchObject({ conversation: forked });

    expect(client.getState()).toMatchObject({
      selectedConversationId: "conversation-2",
      drafts: {
        "conversation-1": "source draft",
        "conversation-2": "Keep the source",
      },
    });
    expect(
      client.getState().conversations["conversation-1"]?.conversation.messages,
    ).toMatchObject([{ entryId: "user-entry-1", blocks: [{ text: "Keep the source" }] }]);
    expect(client.getState().conversations["conversation-2"]?.conversation).toEqual(forked);
    expect(client.getState().history).toMatchObject([{
      id: "conversation-1",
      title: "One",
    }]);
    expect(socket.commands().filter((command) =>
      typeof command.type === "string" && command.type.startsWith("prompt."),
    )).toEqual([]);

    client.setDraft("conversation-2", "Edited copied prompt");
    expect(client.getState().drafts).toMatchObject({
      "conversation-1": "source draft",
      "conversation-2": "Edited copied prompt",
    });
    client.setDraft("conversation-2", "");
    expect(client.getState().drafts["conversation-2"]).toBe("");
    client.disconnect();
  });

  it("selects a rewind fork and removes the replaced source projection and draft", async () => {
    let request = 0;
    const socket = new FakeSocket();
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => socket as unknown as WebSocket,
      requestId: () => `rewind-${++request}`,
    });
    client.connect();
    socket.server({ type: "ready", serverVersion: "1" });
    socket.server({ type: "workspaces", requestId: "rewind-1", workspaces: [workspace] });
    await flush();
    const selection = client.selectWorkspace("workspace-1");
    socket.server({
      type: "history",
      requestId: "rewind-2",
      workspaceId: "workspace-1",
      conversations: [{
        id: "conversation-1",
        workspaceId: "workspace-1",
        sessionFile: "/sessions/one.jsonl",
        title: "One",
        cwd: "/workspace",
        modifiedAt: 2,
        messageCount: 1,
        status: "idle",
        runnable: true,
      }],
    });
    await selection;
    socket.server({ type: "state", conversation: conversation() });
    client.selectConversation("conversation-1");
    client.setDraft("conversation-1", "discard this draft");

    const pending = client.rewindConversation("conversation-1", "user-entry-1");
    expect(socket.commands().at(-1)).toEqual({
      type: "conversation.rewind",
      requestId: "rewind-3",
      conversationId: "conversation-1",
      entryId: "user-entry-1",
    });

    const rewound = {
      ...conversation(0),
      id: "conversation-2",
      sessionFile: "/sessions/two.jsonl",
      title: "Rewound",
      messages: [],
    };
    socket.server({
      type: "state",
      requestId: "rewind-3",
      conversation: rewound,
      editorText: "Try this prompt again",
    });
    await expect(pending).resolves.toMatchObject({ conversation: rewound });

    expect(client.getState()).toMatchObject({
      selectedConversationId: "conversation-2",
      drafts: { "conversation-2": "Try this prompt again" },
    });
    expect(client.getState().drafts).not.toHaveProperty("conversation-1");
    expect(client.getState().conversations).not.toHaveProperty("conversation-1");
    expect(client.getState().conversations["conversation-2"]?.conversation).toEqual(rewound);
    expect(client.getState().history).toEqual([]);
    client.disconnect();
  });

  it("does not change selection or drafts when a fork fails", async () => {
    let request = 0;
    const socket = new FakeSocket();
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => socket as unknown as WebSocket,
      requestId: () => `failed-fork-${++request}`,
    });
    client.connect();
    socket.server({ type: "ready", serverVersion: "1" });
    socket.server({
      type: "workspaces",
      requestId: "failed-fork-1",
      workspaces: [workspace],
    });
    await flush();
    const selection = client.selectWorkspace("workspace-1");
    socket.server({
      type: "history",
      requestId: "failed-fork-2",
      workspaceId: "workspace-1",
      conversations: [],
    });
    await selection;
    socket.server({ type: "state", conversation: conversation() });
    client.selectConversation("conversation-1");
    client.setDraft("conversation-1", "unchanged");

    const pending = client.forkConversation("conversation-1", "user-entry-1");
    socket.server({
      type: "error",
      requestId: "failed-fork-3",
      code: "fork_source_busy",
      message: "A conversation cannot be forked while it is running.",
    });

    await expect(pending).rejects.toMatchObject({ code: "fork_source_busy" });
    expect(client.getState()).toMatchObject({
      selectedConversationId: "conversation-1",
      drafts: { "conversation-1": "unchanged" },
    });
    client.disconnect();
  });

  it("serializes prepared image payloads into prompt commands", async () => {
    let request = 0;
    const socket = new FakeSocket();
    const client = new ChatSocketClient({
      url: "ws://test/ws",
      webSocketFactory: () => socket as unknown as WebSocket,
      requestId: () => `image-${++request}`,
    });
    client.connect();
    socket.server({ type: "ready", serverVersion: "1" });
    socket.server({ type: "workspaces", requestId: "image-1", workspaces: [] });
    await flush();

    const image = {
      mimeType: "image/webp" as const,
      encoding: "base64" as const,
      data: "AQID",
      name: "diagram.webp",
      width: 2048,
      height: 1024,
      byteSize: 3,
    };
    const pending = client.send({
      type: "prompt.submit",
      conversationId: "conversation-1",
      text: "Inspect this",
      images: [image],
    });
    expect(socket.commands().at(-1)).toEqual({
      type: "prompt.submit",
      requestId: "image-2",
      conversationId: "conversation-1",
      text: "Inspect this",
      images: [image],
    });
    socket.server({
      type: "ack",
      requestId: "image-2",
      command: "prompt.submit",
    });
    await expect(pending).resolves.toMatchObject({ type: "ack" });
    client.disconnect();
  });

  it("reconnects without a selection by listing workspaces only", async () => {
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
      requestId: () => `unselected-${++request}`,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 10,
    });

    client.connect();
    sockets[0]?.server({ type: "ready", serverVersion: "1" });
    sockets[0]?.server({
      type: "workspaces",
      requestId: "unselected-1",
      workspaces: [workspace],
    });
    await flush();
    expect(sockets[0]?.commands()).toEqual([
      { type: "workspace.list", requestId: "unselected-1" },
    ]);
    expect(client.getState().selectedWorkspaceId).toBeNull();

    sockets[0]?.remoteClose();
    await vi.advanceTimersByTimeAsync(10);
    sockets[1]?.server({ type: "ready", serverVersion: "1" });
    sockets[1]?.server({
      type: "workspaces",
      requestId: "unselected-2",
      workspaces: [workspace],
    });
    await flush();

    expect(sockets[1]?.commands()).toEqual([
      { type: "workspace.list", requestId: "unselected-2" },
    ]);
    expect(client.getState()).toMatchObject({
      connection: "connected",
      selectedWorkspaceId: null,
      history: [],
      historyWorkspaceId: null,
    });
    client.disconnect();
  });

  it("reconnects with bounded backoff and reloads only selected history and state", async () => {
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
    await client.selectWorkspace("workspace-1");
    client.connect();

    sockets[0]?.server({ type: "ready", serverVersion: "1" });
    expect(sockets[0]?.commands()).toMatchObject([{ type: "workspace.list" }]);
    sockets[0]?.server({ type: "workspaces", requestId: "id-1", workspaces: [workspace] });
    await flush();
    expect(sockets[0]?.commands()[1]).toMatchObject({
      type: "history.list",
      workspaceId: "workspace-1",
    });
    sockets[0]?.server({
      type: "history",
      requestId: "id-2",
      workspaceId: "workspace-1",
      conversations: [{
        id: "conversation-1",
        workspaceId: "workspace-1",
        sessionFile: "/sessions/one.jsonl",
        title: "One",
        cwd: "/workspace",
        modifiedAt: 2,
        messageCount: 1,
        status: "idle",
        runnable: true,
      }],
    });
    await flush();
    sockets[0]?.server({ type: "state", conversation: conversation(2) });
    client.selectConversation("conversation-1");
    client.setDraft("conversation-1", "local draft");

    sockets[0]?.remoteClose();
    expect(client.getState().connection).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(2);

    sockets[1]?.server({ type: "ready", serverVersion: "1" });
    sockets[1]?.server({ type: "workspaces", requestId: "id-3", workspaces: [workspace] });
    await flush();
    expect(sockets[1]?.commands()[1]).toMatchObject({
      type: "history.list",
      workspaceId: "workspace-1",
    });
    sockets[1]?.server({
      type: "history",
      requestId: "id-4",
      workspaceId: "workspace-1",
      conversations: [{
        id: "conversation-1",
        workspaceId: "workspace-1",
        sessionFile: "/sessions/one.jsonl",
        title: "One",
        cwd: "/workspace",
        modifiedAt: 3,
        messageCount: 1,
        status: "idle",
        runnable: true,
      }],
    });
    await flush();
    expect(sockets[1]?.commands()[2]).toMatchObject({
      type: "conversation.state",
      conversationId: "conversation-1",
    });
    sockets[1]?.server({
      type: "state",
      requestId: "id-5",
      conversation: conversation(3),
    });
    await flush();

    expect(client.getState()).toMatchObject({
      connection: "connected",
      selectedWorkspaceId: "workspace-1",
      selectedConversationId: "conversation-1",
      historyWorkspaceId: "workspace-1",
      drafts: { "conversation-1": "local draft" },
    });
    expect(sockets[1]?.commands()).toHaveLength(3);
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
      type: "workspaces",
      requestId: "id-1",
      workspaces: [],
    });
    await flush();

    const create = client.send({
      type: "conversation.create",
      workspaceId: "workspace-1",
    });
    socket.server({
      type: "state",
      requestId: "id-2",
      conversation: conversation(2),
    });
    await create;
    socket.server({
      type: "conversation.status",
      workspaceId: "workspace-1",
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
    const pending = client.send({ type: "history.list", workspaceId: "workspace-1" });
    const rejection = expect(pending).rejects.toBeInstanceOf(ChatTransportError);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;

    const interrupted = client.send({ type: "history.list", workspaceId: "workspace-1" });
    const disconnected = expect(interrupted).rejects.toBeInstanceOf(ChatTransportError);
    socket.remoteClose();
    await disconnected;
    client.disconnect();
  });
});
