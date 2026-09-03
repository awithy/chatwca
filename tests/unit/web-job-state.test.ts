import { describe, expect, it } from "vitest";

import type { JobRunState, JobSummary } from "../../src/shared/jobs.js";
import { summaryOnly } from "../../src/server/job-service.js";
import {
  createInitialChatClientState,
  reduceChatClientState,
} from "../../src/web/src/api/state.js";

const detail: JobRunState = {
  id: "run-1", jobId: "job-1", trigger: "manual", scheduledFor: 1,
  startedAt: 2, finishedAt: null, status: "running", phase: "pre-hook",
  errorCode: null, errorMessage: null, conversationId: null, revision: 2,
  createdAt: 1, updatedAt: 2, preExitCode: null, preStdout: "detail",
  preStderr: null, postExitCode: null, postStdout: null, postStderr: null,
  conversationAvailable: false,
};
const job: JobSummary = {
  id: "job-1", name: "Job", workspaceId: "workspace-1", workspaceName: "Workspace",
  workspaceAvailable: true, prompt: "Prompt",
  schedule: { kind: "interval", intervalMinutes: 1, anchorAt: 0 },
  preRunScript: null, postRunScript: null, enabled: true, nextRunAt: 60_000,
  createdAt: 0, updatedAt: 0, activeRun: summaryOnly(detail), lastRun: null,
  configurationIssue: null,
};

describe("browser scheduled-job protocol state", () => {
  it("replaces authoritative jobs and retains diagnostics only from detail", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "jobs", jobs: [job],
    });
    state = reduceChatClientState(state, { type: "job.run.state", run: detail });
    state = reduceChatClientState(state, {
      type: "job.run.updated",
      run: { ...summaryOnly(detail), revision: 3, phase: "prompt", updatedAt: 3 },
    });

    expect(state.jobs).toEqual([job]);
    expect(state.jobRuns[detail.id]).toMatchObject({ revision: 3, phase: "prompt" });
    expect(state.jobRuns[detail.id]).not.toHaveProperty("preStdout");
    expect(state.jobRunDetails[detail.id]).toMatchObject({ revision: 3, preStdout: "detail" });

    state = reduceChatClientState(state, { type: "jobs", jobs: [] });
    expect(state.jobRuns).toEqual({});
    expect(state.jobRunDetails).toEqual({});
  });

  it("stores cursor pages and browser-local job selections deterministically", () => {
    let state = reduceChatClientState(createInitialChatClientState(), { type: "jobs", jobs: [job] });
    state = reduceChatClientState(state, { type: "job.select", jobId: job.id });
    state = reduceChatClientState(state, { type: "job.run.select", runId: detail.id });
    state = reduceChatClientState(state, {
      type: "job.runs", jobId: job.id, runs: [summaryOnly(detail)], nextCursor: "older",
    });
    state = reduceChatClientState(state, {
      type: "job.runs", jobId: job.id, runs: [{ ...summaryOnly(detail), id: "run-2" }], append: true,
    });
    expect(state.jobRunPages[job.id]).toEqual({
      runIds: [detail.id, "run-2"], nextCursor: null, loading: false,
    });
    expect(state.selectedJobId).toBe(job.id);
    expect(state.selectedJobRunId).toBe(detail.id);

    state = reduceChatClientState(state, { type: "jobs", jobs: [] });
    expect(state.selectedJobId).toBeNull();
    expect(state.selectedJobRunId).toBeNull();
    expect(state.jobRunPages).toEqual({});
  });

  it("ignores stale revisions and requests detail when a known run has a gap", () => {
    let state = reduceChatClientState(createInitialChatClientState(), {
      type: "job.runs", runs: [summaryOnly(detail)],
    });
    const stale = reduceChatClientState(state, {
      type: "job.run.updated", run: { ...summaryOnly(detail), revision: 1 },
    });
    expect(stale).toBe(state);

    state = reduceChatClientState(state, {
      type: "job.run.updated", run: { ...summaryOnly(detail), revision: 4 },
    });
    expect(state.jobRuns[detail.id]?.revision).toBe(2);
    expect(state.resyncJobRunIds).toEqual(["job-1\0run-1"]);

    state = reduceChatClientState(state, {
      type: "job.run.state", run: { ...detail, revision: 4 },
    });
    expect(state.resyncJobRunIds).toEqual([]);
    expect(state.jobRuns[detail.id]?.revision).toBe(4);
  });
});
