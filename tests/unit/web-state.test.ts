import { describe, expect, it } from "vitest";

import type {
  ConversationEvent,
  ConversationState,
} from "../../src/shared/protocol.js";
import {
  createInitialChatClientState,
  reduceChatClientState,
} from "../../src/web/src/api/state.js";

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
    securityProfile: "unrestricted",
    networkPolicy: null,
  };
}

function event<T extends ConversationEvent>(value: T): ConversationEvent {
  return value;
}

describe("web chat state", () => {
  it("synchronizes a live projection title from authoritative history", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "workspace.select",
      workspaceId: "workspace-1",
    });
    state = reduceChatClientState(state, {
      type: "snapshot",
      conversation: conversation(),
    });
    state = reduceChatClientState(state, {
      type: "history",
      workspaceId: "workspace-1",
      conversations: [{
        id: "conversation-1",
        workspaceId: "workspace-1",
        sessionFile: "/sessions/one.jsonl",
        title: "Renamed conversation",
        cwd: "/workspace",
        modifiedAt: 2,
        messageCount: 0,
        status: "idle",
        runnable: true,
      }],
    });

    expect(state.conversations["conversation-1"]?.conversation.title).toBe(
      "Renamed conversation",
    );
  });

  it("applies contiguous deltas, ignores duplicates, and requests a snapshot on gaps", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "snapshot",
      conversation: {
        ...conversation(3),
        messages: [{
          entryId: "stream:one:1",
          role: "assistant",
          blocks: [{ type: "text", text: "Hel" }],
        }],
      },
    });
    const delta = event({
      type: "message.delta",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      revision: 4,
      payload: {
        entryId: "stream:one:1",
        blockIndex: 0,
        blockType: "text",
        delta: "lo",
      },
    });

    state = reduceChatClientState(state, { type: "event", event: delta });
    expect(state.conversations["conversation-1"]?.conversation).toMatchObject({
      revision: 4,
      messages: [{ blocks: [{ text: "Hello" }] }],
    });

    const duplicate = reduceChatClientState(state, { type: "event", event: delta });
    expect(duplicate).toBe(state);

    state = reduceChatClientState(state, {
      type: "event",
      event: {
        type: "conversation.status",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 6,
        payload: { status: "streaming" },
      },
    });
    expect(state.conversations["conversation-1"]?.conversation.status).toBe("idle");
    expect(state.resyncConversationIds).toEqual(["conversation-1"]);
  });

  it("reconciles temporary message IDs and projects tools, notices, queue, and status", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "snapshot",
      conversation: conversation(),
    });
    const events: ConversationEvent[] = [
      {
        type: "message.started",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 1,
        payload: {
          message: {
            entryId: "stream:one:1",
            role: "assistant",
            blocks: [{ type: "text", text: "draft" }],
          },
        },
      },
      {
        type: "message.completed",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 2,
        payload: {
          message: {
            entryId: "pi-entry-1",
            role: "assistant",
            blocks: [{ type: "text", text: "done" }],
          },
          contextUsage: { tokens: 14_144, contextWindow: 272_000, percent: 5.2 },
        },
      },
      {
        type: "tool.started",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 3,
        payload: {
          entryId: "pi-entry-1",
          tool: {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            arguments: { command: "pwd" },
            status: "running",
          },
        },
      },
      {
        type: "tool.updated",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 4,
        payload: { toolCallId: "call-1", content: "/work", truncated: false },
      },
      {
        type: "tool.completed",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 5,
        payload: {
          result: {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            content: "/workspace",
            isError: false,
            truncated: false,
          },
        },
      },
      {
        type: "conversation.queue",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 6,
        payload: {
          steering: [],
          followUp: [{ text: "later", imageCount: 0 }],
        },
      },
      {
        type: "conversation.notice",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 7,
        payload: {
          notice: { kind: "runtime", level: "info", message: "Settled" },
        },
      },
      {
        type: "conversation.status",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 8,
        payload: { status: "streaming" },
      },
    ];
    for (const item of events) {
      state = reduceChatClientState(state, { type: "event", event: item });
    }

    const projection = state.conversations["conversation-1"];
    expect(projection?.conversation.messages).toHaveLength(1);
    expect(projection?.conversation.messages[0]).toMatchObject({
      entryId: "pi-entry-1",
      blocks: [
        { type: "text", text: "done" },
        { type: "tool-call", status: "succeeded" },
        { type: "tool-result", content: "/workspace" },
      ],
    });
    expect(projection?.conversation.queue.followUp).toHaveLength(1);
    expect(projection?.conversation.status).toBe("streaming");
    expect(projection?.notices).toEqual([
      { kind: "runtime", level: "info", message: "Settled" },
    ]);
  });

  it("collects bounded revisioned network denials, coalesces counts, and preserves them across snapshots", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "snapshot",
      conversation: {
        ...conversation(),
        securityProfile: "workspace-sandboxed",
        networkPolicy: "managed-egress",
      },
    });
    state = reduceChatClientState(state, {
      type: "event",
      event: {
        type: "network.blocked",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 1,
        payload: {
          host: "blocked.example.com",
          port: 443,
          protocol: "https-connect",
          reason: "explicit_deny",
        },
      },
    });
    state = reduceChatClientState(state, {
      type: "event",
      event: {
        type: "network.blocked",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 2,
        payload: {
          host: "blocked.example.com",
          port: 443,
          protocol: "https-connect",
          reason: "explicit_deny",
          occurrenceCount: 4,
        },
      },
    });

    expect(state.conversations["conversation-1"]?.networkBlocked).toEqual([
      expect.objectContaining({ revision: 2, payload: expect.objectContaining({ occurrenceCount: 4 }) }),
    ]);

    state = reduceChatClientState(state, {
      type: "snapshot",
      conversation: {
        ...conversation(3),
        securityProfile: "workspace-sandboxed",
        networkPolicy: "managed-egress",
      },
    });
    expect(state.conversations["conversation-1"]?.networkBlocked).toHaveLength(1);

    for (let revision = 4; revision <= 58; revision += 1) {
      state = reduceChatClientState(state, {
        type: "event",
        event: {
          type: "network.blocked",
          workspaceId: "workspace-1",
          conversationId: "conversation-1",
          revision,
          payload: {
            host: `blocked-${String(revision)}.example.com`,
            port: 80,
            protocol: "http",
            reason: "not_allowed",
          },
        },
      });
    }
    expect(state.conversations["conversation-1"]?.networkBlocked).toHaveLength(50);
    expect(state.conversations["conversation-1"]?.networkBlocked[0]?.revision).toBe(9);
  });

  it("updates context usage on completed messages and clears the estimate after compaction", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "snapshot",
      conversation: conversation(),
    });
    state = reduceChatClientState(state, {
      type: "event",
      event: {
        type: "message.completed",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 1,
        payload: {
          message: {
            entryId: "user-1",
            role: "user",
            blocks: [{ type: "text", text: "hello" }],
            forkEligible: true,
          },
          contextUsage: {
            tokens: 14_144,
            contextWindow: 272_000,
            percent: 5.2,
          },
        },
      },
    });

    expect(state.conversations["conversation-1"]?.conversation.contextUsage).toEqual({
      tokens: 14_144,
      contextWindow: 272_000,
      percent: 5.2,
    });

    state = reduceChatClientState(state, {
      type: "event",
      event: {
        type: "conversation.notice",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 2,
        payload: {
          notice: {
            kind: "compaction",
            phase: "completed",
            message: "Conversation compaction completed.",
          },
        },
      },
    });
    expect(state.conversations["conversation-1"]?.conversation.contextUsage).toEqual({
      tokens: null,
      contextWindow: 272_000,
      percent: null,
    });
  });

  it("materializes streamed thinking and keeps active tool output and status current", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "snapshot",
      conversation: {
        ...conversation(),
        messages: [{
          entryId: "stream:one:1",
          role: "assistant",
          blocks: [],
        }],
      },
    });
    const events: ConversationEvent[] = [
      {
        type: "message.delta",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 1,
        payload: {
          entryId: "stream:one:1",
          blockIndex: 0,
          blockType: "thinking",
          delta: "Inspecting",
        },
      },
      {
        type: "tool.started",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 2,
        payload: {
          entryId: "stream:one:1",
          tool: {
            type: "tool-call",
            toolCallId: "call-live",
            toolName: "bash",
            arguments: { command: "pwd" },
            status: "running",
          },
        },
      },
      {
        type: "tool.updated",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 3,
        payload: {
          toolCallId: "call-live",
          content: "partial output",
          truncated: true,
        },
      },
      {
        type: "tool.completed",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 4,
        payload: {
          result: {
            type: "tool-result",
            toolCallId: "call-live",
            toolName: "bash",
            content: "exit 1",
            isError: true,
            truncated: false,
          },
        },
      },
    ];

    for (const item of events.slice(0, 3)) {
      state = reduceChatClientState(state, { type: "event", event: item });
    }
    expect(state.conversations["conversation-1"]?.conversation.messages[0]).toMatchObject({
      blocks: [
        { type: "thinking", text: "Inspecting" },
        { type: "tool-call", status: "running" },
        { type: "tool-result", content: "partial output", truncated: true },
      ],
    });

    state = reduceChatClientState(state, { type: "event", event: events[3]! });
    expect(state.conversations["conversation-1"]?.conversation.messages[0]).toMatchObject({
      blocks: [
        { type: "thinking" },
        { type: "tool-call", status: "failed" },
        { type: "tool-result", content: "exit 1", isError: true },
      ],
    });
  });

  it("drops stale live projections when authoritative history marks them closed", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "snapshot",
      conversation: conversation(4),
    });

    state = reduceChatClientState(state, {
      type: "workspace.select",
      workspaceId: "workspace-1",
    });
    state = reduceChatClientState(state, {
      type: "history",
      workspaceId: "workspace-1",
      conversations: [{
        id: "conversation-1",
        workspaceId: "workspace-1",
        sessionFile: "/sessions/one.jsonl",
        title: "One",
        cwd: "/workspace",
        modifiedAt: 2,
        messageCount: 1,
        status: "closed",
        runnable: true,
      }],
    });

    expect(state.history[0]?.status).toBe("closed");
    expect(state.conversations["conversation-1"]).toBeUndefined();
  });

  it("keeps selection and drafts local and replaces them independently", () => {
    let state = createInitialChatClientState();
    state = reduceChatClientState(state, {
      type: "select",
      conversationId: "conversation-1",
    });
    state = reduceChatClientState(state, {
      type: "draft",
      conversationId: "conversation-1",
      text: "unfinished",
    });
    state = reduceChatClientState(state, {
      type: "draft",
      conversationId: "conversation-2",
      text: "other",
    });

    expect(state.selectedConversationId).toBe("conversation-1");
    expect(state.drafts).toEqual({
      "conversation-1": "unfinished",
      "conversation-2": "other",
    });
  });

  it("replaces stored/effective usability from each authoritative workspace list", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "workspaces",
      workspaces: [{
        id: "workspace-1",
        name: "One",
        path: "/one",
        sessionStorage: "pi-default",
        sessionDirectory: null,
        securityProfile: "workspace-sandboxed",
        effectiveSecurityProfile: null,
        createdAt: 1,
        updatedAt: 1,
        available: true,
        usable: false,
        policyIssue: "sandbox_disabled",
      }],
    });
    expect(state.workspaces[0]).toMatchObject({
      securityProfile: "workspace-sandboxed",
      effectiveSecurityProfile: null,
      usable: false,
      policyIssue: "sandbox_disabled",
    });

    state = reduceChatClientState(state, {
      type: "workspaces",
      workspaces: [{
        ...state.workspaces[0]!,
        effectiveSecurityProfile: "workspace-sandboxed",
        usable: true,
        policyIssue: null,
      }],
    });
    expect(state.workspaces[0]).toMatchObject({
      securityProfile: "workspace-sandboxed",
      effectiveSecurityProfile: "workspace-sandboxed",
      usable: true,
      policyIssue: null,
    });
  });

  it("scopes history to the selected workspace and rejects stale responses", () => {
    let state = createInitialChatClientState();
    state = reduceChatClientState(state, {
      type: "workspaces",
      workspaces: [
        { id: "workspace-1", name: "One", path: "/one", createdAt: 1, updatedAt: 1, available: true },
        { id: "workspace-2", name: "Two", path: "/two", createdAt: 2, updatedAt: 2, available: true },
      ],
    });
    expect(state.history).toEqual([]);
    expect(state.selectedWorkspaceId).toBeNull();

    state = reduceChatClientState(state, {
      type: "workspace.select",
      workspaceId: "workspace-1",
    });
    state = reduceChatClientState(state, {
      type: "workspace.select",
      workspaceId: "workspace-2",
    });
    const stale = reduceChatClientState(state, {
      type: "history",
      workspaceId: "workspace-1",
      conversations: [],
    });
    expect(stale).toBe(state);

    state = reduceChatClientState(state, {
      type: "history",
      workspaceId: "workspace-2",
      conversations: [],
    });
    expect(state.historyWorkspaceId).toBe("workspace-2");
  });

  it("preserves background projections and drafts across workspace switches", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "snapshot",
      conversation: conversation(2),
    });
    state = reduceChatClientState(state, {
      type: "snapshot",
      conversation: {
        ...conversation(5),
        id: "conversation-2",
        workspaceId: "workspace-2",
        sessionFile: "/sessions/two.jsonl",
      },
    });
    state = reduceChatClientState(state, {
      type: "draft",
      conversationId: "conversation-1",
      text: "background draft",
    });
    state = reduceChatClientState(state, {
      type: "workspace.select",
      workspaceId: "workspace-2",
    });
    state = reduceChatClientState(state, {
      type: "history",
      workspaceId: "workspace-2",
      conversations: [],
    });
    state = reduceChatClientState(state, {
      type: "event",
      event: {
        type: "conversation.status",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 3,
        payload: { status: "streaming" },
      },
    });

    expect(state.conversations["conversation-1"]?.conversation.status).toBe("streaming");
    expect(state.conversations["conversation-2"]).toBeDefined();
    expect(state.drafts["conversation-1"]).toBe("background draft");
  });

  it("clears removed selection and explicitly deleted conversation drafts", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "workspaces",
      workspaces: [{
        id: "workspace-1",
        name: "One",
        path: "/one",
        createdAt: 1,
        updatedAt: 1,
        available: true,
      }],
    });
    state = reduceChatClientState(state, {
      type: "workspace.select",
      workspaceId: "workspace-1",
    });
    state = reduceChatClientState(state, {
      type: "draft",
      conversationId: "conversation-1",
      text: "draft",
    });
    state = reduceChatClientState(state, {
      type: "conversation.deleted",
      conversationId: "conversation-1",
    });
    expect(state.drafts["conversation-1"]).toBeUndefined();

    state = reduceChatClientState(state, { type: "workspaces", workspaces: [] });
    expect(state).toMatchObject({
      selectedWorkspaceId: null,
      selectedConversationId: null,
      historyWorkspaceId: null,
      history: [],
    });
  });
});
