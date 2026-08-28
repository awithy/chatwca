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

function event<T extends ConversationEvent>(value: T): ConversationEvent {
  return value;
}

describe("web chat state", () => {
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
        conversationId: "conversation-1",
        revision: 2,
        payload: {
          message: {
            entryId: "pi-entry-1",
            role: "assistant",
            blocks: [{ type: "text", text: "done" }],
          },
        },
      },
      {
        type: "tool.started",
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
        conversationId: "conversation-1",
        revision: 4,
        payload: { toolCallId: "call-1", content: "/work", truncated: false },
      },
      {
        type: "tool.completed",
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
        conversationId: "conversation-1",
        revision: 6,
        payload: {
          steering: [],
          followUp: [{ text: "later", imageCount: 0 }],
        },
      },
      {
        type: "conversation.notice",
        conversationId: "conversation-1",
        revision: 7,
        payload: {
          notice: { kind: "runtime", level: "info", message: "Settled" },
        },
      },
      {
        type: "conversation.status",
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
});
