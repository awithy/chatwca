import { Buffer } from "node:buffer";

import { describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import type {
  ClientCommand,
  ConversationState,
  ConversationSummary,
} from "../../src/shared/protocol.js";
import {
  decodeClientCommand,
  dispatchClientCommand,
  type ProtocolHistory,
  type ProtocolRegistry,
} from "../../src/server/protocol.js";

const state: ConversationState = {
  id: "conversation-1",
  sessionFile: "/sessions/conversation-1.jsonl",
  title: "Test",
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
  createdAt: state.createdAt,
  modifiedAt: state.lastActiveAt,
  messageCount: 0,
  status: "idle",
  runnable: true,
};

function services(): {
  registry: ProtocolRegistry;
  history: ProtocolHistory;
  calls: {
    create: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    prompt: ReturnType<typeof vi.fn>;
    abort: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
} {
  const create = vi.fn(async () => ({ id: state.id }));
  const open = vi.fn(async () => ({ id: state.id }));
  const close = vi.fn(async () => undefined);
  const prompt = vi.fn(async () => undefined);
  const abort = vi.fn(async () => undefined);
  const deleteSession = vi.fn(async () => [summary]);

  return {
    registry: {
      create,
      open,
      getState: vi.fn(async () => state),
      close,
      prompt,
      abort,
      subscribe: vi.fn(() => () => undefined),
    },
    history: {
      list: vi.fn(async () => [summary]),
      resolve: vi.fn(async () => ({ summary })),
      delete: deleteSession,
    },
    calls: { create, open, close, prompt, abort, delete: deleteSession },
  };
}

function command(value: object): ClientCommand {
  return value as ClientCommand;
}

describe("server WebSocket protocol", () => {
  it("decodes valid text JSON and rejects binary, oversized, malformed, and extra-property commands", () => {
    const valid = Buffer.from(
      JSON.stringify({ type: "history.list", requestId: "request-1" }),
    );
    expect(decodeClientCommand(valid, false)).toEqual({
      type: "history.list",
      requestId: "request-1",
    });

    for (const operation of [
      () => decodeClientCommand(valid, true),
      () => decodeClientCommand(valid, false, valid.byteLength - 1),
      () => decodeClientCommand(Buffer.from("{"), false),
      () =>
        decodeClientCommand(
          Buffer.from(
            JSON.stringify({
              type: "history.list",
              requestId: "request-1",
              extra: true,
            }),
          ),
          false,
        ),
    ]) {
      expect(operation).toThrow(AppError);
    }

    try {
      decodeClientCommand(valid, false, valid.byteLength - 1);
    } catch (error) {
      expect(error).toMatchObject({ code: ERROR_CODES.MESSAGE_TOO_LARGE });
    }
  });

  it("dispatches history and lifecycle commands with correlated responses", async () => {
    const { registry, history, calls } = services();

    await expect(
      dispatchClientCommand(
        command({ type: "history.list", requestId: "history" }),
        registry,
        history,
      ),
    ).resolves.toMatchObject({
      response: { type: "history", requestId: "history", conversations: [summary] },
    });

    await expect(
      dispatchClientCommand(
        command({
          type: "conversation.create",
          requestId: "create",
          cwd: "/workspace",
        }),
        registry,
        history,
      ),
    ).resolves.toMatchObject({
      response: { type: "state", requestId: "create", conversation: state },
      historyChanged: true,
    });
    expect(calls.create).toHaveBeenCalledWith("/workspace");

    await dispatchClientCommand(
      command({
        type: "conversation.open",
        requestId: "open",
        conversationId: state.id,
      }),
      registry,
      history,
    );
    expect(calls.open).toHaveBeenCalledWith(state.sessionFile);

    await expect(
      dispatchClientCommand(
        command({
          type: "conversation.close",
          requestId: "close",
          conversationId: state.id,
        }),
        registry,
        history,
      ),
    ).resolves.toMatchObject({
      response: { type: "ack", requestId: "close", command: "conversation.close" },
    });
    expect(calls.close).toHaveBeenCalledWith(state.id);

    await expect(
      dispatchClientCommand(
        command({
          type: "conversation.delete",
          requestId: "delete",
          conversationId: state.id,
        }),
        registry,
        history,
      ),
    ).resolves.toMatchObject({
      response: { type: "ack", requestId: "delete", command: "conversation.delete" },
      history: [summary],
    });
  });

  it("routes submit, steer, follow-up, and abort and fails fork closed", async () => {
    const { registry, history, calls } = services();
    const promptBase = {
      conversationId: state.id,
      text: "hello",
      images: [],
    };

    for (const [type, behavior] of [
      ["prompt.submit", undefined],
      ["prompt.steer", "steer"],
      ["prompt.followUp", "followUp"],
    ] as const) {
      const result = await dispatchClientCommand(
        command({ ...promptBase, type, requestId: type }),
        registry,
        history,
      );
      expect(result.response).toEqual({
        type: "ack",
        requestId: type,
        command: type,
      });
      expect(calls.prompt).toHaveBeenLastCalledWith(
        state.id,
        "hello",
        [],
        ...(behavior === undefined ? [] : [behavior]),
      );
    }

    await dispatchClientCommand(
      command({
        type: "conversation.abort",
        requestId: "abort",
        conversationId: state.id,
      }),
      registry,
      history,
    );
    expect(calls.abort).toHaveBeenCalledWith(state.id);

    await expect(
      dispatchClientCommand(
        command({
          type: "conversation.fork",
          requestId: "fork",
          conversationId: state.id,
          entryId: "entry-1",
        }),
        registry,
        history,
      ),
    ).rejects.toMatchObject({ code: ERROR_CODES.INVALID_COMMAND });
  });
});
