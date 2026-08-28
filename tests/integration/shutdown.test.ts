import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { loadConfig } from "../../src/server/config.js";
import type { ConversationRegistryListener } from "../../src/server/conversation-registry.js";
import {
  createChatWcaServer,
  installShutdownSignalHandlers,
  type ChatWcaServer,
  type ShutdownSignalTarget,
} from "../../src/server/index.js";
import type {
  ProtocolHistory,
  ProtocolRegistry,
} from "../../src/server/protocol.js";
import {
  WEBSOCKET_RESTART_CLOSE_CODE,
  WEBSOCKET_RESTART_CLOSE_REASON,
  type ShutdownRuntimeOwner,
} from "../../src/server/shutdown.js";
import type { ConversationState } from "../../src/shared/protocol.js";

const state: ConversationState = {
  id: "shutdown-conversation",
  workspaceId: "shutdown-workspace",
  sessionFile: "/sessions/shutdown.jsonl",
  title: "Shutdown test",
  cwd: "/workspace",
  model: null,
  status: "streaming",
  createdAt: 1,
  lastActiveAt: 2,
  revision: 1,
  durable: true,
  messages: [],
  queue: { steering: [], followUp: [] },
};

async function listen(server: ChatWcaServer): Promise<number> {
  await new Promise<void>((resolve) =>
    server.httpServer.listen(0, "127.0.0.1", resolve),
  );
  return (server.httpServer.address() as AddressInfo).port;
}

function nextJson(socket: WebSocket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as unknown);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

describe("server graceful shutdown", () => {
  it.each(["SIGINT", "SIGTERM"] as const)(
    "coalesces %s signal handling through bounded server shutdown",
    async (signal) => {
      const listeners = new Map<string, Set<() => void>>();
      const target: ShutdownSignalTarget = {
        on: (name, listener) => {
          const registered = listeners.get(name) ?? new Set();
          registered.add(listener);
          listeners.set(name, registered);
        },
        off: (name, listener) => listeners.get(name)?.delete(listener),
      };
      const shutdown = vi.fn(async () => undefined);
      const exit = vi.fn();
      const remove = installShutdownSignalHandlers({ shutdown }, target, exit);

      for (const listener of listeners.get(signal) ?? []) listener();
      for (const listener of listeners.get("SIGTERM") ?? []) listener();
      await Promise.resolve();

      expect(shutdown).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(0);

      remove();
      expect(listeners.get("SIGINT")?.size ?? 0).toBe(0);
      expect(listeners.get("SIGTERM")?.size ?? 0).toBe(0);
    },
  );

  it("notifies and closes clients, aborts active work, disposes, and stops HTTP idempotently", async () => {
    const calls: string[] = [];
    const unsubscribe = vi.fn(() => calls.push("unsubscribe"));
    const registry: ProtocolRegistry = {
      create: vi.fn(async () => ({ id: state.id })),
      open: vi.fn(async () => ({ id: state.id })),
      getState: vi.fn(async () => state),
      close: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ conversation: state, editorText: "" })),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      hasLiveWorkspace: vi.fn(() => false),
      subscribe: (_listener: ConversationRegistryListener) => unsubscribe,
    };
    const history: ProtocolHistory = {
      list: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ summary: { sessionFile: state.sessionFile } })),
      delete: vi.fn(async () => []),
    };
    const owner: ShutdownRuntimeOwner = {
      beginShutdown: () => calls.push("begin"),
      abortActive: async () => {
        calls.push("abort");
      },
      dispose: async () => {
        calls.push("dispose");
      },
    };
    const closeStorage = vi.fn(() => calls.push("close-storage"));
    const config = loadConfig(
      {
        CHATWCA_DATA_DIR: "/tmp",
        CHATWCA_SHUTDOWN_GRACE_MS: "500",
      },
      "/tmp",
    );
    const server = createChatWcaServer(config, "shutdown-test", {
      registry,
      history,
      workspaces: {
        list: () => [],
        requireAvailable: (workspaceId) => ({ id: workspaceId, path: "/tmp" }),
        create: () => { throw new Error("Unexpected workspace create"); },
        update: () => { throw new Error("Unexpected workspace update"); },
        delete: () => { throw new Error("Unexpected workspace delete"); },
      },
      shutdown: owner,
      closeStorage,
    });
    const port = await listen(server);
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await expect(nextJson(socket)).resolves.toMatchObject({ type: "ready" });

    const notice = nextJson(socket);
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) =>
        resolve({ code, reason: reason.toString() })
      );
    });
    const first = server.shutdown();
    const second = server.shutdown();

    expect(first).toBe(second);
    expect(server.isShuttingDown).toBe(true);
    expect(calls[0]).toBe("begin");
    await expect(notice).resolves.toEqual({
      type: "server.shutdown",
      gracePeriodMs: 500,
    });
    await expect(closed).resolves.toEqual({
      code: WEBSOCKET_RESTART_CLOSE_CODE,
      reason: WEBSOCKET_RESTART_CLOSE_REASON,
    });
    await first;

    expect(calls).toEqual([
      "begin",
      "unsubscribe",
      "abort",
      "dispose",
      "close-storage",
    ]);
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(closeStorage).toHaveBeenCalledOnce();
    expect(server.httpServer.listening).toBe(false);
    expect(server.webSocketServer.clients.size).toBe(0);
  });
});
