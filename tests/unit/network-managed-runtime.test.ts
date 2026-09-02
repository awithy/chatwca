import http from "node:http";
import net from "node:net";
import { lstat, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadManagedNetworkConfig } from "../../src/server/network/config.js";
import {
  ManagedNetworkRuntime,
  cleanupStaleManagedNetworkDirectories,
} from "../../src/server/network/managed-runtime.js";
import {
  PinnedDestinationConnector,
  type NumericAddressDialer,
  type PinnedAddressResolver,
} from "../../src/server/network/resolver.js";

const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

function config(allowed = "allowed.example") {
  return loadManagedNetworkConfig({
    CHATWCA_MANAGED_EGRESS_MODE: "optional",
    CHATWCA_NETWORK_ALLOWED_DOMAINS: JSON.stringify([allowed]),
    CHATWCA_NETWORK_ALLOWED_PORTS: "[80,443]",
    CHATWCA_NETWORK_HELPER_PATH: "/unused/chatwca-network-helper",
  }, "optional");
}

function selected(configValue: ReturnType<typeof config>, id = "default") {
  const policySet = configValue.policySets.get(id);
  if (policySet === undefined) throw new Error(`missing test policy set ${id}`);
  return { config: configValue, policySetId: id, policySet };
}

function unusedConnector(): PinnedDestinationConnector {
  const resolver: PinnedAddressResolver = { resolve: async () => ({ address: "8.8.8.8", family: 4 }) };
  const dialer: NumericAddressDialer = { dial: async () => { throw new Error("not expected"); } };
  return new PinnedDestinationConnector(resolver, dialer);
}

function connectorTo(port: number, resolvedHosts: string[] = []): PinnedDestinationConnector {
  const resolver: PinnedAddressResolver = {
    resolve: async (host) => {
      resolvedHosts.push(host.host);
      return { address: "8.8.8.8", family: 4 };
    },
  };
  const dialer: NumericAddressDialer = {
    dial: async () => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
      return socket;
    },
  };
  return new PinnedDestinationConnector(resolver, dialer);
}

async function root(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "cwca-runtime-"));
  roots.push(value);
  return value;
}

async function exchange(socketPath: string, payload: string): Promise<string> {
  const socket = net.createConnection(socketPath);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  socket.end(payload);
  await new Promise<void>((resolve) => socket.once("close", resolve));
  return Buffer.concat(chunks).toString();
}

async function socksConnectResponse(socketPath: string, host: string): Promise<Buffer> {
  const socket = net.createConnection(socketPath);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const encodedHost = Buffer.from(host);
  socket.end(Buffer.concat([
    Buffer.from([5, 1, 0, 5, 1, 0, 3, encodedHost.length]),
    encodedHost,
    Buffer.from([0, 80]),
  ]));
  await new Promise<void>((resolve) => socket.once("close", resolve));
  return Buffer.concat(chunks);
}

async function exchangeUntilResponse(socketPath: string, payload: string): Promise<string> {
  const socket = net.createConnection(socketPath);
  const chunks: Buffer[] = [];
  return new Promise<string>((resolve, reject) => {
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const response = Buffer.concat(chunks).toString();
      if (!response.includes("\r\n\r\n")) return;
      socket.destroy();
      resolve(response);
    });
    socket.on("connect", () => socket.write(payload));
  });
}

describe("ManagedNetworkRuntime", () => {
  it("owns separate private sockets and emits validated/coalesced blocked notifications", async () => {
    const dataDir = await root();
    const diagnostics: unknown[] = [];
    const firstConfig = config();
    const secondConfig = config("other.example");
    const first = await ManagedNetworkRuntime.startForTesting({
      dataDir, workspaceId: "workspace-1", conversationId: "conversation-1",
      ...selected(firstConfig), diagnosticSink: (event) => diagnostics.push(event),
    }, unusedConnector());
    const second = await ManagedNetworkRuntime.startForTesting({
      dataDir, workspaceId: "workspace-2", conversationId: "conversation-2",
      ...selected(secondConfig), diagnosticSink: () => undefined,
    }, unusedConnector());
    expect(first.httpSocketPath).not.toBe(second.httpSocketPath);
    expect(first.socksSocketPath).not.toBe(second.socksSocketPath);
    expect(first.policySetId).toBe("default");
    expect(first.policySet).toBe(firstConfig.policySets.get("default"));

    for (const socketPath of [first.httpSocketPath, first.socksSocketPath]) {
      const stat = await lstat(socketPath);
      expect(stat.isSocket()).toBe(true);
      expect(stat.mode & 0o777).toBe(0o600);
      expect((await lstat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
      expect((await lstat(path.dirname(path.dirname(socketPath)))).mode & 0o777).toBe(0o700);
    }

    const blocked = vi.fn();
    first.subscribeBlocked(blocked);
    const response = await exchange(first.httpSocketPath,
      "CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n");
    expect(response).toContain("blocked-by-allowlist");
    expect(blocked).toHaveBeenCalledWith({
      protocol: "https-connect", host: "denied.example", port: 443, reason: "not_allowed",
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatchObject({ policySetId: "default" });
    expect(JSON.stringify(diagnostics)).not.toMatch(/socket|dataDir|resolved|header/i);
    const isolatedPolicy = await exchange(second.httpSocketPath,
      "CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n");
    expect(isolatedPolicy).toContain("blocked-by-allowlist");

    const firstClose = first.close();
    expect(first.close()).toBe(firstClose);
    await Promise.all([firstClose, second.close()]);
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("enforces distinct immutable selected sets across concurrent workspace proxies", async () => {
    const dataDir = await root();
    const configured = loadManagedNetworkConfig({
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["alpha.example","beta.example"]',
      CHATWCA_NETWORK_ALLOWED_PORTS: "[80]",
      CHATWCA_NETWORK_POLICY_SETS: JSON.stringify([
        { id: "default", label: "Alpha", allowedDomains: ["alpha.example"], allowedPorts: [80] },
        { id: "beta", label: "Beta", allowedDomains: ["beta.example"], allowedPorts: [80] },
      ]),
      CHATWCA_NETWORK_HELPER_PATH: "/unused/chatwca-network-helper",
    }, "optional");
    const origin = http.createServer((_request, response) => {
      response.writeHead(204, { connection: "close" });
      response.end();
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originPort = (origin.address() as net.AddressInfo).port;
    const alphaResolved: string[] = [];
    const betaResolved: string[] = [];
    const alpha = await ManagedNetworkRuntime.startForTesting({
      dataDir, workspaceId: "workspace-alpha", conversationId: "conversation-alpha",
      ...selected(configured), diagnosticSink: () => undefined,
    }, connectorTo(originPort, alphaResolved));
    const beta = await ManagedNetworkRuntime.startForTesting({
      dataDir, workspaceId: "workspace-beta", conversationId: "conversation-beta",
      ...selected(configured, "beta"), diagnosticSink: () => undefined,
    }, connectorTo(originPort, betaResolved));

    try {
      const request = (host: string) =>
        `GET http://${host}/ HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`;
      const [alphaOwn, alphaOther, betaOwn, betaOther, alphaSocksOther, betaSocksOther] = await Promise.all([
        exchangeUntilResponse(alpha.httpSocketPath, request("alpha.example")),
        exchangeUntilResponse(alpha.httpSocketPath, request("beta.example")),
        exchangeUntilResponse(beta.httpSocketPath, request("beta.example")),
        exchangeUntilResponse(beta.httpSocketPath, request("alpha.example")),
        socksConnectResponse(alpha.socksSocketPath, "beta.example"),
        socksConnectResponse(beta.socksSocketPath, "alpha.example"),
      ]);
      expect(alphaOwn).toContain("204 No Content");
      expect(betaOwn).toContain("204 No Content");
      expect(alphaOther).toContain("403 Forbidden");
      expect(betaOther).toContain("403 Forbidden");
      expect(alphaSocksOther.subarray(0, 4)).toEqual(Buffer.from([5, 0, 5, 2]));
      expect(betaSocksOther.subarray(0, 4)).toEqual(Buffer.from([5, 0, 5, 2]));
      expect(alphaResolved).toEqual(["alpha.example"]);
      expect(betaResolved).toEqual(["beta.example"]);
      expect(alpha.policySetId).toBe("default");
      expect(beta.policySetId).toBe("beta");
      expect(alpha.policySet).not.toBe(beta.policySet);
    } finally {
      await Promise.all([alpha.close(), beta.close()]);
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    }
  });

  it("fails closed on a missing or mismatched selected compiled set before listening", async () => {
    const dataDir = await root();
    const configured = config();
    const policySet = configured.policySets.get("default")!;
    await expect(ManagedNetworkRuntime.startForTesting({
      dataDir,
      workspaceId: "workspace",
      conversationId: "conversation",
      config: configured,
      policySetId: "other",
      policySet,
      diagnosticSink: () => undefined,
    }, unusedConnector())).rejects.toMatchObject({ code: "network_policy_invalid" });
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("recovers descriptors after malformed connection pressure and closes every stalled client", async () => {
    const dataDir = await root();
    const stressed = config();
    const pressureConfig = Object.freeze({ ...stressed, connectTimeoutMs: 30 });
    const runtime = await ManagedNetworkRuntime.startForTesting({
      dataDir, workspaceId: "workspace-pressure", conversationId: "conversation-pressure",
      ...selected(pressureConfig), diagnosticSink: () => undefined,
    }, unusedConnector());
    const before = (await readdir("/proc/self/fd")).length;
    const clients = await Promise.all(Array.from({ length: 64 }, async () => {
      const socket = net.createConnection(runtime.httpSocketPath);
      await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      socket.write("GET http://allowed.example/ HTTP/1.1\r\nX-Partial");
      return socket;
    }));
    await Promise.all(clients.map((socket) => new Promise<void>((resolve) => {
      if (socket.destroyed) resolve(); else socket.once("close", resolve);
    })));
    await vi.waitFor(async () => expect((await readdir("/proc/self/fd")).length).toBeLessThanOrEqual(before + 2));
    expect(await exchange(runtime.httpSocketPath,
      "CONNECT denied.example:443 HTTP/1.1\r\nHost: denied.example:443\r\n\r\n"))
      .toContain("blocked-by-allowlist");
    await runtime.close();
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("rejects overlong Unix socket paths before creating a process directory", async () => {
    const base = await root();
    const deep = path.join(base, "x".repeat(90));
    await expect(ManagedNetworkRuntime.startForTesting({
      dataDir: deep, workspaceId: "workspace", conversationId: "conversation",
      ...selected(config()), diagnosticSink: () => undefined,
    }, unusedConnector())).rejects.toMatchObject({ code: "network_proxy_start_failed" });
    expect(await readdir(deep)).toEqual([]);
  });

  it("cleans only verified stale direct entries and leaves unknown/symlink shapes untouched", async () => {
    const dataDir = await root();
    const stale = path.join(dataDir, "net-p-99999999-abcde");
    const runtime = path.join(stale, "r-abcde");
    await mkdir(runtime, { recursive: true, mode: 0o700 });
    await cleanupStaleManagedNetworkDirectories(dataDir);
    expect(await readdir(dataDir)).toEqual([]);

    const unsafe = path.join(dataDir, "net-p-99999998-abcde");
    const unsafeRuntime = path.join(unsafe, "r-abcde");
    await mkdir(unsafeRuntime, { recursive: true, mode: 0o700 });
    await writeFile(path.join(unsafeRuntime, "unexpected"), "do not remove", { mode: 0o600 });
    const target = path.join(dataDir, "target");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, path.join(dataDir, "net-p-99999997-abcde"));
    await cleanupStaleManagedNetworkDirectories(dataDir);
    expect((await readdir(dataDir)).sort()).toEqual([
      "net-p-99999997-abcde", "net-p-99999998-abcde", "target",
    ]);
  });
});
