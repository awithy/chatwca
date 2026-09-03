import { describe, expect, it, vi } from "vitest";

import type { JobRunState } from "../../src/shared/jobs.js";
import { RuntimeCoordinator } from "../../src/server/runtime-coordinator.js";

const interrupted: JobRunState = {
  id: "run",
  jobId: "job",
  trigger: "scheduled",
  scheduledFor: 1,
  startedAt: 1,
  finishedAt: 2,
  status: "interrupted",
  phase: "prompt",
  errorCode: "job_interrupted",
  errorMessage: "interrupted",
  conversationId: "conversation",
  revision: 3,
  createdAt: 1,
  updatedAt: 2,
  preExitCode: null,
  preStdout: null,
  preStderr: null,
  postExitCode: null,
  postStdout: null,
  postStderr: null,
  conversationAvailable: true,
};

function fixture(mark = vi.fn((): readonly JobRunState[] => [interrupted])) {
  const calls: string[] = [];
  const scheduler = {
    beginShutdown: vi.fn(() => calls.push("scheduler-stop")),
    dispose: vi.fn(async () => { calls.push("scheduler-dispose"); }),
  };
  const jobRunner = {
    beginShutdown: vi.fn(() => calls.push("runner-stop")),
    sealPersistence: vi.fn((states: readonly JobRunState[]) => {
      calls.push(`seal-${states.length}`);
    }),
    dispose: vi.fn(async () => { calls.push("runner-dispose"); }),
  };
  const hookRunner = {
    beginShutdown: vi.fn(() => calls.push("hooks-stop")),
    dispose: vi.fn(async () => { calls.push("hooks-dispose"); }),
  };
  const registry = {
    beginShutdown: vi.fn(() => calls.push("registry-stop")),
    abortActive: vi.fn(async () => { calls.push("registry-abort"); }),
    dispose: vi.fn(async () => { calls.push("registry-dispose"); }),
  };
  const repository = {
    markAllInterrupted: vi.fn((at?: number) => {
      calls.push(`interrupt-${String(at)}`);
      return mark(at);
    }),
  };
  const errors: unknown[] = [];
  const coordinator = new RuntimeCoordinator({
    scheduler,
    jobRunner,
    hookRunner,
    registry,
    repository,
    clock: () => 42,
    onInternalError: (error) => errors.push(error),
  });
  return { coordinator, calls, scheduler, jobRunner, hookRunner, registry, repository, errors };
}

describe("RuntimeCoordinator", () => {
  it("closes every admission boundary, interrupts SQLite rows, and seals callbacks synchronously", async () => {
    const f = fixture();

    f.coordinator.beginShutdown();
    f.coordinator.beginShutdown();

    expect(f.calls.slice(0, 6)).toEqual([
      "scheduler-stop",
      "runner-stop",
      "hooks-stop",
      "registry-stop",
      "registry-abort",
      "interrupt-42",
    ]);
    expect(f.calls[6]).toBe("seal-1");
    expect(f.repository.markAllInterrupted).toHaveBeenCalledOnce();
    expect(f.jobRunner.sealPersistence).toHaveBeenCalledWith([interrupted]);

    await f.coordinator.abortActive();
    await Promise.all([f.coordinator.dispose(), f.coordinator.dispose()]);
    expect(f.scheduler.dispose).toHaveBeenCalledOnce();
    expect(f.hookRunner.dispose).toHaveBeenCalledOnce();
    expect(f.jobRunner.dispose).toHaveBeenCalledOnce();
    expect(f.registry.dispose).toHaveBeenCalledOnce();
  });

  it("seals runner persistence even when interruption persistence fails", () => {
    const failure = new Error("database failed");
    const f = fixture(vi.fn(() => { throw failure; }));

    expect(() => f.coordinator.beginShutdown()).toThrow(failure);
    expect(f.jobRunner.sealPersistence).toHaveBeenCalledExactlyOnceWith([]);
  });
});
