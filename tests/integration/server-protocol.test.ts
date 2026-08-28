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
