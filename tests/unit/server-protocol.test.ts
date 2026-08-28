import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import type {
  ClientCommand,
  ConversationState,
  ConversationSummary,
  WorkspaceSummary,
} from "../../src/shared/protocol.js";
import {
  decodeClientCommand,
  dispatchClientCommand,
  type ProtocolHistory,
  type ProtocolRegistry,
  type ProtocolWorkspaceRepository,
} from "../../src/server/protocol.js";

const workspace: WorkspaceSummary = {
  id: "workspace-1",
  name: "Workspace",
  path: "/workspace",
  createdAt: 1,
  updatedAt: 1,
  available: true,
};
const state: ConversationState = {
  id: "conversation-1",
  workspaceId: workspace.id,
  sessionFile: "/sessions/conversation-1.jsonl",
  title: "Test",
  cwd: workspace.path,
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
  workspaceId: workspace.id,
  sessionFile: state.sessionFile,
  title: state.title,
  cwd: state.cwd,
  createdAt: state.createdAt,
  modifiedAt: state.lastActiveAt,
  messageCount: 0,
  status: "idle",
  runnable: true,
};

function services() {
  const create = vi.fn(async () => ({ id: state.id }));
  const open = vi.fn(async () => ({ id: state.id }));
  const close = vi.fn(async () => undefined);
  const fork = vi.fn(async () => ({ conversation: state, editorText: "copied prompt" }));
  const prompt = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const deleteSession = vi.fn(async () => [summary]);
  const busy = vi.fn(() => false);
  let authoritative = [workspace];

  const registry: ProtocolRegistry = {
    create,
    open,
    getState: vi.fn(async () => state),
    close,
    fork,
    prompt,
    abort,
    hasLiveWorkspace: busy,
    subscribe: vi.fn(() => () => undefined),
  };
  const history: ProtocolHistory = {
    list: vi.fn(async () => [summary]),
    resolve: vi.fn(async () => ({ summary })),
    delete: deleteSession,
  };
  const workspaces: ProtocolWorkspaceRepository = {
    list: vi.fn(() => authoritative),
    requireAvailable: vi.fn(() => workspace),
    create: vi.fn((input) => {
      authoritative = [{ ...workspace, name: input.name, path: input.path }];
      return authoritative[0]!;
    }),
    update: vi.fn((_id, changes) => {
      authoritative = [{ ...workspace, ...changes }];
      return authoritative[0]!;
    }),
    delete: vi.fn(() => { authoritative = []; }),
  };
  return {
    registry,
    history,
    workspaces,
    calls: { create, open, close, fork, prompt, abort, delete: deleteSession, busy },
  };
}

function command(value: object): ClientCommand {
  return value as ClientCommand;
}

describe("server WebSocket protocol", () => {
  it("decodes closed workspace-aware commands and rejects invalid frames", () => {
    const valid = Buffer.from(JSON.stringify({
      type: "history.list",
      requestId: "request-1",
      workspaceId: workspace.id,
    }));
    expect(decodeClientCommand(valid, false)).toEqual({
      type: "history.list",
      requestId: "request-1",
      workspaceId: workspace.id,
    });
    for (const operation of [
      () => decodeClientCommand(valid, true),
      () => decodeClientCommand(valid, false, valid.byteLength - 1),
      () => decodeClientCommand(Buffer.from("{"), false),
      () => decodeClientCommand(Buffer.from(JSON.stringify({
        type: "history.list",
        requestId: "request-1",
        workspaceId: workspace.id,
        extra: true,
      })), false),
    ]) expect(operation).toThrow(AppError);
  });

  it("dispatches scoped history and lifecycle commands with exact correlated responses", async () => {
    const { registry, history, workspaces, calls } = services();
    await expect(dispatchClientCommand(command({
      type: "history.list",
      requestId: "history",
      workspaceId: workspace.id,
    }), registry, history, workspaces)).resolves.toEqual({
      response: {
        type: "history",
        requestId: "history",
        workspaceId: workspace.id,
        conversations: [summary],
      },
    });
    expect(history.list).toHaveBeenCalledWith(workspace);

    await expect(dispatchClientCommand(command({
      type: "conversation.create",
      requestId: "create",
      workspaceId: workspace.id,
    }), registry, history, workspaces)).resolves.toMatchObject({
      response: { type: "state", requestId: "create", conversation: state },
      affectedWorkspaceId: workspace.id,
    });
    expect(calls.create).toHaveBeenCalledWith(workspace);

    await dispatchClientCommand(command({
      type: "conversation.open",
      requestId: "open",
      workspaceId: workspace.id,
      conversationId: state.id,
    }), registry, history, workspaces);
    expect(history.resolve).toHaveBeenCalledWith(workspace, state.id);
    expect(calls.open).toHaveBeenCalledWith(workspace, state.sessionFile);

    await expect(dispatchClientCommand(command({
      type: "conversation.delete",
      requestId: "delete",
      workspaceId: workspace.id,
      conversationId: state.id,
    }), registry, history, workspaces)).resolves.toEqual({
      response: { type: "ack", requestId: "delete", command: "conversation.delete" },
      affectedWorkspaceId: workspace.id,
      history: [summary],
    });
    expect(calls.delete).toHaveBeenCalledWith(workspace, state.id);
  });

  it("dispatches workspace CRUD, permits live rename, and guards path/delete while live", async () => {
    const { registry, history, workspaces, calls } = services();
    await expect(dispatchClientCommand(command({
      type: "workspace.list", requestId: "list",
    }), registry, history, workspaces)).resolves.toEqual({
      response: { type: "workspaces", requestId: "list", workspaces: [workspace] },
    });

    const renamed = await dispatchClientCommand(command({
      type: "workspace.update",
      requestId: "rename",
      workspaceId: workspace.id,
      name: "Renamed",
    }), registry, history, workspaces);
    expect(renamed).toMatchObject({
      response: { type: "workspaces", requestId: "rename" },
      workspaces: [{ name: "Renamed" }],
    });

    calls.busy.mockReturnValue(true);
    await expect(dispatchClientCommand(command({
      type: "workspace.update",
      requestId: "path",
      workspaceId: workspace.id,
      path: "/other",
    }), registry, history, workspaces)).rejects.toMatchObject({ code: ERROR_CODES.WORKSPACE_BUSY });
    await expect(dispatchClientCommand(command({
      type: "workspace.delete",
      requestId: "delete",
      workspaceId: workspace.id,
    }), registry, history, workspaces)).rejects.toMatchObject({ code: ERROR_CODES.WORKSPACE_BUSY });
  });

  it("rejects all protocol admission during shutdown, including workspace writes and abort", async () => {
    const { registry, history, workspaces, calls } = services();
    for (const shuttingDownCommand of [
      {
        type: "conversation.create",
        requestId: "create",
        workspaceId: workspace.id,
      },
      {
        type: "workspace.create",
        requestId: "workspace-create",
        name: "Blocked",
        path: "/blocked",
      },
      {
        type: "conversation.abort",
        requestId: "abort",
        conversationId: state.id,
      },
    ]) {
      await expect(dispatchClientCommand(
        command(shuttingDownCommand),
        registry,
        history,
        workspaces,
        true,
      )).rejects.toMatchObject({ code: ERROR_CODES.SHUTTING_DOWN });
    }
    expect(calls.create).not.toHaveBeenCalled();
    expect(calls.abort).not.toHaveBeenCalled();
    expect(workspaces.create).not.toHaveBeenCalled();
  });

  it("routes prompt behaviors and source-preserving fork", async () => {
    const { registry, history, workspaces, calls } = services();
    for (const [type, behavior] of [
      ["prompt.submit", undefined],
      ["prompt.steer", "steer"],
      ["prompt.followUp", "followUp"],
    ] as const) {
      await dispatchClientCommand(command({
        type,
        requestId: type,
        conversationId: state.id,
        text: "hello",
        images: [],
      }), registry, history, workspaces);
      expect(calls.prompt).toHaveBeenLastCalledWith(
        state.id, "hello", [], ...(behavior === undefined ? [] : [behavior]),
      );
    }
    await expect(dispatchClientCommand(command({
      type: "conversation.fork",
      requestId: "fork",
      conversationId: state.id,
      entryId: "entry-1",
    }), registry, history, workspaces)).resolves.toEqual({
      response: {
        type: "state",
        requestId: "fork",
        conversation: state,
        editorText: "copied prompt",
      },
      affectedWorkspaceId: workspace.id,
    });
  });
});
