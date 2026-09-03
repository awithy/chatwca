import { describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import type { JobRunState, JobSummary } from "../../src/shared/jobs.js";
import {
  JobScheduler,
  type JobSchedulerRepositoryPort,
  type JobSchedulerTimerPort,
} from "../../src/server/job-scheduler.js";
import type { ClaimedJobRun } from "../../src/server/job-repository.js";

function job(id: string, nextRunAt: number | null, issue: JobSummary["configurationIssue"] = null): JobSummary {
  return {
    id,
    name: id,
    workspaceId: "workspace",
    workspaceName: "Workspace",
    workspaceAvailable: true,
    prompt: "run",
    schedule: { kind: "interval", intervalMinutes: 1, anchorAt: 0 },
    preRunScript: null,
    postRunScript: null,
    enabled: nextRunAt !== null,
    nextRunAt,
    createdAt: 0,
    updatedAt: 0,
    activeRun: null,
    lastRun: null,
    configurationIssue: issue,
  };
}

function run(jobId: string, trigger: JobRunState["trigger"], scheduledFor: number, status: JobRunState["status"] = "queued", errorCode: JobRunState["errorCode"] = null): JobRunState {
  return {
    id: `${jobId}-${trigger}-${scheduledFor}`,
    jobId,
    trigger,
    scheduledFor,
    startedAt: null,
    finishedAt: status === "queued" ? null : scheduledFor,
    status,
    phase: null,
    errorCode,
    errorMessage: errorCode === null ? null : errorCode,
    conversationId: null,
    revision: 0,
    createdAt: scheduledFor,
    updatedAt: scheduledFor,
    preExitCode: null,
    preStdout: null,
    preStderr: null,
    postExitCode: null,
    postStdout: null,
    postStderr: null,
    conversationAvailable: false,
  };
}

class FakeRepository implements JobSchedulerRepositoryPort {
  readonly jobs: JobSummary[];
  readonly recovered: number[] = [];
  readonly catchups: string[] = [];
  readonly dues: string[] = [];
  readonly manuals: string[] = [];
  readonly scheduleBeforeManual = new Map<string, number | null>();
  activeJob: string | undefined;

  constructor(jobs: JobSummary[]) {
    this.jobs = jobs;
  }

  markAllInterrupted(at = 0): readonly JobRunState[] {
    this.recovered.push(at);
    return [];
  }

  listEnabled(): readonly JobSummary[] {
    return this.jobs.filter(({ enabled }) => enabled);
  }

  listDue(now = 0): readonly JobSummary[] {
    return this.jobs.filter(({ enabled, nextRunAt }) => enabled && nextRunAt !== null && nextRunAt <= now);
  }

  claimStartupCatchUp(jobId: string, startupAt = 0): ClaimedJobRun | null {
    this.catchups.push(jobId);
    return this.claim(jobId, startupAt, "catch-up");
  }

  claimDue(jobId: string, now = 0): ClaimedJobRun | null {
    this.dues.push(jobId);
    return this.claim(jobId, now, "scheduled");
  }

  claimManual(jobId: string, now = 0): ClaimedJobRun {
    const definition = this.required(jobId);
    this.manuals.push(jobId);
    this.scheduleBeforeManual.set(jobId, definition.nextRunAt);
    return { job: definition, run: run(jobId, "manual", now) };
  }

  private claim(jobId: string, now: number, trigger: "scheduled" | "catch-up"): ClaimedJobRun | null {
    const definition = this.required(jobId);
    const scheduledFor = definition.nextRunAt;
    if (scheduledFor === null || scheduledFor > now) return null;
    // Advance directly past now, modelling the repository's anchored arithmetic.
    const step = 60_000;
    const nextRunAt = scheduledFor + (Math.floor((now - scheduledFor) / step) + 1) * step;
    Object.assign(definition, { nextRunAt });
    if (this.activeJob === jobId) {
      return {
        job: definition,
        run: run(jobId, trigger, scheduledFor, "skipped", ERROR_CODES.JOB_ALREADY_RUNNING),
      };
    }
    return { job: definition, run: run(jobId, trigger, scheduledFor) };
  }

  private required(id: string): JobSummary {
    const found = this.jobs.find((candidate) => candidate.id === id);
    if (found === undefined) throw new AppError(ERROR_CODES.JOB_NOT_FOUND);
    return found;
  }
}

class FakeTimers implements JobSchedulerTimerPort {
  readonly pending = new Map<number, { callback: () => void; delay: number }>();
  readonly delays: number[] = [];
  readonly cleared: number[] = [];
  next = 1;

  setTimeout(callback: () => void, delayMs: number): unknown {
    const handle = this.next++;
    this.delays.push(delayMs);
    this.pending.set(handle, { callback, delay: delayMs });
    return handle;
  }

  clearTimeout(handle: unknown): void {
    this.cleared.push(handle as number);
    this.pending.delete(handle as number);
  }

  fireNext(): void {
    const first = this.pending.entries().next().value as [number, { callback: () => void }] | undefined;
    if (first === undefined) throw new Error("no timer");
    this.pending.delete(first[0]);
    first[1].callback();
  }
}

function fixture(definitions: JobSummary[], now = 1_000, maxTimerDelayMs = 100) {
  let wallClock = now;
  const repository = new FakeRepository(definitions);
  const timers = new FakeTimers();
  const dispatched: ClaimedJobRun[] = [];
  const errors: unknown[] = [];
  const dispatch = vi.fn(async (claim: ClaimedJobRun) => {
    dispatched.push(claim);
    return claim.run;
  });
  const scheduler = new JobScheduler({
    repository,
    runner: { dispatch },
    clock: () => wallClock,
    timers,
    maxTimerDelayMs,
    onInternalError: (error) => errors.push(error),
  });
  return { scheduler, repository, timers, dispatch, dispatched, errors, setNow: (value: number) => { wallClock = value; } };
}

describe("JobScheduler", () => {
  it("recovers first, creates one catch-up after many misses, ignores invalid rows, and caps a distant timer", async () => {
    const invalid = job("invalid", 10, { code: ERROR_CODES.JOB_INVALID, message: "invalid" });
    const unavailable = job("unavailable", 100, {
      code: ERROR_CODES.WORKSPACE_UNAVAILABLE,
      message: "unavailable",
    });
    const f = fixture([job("overdue", 100), invalid, unavailable, job("future", 10_000)], 1_000, 250);

    await f.scheduler.start();

    expect(f.repository.recovered).toEqual([1_000]);
    expect(f.repository.catchups).toEqual(["overdue", "unavailable"]);
    expect(f.dispatched).toHaveLength(2);
    expect(f.dispatched[0]?.run).toMatchObject({ trigger: "catch-up", scheduledFor: 100 });
    expect(f.repository.jobs.find(({ id }) => id === "overdue")?.nextRunAt).toBe(60_100);
    expect(f.timers.delays).toEqual([250]);
  });

  it("re-queries on early and late wakes, claims jobs independently, and records active overlap", async () => {
    const f = fixture([job("a", 2_000), job("b", 2_000)], 1_000, 10_000);
    f.repository.activeJob = "a";
    await f.scheduler.start();
    expect(f.timers.delays).toEqual([1_000]);

    f.setNow(1_500);
    f.timers.fireNext();
    expect(f.repository.dues).toEqual([]);
    expect(f.timers.delays.at(-1)).toBe(500);

    f.setNow(5_000);
    f.timers.fireNext();
    expect(f.repository.dues).toEqual(["a", "b"]);
    expect(f.dispatched.map(({ run: state }) => [state.jobId, state.status])).toEqual([
      ["a", "skipped"],
      ["b", "queued"],
    ]);
    expect(f.repository.jobs.map(({ nextRunAt }) => nextRunAt)).toEqual([62_000, 62_000]);
  });

  it("preserves manual scheduling, rejects capacity after recording the attempt, and closes idempotently", async () => {
    const f = fixture([job("manual", 9_000)], 1_000);
    f.dispatch.mockImplementationOnce(async (claim) => ({
      ...claim.run,
      status: "skipped",
      finishedAt: 1_000,
      errorCode: ERROR_CODES.LIVE_RUNTIME_LIMIT,
      errorMessage: "limit",
    }));
    await f.scheduler.start();

    await expect(f.scheduler.runNow("manual")).rejects.toMatchObject({ code: ERROR_CODES.LIVE_RUNTIME_LIMIT });
    expect(f.repository.scheduleBeforeManual.get("manual")).toBe(9_000);
    expect(f.repository.jobs[0]?.nextRunAt).toBe(9_000);

    f.scheduler.stop();
    f.scheduler.stop();
    expect(f.timers.pending.size).toBe(0);
    await expect(f.scheduler.runNow("manual")).rejects.toMatchObject({ code: ERROR_CODES.SHUTTING_DOWN });

    await f.scheduler.start();
    expect(f.repository.recovered).toEqual([1_000]);
    expect(f.timers.pending.size).toBe(1);
    f.scheduler.beginShutdown();
    await expect(f.scheduler.start()).rejects.toMatchObject({ code: ERROR_CODES.SHUTTING_DOWN });
  });

  it("isolates dispatch rejection and makes stale callbacks harmless after stop", async () => {
    const f = fixture([job("due", 1_000)], 1_000);
    f.dispatch.mockRejectedValueOnce(new Error("runner failed"));
    await f.scheduler.start();
    await Promise.resolve();
    expect(f.errors).toHaveLength(1);

    const callback = [...f.timers.pending.values()][0]?.callback;
    f.scheduler.stop();
    callback?.();
    expect(f.repository.dues).toEqual([]);
  });
});
