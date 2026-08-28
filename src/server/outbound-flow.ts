import { Buffer } from "node:buffer";
import WebSocket from "ws";

import type { ServerMessage } from "../shared/protocol.js";

/** Start retaining application-level messages once ws has this much buffered data. */
export const DEFAULT_OUTBOUND_HIGH_WATER_BYTES = 512 * 1024;
/** Application memory retained for one slow client, excluding ws' own bounded buffer. */
export const DEFAULT_MAX_OUTBOUND_QUEUE_BYTES = 4 * 1024 * 1024;
/** Disconnect a client that remains backpressured for this long. */
export const DEFAULT_SLOW_CLIENT_TIMEOUT_MS = 5_000;
export const DEFAULT_OUTBOUND_POLL_INTERVAL_MS = 25;
export const SLOW_CLIENT_CLOSE_CODE = 1013;
export const SLOW_CLIENT_CLOSE_REASON = "Client is too slow; reconnect to resynchronize";

export interface OutboundSocket {
  readonly readyState: number;
  readonly bufferedAmount: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
}

export interface OutboundFlowOptions {
  readonly highWaterBytes?: number;
  readonly maxQueueBytes?: number;
  readonly slowClientTimeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly now?: () => number;
  readonly onError?: (error: unknown) => void;
}

interface QueuedMessage {
  readonly data: string;
  readonly bytes: number;
  readonly coalesceKey?: string;
  readonly droppable: boolean;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function coalesceKey(message: ServerMessage): string | undefined {
  if (message.type === "tool.updated") {
    return `tool:${message.conversationId}:${message.payload.toolCallId}`;
  }
  if (message.type === "history" && message.requestId === undefined) {
    return "history";
  }
  return undefined;
}

function isDroppable(message: ServerMessage): boolean {
  return message.type === "tool.updated" ||
    (message.type === "history" && message.requestId === undefined);
}

/**
 * Per-socket outbound flow control.
 *
 * Text, status, completion, state, and correlated response messages are never
 * coalesced. Consecutive cumulative `tool.updated` values may replace one
 * another while queued. The replacement keeps the newest authoritative
 * revision, so the browser's normal revision-gap handling requests a snapshot
 * if it did not receive the superseded update. This makes coalescing safe
 * without changing a conversation's server-side revision stream.
 */
export class OutboundFlowController {
  readonly #socket: OutboundSocket;
  readonly #highWaterBytes: number;
  readonly #maxQueueBytes: number;
  readonly #slowClientTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;
  readonly #queue: QueuedMessage[] = [];
  #queuedBytes = 0;
  #pressureStartedAt: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pumping = false;
  #disposed = false;

  constructor(socket: OutboundSocket, options: OutboundFlowOptions = {}) {
    this.#socket = socket;
    this.#highWaterBytes = positiveInteger(
      options.highWaterBytes ?? DEFAULT_OUTBOUND_HIGH_WATER_BYTES,
      "highWaterBytes",
    );
    this.#maxQueueBytes = positiveInteger(
      options.maxQueueBytes ?? DEFAULT_MAX_OUTBOUND_QUEUE_BYTES,
      "maxQueueBytes",
    );
    this.#slowClientTimeoutMs = positiveInteger(
      options.slowClientTimeoutMs ?? DEFAULT_SLOW_CLIENT_TIMEOUT_MS,
      "slowClientTimeoutMs",
    );
    this.#pollIntervalMs = positiveInteger(
      options.pollIntervalMs ?? DEFAULT_OUTBOUND_POLL_INTERVAL_MS,
      "pollIntervalMs",
    );
    this.#now = options.now ?? Date.now;
    this.#onError = options.onError ?? (() => undefined);
  }

  /** Bytes retained by ws plus messages still held in the application queue. */
  get bufferedBytes(): number {
    return this.#socket.bufferedAmount + this.#queuedBytes;
  }

  get queuedBytes(): number {
    return this.#queuedBytes;
  }

  send(message: ServerMessage): void {
    if (this.#disposed || this.#socket.readyState !== WebSocket.OPEN) return;

    let data: string;
    try {
      data = JSON.stringify(message);
    } catch (error) {
      this.#onError(error);
      return;
    }
    const key = coalesceKey(message);
    const item: QueuedMessage = {
      data,
      bytes: Buffer.byteLength(data),
      ...(key === undefined ? {} : { coalesceKey: key }),
      droppable: isDroppable(message),
    };

    if (
      this.#queue.length === 0 &&
      this.#socket.bufferedAmount < this.#highWaterBytes
    ) {
      this.#write(item);
      this.#updatePressure();
      return;
    }

    if (item.coalesceKey !== undefined) {
      const previous = this.#queue.at(-1);
      // Only adjacent cumulative updates are replaceable. Replacing across an
      // intervening revision would reorder events for this socket.
      if (previous?.coalesceKey === item.coalesceKey) {
        this.#queue[this.#queue.length - 1] = item;
        this.#queuedBytes += item.bytes - previous.bytes;
        if (this.#queuedBytes > this.#maxQueueBytes) {
          this.#queue.pop();
          this.#queuedBytes -= item.bytes;
        }
        this.#updatePressure();
        return;
      }
    }

    if (this.#queuedBytes + item.bytes > this.#maxQueueBytes) {
      if (item.droppable) {
        // A later revision or snapshot reconciles this cumulative update.
        this.#updatePressure();
        return;
      }
      this.#discardDroppableUntil(item.bytes);
      if (this.#queuedBytes + item.bytes > this.#maxQueueBytes) {
        this.#closeSlowClient();
        return;
      }
    }

    this.#queue.push(item);
    this.#queuedBytes += item.bytes;
    this.#updatePressure();
    this.#pump();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#queue.length = 0;
    this.#queuedBytes = 0;
  }

  #discardDroppableUntil(requiredBytes: number): void {
    for (let index = 0; index < this.#queue.length;) {
      if (this.#queuedBytes + requiredBytes <= this.#maxQueueBytes) return;
      const candidate = this.#queue[index];
      if (candidate === undefined || !candidate.droppable) {
        index += 1;
        continue;
      }
      this.#queue.splice(index, 1);
      this.#queuedBytes -= candidate.bytes;
    }
  }

  #pump(): void {
    if (this.#pumping || this.#disposed) return;
    this.#pumping = true;
    try {
      while (
        this.#queue.length > 0 &&
        this.#socket.readyState === WebSocket.OPEN &&
        this.#socket.bufferedAmount < this.#highWaterBytes
      ) {
        const item = this.#queue.shift();
        if (item === undefined) break;
        this.#queuedBytes -= item.bytes;
        this.#write(item);
      }
    } finally {
      this.#pumping = false;
      this.#updatePressure();
    }
  }

  #write(item: QueuedMessage): void {
    try {
      this.#socket.send(item.data, (error) => {
        if (error !== undefined) this.#onError(error);
        this.#pump();
      });
    } catch (error) {
      this.#onError(error);
    }
  }

  #updatePressure(): void {
    if (this.#disposed || this.#socket.readyState !== WebSocket.OPEN) {
      this.dispose();
      return;
    }

    const pressured =
      this.#queue.length > 0 ||
      this.#socket.bufferedAmount >= this.#highWaterBytes;
    if (!pressured) {
      this.#pressureStartedAt = undefined;
      if (this.#timer !== undefined) clearTimeout(this.#timer);
      this.#timer = undefined;
      return;
    }

    this.#pressureStartedAt ??= this.#now();
    if (this.#now() - this.#pressureStartedAt >= this.#slowClientTimeoutMs) {
      this.#closeSlowClient();
      return;
    }
    if (this.#timer === undefined) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        this.#pump();
      }, this.#pollIntervalMs);
    }
  }

  #closeSlowClient(): void {
    if (this.#disposed) return;
    try {
      this.#socket.close(SLOW_CLIENT_CLOSE_CODE, SLOW_CLIENT_CLOSE_REASON);
    } catch (error) {
      this.#onError(error);
    } finally {
      this.dispose();
    }
  }
}
