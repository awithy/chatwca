import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { loadConfig } from "../../src/server/config.js";
import type { ConversationRegistryListener } from "../../src/server/conversation-registry.js";
import {
  createChatWcaServer,
  type ChatWcaServer,
} from "../../src/server/index.js";
import type {
  ProtocolHistory,
  ProtocolRegistry,
} from "../../src/server/protocol.js";
import type {
  ConversationState,
  ConversationSummary,
  ServerMessage,
} from "../../src/shared/protocol.js";

const servers: ChatWcaServer[] = [];
const state: ConversationState = {
  id: "conversation-1",
  sessionFile: "/sessions/conversation-1.jsonl",
  title: "Protocol test",
  cwd: "/workspace",
  model: null,
  status: "idle",
  createdAt: 1,
  lastActiveAt: 2,
  revision: 0,
  durable: true,
  messages: [],
  queue: { steering: [], followUp: [] },
};
const summary: ConversationSummary = {
  id: state.id,
  sessionFile: state.sessionFile,
  title: state.title,
  cwd: state.cwd,
  modifiedAt: 2,
  messageCount: 0,
  status: "idle",
  runnable: true,
};

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as ServerMessage);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function closeServer(server: ChatWcaServer): Promise<void> {
  for (const client of server.webSocketServer.clients) client.terminate();
  await new Promise<void>((resolve) => server.webSocketServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe("WebSocket command server", () => {
  it("keeps a run alive without clients and recovers history and state after reconnect", async () => {
    let reconnectState: ConversationState = {
      ...state,
      title: "Reconnect test",
    };
    let releaseRun: (() => void) | undefined;
    const runGate = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    let markRunComplete: (() => void) | undefined;
    const runComplete = new Promise<void>((resolve) => {
      markRunComplete = resolve;
    });
    const abort = vi.fn(async () => undefined);
    const registry: ProtocolRegistry = {
      create: vi.fn(async () => ({ id: reconnectState.id })),
      open: vi.fn(async () => ({ id: reconnectState.id })),
      getState: vi.fn(async () => reconnectState),
      close: vi.fn(async () => undefined),
      prompt: vi.fn(async () => {
        reconnectState = {
          ...reconnectState,
          status: "streaming",
          revision: 1,
        };
        void runGate.then(() => {
          reconnectState = {
            ...reconnectState,
            status: "idle",
            revision: 3,
            messages: [
              {
                entryId: "user-1",
                role: "user",
                blocks: [{ type: "text", text: "Keep going" }],
              },
              {
                entryId: "assistant-1",
                role: "assistant",
                blocks: [{ type: "text", text: "Finished in the background" }],
                stopReason: "stop",
              },
            ],
          };
          markRunComplete?.();
        });
      }),
      abort,
      subscribe: () => () => undefined,
    };
    const history: ProtocolHistory = {
      list: vi.fn(async () => [
        {
          ...summary,
          title: reconnectState.title,
          modifiedAt: reconnectState.lastActiveAt,
          messageCount: reconnectState.messages.length,
          status:
            reconnectState.status === "aborting"
              ? "streaming"
              : reconnectState.status,
        },
      ]),
      resolve: vi.fn(async () => ({ summary })),
      delete: vi.fn(async () => []),
    };
    const config = loadConfig({ CHATWCA_DEFAULT_CWD: "/tmp" }, "/tmp");
    const server = createChatWcaServer(config, "reconnect-test", {
      registry,
      history,
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;

    const first = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await expect(nextMessage(first)).resolves.toMatchObject({ type: "ready" });
    const accepted = nextMessage(first);
    first.send(
      JSON.stringify({
        type: "prompt.submit",
        requestId: "prompt-before-disconnect",
        conversationId: reconnectState.id,
        text: "Keep going",
        images: [],
      }),
    );
    await expect(accepted).resolves.toEqual({
      type: "ack",
      requestId: "prompt-before-disconnect",
      command: "prompt.submit",
    });
    expect(reconnectState.status).toBe("streaming");

    const firstClosed = new Promise<void>((resolve) =>
      first.once("close", resolve),
    );
    first.close();
    await firstClosed;
    await vi.waitFor(() => expect(server.webSocketServer.clients.size).toBe(0));

    releaseRun?.();
    await runComplete;
    expect(abort).not.toHaveBeenCalled();
    expect(reconnectState.status).toBe("idle");

    const second = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await expect(nextMessage(second)).resolves.toEqual({
      type: "ready",
      serverVersion: "reconnect-test",
    });

    const recoveredHistory = nextMessage(second);
    second.send(
      JSON.stringify({ type: "history.list", requestId: "reconnect-history" }),
    );
    await expect(recoveredHistory).resolves.toMatchObject({
      type: "history",
      requestId: "reconnect-history",
      conversations: [
        { id: reconnectState.id, status: "idle", messageCount: 2 },
      ],
    });

    const recoveredState = nextMessage(second);
    second.send(
      JSON.stringify({
        type: "conversation.state",
        requestId: "reconnect-state",
        conversationId: reconnectState.id,
      }),
    );
    await expect(recoveredState).resolves.toEqual({
      type: "state",
      requestId: "reconnect-state",
      conversation: reconnectState,
    });
    second.close();
  });

  it("correlates errors/results and broadcasts registry events and history", async () => {
    let registryListener: ConversationRegistryListener | undefined;
    const registry: ProtocolRegistry = {
      create: vi.fn(async () => ({ id: state.id })),
      open: vi.fn(async () => ({ id: state.id })),
      getState: vi.fn(async () => state),
      close: vi.fn(async () => undefined),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      subscribe: (listener) => {
        registryListener = listener;
        return () => {
          registryListener = undefined;
        };
      },
    };
    let listCount = 0;
    let releaseBroadcastHistory: (() => void) | undefined;
    const broadcastHistoryGate = new Promise<void>((resolve) => {
      releaseBroadcastHistory = resolve;
    });
    const history: ProtocolHistory = {
      list: vi.fn(async () => {
        listCount += 1;
        if (listCount > 1) await broadcastHistoryGate;
        return [summary];
      }),
      resolve: vi.fn(async () => ({ summary })),
      delete: vi.fn(async () => [summary]),
    };
    const config = loadConfig({ CHATWCA_DEFAULT_CWD: "/tmp" }, "/tmp");
    const server = createChatWcaServer(config, "protocol-test", {
      registry,
      history,
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;
    const first = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    const second = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await Promise.all([nextMessage(first), nextMessage(second)]);

    const invalidResponse = nextMessage(first);
    first.send(
      JSON.stringify({ type: "history.list", requestId: "bad", extra: true }),
    );
    await expect(invalidResponse).resolves.toEqual({
      type: "error",
      requestId: "bad",
      code: "invalid_command",
      message: "The command is invalid.",
    });

    const historyResponse = nextMessage(first);
    first.send(JSON.stringify({ type: "history.list", requestId: "history" }));
    await expect(historyResponse).resolves.toEqual({
      type: "history",
      requestId: "history",
      conversations: [summary],
    });

    const firstEvent = nextMessage(first);
    const secondEvent = nextMessage(second);
    registryListener?.({
      type: "conversation.event",
      record: { id: state.id } as never,
      event: {
        type: "conversation.status",
        conversationId: state.id,
        revision: 1,
        payload: { status: "streaming" },
      },
    });
    await expect(Promise.all([firstEvent, secondEvent])).resolves.toEqual([
      {
        type: "conversation.status",
        conversationId: state.id,
        revision: 1,
        payload: { status: "streaming" },
      },
      {
        type: "conversation.status",
        conversationId: state.id,
        revision: 1,
        payload: { status: "streaming" },
      },
    ]);

    const firstHistory = nextMessage(first);
    const secondHistory = nextMessage(second);
    releaseBroadcastHistory?.();
    await expect(Promise.all([firstHistory, secondHistory])).resolves.toEqual([
      { type: "history", conversations: [summary] },
      { type: "history", conversations: [summary] },
    ]);

    first.close();
    second.close();
  });
});
