import http from "node:http";
import net, { type Server, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { NetworkDecisionAuditor, type NetworkPolicyAuditEvent } from "../../src/server/network/audit.js";
import { createHttpPolicyProxyForTesting } from "../../src/server/network/http-proxy.js";
import { compileDestinationPolicy } from "../../src/server/network/policy.js";
import {
  PinnedDestinationConnector,
  type NumericAddressDialer,
  type PinnedAddressResolver,
} from "../../src/server/network/resolver.js";
import { createSocks5PolicyProxyForTesting } from "../../src/server/network/socks5-proxy.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { while (cleanup.length > 0) await cleanup.pop()!(); });

async function listen(server: Server | http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as net.AddressInfo).port;
}

function connectorTo(localPort: number, calls: Array<{ address: string; port: number }> = []): PinnedDestinationConnector {
  const resolver: PinnedAddressResolver = {
    resolve: async () => ({ address: "8.8.8.8", family: 4 }),
  };
  const dialer: NumericAddressDialer = {
    dial: async (address, port) => {
      calls.push({ address: address.address, port });
      const socket = net.createConnection({ host: "127.0.0.1", port: localPort });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return socket;
    },
  };
  return new PinnedDestinationConnector(resolver, dialer);
}

function fixtureOptions(events: NetworkPolicyAuditEvent[]) {
  const auditor = new NetworkDecisionAuditor(
    { workspaceId: "workspace-1", conversationId: "conversation-1" },
    (event) => events.push(event),
  );
  cleanup.push(() => auditor.close());
  return {
    policy: compileDestinationPolicy({
      allowedDomainPatterns: ["allowed.example"],
      deniedDomainPatterns: ["denied.example"],
      allowedPorts: [80, 443],
    }),
    maxConnections: 2,
    connectTimeoutMs: 1_000,
    idleTimeoutMs: 1_000,
    maxConnectionBytes: 1024 * 1024,
    auditor,
  };
}

async function unixExchange(socketPath: string, payload: Buffer | string, end = true): Promise<Buffer> {
  const socket = net.createConnection(socketPath);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.write(payload);
  if (end) socket.end();
  else {
    await new Promise<void>((resolve) => socket.once("data", () => resolve()));
    socket.destroy();
  }
  await new Promise<void>((resolve) => socket.once("close", resolve));
  return Buffer.concat(chunks);
}

async function socketPath(name: string): Promise<{ root: string; socket: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cwca-net-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  return { root, socket: path.join(root, name) };
}

describe("parent HTTP policy proxy", () => {
  it("pins plain HTTP, reconstructs origin-form, strips hop headers, and does not follow redirects", async () => {
    const received: Array<{ url?: string; host?: string; secret?: string; remove?: string }> = [];
    const origin = http.createServer((request, response) => {
      received.push({ url: request.url, host: request.headers.host, secret: request.headers["proxy-authorization"], remove: request.headers["x-remove"] });
      response.writeHead(302, { location: "http://denied.example/private" });
      response.end("redirect");
    });
    const originPort = await listen(origin);
    const events: NetworkPolicyAuditEvent[] = [];
    const calls: Array<{ address: string; port: number }> = [];
    const proxy = createHttpPolicyProxyForTesting(fixtureOptions(events), connectorTo(originPort, calls));
    cleanup.push(() => proxy.close());
    const location = await socketPath("http.sock");
    await proxy.listen(location.socket);

    const response = (await unixExchange(location.socket,
      "GET http://allowed.example/hello?q=secret HTTP/1.1\r\n" +
      "Host: allowed.example\r\nConnection: x-remove\r\nX-Remove: hidden\r\n" +
      "Proxy-Authorization: Basic hidden\r\nConnection: close\r\n\r\n",
    )).toString("utf8");
    // Duplicate Connection is deliberately rejected rather than merged.
    expect(response).toContain("400 Bad Request");

    const accepted = (await unixExchange(location.socket,
      "GET http://allowed.example/hello?q=secret HTTP/1.1\r\n" +
      "Host: allowed.example\r\nConnection: close, x-remove\r\nX-Remove: hidden\r\nProxy-Authorization: Basic hidden\r\n\r\n",
      false,
    )).toString("utf8");
    expect(accepted).toContain("302 Found");
    expect(accepted).toContain("location: http://denied.example/private");
    expect(received).toEqual([{ url: "/hello?q=secret", host: "allowed.example", secret: undefined, remove: undefined }]);
    expect(calls).toEqual([{ address: "8.8.8.8", port: 80 }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ host: "allowed.example", decision: "allow", reason: "allowlist" });
    expect(JSON.stringify(events)).not.toContain("hello");
    expect(JSON.stringify(events)).not.toContain("secret");
  });

  it("rejects conflicting authorities, credentials, duplicate hosts, and ambiguous framing", async () => {
    const origin = net.createServer();
    const originPort = await listen(origin);
    const events: NetworkPolicyAuditEvent[] = [];
    const proxy = createHttpPolicyProxyForTesting(fixtureOptions(events), connectorTo(originPort));
    cleanup.push(() => proxy.close());
    const location = await socketPath("strict.sock");
    await proxy.listen(location.socket);
    const bad = [
      "GET http://allowed.example/ HTTP/1.1\r\nHost: denied.example\r\n\r\n",
      "GET http://user:pass@allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n",
      "GET http://allowed.example:/ HTTP/1.1\r\nHost: allowed.example\r\n\r\n",
      "GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\nConnection: content-length\r\nContent-Length: 0\r\n\r\n",
      "GET http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\nHost: allowed.example\r\n\r\n",
      "POST http://allowed.example/ HTTP/1.1\r\nHost: allowed.example\r\nContent-Length: 1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    ];
    for (const request of bad) expect((await unixExchange(location.socket, request)).toString()).toContain("400 Bad Request");
    expect(events).toEqual([]);
  });

  it("handles HTTP WebSocket upgrades only on the dedicated pinned path", async () => {
    const websocket = http.createServer();
    websocket.on("upgrade", (request, socket, head) => {
      expect(request.url).toBe("/chat");
      expect(request.headers.host).toBe("allowed.example");
      socket.write("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
      if (head.length > 0) socket.write(head);
      socket.pipe(socket);
    });
    const websocketPort = await listen(websocket);
    const events: NetworkPolicyAuditEvent[] = [];
    const proxy = createHttpPolicyProxyForTesting(fixtureOptions(events), connectorTo(websocketPort));
    cleanup.push(() => proxy.close());
    const location = await socketPath("websocket.sock");
    await proxy.listen(location.socket);

    const socket = net.createConnection(location.socket);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("GET http://allowed.example/chat HTTP/1.1\r\nHost: allowed.example\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n");
    await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toContain("101 Switching Protocols"));
    socket.write("websocket-frame");
    await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toContain("websocket-frame"));
    socket.destroy();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ protocol: "http", decision: "allow" });
  });

  it("returns stable policy denial codes and establishes CONNECT only after pinned dialing", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const events: NetworkPolicyAuditEvent[] = [];
    const proxy = createHttpPolicyProxyForTesting(fixtureOptions(events), connectorTo(echoPort));
    cleanup.push(() => proxy.close());
    const location = await socketPath("connect.sock");
    await proxy.listen(location.socket);

    const denied = (await unixExchange(location.socket,
      "CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n",
    )).toString();
    expect(denied).toContain("403 Forbidden");
    expect(denied).toContain("x-chatwca-proxy-error: blocked-by-denylist");
    expect(denied).not.toContain("127.0.0.1");

    const socket = net.createConnection(location.socket);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write("CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n");
    await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toContain("200 Connection Established"));
    socket.write("opaque-tls");
    await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toContain("opaque-tls"));
    socket.destroy();
    expect(events.map((event) => [event.decision, event.reason])).toEqual([
      ["deny", "explicit_deny"], ["allow", "allowlist"],
    ]);
  });
});

describe("parent SOCKS5 policy proxy", () => {
  it("supports no-auth domain CONNECT with parent resolution and opaque relay", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const calls: Array<{ address: string; port: number }> = [];
    const events: NetworkPolicyAuditEvent[] = [];
    const proxy = createSocks5PolicyProxyForTesting(fixtureOptions(events), connectorTo(echoPort, calls));
    cleanup.push(() => proxy.close());
    const location = await socketPath("socks.sock");
    await proxy.listen(location.socket);

    const socket = net.createConnection(location.socket);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => chunks.push(chunk));
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    socket.write(Buffer.from([5, 1, 0]));
    await vi.waitFor(() => expect(Buffer.concat(chunks).subarray(0, 2)).toEqual(Buffer.from([5, 0])));
    const host = Buffer.from("allowed.example");
    socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, Buffer.from([0, 80])]));
    await vi.waitFor(() => expect(Buffer.concat(chunks).length).toBeGreaterThanOrEqual(12));
    socket.write("socks-data");
    await vi.waitFor(() => expect(Buffer.concat(chunks).toString()).toContain("socks-data"));
    socket.destroy();
    expect(calls).toEqual([{ address: "8.8.8.8", port: 80 }]);
    expect(events[0]).toMatchObject({ protocol: "socks5-tcp", host: "allowed.example", decision: "allow" });
  });

  it("parses canonical IPv4 and IPv6 CONNECT targets through the same pinned path", async () => {
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const hosts: string[] = [];
    const resolver: PinnedAddressResolver = {
      resolve: async (host) => {
        hosts.push(host.host);
        return { address: "8.8.8.8", family: 4 };
      },
    };
    const dialer: NumericAddressDialer = {
      dial: async () => {
        const socket = net.createConnection({ host: "127.0.0.1", port: echoPort });
        await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
        return socket;
      },
    };
    const events: NetworkPolicyAuditEvent[] = [];
    const options = fixtureOptions(events);
    const proxy = createSocks5PolicyProxyForTesting({
      ...options,
      policy: compileDestinationPolicy({
        allowedDomainPatterns: ["8.8.8.8", "2001:4860:4860::8888"],
        deniedDomainPatterns: [],
        allowedPorts: [80],
      }),
    }, new PinnedDestinationConnector(resolver, dialer));
    cleanup.push(() => proxy.close());
    const location = await socketPath("numeric-socks.sock");
    await proxy.listen(location.socket);

    const ipv4 = await unixExchange(location.socket, Buffer.from([
      5, 1, 0, 5, 1, 0, 1, 8, 8, 8, 8, 0, 80,
    ]));
    expect(ipv4.subarray(0, 4)).toEqual(Buffer.from([5, 0, 5, 0]));
    const ipv6Bytes = Buffer.from("20014860486000000000000000008888", "hex");
    const ipv6 = await unixExchange(location.socket, Buffer.concat([
      Buffer.from([5, 1, 0, 5, 1, 0, 4]), ipv6Bytes, Buffer.from([0, 80]),
    ]));
    expect(ipv6.subarray(0, 4)).toEqual(Buffer.from([5, 0, 5, 0]));
    expect(hosts).toEqual(["8.8.8.8", "2001:4860:4860::8888"]);
  });

  it("rejects unsupported auth, commands, malformed/trailing handshakes, and denied targets without diagnostics", async () => {
    const origin = net.createServer();
    const originPort = await listen(origin);
    const events: NetworkPolicyAuditEvent[] = [];
    const proxy = createSocks5PolicyProxyForTesting(fixtureOptions(events), connectorTo(originPort));
    cleanup.push(() => proxy.close());
    const location = await socketPath("strict-socks.sock");
    await proxy.listen(location.socket);

    expect(await unixExchange(location.socket, Buffer.from([5, 1, 2]))).toEqual(Buffer.from([5, 0xff]));
    expect((await unixExchange(location.socket, Buffer.from([5, 1, 0, 5, 3, 0, 1, 1, 2, 3, 4, 0, 80]))).subarray(-10, -9)).toEqual(Buffer.from([5]));

    const host = Buffer.from("denied.example");
    const denied = await unixExchange(location.socket, Buffer.concat([
      Buffer.from([5, 1, 0, 5, 1, 0, 3, host.length]), host, Buffer.from([0, 80]),
    ]));
    expect(denied.subarray(0, 2)).toEqual(Buffer.from([5, 0]));
    expect(denied.subarray(2, 4)).toEqual(Buffer.from([5, 2]));
    expect(denied.toString()).not.toContain("denied.example");
    expect(events.at(-1)).toMatchObject({ decision: "deny", reason: "explicit_deny" });

    const allowed = Buffer.from("allowed.example");
    const trailing = await unixExchange(location.socket, Buffer.concat([
      Buffer.from([5, 1, 0, 5, 1, 0, 3, allowed.length]), allowed, Buffer.from([0, 80, 99]),
    ]));
    expect(trailing.subarray(0, 2)).toEqual(Buffer.from([5, 0]));
    expect(trailing.subarray(2, 4)).toEqual(Buffer.from([5, 1]));
  });
});
