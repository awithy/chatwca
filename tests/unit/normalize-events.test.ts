import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  PiEventNormalizer,
  type NormalizedPiEvent,
} from "../../src/server/normalize-events.js";

function event(value: unknown): AgentSessionEvent {
  return value as AgentSessionEvent;
}

function sessionWithBranch(branch: unknown[]): AgentSession {
  return {
    sessionManager: { getBranch: () => branch },
  } as unknown as AgentSession;
}

function assistant(timestamp = 10): Record<string, unknown> {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Hello" }],
    api: "faux",
    provider: "faux",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

describe("PiEventNormalizer", () => {
  it("normalizes message starts/deltas and completes with the persisted Pi entry ID", async () => {
    const branch: unknown[] = [];
    const emitted: NormalizedPiEvent[] = [];
    const persisted = vi.fn();
    const message = assistant();
    const normalizer = new PiEventNormalizer({
      sessionId: "session-1",
      getSession: () => sessionWithBranch(branch),
      emit: (item) => emitted.push(item),
      onMessagePersisted: persisted,
    });

    normalizer.handle(event({ type: "message_start", message }));
    normalizer.handle(
      event({
        type: "message_update",
        message,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "lo",
          partial: message,
        },
      }),
    );
    normalizer.handle(event({ type: "message_end", message }));
    branch.push({
      type: "message",
      id: "pi-entry-42",
      message,
      parentId: null,
      timestamp: "2025-01-01T00:00:00.000Z",
    });
    await Promise.resolve();

    expect(emitted).toHaveLength(3);
    expect(emitted[0]).toMatchObject({
      type: "message.started",
      payload: { message: { entryId: "stream:session-1:1" } },
    });
    expect(emitted[1]).toEqual({
      type: "message.delta",
      payload: {
        entryId: "stream:session-1:1",
        blockIndex: 0,
        blockType: "text",
        delta: "lo",
      },
    });
    expect(emitted[2]).toMatchObject({
      type: "message.completed",
      payload: {
        message: {
          entryId: "pi-entry-42",
          role: "assistant",
          blocks: [{ type: "text", text: "Hello" }],
        },
      },
    });
    expect(persisted).toHaveBeenCalledWith(message);
  });

  it("maps tool lifecycle and bounds streamed tool output", () => {
    const emitted: NormalizedPiEvent[] = [];
    const normalizer = new PiEventNormalizer({
      sessionId: "tools",
      getSession: () => sessionWithBranch([]),
      emit: (item) => emitted.push(item),
    });

    normalizer.handle(
      event({
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "pwd" },
      }),
    );
    normalizer.handle(
      event({
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "bash",
        args: { command: "pwd" },
        partialResult: {
          content: [{ type: "text", text: "x".repeat(70 * 1024) }],
        },
      }),
    );
    normalizer.handle(
      event({
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { content: [{ type: "text", text: "done" }] },
        isError: true,
      }),
    );

    expect(emitted[0]).toEqual({
      type: "tool.started",
      payload: {
        tool: {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "bash",
          arguments: { command: "pwd" },
          status: "running",
        },
      },
    });
    expect(emitted[1]).toMatchObject({
      type: "tool.updated",
      payload: { toolCallId: "call-1", truncated: true },
    });
    expect(
      (emitted[1] as Extract<NormalizedPiEvent, { type: "tool.updated" }>).payload
        .content.length,
    ).toBe(64 * 1024);
    expect(emitted[2]).toEqual({
      type: "tool.completed",
      payload: {
        result: {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "bash",
          content: "done",
          isError: true,
          truncated: false,
        },
      },
    });
  });

  it("maps lifecycle, queue, retry, and compaction events without raw SDK errors", () => {
    const emitted: NormalizedPiEvent[] = [];
    const metadataChanged = vi.fn();
    const normalizer = new PiEventNormalizer({
      sessionId: "notices",
      getSession: () => sessionWithBranch([]),
      emit: (item) => emitted.push(item),
      onMetadataChanged: metadataChanged,
    });

    normalizer.handle(event({ type: "agent_start" }));
    normalizer.handle(
      event({ type: "queue_update", steering: ["now"], followUp: ["later"] }),
    );
    normalizer.handle(
      event({
        type: "auto_retry_start",
        attempt: 2,
        maxAttempts: 3,
        delayMs: 50,
        errorMessage: "secret provider detail",
      }),
    );
    normalizer.handle(event({ type: "compaction_start", reason: "threshold" }));
    normalizer.handle(
      event({
        type: "compaction_end",
        reason: "threshold",
        result: undefined,
        aborted: false,
        willRetry: false,
        errorMessage: "internal path /private/workspace",
      }),
    );
    normalizer.handle(event({ type: "session_info_changed", name: "New name" }));
    normalizer.handle(event({ type: "agent_end", messages: [], willRetry: false }));

    expect(emitted).toEqual([
      { type: "conversation.status", payload: { status: "streaming" } },
      {
        type: "conversation.queue",
        payload: {
          steering: [{ text: "now", imageCount: 0 }],
          followUp: [{ text: "later", imageCount: 0 }],
        },
      },
      {
        type: "conversation.notice",
        payload: {
          notice: {
            kind: "retry",
            phase: "scheduled",
            message: "A model retry has been scheduled.",
            attempt: 2,
            maxAttempts: 3,
            delayMs: 50,
          },
        },
      },
      {
        type: "conversation.notice",
        payload: {
          notice: {
            kind: "compaction",
            phase: "started",
            message: "Conversation compaction started.",
          },
        },
      },
      {
        type: "conversation.notice",
        payload: {
          notice: {
            kind: "compaction",
            phase: "failed",
            message: "Conversation compaction failed.",
          },
        },
      },
      { type: "conversation.status", payload: { status: "idle" } },
    ]);
    expect(JSON.stringify(emitted)).not.toContain("secret provider detail");
    expect(JSON.stringify(emitted)).not.toContain("/private/workspace");
    expect(metadataChanged).toHaveBeenCalledOnce();
  });

  it("drops deferred completion after disposal", async () => {
    const emitted: NormalizedPiEvent[] = [];
    const message = assistant();
    const normalizer = new PiEventNormalizer({
      sessionId: "disposed",
      getSession: () => sessionWithBranch([]),
      emit: (item) => emitted.push(item),
    });

    normalizer.handle(event({ type: "message_end", message }));
    normalizer.dispose();
    await Promise.resolve();
    expect(emitted).toEqual([]);
  });
});
