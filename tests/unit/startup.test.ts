import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/shared/errors.js";
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
import { JobRepository } from "../../src/server/job-repository.js";
import { JobRunner } from "../../src/server/job-runner.js";
import { JobScheduler } from "../../src/server/job-scheduler.js";
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
      createJobRepository: (connection) => {
        calls.push("job-repository");
        return new JobRepository(connection);
      },
      createRuntimeFactory: async () => {
        calls.push("pi-services");
        return fakeRuntimeFactory();
      },
      createJobRunner: (runnerOptions) => {
        calls.push("job-runner");
        return new JobRunner(runnerOptions);
      },
      createJobScheduler: (schedulerOptions) => {
        calls.push("scheduler");
        return new JobScheduler(schedulerOptions);
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
      "job-repository",
      "pi-services",
      "job-runner",
      "scheduler",
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

  it("recovers interrupted runs and claims one overdue catch-up before listener readiness", async () => {
    const root = temporaryDirectory();
    const workspacePath = path.join(root, "workspace");
    mkdirSync(workspacePath);
    const loadedConfig = config(root);
    let database: ChatWcaDatabase | undefined;
    const listSessions = vi.fn(async () => []);

    const server = await startChatWcaServer({
      loadConfiguration: () => loadedConfig,
      openDatabase: (dataDir) => {
        database = openDatabase(dataDir);
        database.connection.prepare(`
          INSERT INTO workspaces (
            id, name, path, session_storage, security_profile, network_policy,
            network_policy_set_id, created_at, updated_at
          ) VALUES ('workspace', 'Workspace', ?, 'pi-default', 'unrestricted',
            'isolated', 'default', 0, 0)
        `).run(realpathSync(workspacePath));
        database.connection.prepare(`
          INSERT INTO jobs (
            id, name, workspace_id, prompt, schedule_kind, interval_minutes,
            anchor_at, enabled, next_run_at, created_at, updated_at
          ) VALUES ('job', 'Job', 'workspace', 'run', 'interval', 1,
            0, 1, 0, 0, 0)
        `).run();
        database.connection.prepare(`
          INSERT INTO job_runs (
            id, job_id, trigger, scheduled_for, started_at, status, revision,
            created_at, updated_at
          ) VALUES ('old-run', 'job', 'scheduled', 0, 0, 'running', 1, 0, 0)
        `).run();
        return database;
      },
      createRuntimeFactory: async () => fakeRuntimeFactory(),
      listSessions,
      serverVersion: "job-recovery-test",
      listen: async (created) => {
        const old = database!.connection.prepare("SELECT status, error_code FROM job_runs WHERE id = 'old-run'").get();
        expect(old).toEqual({ status: "interrupted", error_code: ERROR_CODES.JOB_INTERRUPTED });
        const catches = database!.connection.prepare("SELECT trigger, scheduled_for FROM job_runs WHERE job_id = 'job' AND id != 'old-run'").all();
        expect(catches).toEqual([{ trigger: "catch-up", scheduled_for: 0 }]);
        const next = database!.connection.prepare("SELECT next_run_at FROM jobs WHERE id = 'job'").get() as { next_run_at: number };
        expect(next.next_run_at).toBeGreaterThan(Date.now());
        await bindEphemeral(created);
      },
    });
    runningServers.push(server);
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("runs enabled sandbox loading, validation, and functional probing before Pi services and listeners", async () => {
    const root = temporaryDirectory();
    const hookRoot = path.join(root, "trusted-hooks");
    mkdirSync(hookRoot);
    const loadedConfig = loadConfig({
      CHATWCA_HOST: "127.0.0.1",
      CHATWCA_PORT: "8787",
      CHATWCA_DATA_DIR: path.join(root, "data"),
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_WORKSPACE_ROOTS: "[]",
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["EXAMPLE.com."]',
      CHATWCA_JOB_SCRIPT_ROOTS: JSON.stringify([hookRoot]),
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
      validateNetworkHelper: (input) => {
        calls.push("network-helper");
        expect(input.protectedPaths).toContain(realpathSync(hookRoot));
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
      runSandboxStartupProbe: async (input) => {
        calls.push("probe");
        expect(input.protectedPaths).toEqual([realpathSync(hookRoot)]);
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
      jobs: {
        schedulerAvailable: true,
        hooksAvailable: true,
        scriptRoots: [realpathSync(hookRoot)],
        minIntervalMinutes: 1,
        maxIntervalMinutes: 525_600,
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

  it("unwinds runtimes and SQLite without listening when scheduler recovery fails", async () => {
    const root = temporaryDirectory();
    const failure = new Error("scheduler recovery failed");
    let database: ChatWcaDatabase | undefined;
    const bind = vi.fn(bindEphemeral);

    await expect(startChatWcaServer({
      loadConfiguration: () => config(root),
      openDatabase: (dataDir) => {
        database = openDatabase(dataDir);
        return database;
      },
      createRuntimeFactory: async () => fakeRuntimeFactory(),
      createJobScheduler: (schedulerOptions) => {
        const scheduler = new JobScheduler(schedulerOptions);
        vi.spyOn(scheduler, "start").mockRejectedValue(failure);
        return scheduler;
      },
      listen: bind,
    })).rejects.toBe(failure);

    expect(bind).not.toHaveBeenCalled();
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
