import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  ClientCommandSchema,
  ConversationStateSchema,
  ServerMessageSchema,
  WorkspaceSchema,
  WorkspaceSummarySchema,
  type CommandSuccessByType,
} from "../../src/shared/protocol.js";

const requestId = "request-1";

const commands = [
  { type: "workspace.list", requestId },
  {
    type: "workspace.create",
    requestId,
    name: "Example",
    path: "/workspace",
  },
  {
    type: "workspace.update",
    requestId,
    workspaceId: "workspace-1",
    name: "Renamed",
  },
  {
    type: "workspace.update",
    requestId,
    workspaceId: "workspace-1",
    path: "/other-workspace",
  },
  {
    type: "workspace.delete",
    requestId,
    workspaceId: "workspace-1",
  },
  { type: "history.list", requestId },
  { type: "conversation.create", requestId, cwd: "/workspace" },
  { type: "conversation.open", requestId, conversationId: "session-1" },
  { type: "conversation.state", requestId, conversationId: "session-1" },
  { type: "conversation.close", requestId, conversationId: "session-1" },
  { type: "conversation.delete", requestId, conversationId: "session-1" },
  {
    type: "conversation.fork",
    requestId,
    conversationId: "session-1",
    entryId: "entry-1",
  },
  {
    type: "prompt.submit",
    requestId,
    conversationId: "session-1",
    text: "hello",
    images: [],
  },
  {
    type: "prompt.steer",
    requestId,
    conversationId: "session-1",
    text: "change direction",
    images: [],
  },
  {
    type: "prompt.followUp",
    requestId,
    conversationId: "session-1",
    text: "then do this",
    images: [],
  },
  { type: "conversation.abort", requestId, conversationId: "session-1" },
] as const;

const conversationState = {
  id: "session-1",
  sessionFile: "/sessions/session-1.jsonl",
  title: "Example",
  cwd: "/workspace",
  model: {
    id: "model-1",
    provider: "test",
    supportsImages: true,
  },
  status: "idle",
  createdAt: 1,
  lastActiveAt: 2,
  revision: 0,
  durable: true,
  messages: [
    {
      entryId: "entry-1",
      role: "user",
      forkEligible: false,
      blocks: [
        { type: "text", text: "hello" },
        {
          type: "image",
          image: {
            mimeType: "image/png",
            encoding: "base64",
            data: "iVBORw0KGgo=",
          },
        },
      ],
    },
    {
      entryId: "entry-2",
      role: "assistant",
      blocks: [
        { type: "thinking", text: "Working" },
        { type: "text", text: "Done" },
        {
          type: "tool-call",
          toolCallId: "tool-1",
          toolName: "read",
          arguments: { path: "README.md" },
          status: "succeeded",
        },
        {
          type: "tool-result",
          toolCallId: "tool-1",
          toolName: "read",
          content: "contents",
          isError: false,
          truncated: false,
        },
      ],
      stopReason: "stop",
    },
  ],
  queue: { steering: [], followUp: [] },
} as const;

describe("ClientCommandSchema", () => {
  it("accepts every command in the v1 protocol", () => {
    for (const command of commands) {
      expect(Value.Check(ClientCommandSchema, command)).toBe(true);
    }
  });

  it("requires a client request ID", () => {
    expect(Value.Check(ClientCommandSchema, { type: "history.list" })).toBe(
      false,
    );
  });

  it("requires at least one workspace update field", () => {
    expect(
      Value.Check(ClientCommandSchema, {
        type: "workspace.update",
        requestId,
        workspaceId: "workspace-1",
      }),
    ).toBe(false);
    expect(
      Value.Check(ClientCommandSchema, {
        type: "workspace.update",
        requestId,
        workspaceId: "workspace-1",
        name: "Renamed",
        ignored: true,
      }),
    ).toBe(false);
  });

  it("rejects unknown command types and extra properties", () => {
    expect(
      Value.Check(ClientCommandSchema, {
        type: "conversation.rename",
        requestId,
      }),
    ).toBe(false);
    expect(
      Value.Check(ClientCommandSchema, {
        type: "history.list",
        requestId,
        ignored: true,
      }),
    ).toBe(false);
  });

  it("rejects unsupported and malformed image payloads", () => {
    const base = {
      type: "prompt.submit",
      requestId,
      conversationId: "session-1",
      text: "",
    };

    expect(
      Value.Check(ClientCommandSchema, {
        ...base,
        images: [
          {
            mimeType: "image/gif",
            encoding: "base64",
            data: "AAAA",
          },
        ],
      }),
    ).toBe(false);
    expect(
      Value.Check(ClientCommandSchema, {
        ...base,
        images: [
          { mimeType: "image/png", encoding: "data-url", data: "AAAA" },
        ],
      }),
    ).toBe(false);
  });
});

describe("workspace schemas", () => {
  const workspace = {
    id: "workspace-1",
    name: "Example",
    path: "/workspace",
    createdAt: 10,
    updatedAt: 20,
  } as const;

  it("defines closed workspace records and availability summaries", () => {
    expect(Value.Check(WorkspaceSchema, workspace)).toBe(true);
    expect(
      Value.Check(WorkspaceSummarySchema, { ...workspace, available: true }),
    ).toBe(true);
    expect(
      Value.Check(WorkspaceSummarySchema, {
        ...workspace,
        available: true,
        privateMetadata: "no",
      }),
    ).toBe(false);
  });

  it("types workspace command successes as exact correlated responses", () => {
    const listResponse = {
      type: "workspaces",
      requestId,
      workspaces: [{ ...workspace, available: true }],
    } satisfies CommandSuccessByType["workspace.list"];
    const createResponse = listResponse satisfies CommandSuccessByType["workspace.create"];
    const updateResponse = listResponse satisfies CommandSuccessByType["workspace.update"];
    const deleteResponse = {
      type: "ack",
      requestId,
      command: "workspace.delete",
    } satisfies CommandSuccessByType["workspace.delete"];

    expect([createResponse, updateResponse, deleteResponse]).toHaveLength(3);
  });
});

describe("normalized conversation state", () => {
  it("accepts messages containing all normalized block categories", () => {
    expect(Value.Check(ConversationStateSchema, conversationState)).toBe(true);
  });

  it("requires explicit server-derived fork eligibility on user messages", () => {
    const [user, assistant] = conversationState.messages;
    expect(
      Value.Check(ConversationStateSchema, {
        ...conversationState,
        messages: [{ ...user, forkEligible: true }, assistant],
      }),
    ).toBe(true);
    const { forkEligible: _forkEligible, ...unmarkedUser } = user;
    expect(
      Value.Check(ConversationStateSchema, {
        ...conversationState,
        messages: [unmarkedUser, assistant],
      }),
    ).toBe(false);
  });

  it("applies the closed-object policy recursively", () => {
    expect(
      Value.Check(ConversationStateSchema, {
        ...conversationState,
        queue: { steering: [], followUp: [], unknown: [] },
      }),
    ).toBe(false);
  });
});

describe("ServerMessageSchema", () => {
  it("accepts acknowledgements, correlated errors, snapshots, and events", () => {
    const messages = [
      { type: "ready", serverVersion: "0.0.0" },
      {
        type: "workspaces",
        requestId,
        workspaces: [
          {
            id: "workspace-1",
            name: "Example",
            path: "/workspace",
            createdAt: 1,
            updatedAt: 2,
            available: true,
          },
        ],
      },
      { type: "workspaces", workspaces: [] },
      {
        type: "ack",
        requestId,
        command: "prompt.submit",
      },
      {
        type: "error",
        requestId,
        code: "invalid_command",
        message: "Invalid command",
      },
      {
        type: "history",
        requestId,
        conversations: [
          {
            id: "session-1",
            sessionFile: "/sessions/session-1.jsonl",
            title: "Example",
            cwd: "/workspace",
            modifiedAt: 2,
            messageCount: 2,
            status: "idle",
            runnable: true,
          },
        ],
      },
      { type: "state", requestId, conversation: conversationState },
      {
        type: "message.delta",
        conversationId: "session-1",
        revision: 1,
        payload: {
          entryId: "entry-2",
          blockIndex: 1,
          blockType: "text",
          delta: "Done",
        },
      },
      {
        type: "conversation.notice",
        conversationId: "session-1",
        revision: 2,
        payload: {
          notice: {
            kind: "retry",
            phase: "scheduled",
            message: "Retrying",
            attempt: 1,
            maxAttempts: 3,
            delayMs: 100,
          },
        },
      },
    ];

    for (const message of messages) {
      expect(Value.Check(ServerMessageSchema, message)).toBe(true);
    }
  });

  it("requires safe non-negative snapshot and positive event revisions", () => {
    expect(
      Value.Check(ServerMessageSchema, {
        type: "state",
        conversation: { ...conversationState, revision: -1 },
      }),
    ).toBe(false);
    expect(
      Value.Check(ServerMessageSchema, {
        type: "state",
        conversation: {
          ...conversationState,
          revision: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toBe(false);
    expect(
      Value.Check(ServerMessageSchema, {
        type: "conversation.status",
        conversationId: "session-1",
        revision: 0,
        payload: { status: "streaming" },
      }),
    ).toBe(false);
  });

  it("acknowledges only commands whose success has no result payload", () => {
    expect(
      Value.Check(ServerMessageSchema, {
        type: "ack",
        requestId,
        command: "conversation.close",
      }),
    ).toBe(true);
    expect(
      Value.Check(ServerMessageSchema, {
        type: "ack",
        requestId,
        command: "workspace.delete",
      }),
    ).toBe(true);
    expect(
      Value.Check(ServerMessageSchema, {
        type: "ack",
        requestId,
        command: "conversation.create",
      }),
    ).toBe(false);
  });
});
