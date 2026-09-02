import net, { type Socket } from "node:net";

import { NetworkDecisionAuditor, type NetworkAuditReason } from "./audit.js";
import {
  ConnectionAdmission,
  ConnectionSet,
  NETWORK_RELAY_HIGH_WATER_MARK,
  relayBidirectional,
  type ConnectionLimits,
} from "./connections.js";
import {
  decideDestination,
  normalizeDestinationHost,
  type CompiledDestinationPolicy,
  type NormalizedDestinationHost,
} from "./policy.js";
import {
  PinnedConnectionError,
  PinnedDestinationConnector,
  createProductionPinnedConnector,
  createSetupDeadline,
} from "./resolver.js";

const MAX_SOCKS_HANDSHAKE_BYTES = 512;

export interface Socks5PolicyProxyOptions extends ConnectionLimits {
  readonly policy: CompiledDestinationPolicy;
  readonly connectTimeoutMs: number;
  readonly auditor: NetworkDecisionAuditor;
}

function failureReason(error: unknown): NetworkAuditReason {
  if (error instanceof PinnedConnectionError) {
    if (error.code === "non_public_address") return "local_address";
    if (error.code.startsWith("dns_")) return "dns_failure";
  }
  return "proxy_unavailable";
}

function ipv6String(bytes: Buffer): string {
  const words: string[] = [];
  for (let index = 0; index < 16; index += 2) words.push(bytes.readUInt16BE(index).toString(16));
  return words.join(":");
}

function reply(socket: Socket, code: number): void {
  if (!socket.destroyed) socket.write(Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]));
}

function denialReply(reason: NetworkAuditReason): number {
  if (reason === "port_not_allowed" || reason === "explicit_deny" || reason === "not_allowed" || reason === "local_address") return 2;
  if (reason === "limit_exceeded") return 1;
  if (reason === "dns_failure") return 4;
  return 5;
}

export class Socks5PolicyProxy {
  readonly #server: net.Server;
  readonly #admission: ConnectionAdmission;
  readonly #connections = new ConnectionSet();
  readonly #fatalListeners = new Set<() => void>();
  #listening = false;
  #closing = false;

  constructor(
    private readonly options: Socks5PolicyProxyOptions,
    private readonly connector: PinnedDestinationConnector = createProductionPinnedConnector(),
    sharedAdmission?: ConnectionAdmission,
  ) {
    this.#admission = sharedAdmission ?? new ConnectionAdmission(options.maxConnections);
    this.#server = net.createServer({
      allowHalfOpen: true,
      highWaterMark: NETWORK_RELAY_HIGH_WATER_MARK,
    }, (socket) => this.#accept(socket));
    this.#server.on("error", () => { if (this.#listening && !this.#closing) this.#fatal(); });
    this.#server.on("close", () => { if (this.#listening && !this.#closing) this.#fatal(); });
  }

  onFatal(listener: () => void): () => void {
    this.#fatalListeners.add(listener);
    return () => this.#fatalListeners.delete(listener);
  }

  async listen(socketPath: string): Promise<void> {
    if (this.#listening || this.#closing) throw new Error("proxy unavailable");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.#server.off("listening", onListening); reject(error); };
      const onListening = () => { this.#server.off("error", onError); resolve(); };
      this.#server.once("error", onError);
      this.#server.once("listening", onListening);
      this.#server.listen(socketPath);
    });
    this.#listening = true;
  }

  #fatal(): void {
    if (this.#closing) return;
    this.#closing = true;
    this.#admission.stop();
    this.#connections.closeAll();
    for (const listener of this.#fatalListeners) { try { listener(); } catch { /* observer */ } }
  }

  #accept(socket: Socket): void {
    this.#connections.add(socket);
    socket.setNoDelay(true);
    let buffer = Buffer.alloc(0);
    let stage: "greeting" | "request" | "connecting" | "relay" | "closed" = "greeting";
    const timer = setTimeout(() => socket.destroy(), this.options.connectTimeoutMs);
    timer.unref();

    const fail = (code?: number) => {
      if (stage === "closed") return;
      stage = "closed";
      clearTimeout(timer);
      if (code === undefined) socket.destroy();
      else { reply(socket, code); socket.end(); }
    };

    const parse = () => {
      if (stage === "greeting") {
        if (buffer.length < 2) return;
        const methods = buffer[1]!;
        if (buffer[0] !== 5 || methods < 1) { fail(); return; }
        const length = 2 + methods;
        if (length > MAX_SOCKS_HANDSHAKE_BYTES) { fail(); return; }
        if (buffer.length < length) return;
        const offered = buffer.subarray(2, length);
        buffer = buffer.subarray(length);
        // Select only no-auth; unsupported methods are never negotiated.
        if (!offered.includes(0)) {
          socket.end(Buffer.from([5, 0xff]));
          stage = "closed";
          clearTimeout(timer);
          return;
        }
        socket.write(Buffer.from([5, 0]));
        stage = "request";
      }
      if (stage !== "request") return;
      if (buffer.length < 4) return;
      if (buffer[0] !== 5 || buffer[2] !== 0) { fail(1); return; }
      if (buffer[1] !== 1) { fail(buffer[1] === 2 || buffer[1] === 3 ? 7 : 7); return; }
      const atyp = buffer[3]!;
      let offset = 4;
      let hostLength: number;
      if (atyp === 1) hostLength = 4;
      else if (atyp === 4) hostLength = 16;
      else if (atyp === 3) {
        if (buffer.length < 5) return;
        hostLength = buffer[4]!;
        offset = 5;
        if (hostLength < 1 || hostLength > 253) { fail(8); return; }
      } else { fail(8); return; }
      const total = offset + hostLength + 2;
      if (total > MAX_SOCKS_HANDSHAKE_BYTES) { fail(1); return; }
      if (buffer.length < total) return;
      if (buffer.length !== total) { fail(1); return; }

      let rawHost: string;
      if (atyp === 1) rawHost = [...buffer.subarray(offset, offset + 4)].join(".");
      else if (atyp === 4) rawHost = ipv6String(buffer.subarray(offset, offset + 16));
      else {
        try { rawHost = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(offset, offset + hostLength)); }
        catch { fail(8); return; }
      }
      const port = buffer.readUInt16BE(offset + hostLength);
      let host: NormalizedDestinationHost;
      try {
        host = normalizeDestinationHost(rawHost);
        if (port === 0) throw new Error("invalid port");
      } catch { fail(8); return; }
      buffer = Buffer.alloc(0);
      stage = "connecting";
      void this.#connect(socket, host, port, timer, fail, () => { stage = "relay"; }, onData);
    };

    const onData = (chunk: Buffer) => {
      if (stage === "connecting") { fail(1); return; }
      if (stage === "relay" || stage === "closed") return;
      if (buffer.length + chunk.length > MAX_SOCKS_HANDSHAKE_BYTES) { fail(); return; }
      buffer = Buffer.concat([buffer, chunk]);
      parse();
    };
    socket.on("data", onData);
    socket.once("error", () => fail());
    socket.once("close", () => { stage = "closed"; clearTimeout(timer); });
  }

  async #connect(
    client: Socket,
    host: NormalizedDestinationHost,
    port: number,
    timer: NodeJS.Timeout,
    fail: (code?: number) => void,
    relayStarted: () => void,
    dataListener: (chunk: Buffer) => void,
  ): Promise<void> {
    const destination = { host: host.host, port };
    const policy = decideDestination(this.options.policy, destination);
    if (!policy.allowed) {
      this.options.auditor.record({ protocol: "socks5-tcp", ...destination, decision: "deny", reason: policy.reason });
      fail(denialReply(policy.reason));
      return;
    }
    const release = this.#admission.acquire();
    if (release === null) {
      this.options.auditor.record({ protocol: "socks5-tcp", ...destination, decision: "deny", reason: "limit_exceeded" });
      fail(1);
      return;
    }
    let outbound: Socket;
    try {
      outbound = (await this.connector.connect(host, port, createSetupDeadline(this.options.connectTimeoutMs))).socket;
    } catch (error) {
      release();
      const reason = failureReason(error);
      this.options.auditor.record({ protocol: "socks5-tcp", ...destination, decision: "deny", reason });
      fail(denialReply(reason));
      return;
    }
    clearTimeout(timer);
    this.#connections.add(outbound);
    outbound.once("close", release);
    this.options.auditor.record({ protocol: "socks5-tcp", ...destination, decision: "allow", reason: "allowlist" });
    client.off("data", dataListener);
    reply(client, 0);
    relayStarted();
    relayBidirectional(client, outbound, {
      idleTimeoutMs: this.options.idleTimeoutMs,
      maxBytes: this.options.maxConnectionBytes,
    });
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    this.#admission.stop();
    this.#connections.closeAll();
    if (!this.#server.listening) return;
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  forceClose(): void {
    this.#closing = true;
    this.#admission.stop();
    this.#connections.closeAll();
    this.#server.close();
  }
}

export function createSocks5PolicyProxyForTesting(
  options: Socks5PolicyProxyOptions,
  connector: PinnedDestinationConnector,
  sharedAdmission?: ConnectionAdmission,
): Socks5PolicyProxy {
  return new Socks5PolicyProxy(options, connector, sharedAdmission);
}
