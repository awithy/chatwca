import { Buffer } from "node:buffer";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  OutboundFlowController,
  SLOW_CLIENT_CLOSE_CODE,
  SLOW_CLIENT_CLOSE_REASON,
  type OutboundSocket,
} from "../../src/server/outbound-flow.js";
import type { ServerMessage } from "../../src/shared/protocol.js";

class FakeSocket implements OutboundSocket {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  readonly sent: ServerMessage[] = [];
  readonly closes: Array<{ code?: number; reason?: string }> = [];
  readonly #callbacks: Array<(error?: Error) => void> = [];

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data) as ServerMessage);
    this.bufferedAmount += Buffer.byteLength(data);
    this.#callbacks.push(callback);
  }

  close(code?: number, reason?: string): void {
    this.readyState = WebSocket.CLOSING;
    this.closes.push({ code, reason });
  }

  flush(error?: Error | null): void {
    this.bufferedAmount = 0;
    const callbacks = this.#callbacks.splice(0);
    for (const callback of callbacks) callback(error as Error | undefined);
  }
}

function toolUpdate(
  revision: number,
  content: string,
  workspaceId = "workspace-1",
): ServerMessage {
  return {
    type: "tool.updated",
    workspaceId,
    conversationId: "conversation-1",
    revision,
    payload: {
      toolCallId: "tool-1",
      content,
      truncated: false,
    },
  };
}

function textDelta(revision: number): ServerMessage {
  return {
    type: "message.delta",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    revision,
    payload: {
      entryId: "assistant-1",
      blockIndex: 0,
      blockType: "text",
      delta: "important text",
    },
  };
}

function status(revision: number): ServerMessage {
  return {
    type: "conversation.status",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    revision,
    payload: { status: "idle" },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("outbound WebSocket flow control", () => {
  it("tracks ws and application-buffered bytes and drains in order", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.bufferedAmount = 100;
    const flow = new OutboundFlowController(socket, {
      highWaterBytes: 100,
      maxQueueBytes: 4_096,
      slowClientTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });

    flow.send(toolUpdate(1, "first"));
    expect(flow.queuedBytes).toBeGreaterThan(0);
    expect(flow.bufferedBytes).toBe(socket.bufferedAmount + flow.queuedBytes);
    expect(socket.sent).toEqual([]);

    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(10);
    expect(socket.sent).toEqual([toolUpdate(1, "first")]);
    expect(flow.queuedBytes).toBe(0);

    socket.flush();
    expect(flow.bufferedBytes).toBe(0);
    flow.dispose();
  });

  it("treats ws null and undefined send callback values as success", () => {
    const socket = new FakeSocket();
    const onError = vi.fn();
    const flow = new OutboundFlowController(socket, { onError });

    flow.send(status(1));
    socket.flush(null);
    flow.send(status(2));
    socket.flush();

    expect(onError).not.toHaveBeenCalled();
    flow.dispose();
  });

  it("coalesces only adjacent cumulative tool updates and preserves status", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.bufferedAmount = 100;
    const flow = new OutboundFlowController(socket, {
      highWaterBytes: 100,
      maxQueueBytes: 4_096,
      slowClientTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });

    flow.send(toolUpdate(1, "partial"));
    flow.send(toolUpdate(2, "complete partial output"));
    flow.send(textDelta(3));
    flow.send(status(4));

    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(10);
    expect(socket.sent).toEqual([toolUpdate(2, "complete partial output")]);

    socket.flush();
    socket.flush();
    expect(socket.sent).toEqual([
      toolUpdate(2, "complete partial output"),
      textDelta(3),
      status(4),
    ]);
    // The retained authoritative revision exposes the dropped revision as a
    // gap, causing the existing browser reducer to request a full snapshot.
    expect(socket.sent.map((message) => "revision" in message && message.revision)).toEqual([
      2,
      3,
      4,
    ]);
    expect(socket.closes).toEqual([]);
    flow.dispose();
  });

  it("keeps identical conversation/tool flow keys isolated by workspace ownership", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.bufferedAmount = 100;
    const flow = new OutboundFlowController(socket, {
      highWaterBytes: 100,
      maxQueueBytes: 4_096,
      slowClientTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    const first = toolUpdate(1, "workspace one", "workspace-1");
    const second = toolUpdate(1, "workspace two", "workspace-2");

    flow.send(first);
    flow.send(second);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(10);
    socket.flush();

    expect(socket.sent).toEqual([first, second]);
    flow.dispose();
  });

  it("keeps queued history coalescing isolated by workspace", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.bufferedAmount = 100;
    const flow = new OutboundFlowController(socket, {
      highWaterBytes: 100,
      maxQueueBytes: 4_096,
      slowClientTimeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    const first: ServerMessage = {
      type: "history",
      workspaceId: "workspace-1",
      conversations: [],
    };
    const second: ServerMessage = {
      type: "history",
      workspaceId: "workspace-2",
      conversations: [],
    };

    flow.send(first);
    flow.send(second);
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(10);
    socket.flush();

    expect(socket.sent).toEqual([first, second]);
    flow.dispose();
  });

  it("disconnects a persistently slow client without invoking application work", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    socket.bufferedAmount = 100;
    const applicationWork = vi.fn();
    const flow = new OutboundFlowController(socket, {
      highWaterBytes: 100,
      maxQueueBytes: 4_096,
      slowClientTimeoutMs: 50,
      pollIntervalMs: 10,
    });

    flow.send(status(1));
    applicationWork();
    vi.advanceTimersByTime(50);

    expect(socket.closes).toEqual([{
      code: SLOW_CLIENT_CLOSE_CODE,
      reason: SLOW_CLIENT_CLOSE_REASON,
    }]);
    expect(applicationWork).toHaveBeenCalledOnce();
    expect(flow.queuedBytes).toBe(0);
  });
});
