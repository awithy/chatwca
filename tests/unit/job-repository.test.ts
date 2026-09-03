import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import { openDatabase, type ChatWcaDatabase } from "../../src/server/database.js";
import {
  JOB_RUN_PAGE_MAX_LIMIT,
  JobRepository,
} from "../../src/server/job-repository.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

let database: ChatWcaDatabase;
let now: number;
let sequence: number;
let repository: JobRepository;

function insertWorkspace(id = "workspace-1", name = "Workspace"): void {
  database.connection.prepare(`
    INSERT INTO workspaces (id, name, path, created_at, updated_at)
    VALUES (?, ?, ?, 0, 0)
  `).run(id, name, `/${id}`);
}

function makeRepository(options: ConstructorParameters<typeof JobRepository>[1] = {}): JobRepository {
  return new JobRepository(database.connection, {
    uuid: () => `id-${++sequence}`,
    clock: () => now,
    hookPathAdmission: { validateForConfiguration: (scriptPath) => scriptPath },
    hookWorkspacePolicy: () => ({ cwd: "/workspace-1", mounts: [] }),
    ...options,
  });
}

function createInterval(overrides: Partial<Parameters<JobRepository["create"]>[0]> = {}) {
  return repository.create({
    name: " Report ",
    workspaceId: "workspace-1",
    prompt: "Write a report",
    schedule: { kind: "interval", intervalMinutes: 1 },
    enabled: true,
    ...overrides,
  });
}

beforeEach(() => {
  database = openDatabase("/tmp", ":memory:");
  now = 1_000;
  sequence = 0;
  insertWorkspace();
  repository = makeRepository();
});

afterEach(() => database.close());

function expectCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error("Expected operation to throw");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

describe("JobRepository definitions", () => {
  it("creates normalized definitions, computes next runs, and sorts by name then id", () => {
    const report = createInterval();
    expect(report).toMatchObject({
      id: "id-1",
      name: "Report",
      enabled: true,
      nextRunAt: 61_000,
      schedule: { kind: "interval", intervalMinutes: 1, anchorAt: 1_000 },
      activeRun: null,
      lastRun: null,
      configurationIssue: null,
    });
    createInterval({ name: "alpha", enabled: false });
    createInterval({ name: "Alpha", enabled: false });
    expect(repository.list().map(({ id, name }) => [id, name])).toEqual([
      ["id-2", "alpha"], ["id-3", "Alpha"], ["id-1", "Report"],
    ]);
  });

  it("validates fields, workspace references, and host-hook acknowledgement", () => {
    const hooksDisabled = new JobRepository(database.connection, {
      uuid: () => "disabled-hook-job",
      clock: () => now,
    });
    expectCode(() => hooksDisabled.create({
      name: "Disabled hooks",
      workspaceId: "workspace-1",
      prompt: "Run",
      schedule: { kind: "interval", intervalMinutes: 1 },
      preRunScript: "/trusted/pre.sh",
      enabled: false,
      acknowledgeHostHooks: true,
    }), ERROR_CODES.JOB_SCRIPT_ROOTS_UNAVAILABLE);
    expectCode(() => createInterval({ name: "  " }), ERROR_CODES.JOB_INVALID);
    expectCode(() => createInterval({ prompt: "\n\t" }), ERROR_CODES.JOB_INVALID);
    expectCode(() => createInterval({ workspaceId: "missing" }), ERROR_CODES.JOB_INVALID);
    expectCode(() => createInterval({ preRunScript: "/trusted/pre.sh" }), ERROR_CODES.JOB_INVALID);
    expectCode(() => createInterval({ acknowledgeHostHooks: true }), ERROR_CODES.JOB_INVALID);
    const job = createInterval({
      preRunScript: "/trusted/pre.sh",
      acknowledgeHostHooks: true,
    });
    expect(job.preRunScript).toBe("/trusted/pre.sh");
    expectCode(
      () => repository.update(job.id, { postRunScript: "/trusted/post.sh" }),
      ERROR_CODES.JOB_INVALID,
    );
    expect(repository.update(job.id, {
      postRunScript: "/trusted/post.sh", acknowledgeHostHooks: true,
    }).postRunScript).toBe("/trusted/post.sh");
    // Any configured hook change is explicit, including removal.
    expect(repository.update(job.id, {
      postRunScript: null, acknowledgeHostHooks: true,
    }).postRunScript).toBeNull();
    expectCode(
      () => repository.update(job.id, { workspaceId: "workspace-1", acknowledgeHostHooks: true }),
      ERROR_CODES.JOB_INVALID,
    );
  });

  it("preserves schedule state for ordinary edits and reanchors schedule edits", () => {
    const job = createInterval();
    const originalNext = job.nextRunAt;
    now = 10_000;
    expect(repository.update(job.id, { name: "Renamed", prompt: "New prompt" })).toMatchObject({
      name: "Renamed", prompt: "New prompt", nextRunAt: originalNext,
      schedule: { anchorAt: 1_000 },
    });
    now = 20_000;
    expect(repository.update(job.id, {
      schedule: { kind: "interval", intervalMinutes: 2 },
    })).toMatchObject({
      schedule: { kind: "interval", intervalMinutes: 2, anchorAt: 20_000 },
      nextRunAt: 140_000,
    });
  });

  it("maintains enable/disable next-run invariants while preserving interval anchors", () => {
    const job = createInterval();
    expect(repository.disable(job.id)).toMatchObject({ enabled: false, nextRunAt: null });
    now = 125_000;
    expect(repository.enable(job.id)).toMatchObject({
      enabled: true,
      nextRunAt: 181_000,
      schedule: { anchorAt: 1_000 },
    });
    expectCode(() => repository.claimManual(repository.disable(job.id).id), ERROR_CODES.JOB_DISABLED);
  });

  it("rejects edits/deletion while active except disable", () => {
    const job = createInterval();
    const claim = repository.claimManual(job.id);
    expectCode(() => repository.update(job.id, { name: "No" }), ERROR_CODES.JOB_BUSY);
    expectCode(() => repository.delete(job.id), ERROR_CODES.JOB_BUSY);
    expect(repository.disable(job.id)).toMatchObject({ enabled: false, nextRunAt: null });
    expect(repository.getRun(job.id, claim.run.id).status).toBe("queued");
  });

  it("requires a complete valid replacement to repair invalid persisted rows", () => {
    const daily = repository.create({
      name: "Daily", workspaceId: "workspace-1", prompt: "Do it",
      schedule: { kind: "daily", localTime: "07:00", timeZone: "UTC" }, enabled: true,
    });
    database.connection.prepare("UPDATE jobs SET time_zone = 'Mars/Olympus' WHERE id = ?").run(daily.id);
    expect(repository.get(daily.id).configurationIssue?.code).toBe(ERROR_CODES.JOB_INVALID);
    expectCode(() => repository.update(daily.id, { name: "Still broken" }), ERROR_CODES.JOB_INVALID);
    const repaired = repository.update(daily.id, {
      name: "Repaired", workspaceId: "workspace-1", prompt: "Do it",
      schedule: { kind: "daily", localTime: "07:00", timeZone: "UTC" },
      preRunScript: null, postRunScript: null, enabled: true,
    });
    expect(repaired.configurationIssue).toBeNull();
    expect(repaired.name).toBe("Repaired");
  });

  it("projects workspace availability without exposing resolver failures", () => {
    repository = makeRepository({ workspaceStatus: () => ({ name: "Current", available: false }) });
    const job = createInterval();
    expect(job).toMatchObject({
      workspaceName: "Current",
      workspaceAvailable: false,
      configurationIssue: { code: ERROR_CODES.WORKSPACE_UNAVAILABLE },
    });
  });
});

describe("JobRepository claims and transitions", () => {
  it("manual claims preserve the recurring schedule and reject overlap without a row", () => {
    const job = createInterval();
    const claim = repository.claimManual(job.id, 2_000);
    expect(claim.run).toMatchObject({
      trigger: "manual", scheduledFor: 2_000, status: "queued", revision: 0,
    });
    expect(claim.job.nextRunAt).toBe(61_000);
    expectCode(() => repository.claimManual(job.id, 3_000), ERROR_CODES.JOB_ALREADY_RUNNING);
    expect(repository.listRuns(job.id).runs).toHaveLength(1);
  });

  it("atomically advances due schedules and records active overlap as one skipped run", () => {
    const job = createInterval();
    const manual = repository.claimManual(job.id, 2_000);
    const due = repository.claimDue(job.id, 61_000);
    expect(due?.run).toMatchObject({
      trigger: "scheduled", scheduledFor: 61_000, status: "skipped",
      errorCode: ERROR_CODES.JOB_ALREADY_RUNNING, finishedAt: 61_000,
    });
    expect(due?.job.nextRunAt).toBe(121_000);
    expect(repository.get(job.id).activeRun?.id).toBe(manual.run.id);
    expect(repository.claimDue(job.id, 61_000)).toBeNull();
  });

  it("claims one catch-up after many misses and advances directly past startup", () => {
    const job = createInterval();
    const catchUp = repository.claimStartupCatchUp(job.id, 600_500);
    expect(catchUp?.run).toMatchObject({ trigger: "catch-up", scheduledFor: 61_000 });
    expect(catchUp?.job.nextRunAt).toBe(601_000);
  });

  it("persists monotonic revisions for phases, conversation attachment, hooks, and terminal CAS", () => {
    const job = createInterval();
    const queued = repository.claimManual(job.id);
    const running = repository.startRun(job.id, queued.run.id, "pre-hook", 1_100, 0);
    expect(running).toMatchObject({ status: "running", revision: 1, startedAt: 1_100 });
    const hook = repository.recordHookResult(job.id, queued.run.id, "pre", {
      exitCode: 0, stdout: "out", stderr: "", expectedRevision: 1,
    });
    expect(hook).toMatchObject({ revision: 2, preExitCode: 0, preStdout: "out" });
    const prompt = repository.setRunPhase(job.id, queued.run.id, "prompt", 2);
    expect(prompt.revision).toBe(3);
    const attached = repository.attachConversation(job.id, queued.run.id, "conversation", 3);
    expect(attached).toMatchObject({ revision: 4, conversationId: "conversation" });
    const done = repository.finishRun(job.id, queued.run.id, {
      status: "succeeded", finishedAt: 2_000, expectedRevision: 4,
    });
    expect(done).toMatchObject({ status: "succeeded", revision: 5, finishedAt: 2_000 });
    expectCode(
      () => repository.finishRun(job.id, queued.run.id, {
        status: "failed", errorCode: ERROR_CODES.JOB_PROMPT_FAILED,
      }),
      ERROR_CODES.JOB_BUSY,
    );
    expect(repository.get(job.id).lastRun?.revision).toBe(5);
  });

  it("allows a running attempt to CAS to skipped when runtime capacity admission fails", () => {
    const job = createInterval();
    const claim = repository.claimManual(job.id);
    const running = repository.startRun(job.id, claim.run.id, null, 1_100, 0);
    const skipped = repository.finishRun(job.id, claim.run.id, {
      status: "skipped",
      errorCode: ERROR_CODES.LIVE_RUNTIME_LIMIT,
      expectedRevision: running.revision,
    });
    expect(skipped).toMatchObject({
      status: "skipped",
      errorCode: ERROR_CODES.LIVE_RUNTIME_LIMIT,
      revision: 2,
    });
  });

  it("stores post-hook diagnostics only in detail, not summaries", () => {
    const job = createInterval();
    const claim = repository.claimManual(job.id);
    repository.startRun(job.id, claim.run.id, "post-hook");
    const state = repository.recordHookResult(job.id, claim.run.id, "post", {
      exitCode: 7, stdout: "secret output", stderr: "secret error",
    });
    expect(state).toMatchObject({ postExitCode: 7, postStdout: "secret output" });
    const summary = repository.listRuns(job.id).runs[0];
    expect(summary).not.toHaveProperty("postStdout");
    expect(repository.getRunDetail(job.id, claim.run.id).postStderr).toBe("secret error");
  });

  it("marks every leftover queued/running row interrupted exactly once", () => {
    const one = createInterval({ name: "One" });
    const first = repository.claimManual(one.id);
    const two = createInterval({ name: "Two" });
    const second = repository.claimManual(two.id);
    repository.startRun(two.id, second.run.id, "prompt");
    const recovered = repository.markAllInterrupted(5_000);
    expect(recovered.map(({ status, errorCode, revision }) => [status, errorCode, revision])).toEqual([
      ["interrupted", ERROR_CODES.JOB_INTERRUPTED, 1],
      ["interrupted", ERROR_CODES.JOB_INTERRUPTED, 2],
    ]);
    expect(repository.markAllInterrupted(6_000)).toEqual([]);
    expect(repository.getRun(one.id, first.run.id).finishedAt).toBe(5_000);
  });
});

describe("JobRepository history and deletion", () => {
  it("never serializes persisted diagnostic error text", () => {
    const created = createInterval();
    const claim = repository.claimManual(created.id);
    const running = repository.startRun(created.id, claim.run.id);
    const failed = repository.finishRun(created.id, running.id, {
      status: "failed",
      phase: "prompt",
      errorCode: ERROR_CODES.JOB_PROMPT_FAILED,
      errorMessage: "provider token at /private/host/path",
      expectedRevision: running.revision,
    });

    expect(failed.errorMessage).toBe("The scheduled prompt failed.");
    expect(repository.listRuns(created.id).runs[0]?.errorMessage).toBe(
      "The scheduled prompt failed.",
    );
    expect(repository.getRun(created.id, running.id).errorMessage).not.toContain("/private");
  });
  it("uses opaque keyset cursors with deterministic tie ordering", () => {
    const job = createInterval();
    for (let index = 0; index < 5; index += 1) {
      const claim = repository.claimManual(job.id, 10_000);
      repository.startRun(job.id, claim.run.id, "prompt", 10_000);
      repository.finishRun(job.id, claim.run.id, { status: "succeeded", finishedAt: 10_001 });
    }
    const first = repository.listRuns(job.id, { limit: 2 });
    expect(first.runs.map(({ id }) => id)).toEqual(["id-6", "id-5"]);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = repository.listRuns(job.id, { limit: 2, cursor: first.nextCursor });
    expect(second.runs.map(({ id }) => id)).toEqual(["id-4", "id-3"]);
    const third = repository.listRuns(job.id, { limit: 2, cursor: second.nextCursor });
    expect(third.runs.map(({ id }) => id)).toEqual(["id-2"]);
    expect(third.nextCursor).toBeUndefined();
    expectCode(() => repository.listRuns(job.id, { cursor: "not-json" }), ERROR_CODES.JOB_INVALID);
    expectCode(() => repository.listRuns(job.id, { limit: JOB_RUN_PAGE_MAX_LIMIT + 1 }), ERROR_CODES.JOB_INVALID);
  });

  it("reports workspace references, relies on FK restriction, and cascades metadata only", () => {
    const job = createInterval();
    const claim = repository.claimManual(job.id);
    repository.startRun(job.id, claim.run.id, "prompt");
    repository.finishRun(job.id, claim.run.id, { status: "succeeded" });
    expect(repository.referencesWorkspace("workspace-1")).toBe(true);
    expect(() => database.connection.prepare("DELETE FROM workspaces WHERE id = 'workspace-1'").run())
      .toThrow(/FOREIGN KEY/);
    repository.delete(job.id);
    expect(repository.referencesWorkspace("workspace-1")).toBe(false);
    expect(database.connection.prepare("SELECT * FROM job_runs").all()).toEqual([]);
    expectCode(() => repository.get(job.id), ERROR_CODES.JOB_NOT_FOUND);
  });

  it("wraps unknown SQLite failures as database_error", () => {
    const job = createInterval();
    database.connection.close();
    expectCode(() => repository.get(job.id), ERROR_CODES.DATABASE_ERROR);
    // afterEach close is idempotent at the owner level.
  });
});
