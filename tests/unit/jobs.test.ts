import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  JOB_INTERVAL_MINUTES_MAX,
  JOB_NAME_MAX_LENGTH,
  JOB_PROMPT_MAX_LENGTH,
  JobErrorCodeSchema,
  JobRunStateSchema,
  JobRunSummarySchema,
  JobScheduleInputSchema,
  JobScheduleSchema,
  JobSummarySchema,
  isSafeJobTimestamp,
  isSupportedJobTimeZone,
  isValidJobPrompt,
  normalizeJobName,
} from "../../src/shared/jobs.js";

const run = {
  id: "run-1",
  jobId: "job-1",
  trigger: "scheduled",
  scheduledFor: 100,
  startedAt: 101,
  finishedAt: null,
  status: "running",
  phase: "prompt",
  errorCode: null,
  errorMessage: null,
  conversationId: "conversation-1",
  revision: 2,
  createdAt: 100,
  updatedAt: 101,
} as const;

describe("job schedules", () => {
  it("accepts closed interval and canonical daily input variants", () => {
    expect(Value.Check(JobScheduleInputSchema, {
      kind: "interval", intervalMinutes: 60,
    })).toBe(true);
    expect(Value.Check(JobScheduleInputSchema, {
      kind: "daily", localTime: "07:05", timeZone: "America/New_York",
    })).toBe(true);
    expect(Value.Check(JobScheduleInputSchema, {
      kind: "interval", intervalMinutes: 60, anchorAt: 1,
    })).toBe(false);
    expect(Value.Check(JobScheduleInputSchema, {
      kind: "daily", localTime: "7:05", timeZone: "America/New_York",
    })).toBe(false);
    expect(Value.Check(JobScheduleInputSchema, {
      kind: "daily", localTime: "24:00", timeZone: "UTC",
    })).toBe(false);
    expect(Value.Check(JobScheduleInputSchema, {
      kind: "daily", localTime: "07:05", timeZone: "UTC", ignored: true,
    })).toBe(false);
  });

  it("requires a server-owned safe anchor on authoritative intervals", () => {
    expect(Value.Check(JobScheduleSchema, {
      kind: "interval", intervalMinutes: 1, anchorAt: 0,
    })).toBe(true);
    for (const anchorAt of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(Value.Check(JobScheduleSchema, {
        kind: "interval", intervalMinutes: 1, anchorAt,
      })).toBe(false);
    }
    for (const intervalMinutes of [0, JOB_INTERVAL_MINUTES_MAX + 1, 1.5]) {
      expect(Value.Check(JobScheduleInputSchema, {
        kind: "interval", intervalMinutes,
      })).toBe(false);
    }
  });

  it("provides explicit runtime timezone and safe-timestamp validation", () => {
    expect(isSupportedJobTimeZone("UTC")).toBe(true);
    expect(isSupportedJobTimeZone("America/New_York")).toBe(true);
    expect(isSupportedJobTimeZone("Mars/Olympus_Mons")).toBe(false);
    // Structural decoding intentionally remains independent of host ICU data.
    expect(Value.Check(JobScheduleInputSchema, {
      kind: "daily", localTime: "12:00", timeZone: "Mars/Olympus_Mons",
    })).toBe(true);
    expect(isSafeJobTimestamp(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(isSafeJobTimestamp(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });
});

describe("job definition and run projections", () => {
  it("enforces shared name, prompt, path, and closed-object limits", () => {
    const summary = {
      id: "job-1",
      name: "Daily report",
      workspaceId: "workspace-1",
      workspaceName: "Reports",
      workspaceAvailable: true,
      prompt: "Write the report",
      schedule: { kind: "daily", localTime: "07:00", timeZone: "UTC" },
      preRunScript: null,
      postRunScript: "/trusted/post.sh",
      enabled: true,
      nextRunAt: 200,
      createdAt: 1,
      updatedAt: 2,
      activeRun: run,
      lastRun: null,
      configurationIssue: null,
    } as const;
    expect(Value.Check(JobSummarySchema, summary)).toBe(true);
    expect(Value.Check(JobSummarySchema, { ...summary, privatePath: "/data" })).toBe(false);
    expect(Value.Check(JobSummarySchema, { ...summary, name: " ".repeat(2) })).toBe(false);
    expect(Value.Check(JobSummarySchema, { ...summary, name: "x".repeat(JOB_NAME_MAX_LENGTH + 1) })).toBe(false);
    expect(Value.Check(JobSummarySchema, { ...summary, prompt: "\n\t" })).toBe(false);
    expect(Value.Check(JobSummarySchema, { ...summary, prompt: "x".repeat(JOB_PROMPT_MAX_LENGTH + 1) })).toBe(false);
  });

  it("keeps hook diagnostics out of summaries and only in explicit state", () => {
    expect(Value.Check(JobRunSummarySchema, run)).toBe(true);
    expect(Value.Check(JobRunSummarySchema, { ...run, preStdout: "secret" })).toBe(false);
    expect(Value.Check(JobRunStateSchema, {
      ...run,
      preExitCode: 0,
      preStdout: "ok",
      preStderr: "",
      postExitCode: null,
      postStdout: null,
      postStderr: null,
      conversationAvailable: true,
    })).toBe(true);
  });

  it("defines the complete job-owned stable error union", () => {
    for (const code of [
      "job_not_found", "job_invalid", "job_busy", "job_disabled",
      "job_already_running", "job_script_roots_unavailable",
      "job_script_invalid", "job_script_unavailable", "job_pre_run_failed",
      "job_post_run_failed", "job_hook_timeout", "job_hook_output_limit",
      "job_prompt_failed", "job_aborted", "job_interrupted",
    ]) {
      expect(Value.Check(JobErrorCodeSchema, code)).toBe(true);
    }
    expect(Value.Check(JobErrorCodeSchema, "live_runtime_limit")).toBe(false);
  });

  it("normalizes names and rejects whitespace-only prompts", () => {
    expect(normalizeJobName("  Report  ")).toBe("Report");
    expect(normalizeJobName(" ")).toBeUndefined();
    expect(isValidJobPrompt("\n do it \n")).toBe(true);
    expect(isValidJobPrompt("\n\t")).toBe(false);
  });
});
