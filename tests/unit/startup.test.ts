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
import type {
  SandboxWorkerArtifact,
  ValidatedSandboxHost,
} from "../../src/server/sandbox/bwrap.js";

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

const workerArtifact: SandboxWorkerArtifact = {
  source: Buffer.from("worker"), sha256: "a".repeat(64), version: "1",
};
const validatedHost: ValidatedSandboxHost = {
  bwrapPath: "/usr/bin/bwrap",
  bwrapVersion: "bubblewrap 0.6.1",
  nodeVersion: "v22.19.0",
  rgPath: "/usr/bin/rg",
  rgVersion: "ripgrep 14.0.0",
  compatibilityLinks: { bin: true, sbin: true, lib: true, lib64: true },
};

function fakeRuntimeFactory(): PiRuntimeFactoryPort {
  return {
    modelRuntime: {} as PiRuntimeFactoryPort["modelRuntime"],
    strictModelRuntime: {} as PiRuntimeFactoryPort["strictModelRuntime"],
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

  it("runs enabled sandbox loading, validation, and functional probing before Pi services and listeners", async () => {
    const root = temporaryDirectory();
    const loadedConfig = loadConfig({
      CHATWCA_HOST: "127.0.0.1",
      CHATWCA_PORT: "8787",
      CHATWCA_DATA_DIR: path.join(root, "data"),
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_WORKSPACE_ROOTS: "[]",
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["EXAMPLE.com."]',
      CHATWCA_NETWORK_POLICY_SETS: JSON.stringify([{
        id: "default",
        label: "Example destinations",
        allowedDomains: ["example.com"],
        allowedPorts: [443],
      }]),
      CHATWCA_SHUTDOWN_GRACE_MS: "25",
    }, root);
    const calls: string[] = [];
    let database: ChatWcaDatabase | undefined;
    const server = await startChatWcaServer({
      loadConfiguration: () => { calls.push("config"); return loadedConfig; },
      openDatabase: (dataDir) => {
        calls.push("sqlite");
        database = openDatabase(dataDir);
        return database;
      },
      loadSandboxWorkerArtifact: async () => { calls.push("worker"); return workerArtifact; },
      validateNetworkHelper: () => {
        calls.push("network-helper");
        return {
          path: loadedConfig.managedNetwork.helperPath,
          directory: loadedConfig.managedNetwork.helperDirectory,
          manifestPath: loadedConfig.managedNetwork.helperManifestPath,
          architecture: "x64",
          buildVersion: "1.0.0",
          protocolVersion: 1,
          sha256: "0".repeat(64),
        };
      },
      validateSandboxHost: () => { calls.push("validate"); return validatedHost; },
      runSandboxStartupProbe: async () => {
        calls.push("probe");
        return { succeeded: true, managedEgressSucceeded: true, bwrapVersion: "bubblewrap 0.6.1", nodeVersion: "v22.19.0", rgVersion: "ripgrep 14.0.0", workerSha256: workerArtifact.sha256 };
      },
      createWorkspaceRepository: (connection) => {
        calls.push("workspace-repository");
        return new WorkspaceRepository(connection);
      },
      createRuntimeFactory: async () => { calls.push("pi-services"); return fakeRuntimeFactory(); },
      serverVersion: "sandbox-startup-test",
      listen: async (created) => { calls.push("listeners"); await bindEphemeral(created); },
    });
    runningServers.push(server);
    expect(calls).toEqual([
      "config", "sqlite", "network-helper", "worker", "validate", "probe",
      "workspace-repository", "pi-services", "listeners",
    ]);
    const address = server.httpServer.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/config`);
    await expect(response.json()).resolves.toMatchObject({
      sandbox: { mode: "optional", functionalProbeSucceeded: true },
      managedEgress: {
        mode: "optional",
        selectablePolicies: ["isolated", "managed-egress"],
        policySets: [{
          id: "default",
          label: "Example destinations",
          allowedDomainPatterns: ["example.com"],
          allowedPorts: [443],
        }],
        allowedDomainPatterns: ["example.com"],
        functionalProbeSucceeded: true,
      },
    });
    await server.shutdown();
    expect(database?.closed).toBe(true);
  });

  it("refuses to listen when the optional managed startup probe is incomplete", async () => {
    const root = temporaryDirectory();
    const loadedConfig = loadConfig({
      CHATWCA_DATA_DIR: path.join(root, "data"),
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_WORKSPACE_ROOTS: "[]",
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["example.com"]',
    }, root);
    let database: ChatWcaDatabase | undefined;
    const createPi = vi.fn(async () => fakeRuntimeFactory());
    const bind = vi.fn(bindEphemeral);
    await expect(startChatWcaServer({
      loadConfiguration: () => loadedConfig,
      openDatabase: (dataDir) => { database = openDatabase(dataDir); return database; },
      loadSandboxWorkerArtifact: async () => workerArtifact,
      validateNetworkHelper: () => ({
        path: loadedConfig.managedNetwork.helperPath,
        directory: loadedConfig.managedNetwork.helperDirectory,
        manifestPath: loadedConfig.managedNetwork.helperManifestPath,
        architecture: "x64", buildVersion: "1.0.0", protocolVersion: 1, sha256: "0".repeat(64),
      }),
      validateSandboxHost: () => validatedHost,
      runSandboxStartupProbe: async () => ({
        succeeded: true, managedEgressSucceeded: false,
        bwrapVersion: "bubblewrap 0.6.1", nodeVersion: "v22.19.0",
        rgVersion: "ripgrep 14.0.0", workerSha256: workerArtifact.sha256,
      }),
      createRuntimeFactory: createPi,
      listen: bind,
    })).rejects.toMatchObject({ code: "network_helper_unavailable" });
    expect(database?.closed).toBe(true);
    expect(createPi).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
  });

  it("fails before storage when managed egress conflicts with disabled sandboxing", async () => {
    const open = vi.fn(() => openDatabase(temporaryDirectory()));
    await expect(startChatWcaServer({
      loadConfiguration: () => loadConfig({
        CHATWCA_SANDBOX_MODE: "disabled",
        CHATWCA_MANAGED_EGRESS_MODE: "optional",
        CHATWCA_NETWORK_ALLOWED_DOMAINS: '["example.com"]',
      }, temporaryDirectory()),
      openDatabase: open,
      createRuntimeFactory: async () => fakeRuntimeFactory(),
    })).rejects.toThrow(/requires CHATWCA_SANDBOX_MODE/);
    expect(open).not.toHaveBeenCalled();
  });

  it("disabled mode never loads, validates, or probes Bubblewrap", async () => {
    const root = temporaryDirectory();
    const loadWorker = vi.fn(async () => workerArtifact);
    const validateNetwork = vi.fn();
    const validateHost = vi.fn(() => validatedHost);
    const probe = vi.fn(async () => ({ succeeded: true as const, bwrapVersion: "", nodeVersion: "", rgVersion: "", workerSha256: "" }));
    const server = await startChatWcaServer({
      loadConfiguration: () => config(root),
      loadSandboxWorkerArtifact: loadWorker,
      validateNetworkHelper: validateNetwork,
      validateSandboxHost: validateHost,
      runSandboxStartupProbe: probe,
      createRuntimeFactory: async () => fakeRuntimeFactory(),
      serverVersion: "disabled-test",
      listen: bindEphemeral,
    });
    runningServers.push(server);
    expect(loadWorker).not.toHaveBeenCalled();
    expect(validateNetwork).not.toHaveBeenCalled();
    expect(validateHost).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });

  it("fails closed and closes SQLite when the functional probe fails before Pi/listen", async () => {
    const root = temporaryDirectory();
    const loadedConfig = loadConfig({
      CHATWCA_DATA_DIR: path.join(root, "data"),
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_WORKSPACE_ROOTS: "[]",
    }, root);
    const failure = new Error("probe failed");
    let database: ChatWcaDatabase | undefined;
    const createPi = vi.fn(async () => fakeRuntimeFactory());
    const bind = vi.fn(bindEphemeral);
    await expect(startChatWcaServer({
      loadConfiguration: () => loadedConfig,
      openDatabase: (dataDir) => { database = openDatabase(dataDir); return database; },
      loadSandboxWorkerArtifact: async () => workerArtifact,
      validateSandboxHost: () => validatedHost,
      runSandboxStartupProbe: async () => { throw failure; },
      createRuntimeFactory: createPi,
      listen: bind,
    })).rejects.toBe(failure);
    expect(database?.closed).toBe(true);
    expect(createPi).not.toHaveBeenCalled();
    expect(bind).not.toHaveBeenCalled();
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
