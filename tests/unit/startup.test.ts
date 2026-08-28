import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig, type ServerConfig } from "../../src/server/config.js";
import {
  openDatabase,
  type ChatWcaDatabase,
} from "../../src/server/database.js";
import {
  startChatWcaServer,
  type ChatWcaServer,
} from "../../src/server/index.js";
import type { PiRuntimeFactoryPort } from "../../src/server/pi-runtime.js";
import { WorkspaceRepository } from "../../src/server/workspace-repository.js";

const temporaryDirectories: string[] = [];
const runningServers: ChatWcaServer[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "chatwca-startup-"));
  temporaryDirectories.push(directory);
  return directory;
}

function config(root: string): Readonly<ServerConfig> {
  return loadConfig(
    {
      CHATWCA_HOST: "127.0.0.1",
      CHATWCA_PORT: "8787",
      CHATWCA_DATA_DIR: path.join(root, "data"),
      CHATWCA_SHUTDOWN_GRACE_MS: "25",
    },
    root,
  );
}

function fakeRuntimeFactory(): PiRuntimeFactoryPort {
  return {
    modelRuntime: {} as PiRuntimeFactoryPort["modelRuntime"],
    listAvailableModels: vi.fn(async () => []),
    createPersistent: vi.fn(async () => {
      throw new Error("Unexpected runtime creation during startup");
    }),
    openPersistent: vi.fn(async () => {
      throw new Error("Unexpected runtime open during startup");
    }),
  };
}

async function bindEphemeral(server: ChatWcaServer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.httpServer.once("error", reject);
    server.httpServer.listen(0, "127.0.0.1", () => {
      server.httpServer.off("error", reject);
      resolve();
    });
  });
}

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.shutdown()));
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("production startup wiring", () => {
  it("initializes config, SQLite/repository, Pi services, scoped services, then listeners without listing history", async () => {
    const root = temporaryDirectory();
    const loadedConfig = config(root);
    const calls: string[] = [];
    const listSessions = vi.fn(async () => []);
    let database: ChatWcaDatabase | undefined;

    const server = await startChatWcaServer({
      loadConfiguration: () => {
        calls.push("config");
        return loadedConfig;
      },
      openDatabase: (dataDir) => {
        calls.push("sqlite");
        database = openDatabase(dataDir);
        return database;
      },
      createWorkspaceRepository: (connection) => {
        calls.push("workspace-repository");
        return new WorkspaceRepository(connection);
      },
      createRuntimeFactory: async () => {
        calls.push("pi-services");
        return fakeRuntimeFactory();
      },
      listSessions,
      serverVersion: "startup-test",
      listen: async (created) => {
        calls.push("listeners");
        await bindEphemeral(created);
      },
    });
    runningServers.push(server);

    expect(calls).toEqual([
      "config",
      "sqlite",
      "workspace-repository",
      "pi-services",
      "listeners",
    ]);
    expect(listSessions).not.toHaveBeenCalled();

    const address = server.httpServer.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${String(address.port)}/api/health`,
    );
    expect(await response.json()).toEqual({
      ready: true,
      version: "startup-test",
    });

    await server.shutdown();
    expect(database?.closed).toBe(true);
  });

  it("closes SQLite when required Pi initialization fails", async () => {
    const root = temporaryDirectory();
    const failure = new Error("Pi initialization failed");
    let database: ChatWcaDatabase | undefined;

    await expect(startChatWcaServer({
      loadConfiguration: () => config(root),
      openDatabase: (dataDir) => {
        database = openDatabase(dataDir);
        return database;
      },
      createRuntimeFactory: async () => { throw failure; },
      serverVersion: "unused",
    })).rejects.toBe(failure);

    expect(database?.closed).toBe(true);
  });

  it("preserves initialization errors while reporting a one-shot SQLite close failure", async () => {
    const root = temporaryDirectory();
    const initializationFailure = new Error("Pi initialization failed");
    const closeFailure = new Error("SQLite close failed");
    const reportError = vi.fn();
    let database: ChatWcaDatabase | undefined;
    let nativeClose: ReturnType<typeof vi.spyOn> | undefined;

    await expect(startChatWcaServer({
      loadConfiguration: () => config(root),
      openDatabase: (dataDir) => {
        database = openDatabase(dataDir);
        nativeClose = vi.spyOn(database.connection, "close").mockImplementation(() => {
          throw closeFailure;
        });
        return database;
      },
      createRuntimeFactory: async () => { throw initializationFailure; },
      serverVersion: "unused",
      onInternalError: reportError,
    })).rejects.toBe(initializationFailure);

    expect(database?.closed).toBe(true);
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(reportError).toHaveBeenCalledExactlyOnceWith(closeFailure);

    nativeClose?.mockRestore();
    database?.connection.close();
  });

  it("cleans protocol, runtimes, and SQLite when listener initialization fails", async () => {
    const root = temporaryDirectory();
    const listenerFailure = new Error("listen failed");
    let database: ChatWcaDatabase | undefined;

    await expect(startChatWcaServer({
      loadConfiguration: () => config(root),
      openDatabase: (dataDir) => {
        database = openDatabase(dataDir);
        return database;
      },
      createRuntimeFactory: async () => fakeRuntimeFactory(),
      serverVersion: "unused",
      listen: async () => { throw listenerFailure; },
    })).rejects.toBe(listenerFailure);

    expect(database?.closed).toBe(true);
  });
});
