import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import { Socket } from "node:net";
import { type Duplex } from "node:stream";

import {
  ConnectionAdmission,
  ConnectionSet,
  NETWORK_RELAY_HIGH_WATER_MARK,
  StreamBudget,
  relayBidirectional,
  type ConnectionLimits,
} from "./connections.js";
import {
  type NetworkAuditProtocol,
  type NetworkAuditReason,
  NetworkDecisionAuditor,
} from "./audit.js";
import {
  DestinationPolicyError,
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

const MAX_HTTP_HEADER_BYTES = 32 * 1024;
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
]);

export interface HttpPolicyProxyOptions extends ConnectionLimits {
  readonly policy: CompiledDestinationPolicy;
  readonly connectTimeoutMs: number;
  readonly auditor: NetworkDecisionAuditor;
}

interface Destination {
  readonly host: NormalizedDestinationHost;
  readonly port: number;
  readonly authority: string;
}

function authorityFor(host: NormalizedDestinationHost, port: number, defaultPort?: number): string {
  const rendered = host.family === 6 ? `[${host.host}]` : host.host;
  return defaultPort === port ? rendered : `${rendered}:${port}`;
}

function parsePort(raw: string, fallback?: number): number {
  if (raw === "") {
    if (fallback !== undefined) return fallback;
    throw new Error("invalid authority");
  }
  if (!/^(?:[1-9][0-9]{0,4})$/.test(raw)) throw new Error("invalid authority");
  const port = Number(raw);
  if (port < 1 || port > 65_535) throw new Error("invalid authority");
  return port;
}

function parseAuthority(raw: string, fallbackPort?: number): Destination {
  if (raw.length === 0 || raw.length > 512 || raw.trim() !== raw || /[\u0000-\u0020\u007f/@?#\\]/.test(raw)) {
    throw new Error("invalid authority");
  }
  let hostRaw: string;
  let portRaw = "";
  let explicitPort = false;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end <= 1 || (raw[end + 1] !== ":" && end !== raw.length - 1)) throw new Error("invalid authority");
    hostRaw = raw.slice(0, end + 1);
    explicitPort = end !== raw.length - 1;
    portRaw = explicitPort ? raw.slice(end + 2) : "";
  } else {
    const colon = raw.lastIndexOf(":");
    if (colon >= 0) {
      if (raw.indexOf(":") !== colon) throw new Error("invalid authority");
      hostRaw = raw.slice(0, colon);
      portRaw = raw.slice(colon + 1);
      explicitPort = true;
    } else {
      hostRaw = raw;
    }
  }
  const host = normalizeDestinationHost(hostRaw);
  const port = parsePort(portRaw, explicitPort ? undefined : fallbackPort);
  return Object.freeze({ host, port, authority: authorityFor(host, port, fallbackPort) });
}

function rawHeaderMap(request: IncomingMessage): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase();
    const values = result.get(name) ?? [];
    values.push(request.rawHeaders[index + 1]!);
    result.set(name, values);
  }
  return result;
}

function validateFraming(request: IncomingMessage, upgrade: boolean): Map<string, string[]> {
  const headers = rawHeaderMap(request);
  for (const values of headers.values()) {
    if (values.some((value) => /[\u0000-\u001f\u007f]/.test(value))) throw new Error("invalid header value");
  }
  for (const name of ["host", "content-length", "transfer-encoding", "connection", "upgrade", "expect"]) {
    if ((headers.get(name)?.length ?? 0) > 1) throw new Error("duplicate critical header");
  }
  if (headers.has("expect")) throw new Error("expect unsupported");
  const contentLength = headers.get("content-length")?.[0];
  const transferEncoding = headers.get("transfer-encoding")?.[0];
  if (contentLength !== undefined && transferEncoding !== undefined) throw new Error("ambiguous framing");
  if (contentLength !== undefined && (!/^(?:0|[1-9][0-9]*)$/.test(contentLength.trim()) ||
      !Number.isSafeInteger(Number(contentLength.trim())))) throw new Error("invalid framing");
  if (transferEncoding !== undefined && transferEncoding.trim().toLowerCase() !== "chunked") throw new Error("invalid framing");
  const named = connectionTokens(headers);
  if (["host", "content-length", "transfer-encoding", "proxy-authorization"].some((name) => named.has(name))) {
    throw new Error("connection token names critical header");
  }
  if (upgrade && (contentLength !== undefined || transferEncoding !== undefined)) throw new Error("upgrade body");
  return headers;
}

function parseAbsoluteRequest(request: IncomingMessage): { destination: Destination; path: string } {
  const target = request.url ?? "";
  if (target.length === 0 || target.length > 16 * 1024 || target.trim() !== target ||
      target.includes("#") || target.includes("\\") || /[\u0000-\u0020\u007f]/.test(target) ||
      !/^http:\/\//i.test(target)) throw new Error("absolute HTTP target required");
  let url: URL;
  try { url = new URL(target); } catch { throw new Error("invalid target"); }
  if (url.protocol !== "http:" || url.username !== "" || url.password !== "" || url.hostname === "") {
    throw new Error("invalid target");
  }
  const authorityStart = target.indexOf("//") + 2;
  const authorityAndPath = target.slice(authorityStart);
  const authorityEnd = authorityAndPath.search(/[/?#]/u);
  const rawAuthority = authorityAndPath.slice(0, authorityEnd < 0 ? undefined : authorityEnd);
  const destination = parseAuthority(rawAuthority, 80);
  const urlDestination = parseAuthority(url.host, 80);
  if (urlDestination.host.host !== destination.host.host || urlDestination.port !== destination.port) throw new Error("ambiguous target");
  const hostHeaders = rawHeaderMap(request).get("host");
  if (hostHeaders?.length !== 1) throw new Error("one host header required");
  const metadata = parseAuthority(hostHeaders[0]!, 80);
  if (metadata.host.host !== destination.host.host || metadata.port !== destination.port) {
    throw new Error("conflicting authority");
  }
  return { destination, path: `${url.pathname}${url.search}` || "/" };
}

function parseConnectRequest(request: IncomingMessage): Destination {
  const destination = parseAuthority(request.url ?? "");
  const hosts = rawHeaderMap(request).get("host");
  if (hosts !== undefined) {
    if (hosts.length !== 1) throw new Error("duplicate host");
    const metadata = parseAuthority(hosts[0]!);
    if (metadata.host.host !== destination.host.host || metadata.port !== destination.port) {
      throw new Error("conflicting authority");
    }
  }
  return destination;
}

function connectionTokens(headers: Map<string, string[]>): Set<string> {
  const tokens = new Set<string>();
  const value = headers.get("connection")?.[0];
  if (value === undefined) return tokens;
  for (const raw of value.split(",")) {
    const token = raw.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(token)) throw new Error("invalid connection token");
    tokens.add(token);
  }
  return tokens;
}

function outboundHeaders(request: IncomingMessage, destination: Destination, websocket: boolean): IncomingHttpHeaders {
  const raw = validateFraming(request, websocket);
  const named = connectionTokens(raw);
  const result: IncomingHttpHeaders = {};
  for (const [name, values] of raw) {
    if (name === "host" || HOP_BY_HOP.has(name) || named.has(name)) continue;
    result[name] = values.length === 1 ? values[0] : [...values];
  }
  result.host = authorityFor(destination.host, destination.port, 80);
  if (websocket) {
    const upgrade = raw.get("upgrade")?.[0]?.trim().toLowerCase();
    if (upgrade !== "websocket" || !named.has("upgrade")) throw new Error("invalid websocket upgrade");
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}

function pinnedAgent(socket: Socket): http.Agent {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
  agent.createConnection = () => socket;
  return agent;
}

function responseHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const connection = new Set((headers.connection ?? "").split(",").map((v) => v.trim().toLowerCase()));
  const result: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name) || connection.has(name)) continue;
    result[name] = value;
  }
  return result;
}

function proxyError(reason: NetworkAuditReason): string {
  switch (reason) {
    case "explicit_deny": return "blocked-by-denylist";
    case "not_allowed": return "blocked-by-allowlist";
    case "local_address": return "blocked-local-address";
    case "port_not_allowed": return "blocked-port";
    default: return "policy-unavailable";
  }
}

function isPolicyDenial(reason: NetworkAuditReason): boolean {
  return reason !== "limit_exceeded" && reason !== "proxy_unavailable";
}

function pinnedFailureReason(error: unknown): NetworkAuditReason {
  if (error instanceof PinnedConnectionError) {
    if (error.code === "non_public_address") return "local_address";
    if (error.code.startsWith("dns_")) return "dns_failure";
  }
  return "proxy_unavailable";
}

function genericHttpError(response: ServerResponse, status = 502): void {
  if (response.headersSent) { response.destroy(); return; }
  response.writeHead(status, { "content-type": "text/plain", connection: "close" });
  response.end(status === 400 ? "Bad Request\n" : "Proxy Error\n");
}

function rawHttpError(socket: Duplex, status: 400 | 403 | 502, code?: string): void {
  if (socket.destroyed) return;
  const header = code === undefined ? "" : `x-chatwca-proxy-error: ${code}\r\n`;
  socket.end(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : status === 400 ? "Bad Request" : "Bad Gateway"}\r\n${header}Connection: close\r\nContent-Length: 0\r\n\r\n`);
}

export class HttpPolicyProxy {
  readonly #server: http.Server;
  readonly #admission: ConnectionAdmission;
  readonly #connections = new ConnectionSet();
  readonly #setupTimers = new WeakMap<Socket, NodeJS.Timeout>();
  readonly #fatalListeners = new Set<() => void>();
  #closing = false;
  #listening = false;

  constructor(
    private readonly options: HttpPolicyProxyOptions,
    private readonly connector: PinnedDestinationConnector = createProductionPinnedConnector(),
    sharedAdmission?: ConnectionAdmission,
  ) {
    this.#admission = sharedAdmission ?? new ConnectionAdmission(options.maxConnections);
    this.#server = http.createServer({
      maxHeaderSize: MAX_HTTP_HEADER_BYTES,
      insecureHTTPParser: false,
      joinDuplicateHeaders: false,
      requestTimeout: options.connectTimeoutMs,
      headersTimeout: options.connectTimeoutMs,
      keepAliveTimeout: options.idleTimeoutMs,
      requireHostHeader: true,
      highWaterMark: NETWORK_RELAY_HIGH_WATER_MARK,
    });
    this.#server.on("request", (request, response) => void this.#handleHttp(request, response, false));
    this.#server.on("upgrade", (request, socket, head) => void this.#handleUpgrade(request, socket, head));
    this.#server.on("connect", (request, socket, head) => void this.#handleConnect(request, socket, head));
    this.#server.on("connection", (socket) => {
      this.#connections.add(socket);
      // Use an absolute setup timer rather than an inactivity timeout: traffic
      // must not let a byte-at-a-time slowloris retain a parser indefinitely.
      const timer = setTimeout(() => socket.destroy(), this.options.connectTimeoutMs);
      timer.unref();
      this.#setupTimers.set(socket, timer);
      socket.once("close", () => {
        clearTimeout(timer);
        this.#setupTimers.delete(socket);
      });
    });
    this.#server.on("clientError", (_error, socket) => rawHttpError(socket, 400));
    this.#server.on("error", () => { if (this.#listening && !this.#closing) this.#fatal(); });
    this.#server.on("close", () => { if (this.#listening && !this.#closing) this.#fatal(); });
  }

  onFatal(listener: () => void): () => void {
    this.#fatalListeners.add(listener);
    return () => this.#fatalListeners.delete(listener);
  }

  async listen(socketPath: string): Promise<void> {
    if (this.#closing || this.#listening) throw new Error("proxy unavailable");
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

  #finishClientSetup(socket: Socket): void {
    const timer = this.#setupTimers.get(socket);
    if (timer !== undefined) clearTimeout(timer);
    this.#setupTimers.delete(socket);
    socket.setTimeout(this.options.idleTimeoutMs);
  }

  #audit(protocol: NetworkAuditProtocol, destination: Destination, decision: "allow" | "deny", reason: NetworkAuditReason) {
    this.options.auditor.record({ protocol, host: destination.host.host, port: destination.port, decision, reason });
  }

  async #connect(protocol: NetworkAuditProtocol, destination: Destination, denied: (reason: NetworkAuditReason) => void): Promise<Socket | null> {
    const policy = decideDestination(this.options.policy, { host: destination.host.host, port: destination.port });
    if (!policy.allowed) {
      this.#audit(protocol, destination, "deny", policy.reason);
      denied(policy.reason);
      return null;
    }
    const release = this.#admission.acquire();
    if (release === null) { this.#audit(protocol, destination, "deny", "limit_exceeded"); denied("limit_exceeded"); return null; }
    try {
      const connection = await this.connector.connect(destination.host, destination.port, createSetupDeadline(this.options.connectTimeoutMs));
      const socket = this.#connections.add(connection.socket);
      socket.once("close", release);
      this.#audit(protocol, destination, "allow", "allowlist");
      return socket;
    } catch (error) {
      release();
      const reason = pinnedFailureReason(error);
      this.#audit(protocol, destination, "deny", reason);
      denied(reason);
      return null;
    }
  }

  async #handleHttp(request: IncomingMessage, response: ServerResponse, websocket: boolean): Promise<void> {
    this.#finishClientSetup(request.socket);
    let parsed: { destination: Destination; path: string };
    try {
      validateFraming(request, websocket);
      parsed = parseAbsoluteRequest(request);
      if (!websocket && (request.headers.upgrade !== undefined || connectionTokens(rawHeaderMap(request)).has("upgrade"))) throw new Error("unexpected upgrade");
    } catch { genericHttpError(response, 400); return; }
    const { destination, path } = parsed;
    let deniedReason: NetworkAuditReason | undefined;
    const outbound = await this.#connect("http", destination, (reason) => { deniedReason = reason; });
    if (outbound === null) {
      if (deniedReason === undefined) {
        const decision = decideDestination(this.options.policy, { host: destination.host.host, port: destination.port });
        deniedReason = decision.reason;
      }
      if (isPolicyDenial(deniedReason)) {
        response.writeHead(403, { "x-chatwca-proxy-error": proxyError(deniedReason), connection: "close" });
        response.end();
      } else {
        genericHttpError(response);
      }
      return;
    }

    let headers: IncomingHttpHeaders;
    try { headers = outboundHeaders(request, destination, false); } catch { outbound.destroy(); genericHttpError(response, 400); return; }
    const close = () => { request.destroy(); response.destroy(); outbound.destroy(); };
    const budget = new StreamBudget(this.options.idleTimeoutMs, this.options.maxConnectionBytes, close);
    request.on("data", (chunk: Buffer) => budget.account(chunk));
    request.on("aborted", close);
    response.on("close", () => { budget.dispose(); outbound.destroy(); });

    const outgoing = http.request({
      method: request.method,
      path,
      headers,
      agent: pinnedAgent(outbound),
    }, (incoming) => {
      response.writeHead(incoming.statusCode ?? 502, responseHeaders(incoming.headers));
      incoming.on("data", (chunk: Buffer) => budget.account(chunk));
      incoming.on("end", () => budget.dispose());
      incoming.pipe(response);
    });
    outgoing.once("error", () => { budget.dispose(); genericHttpError(response); outbound.destroy(); });
    request.pipe(outgoing);
  }

  async #handleConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (client instanceof Socket) this.#finishClientSetup(client);
    let destination: Destination;
    try { validateFraming(request, true); destination = parseConnectRequest(request); } catch { rawHttpError(client, 400); return; }
    let deniedReason: NetworkAuditReason | undefined;
    const outbound = await this.#connect("https-connect", destination, (reason) => { deniedReason = reason; });
    if (outbound === null) {
      if (deniedReason === undefined) deniedReason = decideDestination(this.options.policy, { host: destination.host.host, port: destination.port }).reason;
      if (isPolicyDenial(deniedReason)) rawHttpError(client, 403, proxyError(deniedReason));
      else rawHttpError(client, 502);
      return;
    }
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    relayBidirectional(client, outbound, {
      idleTimeoutMs: this.options.idleTimeoutMs,
      maxBytes: this.options.maxConnectionBytes,
      initialLeftToRight: head,
    });
  }

  async #handleUpgrade(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (client instanceof Socket) this.#finishClientSetup(client);
    let parsed: { destination: Destination; path: string };
    let headers: IncomingHttpHeaders;
    try {
      if (request.method !== "GET") throw new Error("invalid websocket method");
      parsed = parseAbsoluteRequest(request);
      headers = outboundHeaders(request, parsed.destination, true);
    } catch { rawHttpError(client, 400); return; }
    let deniedReason: NetworkAuditReason = "proxy_unavailable";
    const outbound = await this.#connect("http", parsed.destination, (reason) => { deniedReason = reason; });
    if (outbound === null) {
      if (isPolicyDenial(deniedReason)) rawHttpError(client, 403, proxyError(deniedReason));
      else rawHttpError(client, 502);
      return;
    }
    const outgoing = http.request({ method: "GET", path: parsed.path, headers, agent: pinnedAgent(outbound) });
    const upgradeTimer = setTimeout(() => {
      outgoing.destroy();
      outbound.destroy();
      rawHttpError(client, 502);
    }, this.options.idleTimeoutMs);
    upgradeTimer.unref();
    outgoing.once("upgrade", (response, upstream, upstreamHead) => {
      clearTimeout(upgradeTimer);
      try {
        const raw = rawHeaderMap(response);
        const upgrade = raw.get("upgrade");
        const connection = raw.get("connection");
        if (response.statusCode !== 101 || upgrade?.length !== 1 || upgrade[0]!.trim().toLowerCase() !== "websocket" ||
            connection?.length !== 1 || !connectionTokens(raw).has("upgrade")) throw new Error("invalid upstream upgrade");
      } catch {
        upstream.destroy();
        outbound.destroy();
        rawHttpError(client, 502);
        return;
      }
      const lines = [`HTTP/${response.httpVersion} 101 ${response.statusMessage ?? "Switching Protocols"}`];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        const name = response.rawHeaders[index]!;
        const value = response.rawHeaders[index + 1]!;
        if (!name.toLowerCase().startsWith("proxy-") && /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) && !/[\r\n]/.test(value)) {
          lines.push(`${name}: ${value}`);
        }
      }
      client.write(`${lines.join("\r\n")}\r\n\r\n`);
      relayBidirectional(client, upstream, {
        idleTimeoutMs: this.options.idleTimeoutMs,
        maxBytes: this.options.maxConnectionBytes,
        initialLeftToRight: head,
        initialRightToLeft: upstreamHead,
      });
    });
    outgoing.once("response", (response) => {
      clearTimeout(upgradeTimer);
      response.destroy();
      rawHttpError(client, 502);
      outbound.destroy();
    });
    outgoing.once("error", () => {
      clearTimeout(upgradeTimer);
      rawHttpError(client, 502);
      outbound.destroy();
    });
    outgoing.end();
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

/** Explicit test boundary; production runtime constructs its own connector. */
export function createHttpPolicyProxyForTesting(
  options: HttpPolicyProxyOptions,
  connector: PinnedDestinationConnector,
  sharedAdmission?: ConnectionAdmission,
): HttpPolicyProxy {
  return new HttpPolicyProxy(options, connector, sharedAdmission);
}
