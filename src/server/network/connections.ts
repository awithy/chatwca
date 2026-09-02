import { type Duplex } from "node:stream";

export const NETWORK_RELAY_HIGH_WATER_MARK = 64 * 1024;

export interface ConnectionLimits {
  readonly maxConnections: number;
  readonly idleTimeoutMs: number;
  readonly maxConnectionBytes: number;
}

export class ConnectionAdmission {
  #active = 0;
  #closed = false;

  constructor(readonly maximum: number) {
    if (!Number.isSafeInteger(maximum) || maximum <= 0) {
      throw new TypeError("maximum connections must be a positive safe integer");
    }
  }

  get active(): number { return this.#active; }
  get closed(): boolean { return this.#closed; }

  acquire(): (() => void) | null {
    if (this.#closed || this.#active >= this.maximum) return null;
    this.#active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#active -= 1;
    };
  }

  stop(): void { this.#closed = true; }
}

/** Owns every accepted/outbound stream so shutdown can never leave a relay alive. */
export class ConnectionSet {
  readonly #streams = new Set<Duplex>();
  #closed = false;

  add<T extends Duplex>(stream: T): T {
    if (this.#closed) {
      stream.destroy();
      return stream;
    }
    this.#streams.add(stream);
    const remove = () => this.#streams.delete(stream);
    stream.once("close", remove);
    return stream;
  }

  delete(stream: Duplex): void { this.#streams.delete(stream); }
  get size(): number { return this.#streams.size; }

  closeAll(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const stream of this.#streams) stream.destroy();
    this.#streams.clear();
  }
}

export interface RelayOptions {
  readonly idleTimeoutMs: number;
  readonly maxBytes: number;
  readonly initialLeftToRight?: Buffer;
  readonly initialRightToLeft?: Buffer;
  readonly onClose?: () => void;
}

/**
 * Relays two connected streams with one aggregate byte budget. Node's writable
 * high-water mark supplies bounded backpressure; explicit pause/resume avoids
 * accumulating readable data when a peer's write queue is full.
 */
export function relayBidirectional(left: Duplex, right: Duplex, options: RelayOptions): () => void {
  if (!Number.isSafeInteger(options.idleTimeoutMs) || options.idleTimeoutMs <= 0 ||
      !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0) {
    throw new TypeError("relay limits must be positive safe integers");
  }

  let bytes = 0;
  let closed = false;
  let idle: NodeJS.Timeout | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    if (idle !== undefined) clearTimeout(idle);
    left.destroy();
    right.destroy();
    options.onClose?.();
  };
  const armIdle = () => {
    if (idle !== undefined) clearTimeout(idle);
    idle = setTimeout(close, options.idleTimeoutMs);
    idle.unref();
  };
  const account = (chunk: Buffer | string): boolean => {
    bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (bytes > options.maxBytes) {
      close();
      return false;
    }
    armIdle();
    return true;
  };
  const forward = (source: Duplex, destination: Duplex, chunk: Buffer | string) => {
    if (!account(chunk)) return;
    if (!destination.write(chunk)) {
      source.pause();
      destination.once("drain", () => { if (!closed) source.resume(); });
    }
  };

  left.on("data", (chunk: Buffer | string) => forward(left, right, chunk));
  right.on("data", (chunk: Buffer | string) => forward(right, left, chunk));
  left.once("end", () => { if (!closed) right.end(); });
  right.once("end", () => { if (!closed) left.end(); });
  left.once("error", close);
  right.once("error", close);
  left.once("close", close);
  right.once("close", close);
  armIdle();

  const writeInitial = (destination: Duplex, chunk: Buffer | undefined) => {
    if (chunk === undefined || chunk.byteLength === 0 || !account(chunk)) return;
    destination.write(chunk);
  };
  writeInitial(right, options.initialLeftToRight);
  writeInitial(left, options.initialRightToLeft);
  return close;
}

/** Applies the same aggregate bytes/idle controls to HTTP request/response streams. */
export class StreamBudget {
  #bytes = 0;
  #closed = false;
  #idle: NodeJS.Timeout | undefined;

  constructor(
    private readonly idleTimeoutMs: number,
    private readonly maxBytes: number,
    private readonly close: () => void,
  ) {
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0 ||
        !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("invalid stream budget");
    this.touch();
  }

  account(chunk: Buffer | string): boolean {
    if (this.#closed) return false;
    this.#bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
    if (this.#bytes > this.maxBytes) {
      this.dispose();
      this.close();
      return false;
    }
    this.touch();
    return true;
  }

  touch(): void {
    if (this.#closed) return;
    if (this.#idle !== undefined) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => {
      this.dispose();
      this.close();
    }, this.idleTimeoutMs);
    this.#idle.unref();
  }

  dispose(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#idle !== undefined) clearTimeout(this.#idle);
  }
}
