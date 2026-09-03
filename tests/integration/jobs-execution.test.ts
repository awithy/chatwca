import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationRegistry } from "../../src/server/conversation-registry.js";
import { openDatabase, type ChatWcaDatabase } from "../../src/server/database.js";
import { JobHookPathAdmission } from "../../src/server/job-hook-path.js";
import { JobHookRunner } from "../../src/server/job-hook-runner.js";
import { JobRepository } from "../../src/server/job-repository.js";
import { JobRunner } from "../../src/server/job-runner.js";
import { JobScheduler } from "../../src/server/job-scheduler.js";
import { JobService } from "../../src/server/job-service.js";
import { PiRuntimeFactory } from "../../src/server/pi-runtime.js";
import { RuntimeCoordinator } from "../../src/server/runtime-coordinator.js";
import { SessionHistory } from "../../src/server/session-history.js";
import { WorkspaceRepository } from "../../src/server/workspace-repository.js";
import { ERROR_CODES } from "../../src/shared/errors.js";
import type { JobRunState, JobSummary } from "../../src/shared/jobs.js";

interface JobsFixture {
  readonly root: string;
  readonly dataDir: string;
  readonly agentDir: string;
  readonly defaultSessions: string;
  readonly hookRoot: string;
  readonly database: ChatWcaDatabase;
  readonly workspaces: WorkspaceRepository;
  readonly jobs: JobRepository;
  readonly registry: ConversationRegistry;
  readonly history: SessionHistory;
  readonly hookRunner: JobHookRunner;
  readonly runner: JobRunner;
  readonly scheduler: JobScheduler;
  readonly coordinator: RuntimeCoordinator;
  readonly faux: FauxProviderHandle;
  readonly runtimeCwds: string[];
  setNow(value: number): void;
  createWorkspace(name: string, directory: string, localSessions?: boolean): ReturnType<WorkspaceRepository["create"]>;
  createJob(workspaceId: string, changes?: Partial<Parameters<JobRepository["create"]>[0]>): JobSummary;
  run(jobId: string): Promise<JobRunState>;
  close(): Promise<void>;
}

const fixtures: JobsFixture[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function createFixture(options: { readonly maxLive?: number; readonly hookTimeoutMs?: number } = {}): Promise<JobsFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-jobs-integration-"));
  const dataDir = path.join(root, "data");
  const agentDir = path.join(root, "pi-agent");
  const defaultSessions = path.join(root, "pi-sessions");
  const hookRoot = path.join(root, "trusted-hooks");
  await Promise.all([
    mkdir(dataDir),
    mkdir(agentDir),
    mkdir(defaultSessions),
    mkdir(hookRoot),
  ]);

  let now = 1_000;
  const database = openDatabase(dataDir);
  const workspaces = new WorkspaceRepository(database.connection, {
    cwd: root,
    clock: () => now,
    policy: {
      mode: "disabled",
      workspaceRoots: [],
      dataDirectory: dataDir,
      piAgentDirectory: agentDir,
      readOnlyMounts: [],
      jobScriptRoots: [hookRoot],
      managedEgressMode: "disabled",
    },
  });
  const hookPaths = new JobHookPathAdmission({
    scriptRoots: [hookRoot],
    protectedPaths: [dataDir, agentDir, defaultSessions],
  });

  const faux = fauxProvider({
    tokensPerSecond: 10_000,
    tokenSize: { min: 4, max: 4 },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const runtimeCwds: string[] = [];
  const runtimeFactory = await PiRuntimeFactory.create({
    modelRuntime,
    strictModelRuntime: modelRuntime,
    agentDir,
    sessionDir: defaultSessions,
    serviceOptions: (cwd) => {
      runtimeCwds.push(cwd);
      return { settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }) };
    },
    sessionOptions: () => ({ model: faux.getModel(), noTools: "all" }),
  });

  let registry!: ConversationRegistry;
  const history = new SessionHistory({
    sessionDir: defaultSessions,
    getLiveStatus: (identity) => {
      const record = registry?.get(identity.id) ?? registry?.getBySessionFile(identity.sessionFile);
      return record === undefined
        ? undefined
        : {
            workspaceId: record.workspaceId,
            status: record.status,
            ...(record.owner === undefined ? {} : { owner: record.owner }),
          };
    },
  });
  registry = new ConversationRegistry({
    runtimeFactory,
    maxLiveConversations: options.maxLive ?? 4,
    refreshHistory: async (workspaceId) => {
      await history.refresh(workspaces.requireAvailable(workspaceId));
    },
  });
  const jobs = new JobRepository(database.connection, {
    clock: () => now,
    workspaceStatus: (workspaceId) => {
      const workspace = workspaces.get(workspaceId);
      return { name: workspace.name, available: workspace.available };
    },
    hookPathAdmission: hookPaths,
    hookWorkspacePolicy: (workspaceId) => {
      const workspace = workspaces.requireAvailable(workspaceId);
      return { cwd: workspace.path, mounts: workspace.mounts };
    },
    conversationAvailable: (conversationId) => registry.get(conversationId) !== undefined,
  });
  const hookRunner = new JobHookRunner({
    config: {
      hookTimeoutMs: options.hookTimeoutMs ?? 5_000,
      hookMaxOutputBytes: 64 * 1_024,
    },
    terminationGraceMs: 50,
  });
  const runner = new JobRunner({
    repository: jobs,
    workspaces,
    hookPaths,
    hooks: hookRunner,
    registry,
  });
  const scheduler = new JobScheduler({ repository: jobs, runner, clock: () => now });
  const coordinator = new RuntimeCoordinator({
    scheduler,
    jobRunner: runner,
    hookRunner,
    registry,
    repository: jobs,
    clock: () => now,
  });

  let closed = false;
  const fixture: JobsFixture = {
    root,
    dataDir,
    agentDir,
    defaultSessions,
    hookRoot,
    database,
    workspaces,
    jobs,
    registry,
    history,
    hookRunner,
    runner,
    scheduler,
    coordinator,
    faux,
    runtimeCwds,
    setNow: (value) => { now = value; },
    createWorkspace: (name, directory, localSessions = false) => workspaces.create({
      name,
      path: directory,
      sessionStorage: localSessions ? "workspace" : "pi-default",
      securityProfile: "unrestricted",
      networkPolicy: "isolated",
    }),
    createJob: (workspaceId, changes = {}) => jobs.create({
      name: "Integration job",
      workspaceId,
      prompt: "Run the deterministic job",
      schedule: { kind: "interval", intervalMinutes: 1 },
      enabled: true,
      ...changes,
    }),
    run: async (jobId) => runner.run(jobs.claimManual(jobId, now)),
    close: async () => {
      if (closed) return;
      closed = true;
      scheduler.beginShutdown();
      runner.beginShutdown();
      hookRunner.beginShutdown();
      registry.beginShutdown();
      await Promise.allSettled([runner.dispose(), hookRunner.dispose(), registry.dispose()]);
      database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  fixtures.push(fixture);
  return fixture;
}

async function createDirectory(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await mkdir(directory);
  return directory;
}

async function writeScript(root: string, name: string, source: string): Promise<string> {
  const filename = path.join(root, name);
  await writeFile(filename, `set -eu\n${source}\n`, { mode: 0o700 });
  return filename;
}

async function waitForTerminal(repository: JobRepository, jobId: string, trigger: JobRunState["trigger"]): Promise<JobRunState> {
  let found: JobRunState | undefined;
  await vi.waitFor(() => {
    const summary = repository.listRuns(jobId).runs.find((run) => run.trigger === trigger);
    expect(summary).toBeDefined();
    expect(summary?.status).not.toBe("queued");
    expect(summary?.status).not.toBe("running");
    if (summary !== undefined) found = repository.getRun(jobId, summary.id);
  }, { timeout: 5_000 });
  return found!;
}

afterEach(async () => {
  await Promise.allSettled(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe("scheduled job execution through real service boundaries", () => {
  it("runs with no clients, creates distinct default/local Pi sessions, and retains them on deletion", async () => {
    const f = await createFixture();
    const defaultWorkspacePath = await createDirectory(f.root, "workspace-default");
    const localWorkspacePath = await createDirectory(f.root, "workspace-local");
    const defaultWorkspace = f.createWorkspace("Default sessions", defaultWorkspacePath);
    const localWorkspace = f.createWorkspace("Local sessions", localWorkspacePath, true);
    const defaultJob = f.createJob(defaultWorkspace.id, { name: "Repeated" });
    const localJob = f.createJob(localWorkspace.id, { name: "Local" });
    f.faux.setResponses([
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
      fauxAssistantMessage("local"),
    ]);

    const recurringNext = defaultJob.nextRunAt;
    const first = await f.run(defaultJob.id);
    const second = await f.run(defaultJob.id);
    const local = await f.run(localJob.id);

    expect([first.status, second.status, local.status]).toEqual(["succeeded", "succeeded", "succeeded"]);
    expect(f.jobs.get(defaultJob.id).nextRunAt).toBe(recurringNext);
    expect(new Set([first.conversationId, second.conversationId, local.conversationId]).size).toBe(3);
    expect(first.conversationId).not.toBeNull();
    const defaultHistory = await f.history.list(f.workspaces.requireAvailable(defaultWorkspace.id));
    const localHistory = await f.history.list(f.workspaces.requireAvailable(localWorkspace.id));
    expect(defaultHistory.map(({ id }) => id)).toEqual(expect.arrayContaining([first.conversationId, second.conversationId]));
    expect(defaultHistory.every(({ sessionFile }) => path.dirname(sessionFile) === f.defaultSessions)).toBe(true);
    expect(localHistory).toContainEqual(expect.objectContaining({ id: local.conversationId }));
    expect(path.dirname(localHistory[0]!.sessionFile)).toBe(path.join(localWorkspacePath, ".chatwca", "sessions"));
    expect(f.registry.size).toBe(0);

    const service = new JobService({
      repository: f.jobs,
      scheduler: f.scheduler,
      runner: f.runner,
      workspaces: f.workspaces,
      history: f.history,
    });
    await expect(service.runState(defaultJob.id, first.id)).resolves.toMatchObject({
      conversationId: first.conversationId,
      conversationAvailable: true,
    });

    const retainedFiles = [...defaultHistory, ...localHistory].map(({ sessionFile }) => sessionFile);
    f.jobs.delete(defaultJob.id);
    f.jobs.delete(localJob.id);
    expect(f.jobs.list()).toEqual([]);
    expect(retainedFiles.every(existsSync)).toBe(true);
  });

  it("runs trusted hooks in order with documented metadata and resolves a changed workspace policy on the next run", async () => {
    const f = await createFixture();
    const firstPath = await createDirectory(f.root, "workspace-a");
    const secondPath = await createDirectory(f.root, "workspace-b");
    const workspace = f.createWorkspace("Moving workspace", firstPath);
    const log = path.join(f.root, "hook-order.log");
    const pre = await writeScript(f.hookRoot, "pre.sh", [
      `printf 'pre|%s|%s|%s|%s\\n' "$CHATWCA_RUN_PHASE" "$PWD" "$CHATWCA_CONVERSATION_ID" "$CHATWCA_RUN_STATUS" >> ${shellQuote(log)}`,
      "printf pre-output",
    ].join("\n"));
    const post = await writeScript(f.hookRoot, "post.sh", [
      `printf 'post|%s|%s|%s|%s\\n' "$CHATWCA_RUN_PHASE" "$PWD" "$CHATWCA_CONVERSATION_ID" "$CHATWCA_RUN_STATUS" >> ${shellQuote(log)}`,
      "printf post-output",
    ].join("\n"));
    const job = f.createJob(workspace.id, {
      preRunScript: pre,
      postRunScript: post,
      acknowledgeHostHooks: true,
    });
    f.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);

    const first = await f.run(job.id);
    f.workspaces.update(workspace.id, { path: secondPath });
    const second = await f.run(job.id);

    expect(first).toMatchObject({ status: "succeeded", preStdout: "pre-output", postStdout: "post-output" });
    expect(second.status).toBe("succeeded");
    expect(f.runtimeCwds).toEqual([firstPath, secondPath]);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      `pre|pre-hook|${firstPath}||running`,
      `post|post-hook|${firstPath}|${first.conversationId}|succeeded`,
      `pre|pre-hook|${secondPath}||running`,
      `post|post-hook|${secondPath}|${second.conversationId}|succeeded`,
    ]);
  });

  it("blocks an unavailable current policy before hooks and preserves pre/post failure semantics", async () => {
    const f = await createFixture();
    const blockedPath = await createDirectory(f.root, "workspace-blocked");
    const failurePath = await createDirectory(f.root, "workspace-failures");
    const blockedWorkspace = f.createWorkspace("Blocked", blockedPath);
    const failureWorkspace = f.createWorkspace("Failures", failurePath);
    const sideEffect = path.join(f.root, "must-not-exist");
    const wouldRun = await writeScript(f.hookRoot, "would-run.sh", `touch ${shellQuote(sideEffect)}`);
    const preFail = await writeScript(f.hookRoot, "pre-fail.sh", "printf pre-failed; printf pre-error >&2; exit 7");
    const postFail = await writeScript(f.hookRoot, "post-fail.sh", "printf post-failed; printf post-error >&2; exit 9");
    const blockedJob = f.createJob(blockedWorkspace.id, {
      name: "Blocked",
      preRunScript: wouldRun,
      acknowledgeHostHooks: true,
    });
    const preJob = f.createJob(failureWorkspace.id, {
      name: "Pre failure",
      preRunScript: preFail,
      acknowledgeHostHooks: true,
    });
    const postJob = f.createJob(failureWorkspace.id, {
      name: "Post failure",
      postRunScript: postFail,
      acknowledgeHostHooks: true,
    });
    await rm(blockedPath, { recursive: true });
    f.faux.setResponses([fauxAssistantMessage("prompt completed before post failure")]);

    const blocked = await f.run(blockedJob.id);
    const pre = await f.run(preJob.id);
    const post = await f.run(postJob.id);

    expect(blocked).toMatchObject({ status: "blocked", errorCode: ERROR_CODES.WORKSPACE_UNAVAILABLE, conversationId: null });
    expect(existsSync(sideEffect)).toBe(false);
    expect(pre).toMatchObject({
      status: "failed", phase: "pre-hook", errorCode: ERROR_CODES.JOB_PRE_RUN_FAILED,
      conversationId: null, preExitCode: 7, preStdout: "pre-failed", preStderr: "pre-error",
    });
    expect(post).toMatchObject({
      status: "failed", phase: "post-hook", errorCode: ERROR_CODES.JOB_POST_RUN_FAILED,
      postExitCode: 9, postStdout: "post-failed", postStderr: "post-error",
    });
    expect(post.conversationId).not.toBeNull();
    expect(f.faux.state.callCount).toBe(1);
    expect((await f.history.list(f.workspaces.requireAvailable(failureWorkspace.id)))
      .some(({ id }) => id === post.conversationId)).toBe(true);
  });

  it("shares capacity with interactive work, protects active ownership, and routes external abort", async () => {
    const f = await createFixture({ maxLive: 1 });
    const workspacePath = await createDirectory(f.root, "workspace-capacity");
    const workspace = f.createWorkspace("Capacity", workspacePath);
    const policy = await f.workspaces.requireUsable(workspace.id);
    const interactive = await f.registry.create(policy);
    f.faux.setResponses([fauxAssistantMessage("interactive response ".repeat(2_000))]);
    await f.registry.prompt(interactive.id, "occupy capacity", []);
    await vi.waitFor(() => expect(interactive.status).toBe("streaming"));
    const capacityJob = f.createJob(workspace.id, { name: "Capacity limited" });

    const skipped = await f.run(capacityJob.id);
    expect(skipped).toMatchObject({ status: "skipped", errorCode: ERROR_CODES.LIVE_RUNTIME_LIMIT, conversationId: null });
    await f.registry.abort(interactive.id);
    await vi.waitFor(() => expect(interactive.status).toBe("idle"));
    await f.registry.close(interactive.id);

    f.faux.appendResponses([fauxAssistantMessage("job response ".repeat(2_000))]);
    const ownedJob = f.createJob(workspace.id, { name: "Owned" });
    const pending = f.run(ownedJob.id);
    let active!: JobRunState;
    await vi.waitFor(() => {
      const summary = f.jobs.get(ownedJob.id).activeRun;
      expect(summary?.conversationId).not.toBeNull();
      active = f.jobs.getRun(ownedJob.id, summary!.id);
      expect(f.registry.get(active.conversationId!)?.status).toBe("streaming");
    }, { timeout: 5_000 });

    await expect(f.registry.rename(active.conversationId!, "forbidden"))
      .rejects.toMatchObject({ code: ERROR_CODES.CONVERSATION_BUSY });
    await expect(f.registry.prompt(active.conversationId!, "forbidden", []))
      .rejects.toMatchObject({ code: ERROR_CODES.CONVERSATION_BUSY });
    await expect(f.run(ownedJob.id))
      .rejects.toMatchObject({ code: ERROR_CODES.JOB_ALREADY_RUNNING });
    expect(f.jobs.listRuns(ownedJob.id).runs).toHaveLength(1);
    expect(f.registry.getActiveOwner(active.conversationId!)).toEqual({
      kind: "scheduled-job", jobId: ownedJob.id, runId: active.id,
    });
    await f.registry.abort(active.conversationId!);

    await expect(pending).resolves.toMatchObject({
      status: "aborted", errorCode: ERROR_CODES.JOB_ABORTED,
      conversationId: active.conversationId,
    });
    expect(f.registry.size).toBe(0);
  }, 10_000);

  it("marks an old active run interrupted and creates only one catch-up after many misses", async () => {
    const f = await createFixture();
    const workspacePath = await createDirectory(f.root, "workspace-restart");
    const workspace = f.createWorkspace("Restart", workspacePath);
    const job = f.createJob(workspace.id, { name: "Catch up" });
    const old = f.jobs.claimManual(job.id, 50_000);
    f.jobs.startRun(job.id, old.run.id, "prompt", 50_000);
    f.setNow(200_000);
    f.faux.setResponses([fauxAssistantMessage("single catch-up")]);

    await f.scheduler.start();
    const catchUp = await waitForTerminal(f.jobs, job.id, "catch-up");
    const runs = f.jobs.listRuns(job.id).runs;

    expect(f.jobs.getRun(job.id, old.run.id)).toMatchObject({
      status: "interrupted", errorCode: ERROR_CODES.JOB_INTERRUPTED,
    });
    expect(catchUp).toMatchObject({ status: "succeeded", trigger: "catch-up", scheduledFor: 61_000 });
    expect(runs.filter(({ trigger }) => trigger === "catch-up")).toHaveLength(1);
    expect(f.jobs.get(job.id).nextRunAt).toBe(241_000);
    expect(f.faux.state.callCount).toBe(1);
  });

  it.runIf(process.platform === "linux")("interrupts persisted state and kills a real pre-hook process group on shutdown", async () => {
    const f = await createFixture({ hookTimeoutMs: 30_000 });
    const workspacePath = await createDirectory(f.root, "workspace-shutdown");
    const workspace = f.createWorkspace("Shutdown", workspacePath);
    const pidFile = path.join(f.root, "hook.pid");
    const script = await writeScript(f.hookRoot, "long-hook.sh", [
      "trap '' TERM",
      `printf '%s' "$$" > ${shellQuote(pidFile)}`,
      "sleep 30 &",
      "wait",
    ].join("\n"));
    const job = f.createJob(workspace.id, {
      name: "Interrupted hook",
      preRunScript: script,
      acknowledgeHostHooks: true,
    });

    const pending = f.run(job.id);
    await vi.waitFor(() => expect(existsSync(pidFile)).toBe(true), { timeout: 5_000 });
    const groupPid = Number(await readFile(pidFile, "utf8"));
    expect(groupPid).toBeGreaterThan(0);
    f.coordinator.beginShutdown();
    await f.coordinator.dispose();

    await expect(pending).resolves.toMatchObject({
      status: "interrupted", phase: "pre-hook", errorCode: ERROR_CODES.JOB_INTERRUPTED,
    });
    expect(f.jobs.listRuns(job.id).runs).toContainEqual(expect.objectContaining({
      status: "interrupted", errorCode: ERROR_CODES.JOB_INTERRUPTED,
    }));
    let alive = true;
    for (let attempt = 0; attempt < 30 && alive; attempt += 1) {
      try {
        process.kill(-groupPid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
      }
      if (alive) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(alive).toBe(false);
  }, 10_000);
});
