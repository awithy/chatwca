import { describe, expect, it, vi } from "vitest";

import type { JobRunState, JobSummary } from "../../src/shared/jobs.js";
import { JobService, summaryOnly } from "../../src/server/job-service.js";

const state: JobRunState = {
  id: "run-1", jobId: "job-1", trigger: "scheduled", scheduledFor: 10,
  startedAt: 11, finishedAt: 12, status: "succeeded", phase: "prompt",
  errorCode: null, errorMessage: null, conversationId: "conversation-1", revision: 4,
  createdAt: 10, updatedAt: 12, preExitCode: 0, preStdout: "sensitive",
  preStderr: "", postExitCode: null, postStdout: null, postStderr: null,
  conversationAvailable: false,
};
const job: JobSummary = {
  id: "job-1", name: "Job", workspaceId: "workspace-1", workspaceName: "Workspace",
  workspaceAvailable: true, prompt: "Prompt",
  schedule: { kind: "interval", intervalMinutes: 1, anchorAt: 0 },
  preRunScript: null, postRunScript: null, enabled: true, nextRunAt: 60_000,
  createdAt: 0, updatedAt: 0, activeRun: null, lastRun: summaryOnly(state),
  configurationIssue: null,
};

function fixture(historySucceeds = true) {
  const repository = {
    list: vi.fn(() => [job]), get: vi.fn(() => job), create: vi.fn(() => job),
    update: vi.fn(() => job), delete: vi.fn(), referencesWorkspace: vi.fn(() => false),
    listRuns: vi.fn(() => ({ runs: [summaryOnly(state)] })), getRun: vi.fn(() => state),
  };
  const scheduler = {
    runNowAccepted: vi.fn(() => state),
    refreshSchedule: vi.fn(),
  };
  const runner = { abort: vi.fn(async () => undefined) };
  const workspace = { id: "workspace-1", path: "/workspace", sessionDirectory: null };
  const workspaces = { requireAvailable: vi.fn(() => workspace) };
  const history = {
    resolve: historySucceeds
      ? vi.fn(async () => ({ summary: {} }))
      : vi.fn(async () => { throw new Error("private /host/path"); }),
  };
  return {
    service: new JobService({ repository, scheduler, runner, workspaces, history }),
    repository, scheduler, runner, workspaces, history,
  };
}

describe("JobService", () => {
  it("probes Pi history only for explicit detail and never for broadcasts", async () => {
    const f = fixture();
    const events: unknown[] = [];
    f.service.subscribe((event) => events.push(event));

    f.service.publishRunUpdated(state);
    f.service.publishJobsChanged();
    expect(f.history.resolve).not.toHaveBeenCalled();
    expect(events[0]).toEqual({ type: "job.run.updated", run: summaryOnly(state) });
    expect(events[0]).not.toHaveProperty("run.preStdout");

    await expect(f.service.runState(job.id, state.id)).resolves.toEqual({
      ...state,
      conversationAvailable: true,
    });
    expect(f.history.resolve).toHaveBeenCalledWith(
      { id: "workspace-1", path: "/workspace", sessionDirectory: null }, state.conversationId,
    );
  });

  it("turns unavailable generated sessions into a safe false flag", async () => {
    const f = fixture(false);
    await expect(f.service.runState(job.id, state.id)).resolves.toEqual(state);
  });

  it("resolves workspace IDs server-side and refreshes scheduling after definition writes", () => {
    const f = fixture();
    f.service.create({
      name: "Job", workspaceId: "workspace-1", prompt: "Prompt",
      schedule: { kind: "interval", intervalMinutes: 1 }, enabled: true,
    });
    f.service.update(job.id, { workspaceId: "workspace-2" });
    f.service.delete(job.id);
    expect(f.workspaces.requireAvailable).toHaveBeenNthCalledWith(1, "workspace-1");
    expect(f.workspaces.requireAvailable).toHaveBeenNthCalledWith(2, "workspace-2");
    expect(f.scheduler.refreshSchedule).toHaveBeenCalledTimes(3);
  });
});
