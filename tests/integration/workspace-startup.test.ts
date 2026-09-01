import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { loadConfig } from "../../src/server/config.js";
import { openDatabase, type ChatWcaDatabase } from "../../src/server/database.js";
import {
  startChatWcaServer,
  type ChatWcaServer,
} from "../../src/server/index.js";
import type { PiRuntimeFactoryPort } from "../../src/server/pi-runtime.js";
import type { ServerMessage } from "../../src/shared/protocol.js";

const roots: string[] = [];
const servers: ChatWcaServer[] = [];

function fakeRuntimeFactory(): PiRuntimeFactoryPort {
  return {
    modelRuntime: {} as PiRuntimeFactoryPort["modelRuntime"],
    strictModelRuntime: {} as PiRuntimeFactoryPort["strictModelRuntime"],
    listAvailableModels: vi.fn(async () => []),
    createPersistent: vi.fn(async () => {
      throw new Error("Startup workspace test must not create a runtime");
    }),
    openPersistent: vi.fn(async () => {
      throw new Error("Startup workspace test must not open a runtime");
    }),
  };
}

function nextMessage(socket: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as ServerMessage);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function command(socket: WebSocket, payload: object): Promise<ServerMessage> {
  const response = nextMessage(socket);
  socket.send(JSON.stringify(payload));
  return response;
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.close();
  await closed;
}

async function start(
  root: string,
  listSessions: (
    cwd: string,
    sessionDirectory?: string,
  ) => Promise<readonly never[]>,
  databases: ChatWcaDatabase[],
): Promise<ChatWcaServer> {
  const config = loadConfig({
    CHATWCA_HOST: "127.0.0.1",
    CHATWCA_PORT: "8787",
    CHATWCA_DATA_DIR: path.join(root, "data"),
    CHATWCA_SHUTDOWN_GRACE_MS: "100",
  }, root);
  const server = await startChatWcaServer({
    loadConfiguration: () => config,
    openDatabase: (dataDir) => {
      const database = openDatabase(dataDir);
      databases.push(database);
      return database;
    },
    createRuntimeFactory: async () => fakeRuntimeFactory(),
    listSessions,
    serverVersion: "workspace-startup-integration",
    listen: (created) => new Promise<void>((resolve, reject) => {
      created.httpServer.once("error", reject);
      created.httpServer.listen(0, "127.0.0.1", () => {
        created.httpServer.off("error", reject);
        resolve();
      });
    }),
  });
  servers.push(server);
  return server;
}

async function connect(server: ChatWcaServer): Promise<WebSocket> {
  const { port } = server.httpServer.address() as AddressInfo;
  const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  await expect(nextMessage(socket)).resolves.toMatchObject({ type: "ready" });
  return socket;
}

afterEach(async () => {
  await Promise.allSettled(servers.splice(0).map((server) => server.shutdown()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("workspace startup, persistence, and availability integration", () => {
  it("persists workspace-local storage and scopes listing without creating it at registration", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "chatwca-workspace-local-"));
    roots.push(root);
    const workspacePath = path.join(root, "project");
    const sessionDirectory = path.join(workspacePath, ".chatwca", "sessions");
    mkdirSync(workspacePath);
    const listSessions = vi.fn(async () => [] as const);
    const databases: ChatWcaDatabase[] = [];
    const first = await start(root, listSessions, databases);
    const firstSocket = await connect(first);

    const created = await command(firstSocket, {
      type: "workspace.create",
      requestId: "create-local",
      name: "Local workspace",
      path: workspacePath,
      sessionStorage: "workspace",
      securityProfile: "unrestricted",
    });
    expect(created).toMatchObject({
      type: "workspaces",
      workspaces: [{
        name: "Local workspace",
        sessionStorage: "workspace",
        sessionDirectory,
      }],
    });
    expect(existsSync(path.join(workspacePath, ".chatwca"))).toBe(false);
    const workspaceId = created.type === "workspaces"
      ? created.workspaces[0]?.id
      : undefined;
    expect(workspaceId).toBeDefined();

    await command(firstSocket, {
      type: "history.list",
      requestId: "list-local",
      workspaceId,
    });
    expect(listSessions).toHaveBeenCalledExactlyOnceWith(
      workspacePath,
      sessionDirectory,
    );

    await closeSocket(firstSocket);
    await first.shutdown();
    servers.splice(servers.indexOf(first), 1);

    const second = await start(root, listSessions, databases);
    const secondSocket = await connect(second);
    await expect(command(secondSocket, {
      type: "workspace.list",
      requestId: "persisted-local",
    })).resolves.toMatchObject({
      type: "workspaces",
      workspaces: [{
        id: workspaceId,
        sessionStorage: "workspace",
        sessionDirectory,
      }],
    });
    await closeSocket(secondSocket);
  });

  it("never scans at startup/connection, persists rows across restart, restores paths, and closes SQLite", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "chatwca-workspace-startup-"));
    roots.push(root);
    const workspacePath = path.join(root, "project");
    mkdirSync(workspacePath);
    let listingAllowed = false;
    const listSessions = vi.fn(async (_cwd: string) => {
      if (!listingAllowed) throw new Error("Pi session listing occurred before workspace selection");
      return [] as const;
    });
    const databases: ChatWcaDatabase[] = [];

    const first = await start(root, listSessions, databases);
    const firstSocket = await connect(first);
    expect(listSessions).not.toHaveBeenCalled();

    await expect(command(firstSocket, {
      type: "workspace.list",
      requestId: "initial-list",
    })).resolves.toEqual({
      type: "workspaces",
      requestId: "initial-list",
      workspaces: [],
    });
    expect(listSessions).not.toHaveBeenCalled();

    const created = await command(firstSocket, {
      type: "workspace.create",
      requestId: "create",
      name: "Persistent workspace",
      path: workspacePath,
      sessionStorage: "pi-default",
      securityProfile: "unrestricted",
    });
    expect(created).toMatchObject({
      type: "workspaces",
      requestId: "create",
      workspaces: [{ name: "Persistent workspace", path: workspacePath, available: true }],
    });
    const workspaceId = created.type === "workspaces" ? created.workspaces[0]?.id : undefined;
    expect(workspaceId).toBeDefined();
    expect(listSessions).not.toHaveBeenCalled();

    await closeSocket(firstSocket);
    await first.shutdown();
    servers.splice(servers.indexOf(first), 1);
    expect(databases[0]?.closed).toBe(true);
    expect(databases[0]?.connection.open).toBe(false);

    const second = await start(root, listSessions, databases);
    const secondSocket = await connect(second);
    const persisted = await command(secondSocket, {
      type: "workspace.list",
      requestId: "persisted-list",
    });
    expect(persisted).toMatchObject({
      type: "workspaces",
      workspaces: [{ id: workspaceId, name: "Persistent workspace", available: true }],
    });
    expect(listSessions).not.toHaveBeenCalled();

    listingAllowed = true;
    await expect(command(secondSocket, {
      type: "history.list",
      requestId: "selected-history",
      workspaceId,
    })).resolves.toMatchObject({
      type: "history",
      workspaceId,
      conversations: [],
    });
    expect(listSessions).toHaveBeenCalledExactlyOnceWith(workspacePath);

    rmSync(workspacePath, { recursive: true });
    await expect(command(secondSocket, {
      type: "workspace.list",
      requestId: "missing-list",
    })).resolves.toMatchObject({
      type: "workspaces",
      workspaces: [{ id: workspaceId, available: false }],
    });
    await expect(command(secondSocket, {
      type: "history.list",
      requestId: "missing-history",
      workspaceId,
    })).resolves.toMatchObject({
      type: "error",
      requestId: "missing-history",
      code: "workspace_unavailable",
    });
    expect(listSessions).toHaveBeenCalledTimes(1);

    mkdirSync(workspacePath);
    await expect(command(secondSocket, {
      type: "workspace.list",
      requestId: "restored-list",
    })).resolves.toMatchObject({
      type: "workspaces",
      workspaces: [{ id: workspaceId, available: true }],
    });
    await expect(command(secondSocket, {
      type: "history.list",
      requestId: "restored-history",
      workspaceId,
    })).resolves.toMatchObject({
      type: "history",
      workspaceId,
      conversations: [],
    });
    expect(listSessions).toHaveBeenCalledTimes(2);

    await closeSocket(secondSocket);
    await second.shutdown();
    servers.splice(servers.indexOf(second), 1);
    expect(databases[1]?.closed).toBe(true);
    expect(databases[1]?.connection.open).toBe(false);
  });
});
