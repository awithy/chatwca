import http from "node:http";
import net, { type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { loadManagedNetworkConfig } from "../../src/server/network/config.js";
import { ManagedNetworkRuntime } from "../../src/server/network/managed-runtime.js";
import {
  PinnedDestinationConnector,
  type NumericAddressDialer,
  type PinnedAddressResolver,
} from "../../src/server/network/resolver.js";

async function connected(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
}

async function listen(server: net.Server | http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

describe("managed parent proxy integration", () => {
  it("shares limits while pinning HTTP, CONNECT, and SOCKS to a validated numeric address", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cwca-net-integration-"));
    const origin = http.createServer((request, response) => {
      response.end(`origin:${request.url}`);
    });
    const originPort = await listen(origin);
    const echo = net.createServer((socket) => socket.pipe(socket));
    const echoPort = await listen(echo);
    const dialed: Array<{ address: string; requestedPort: number }> = [];
    const resolver: PinnedAddressResolver = {
      resolve: async () => ({ address: "8.8.8.8", family: 4 }),
    };
    const dialer: NumericAddressDialer = {
      dial: async (address, requestedPort) => {
        dialed.push({ address: address.address, requestedPort });
        const socket = net.createConnection({
          host: "127.0.0.1",
          port: requestedPort === 80 ? originPort : echoPort,
        });
        await connected(socket);
        return socket;
      },
    };
    const diagnostics: Array<{ decision: string; reason: string }> = [];
    const config = loadManagedNetworkConfig({
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["allowed.example"]',
      CHATWCA_NETWORK_ALLOWED_PORTS: "[80,443]",
      CHATWCA_NETWORK_MAX_CONNECTIONS: "1",
      CHATWCA_NETWORK_MAX_CONNECTION_BYTES: "32",
      CHATWCA_NETWORK_HELPER_PATH: "/unused/helper",
    }, "required");
    const policySet = config.policySets.get("default")!;
    const runtime = await ManagedNetworkRuntime.startForTesting({
      dataDir: root,
      workspaceId: "workspace-integration",
      conversationId: "conversation-integration",
      policySetId: policySet.id,
      policySet,
      config,
      diagnosticSink: (event) => diagnostics.push(event),
    }, new PinnedDestinationConnector(resolver, dialer));

    try {
      const httpClient = net.createConnection(runtime.httpSocketPath);
      const httpChunks: Buffer[] = [];
      httpClient.on("data", (chunk) => httpChunks.push(chunk));
      await connected(httpClient);
      httpClient.write("GET http://allowed.example/pkg HTTP/1.1\r\nHost: allowed.example\r\nConnection: close\r\n\r\n");
      await vi.waitFor(() => expect(Buffer.concat(httpChunks).toString()).toContain("origin:/pkg"));
      httpClient.destroy();
      await vi.waitFor(() => expect(diagnostics).toContainEqual(expect.objectContaining({ decision: "allow" })));

      const tunnel = net.createConnection(runtime.httpSocketPath);
      const tunnelChunks: Buffer[] = [];
      tunnel.on("data", (chunk) => tunnelChunks.push(chunk));
      await connected(tunnel);
      tunnel.write("CONNECT allowed.example:443 HTTP/1.1\r\nHost: allowed.example:443\r\n\r\n");
      await vi.waitFor(() => expect(Buffer.concat(tunnelChunks).toString()).toContain("200 Connection Established"));

      const socks = net.createConnection(runtime.socksSocketPath);
      const socksChunks: Buffer[] = [];
      socks.on("data", (chunk) => socksChunks.push(chunk));
      await connected(socks);
      const host = Buffer.from("allowed.example");
      socks.write(Buffer.concat([
        Buffer.from([5, 1, 0, 5, 1, 0, 3, host.length]), host, Buffer.from([1, 187]),
      ]));
      await vi.waitFor(() => expect(Buffer.concat(socksChunks).subarray(0, 4)).toEqual(Buffer.from([5, 0, 5, 1])));
      expect(diagnostics).toContainEqual(expect.objectContaining({ decision: "deny", reason: "limit_exceeded" }));
      socks.destroy();

      tunnel.write("opaque");
      await vi.waitFor(() => expect(Buffer.concat(tunnelChunks).toString()).toContain("opaque"));
      tunnel.write("01234567890123456");
      await vi.waitFor(() => expect(tunnel.destroyed).toBe(true));
      expect(dialed).toEqual([
        { address: "8.8.8.8", requestedPort: 80 },
        { address: "8.8.8.8", requestedPort: 443 },
      ]);
      expect(JSON.stringify(diagnostics)).not.toMatch(/127\.0\.0\.1|\/pkg|header|opaque/i);
    } finally {
      await runtime.close();
      await Promise.all([
        new Promise<void>((resolve) => origin.close(() => resolve())),
        new Promise<void>((resolve) => echo.close(() => resolve())),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  });
});
