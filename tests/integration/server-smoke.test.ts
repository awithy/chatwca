import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { loadConfig } from "../../src/server/config.js";
import {
  createChatWcaServer,
  type ChatWcaProtocolServices,
  type ChatWcaServer,
} from "../../src/server/index.js";
import type { ConversationImageOwner } from "../../src/server/conversation-images.js";

const openServers: ChatWcaServer[] = [];

async function startServer(images?: ConversationImageOwner): Promise<{
  readonly server: ChatWcaServer;
  readonly baseUrl: string;
}> {
  const config = loadConfig(
    {
      CHATWCA_DATA_DIR: "/tmp/chatwca-smoke-data",
      CHATWCA_MAX_IMAGES: "3",
      CHATWCA_MAX_IMAGE_BYTES: "1024",
      CHATWCA_MAX_TOTAL_IMAGE_BYTES: "2048",
      PI_CODING_AGENT_DIR: "/private/pi-data",
    },
    "/tmp",
  );
  const services = images === undefined
    ? undefined
    : {
        registry: { subscribe: () => () => undefined },
        history: {},
        workspaces: {},
        images,
      } as unknown as ChatWcaProtocolServices;
  const server = createChatWcaServer(config, "test-version", services);

  await new Promise<void>((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(0, "127.0.0.1", () => {
      server.httpServer.off("error", reject);
      resolve();
    });
  });

  openServers.push(server);
  const address = server.httpServer.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

async function rejectedUpgradeStatus(socket: WebSocket): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    socket.once("unexpected-response", (_request, response) => {
      const { statusCode } = response;
      response.resume();
      if (statusCode === undefined) {
        reject(new Error("Upgrade rejection omitted an HTTP status"));
      } else {
        resolve(statusCode);
      }
    });
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("Expected the WebSocket upgrade to be rejected"));
    });
    socket.once("error", reject);
  });
}

async function closeServer(server: ChatWcaServer): Promise<void> {
  for (const client of server.webSocketServer.clients) {
    client.terminate();
  }

  await new Promise<void>((resolve, reject) => {
    server.webSocketServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.httpServer.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map(closeServer));
});

describe("server shell", () => {
  it("serves health and browser-safe configuration", async () => {
    const { baseUrl } = await startServer();

    const healthResponse = await fetch(`${baseUrl}/api/health`);
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({
      ready: true,
      version: "test-version",
    });

    const configResponse = await fetch(`${baseUrl}/api/config`);
    expect(configResponse.status).toBe(200);
    const body = await configResponse.json();
    expect(body).toEqual({
      maxImages: 3,
      maxImageBytes: 1024,
      maxTotalImageBytes: 2048,
      sandbox: {
        mode: "disabled",
        selectableProfiles: ["unrestricted"],
        remoteProviderWarning:
          "Workspace content may still be sent to the configured model provider.",
        functionalProbeSucceeded: false,
      },
    });
    expect(JSON.stringify(body)).not.toContain("/private/pi-data");
    expect(JSON.stringify(body)).not.toContain("/tmp/chatwca-smoke-data");
  });

  it("serves canonical conversation images with restrictive response headers", async () => {
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const { baseUrl } = await startServer({
      getImage: (conversationId, entryId, imageIndex) =>
        conversationId === "one" && entryId === "entry" && imageIndex === 0
          ? { mimeType: "image/png", data: bytes }
          : undefined,
      getWorkspaceImage: async (conversationId, filePath) =>
        conversationId === "one" && filePath === "generated.png"
          ? { mimeType: "image/png", data: bytes }
          : undefined,
    });

    const response = await fetch(
      `${baseUrl}/api/conversations/one/messages/entry/images/0`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);

    const workspaceResponse = await fetch(
      `${baseUrl}/api/conversations/one/workspace-images?path=generated.png`,
    );
    expect(workspaceResponse.status).toBe(200);
    expect(workspaceResponse.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await workspaceResponse.arrayBuffer())).toEqual(bytes);

    expect((await fetch(
      `${baseUrl}/api/conversations/one/messages/entry/images/1`,
    )).status).toBe(404);
  });

  it("accepts direct and same-authority browser WebSocket clients", async () => {
    const { baseUrl } = await startServer();
    const socketUrl = baseUrl.replace(/^http/, "ws") + "/ws";
    const directSocket = new WebSocket(socketUrl);
    const browserSocket = new WebSocket(socketUrl, { origin: baseUrl });

    const messages = await Promise.all(
      [directSocket, browserSocket].map(
        async (socket) =>
          await new Promise<unknown>((resolve, reject) => {
            socket.once("message", (data) => {
              try {
                resolve(JSON.parse(data.toString()));
              } catch (error: unknown) {
                reject(error);
              }
            });
            socket.once("error", reject);
          }),
      ),
    );

    expect(messages).toEqual([
      { type: "ready", serverVersion: "test-version" },
      { type: "ready", serverVersion: "test-version" },
    ]);
    directSocket.close();
    browserSocket.close();
  });

  it("rejects cross-origin, malformed-origin, and unrelated upgrades", async () => {
    const { baseUrl } = await startServer();
    const socketBase = baseUrl.replace(/^http/, "ws");

    expect(
      await rejectedUpgradeStatus(
        new WebSocket(`${socketBase}/ws`, {
          origin: "http://unrelated.example:8787",
        }),
      ),
    ).toBe(403);
    expect(
      await rejectedUpgradeStatus(
        new WebSocket(`${socketBase}/ws`, { origin: "not-an-origin" }),
      ),
    ).toBe(403);
    expect(
      await rejectedUpgradeStatus(new WebSocket(`${socketBase}/elsewhere`)),
    ).toBe(404);
  });
});
