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
  ProtocolWorkspaceRepository,
} from "../../src/server/protocol.js";
import type {
  ConversationState,
  ConversationSummary,
  ServerMessage,
  WorkspaceSummary,
} from "../../src/shared/protocol.js";

const servers: ChatWcaServer[] = [];
const WORKSPACE_ID = "workspace-1";
const state: ConversationState = {
  id: "conversation-1",
  workspaceId: WORKSPACE_ID,
  sessionFile: "/sessions/conversation-1.jsonl",
  title: "Protocol test",
  cwd: "/workspace",
  model: null,
  status: "idle",
  createdAt: 1,
  lastActiveAt: 2,
  revision: 0,
  durable: true,
  contextUsage: null,
  messages: [],
  queue: { steering: [], followUp: [] },
  securityProfile: "unrestricted",
};
const defaultWorkspace: WorkspaceSummary = {
  id: WORKSPACE_ID,
  name: "Workspace",
  path: state.cwd,
  sessionStorage: "pi-default",
  sessionDirectory: null,
  securityProfile: "unrestricted",
  effectiveSecurityProfile: "unrestricted",
  createdAt: 1,
  updatedAt: 1,
  available: true,
  usable: true,
  policyIssue: null,
};

function fixedWorkspaces(
  rows: readonly WorkspaceSummary[] = [
    defaultWorkspace,
    { ...defaultWorkspace, id: "workspace-2", name: "Other workspace", path: "/other" },
  ],
): ProtocolWorkspaceRepository {
  return {
    list: () => [...rows],
    requireAvailable: (workspaceId) => {
      const workspace = rows.find(({ id }) => id === workspaceId);
      if (workspace === undefined) throw new Error("Unknown test workspace");
      return workspace;
    },
    requireUsable: (workspaceId) => {
      const workspace = rows.find(({ id }) => id === workspaceId);
      if (workspace === undefined) throw new Error("Unknown test workspace");
      return {
        workspaceId: workspace.id,
        cwd: workspace.path,
        sessionDirectory: workspace.sessionDirectory,
        securityProfile: workspace.effectiveSecurityProfile ?? "unrestricted",
      };
    },
    create: () => { throw new Error("Unexpected workspace create"); },
    update: () => { throw new Error("Unexpected workspace update"); },
    delete: () => { throw new Error("Unexpected workspace delete"); },
  };
}

const summary: ConversationSummary = {
  id: state.id,
  workspaceId: WORKSPACE_ID,
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
      fork: vi.fn(async () => ({
        conversation: reconnectState,
        editorText: "",
      })),
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
      hasLiveWorkspace: () => false,
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
    const config = loadConfig({ CHATWCA_DATA_DIR: "/tmp" }, "/tmp");
    const server = createChatWcaServer(config, "reconnect-test", {
      registry,
      history,
      workspaces: fixedWorkspaces(),
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
      JSON.stringify({
        type: "history.list",
        requestId: "reconnect-history",
        workspaceId: WORKSPACE_ID,
      }),
    );
    await expect(recoveredHistory).resolves.toMatchObject({
      type: "history",
      requestId: "reconnect-history",
      workspaceId: WORKSPACE_ID,
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
      fork: vi.fn(async () => ({ conversation: state, editorText: "" })),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      hasLiveWorkspace: () => false,
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
      list: vi.fn(async (workspace) => {
        listCount += 1;
        if (listCount > 2) await broadcastHistoryGate;
        return workspace.id === WORKSPACE_ID ? [summary] : [];
      }),
      resolve: vi.fn(async () => ({ summary })),
      delete: vi.fn(async () => [summary]),
    };
    const config = loadConfig({ CHATWCA_DATA_DIR: "/tmp" }, "/tmp");
    const server = createChatWcaServer(config, "protocol-test", {
      registry,
      history,
      workspaces: fixedWorkspaces(),
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;
    const first = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    const second = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await Promise.all([nextMessage(first), nextMessage(second)]);

    registryListener?.({
      type: "conversation.state-changed",
      record: { id: state.id, workspaceId: WORKSPACE_ID } as never,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(history.list).not.toHaveBeenCalled();

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
    first.send(JSON.stringify({
      type: "history.list",
      requestId: "history",
      workspaceId: WORKSPACE_ID,
    }));
    await expect(historyResponse).resolves.toEqual({
      type: "history",
      requestId: "history",
      workspaceId: WORKSPACE_ID,
      conversations: [summary],
    });

    const secondSubscription = nextMessage(second);
    second.send(JSON.stringify({
      type: "history.list",
      requestId: "history-other",
      workspaceId: "workspace-2",
    }));
    await expect(secondSubscription).resolves.toEqual({
      type: "history",
      requestId: "history-other",
      workspaceId: "workspace-2",
      conversations: [],
    });

    const firstEvent = nextMessage(first);
    const secondEvent = nextMessage(second);
    registryListener?.({
      type: "conversation.event",
      record: { id: state.id, workspaceId: WORKSPACE_ID } as never,
      event: {
        type: "conversation.status",
        workspaceId: WORKSPACE_ID,
        conversationId: state.id,
        revision: 1,
        payload: { status: "streaming" },
      },
    });
    await expect(Promise.all([firstEvent, secondEvent])).resolves.toEqual([
      {
        type: "conversation.status",
        workspaceId: WORKSPACE_ID,
        conversationId: state.id,
        revision: 1,
        payload: { status: "streaming" },
      },
      {
        type: "conversation.status",
        workspaceId: WORKSPACE_ID,
        conversationId: state.id,
        revision: 1,
        payload: { status: "streaming" },
      },
    ]);

    const firstHistory = nextMessage(first);
    const secondHistory = nextMessage(second);
    registryListener?.({
      type: "conversation.state-changed",
      record: { id: "other", workspaceId: "workspace-2" } as never,
    });
    await vi.waitFor(() => {
      expect(history.list).toHaveBeenCalledWith(defaultWorkspace);
      expect(history.list).toHaveBeenCalledWith(
        expect.objectContaining({ id: "workspace-2", path: "/other" }),
      );
    });
    releaseBroadcastHistory?.();
    await expect(Promise.all([firstHistory, secondHistory])).resolves.toEqual([
      {
        type: "history",
        workspaceId: WORKSPACE_ID,
        conversations: [summary],
      },
      {
        type: "history",
        workspaceId: "workspace-2",
        conversations: [],
      },
    ]);

    first.close();
    second.close();
  });

  it("replaces a socket's workspace subscription without scanning the deselected workspace on events", async () => {
    let registryListener: ConversationRegistryListener | undefined;
    const registry: ProtocolRegistry = {
      create: vi.fn(async () => ({ id: state.id })),
      open: vi.fn(async () => ({ id: state.id })),
      getState: vi.fn(async () => state),
      close: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ conversation: state, editorText: "" })),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      hasLiveWorkspace: () => false,
      subscribe: (listener) => {
        registryListener = listener;
        return () => { registryListener = undefined; };
      },
    };
    const history: ProtocolHistory = {
      list: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ summary })),
      delete: vi.fn(async () => []),
    };
    const workspaceA: WorkspaceSummary = {
      ...defaultWorkspace,
      id: "workspace-a",
      name: "A",
      path: "/canonical/a",
    };
    const workspaceB: WorkspaceSummary = {
      ...defaultWorkspace,
      id: "workspace-b",
      name: "B",
      path: "/canonical/b",
      createdAt: 2,
      updatedAt: 2,
    };
    const rows = [workspaceA, workspaceB];
    const workspaces = {
      list: () => rows,
      requireAvailable: (workspaceId: string) => rows.find(({ id }) => id === workspaceId)!,
      requireUsable: (workspaceId: string) => {
        const workspace = rows.find(({ id }) => id === workspaceId)!;
        return {
          workspaceId: workspace.id,
          cwd: workspace.path,
          sessionDirectory: workspace.sessionDirectory,
          securityProfile: "unrestricted" as const,
        };
      },
      create: () => workspaceA,
      update: () => workspaceA,
      delete: () => undefined,
    };
    const config = loadConfig({ CHATWCA_DATA_DIR: "/tmp" }, "/tmp");
    const server = createChatWcaServer(config, "subscription-test", {
      registry,
      history,
      workspaces,
    });
    servers.push(server);
    expect(history.list).not.toHaveBeenCalled();
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "ready" });
    expect(history.list).not.toHaveBeenCalled();

    for (const workspace of rows) {
      const response = nextMessage(socket);
      socket.send(JSON.stringify({
        type: "history.list",
        requestId: `select-${workspace.id}`,
        workspaceId: workspace.id,
      }));
      await expect(response).resolves.toMatchObject({
        type: "history",
        workspaceId: workspace.id,
      });
    }
    expect(history.list).toHaveBeenNthCalledWith(1, workspaceA);
    expect(history.list).toHaveBeenNthCalledWith(2, workspaceB);
    vi.mocked(history.list).mockClear();

    registryListener?.({
      type: "conversation.state-changed",
      record: { id: "conversation-a", workspaceId: workspaceA.id } as never,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(history.list).not.toHaveBeenCalled();

    const scopedRefresh = nextMessage(socket);
    registryListener?.({
      type: "conversation.state-changed",
      record: { id: "conversation-b", workspaceId: workspaceB.id } as never,
    });
    await vi.waitFor(() => expect(history.list).toHaveBeenCalledExactlyOnceWith(workspaceB));
    await expect(scopedRefresh).resolves.toEqual({
      type: "history",
      workspaceId: workspaceB.id,
      conversations: [],
    });
    socket.close();
  });

  it("correlates workspace mutations and sends exact authoritative broadcasts", async () => {
    const registry: ProtocolRegistry = {
      create: vi.fn(async () => ({ id: state.id })),
      open: vi.fn(async () => ({ id: state.id })),
      getState: vi.fn(async () => state),
      close: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ conversation: state, editorText: "" })),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      hasLiveWorkspace: () => false,
      subscribe: () => () => undefined,
    };
    const history: ProtocolHistory = {
      list: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ summary })),
      delete: vi.fn(async () => []),
    };
    let rows: WorkspaceSummary[] = [];
    const created: WorkspaceSummary = { ...defaultWorkspace };
    const createWorkspace = vi.fn(
      (input: { readonly sessionStorage: "pi-default" | "workspace" }) => {
        rows = [created];
        return created;
      },
    );
    const workspaces = {
      list: () => [...rows],
      requireAvailable: () => created,
      requireUsable: () => ({
        workspaceId: created.id,
        cwd: created.path,
        sessionDirectory: null,
        securityProfile: "unrestricted" as const,
      }),
      create: createWorkspace,
      update: () => created,
      delete: () => { rows = []; },
    };
    const config = loadConfig({ CHATWCA_DATA_DIR: "/tmp" }, "/tmp");
    const server = createChatWcaServer(config, "workspace-protocol-test", {
      registry,
      history,
      workspaces,
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;
    const first = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    const second = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await Promise.all([nextMessage(first), nextMessage(second)]);
    expect(history.list).not.toHaveBeenCalled();

    const listedWorkspaces = nextMessage(first);
    first.send(JSON.stringify({
      type: "workspace.list",
      requestId: "list-workspaces",
    }));
    await expect(listedWorkspaces).resolves.toEqual({
      type: "workspaces",
      requestId: "list-workspaces",
      workspaces: [],
    });
    expect(history.list).not.toHaveBeenCalled();

    const correlatedCreate = nextMessage(first);
    const createBroadcast = nextMessage(second);
    first.send(JSON.stringify({
      type: "workspace.create",
      requestId: "create-workspace",
      name: "Workspace",
      path: "/workspace",
      sessionStorage: "pi-default",
      securityProfile: "unrestricted",
    }));
    await expect(Promise.all([correlatedCreate, createBroadcast])).resolves.toEqual([
      { type: "workspaces", requestId: "create-workspace", workspaces: [created] },
      { type: "workspaces", workspaces: [created] },
    ]);
    expect(createWorkspace).toHaveBeenCalledExactlyOnceWith({
      name: "Workspace",
      path: "/workspace",
      sessionStorage: "pi-default",
      securityProfile: "unrestricted",
    });

    const correlatedUpdate = nextMessage(first);
    const updateBroadcast = nextMessage(second);
    first.send(JSON.stringify({
      type: "workspace.update",
      requestId: "update-workspace",
      workspaceId: WORKSPACE_ID,
      name: "Renamed workspace",
    }));
    await expect(Promise.all([correlatedUpdate, updateBroadcast])).resolves.toEqual([
      { type: "workspaces", requestId: "update-workspace", workspaces: [created] },
      { type: "workspaces", workspaces: [created] },
    ]);

    const deleteMessages: ServerMessage[] = [];
    const deleteComplete = new Promise<void>((resolve) => {
      first.on("message", (data) => {
        deleteMessages.push(JSON.parse(data.toString()) as ServerMessage);
        if (deleteMessages.length === 2) resolve();
      });
    });
    const deleteBroadcast = nextMessage(second);
    first.send(JSON.stringify({
      type: "workspace.delete",
      requestId: "delete-workspace",
      workspaceId: WORKSPACE_ID,
    }));
    await Promise.all([deleteComplete, deleteBroadcast]);
    expect(deleteMessages).toEqual([
      { type: "ack", requestId: "delete-workspace", command: "workspace.delete" },
      { type: "workspaces", workspaces: [] },
    ]);
    await expect(deleteBroadcast).resolves.toEqual({ type: "workspaces", workspaces: [] });
    expect(history.list).not.toHaveBeenCalled();
    expect(history.resolve).not.toHaveBeenCalled();
    expect(history.delete).not.toHaveBeenCalled();

    first.close();
    second.close();
  });

  it("rejects workspace path changes and deletion while a live runtime owns it", async () => {
    const update = vi.fn();
    const remove = vi.fn();
    let row = defaultWorkspace;
    const registry: ProtocolRegistry = {
      create: vi.fn(async () => ({ id: state.id })),
      open: vi.fn(async () => ({ id: state.id })),
      getState: vi.fn(async () => state),
      close: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ conversation: state, editorText: "" })),
      prompt: vi.fn(async () => undefined),
      abort: vi.fn(async () => undefined),
      hasLiveWorkspace: (workspaceId) => workspaceId === WORKSPACE_ID,
      subscribe: () => () => undefined,
    };
    const history: ProtocolHistory = {
      list: vi.fn(async () => []),
      resolve: vi.fn(async () => ({ summary })),
      delete: vi.fn(async () => []),
    };
    const workspaces: ProtocolWorkspaceRepository = {
      list: () => [row],
      requireAvailable: () => row,
      requireUsable: () => ({
        workspaceId: row.id,
        cwd: row.path,
        sessionDirectory: row.sessionDirectory,
        securityProfile: "unrestricted",
      }),
      create: () => row,
      update: (workspaceId, changes) => {
        update(workspaceId, changes);
        row = { ...row, ...changes };
        return row;
      },
      delete: remove,
    };
    const server = createChatWcaServer(
      loadConfig({ CHATWCA_DATA_DIR: "/tmp" }, "/tmp"),
      "workspace-busy-integration",
      { registry, history, workspaces },
    );
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "ready" });

    const rename = nextMessage(socket);
    socket.send(JSON.stringify({
      type: "workspace.update",
      requestId: "rename-live",
      workspaceId: WORKSPACE_ID,
      name: "Renamed while live",
    }));
    await expect(rename).resolves.toMatchObject({
      type: "workspaces",
      requestId: "rename-live",
      workspaces: [{ name: "Renamed while live", path: defaultWorkspace.path }],
    });

    for (const command of [
      {
        type: "workspace.update",
        requestId: "repath-live",
        workspaceId: WORKSPACE_ID,
        path: "/replacement",
      },
      {
        type: "workspace.delete",
        requestId: "delete-live",
        workspaceId: WORKSPACE_ID,
      },
    ]) {
      const response = nextMessage(socket);
      socket.send(JSON.stringify(command));
      await expect(response).resolves.toMatchObject({
        type: "error",
        requestId: command.requestId,
        code: "workspace_busy",
      });
    }

    expect(update).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(history.list).not.toHaveBeenCalled();
    socket.close();
  });

  it("rejects oversized fragmented payloads inside ws before command dispatch", async () => {
    const prompt = vi.fn(async () => undefined);
    const registry: ProtocolRegistry = {
      create: vi.fn(async () => ({ id: state.id })),
      open: vi.fn(async () => ({ id: state.id })),
      getState: vi.fn(async () => state),
      close: vi.fn(async () => undefined),
      fork: vi.fn(async () => ({ conversation: state, editorText: "" })),
      prompt,
      abort: vi.fn(async () => undefined),
      hasLiveWorkspace: () => false,
      subscribe: () => () => undefined,
    };
    const history: ProtocolHistory = {
      list: vi.fn(async () => [summary]),
      resolve: vi.fn(async () => ({ summary })),
      delete: vi.fn(async () => []),
    };
    const config = loadConfig({ CHATWCA_DATA_DIR: "/tmp" }, "/tmp");
    const server = createChatWcaServer(config, "payload-limit-test", {
      registry,
      history,
      workspaces: fixedWorkspaces(),
      maxInboundMessageBytes: 128,
      onInternalError: () => undefined,
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await expect(nextMessage(socket)).resolves.toMatchObject({ type: "ready" });

    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    const oversized = JSON.stringify({
      type: "prompt.submit",
      requestId: "oversized",
      conversationId: state.id,
      text: "x".repeat(256),
      images: [],
    });
    const midpoint = Math.floor(oversized.length / 2);
    socket.send(oversized.slice(0, midpoint), { fin: false });
    socket.send(oversized.slice(midpoint), { fin: true });

    await expect(closed).resolves.toBe(1009);
    expect(prompt).not.toHaveBeenCalled();
  });
});
