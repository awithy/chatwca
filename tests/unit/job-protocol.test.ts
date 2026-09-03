import { Buffer } from "node:buffer";

import { Value } from "@sinclair/typebox/value";
import { describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/shared/errors.js";
import {
  ClientCommandSchema,
  ServerMessageSchema,
  type ClientCommand,
  type JobRunState,
  type JobSummary,
} from "../../src/shared/protocol.js";
import {
  decodeClientCommand,
  dispatchClientCommand,
  type ProtocolHistory,
  type ProtocolJobs,
  type ProtocolRegistry,
  type ProtocolWorkspaceRepository,
} from "../../src/server/protocol.js";
import { summaryOnly } from "../../src/server/job-service.js";

const run: JobRunState = {
  id: "run-1",
  jobId: "job-1",
  trigger: "manual",
  scheduledFor: 1_000,
  startedAt: null,
  finishedAt: null,
  status: "queued",
  phase: null,
  errorCode: null,
  errorMessage: null,
  conversationId: null,
  revision: 0,
  createdAt: 1_000,
  updatedAt: 1_000,
  preExitCode: null,
  preStdout: null,
  preStderr: null,
  postExitCode: null,
  postStdout: null,
  postStderr: null,
  conversationAvailable: false,
};

const job: JobSummary = {
  id: "job-1",
  name: "Nightly",
  workspaceId: "workspace-1",
  workspaceName: "Workspace",
  workspaceAvailable: true,
  prompt: "Run the report",
  schedule: { kind: "interval", intervalMinutes: 60, anchorAt: 900 },
  preRunScript: null,
  postRunScript: null,
  enabled: true,
  nextRunAt: 3_600_900,
  createdAt: 900,
  updatedAt: 900,
  activeRun: summaryOnly(run),
  lastRun: null,
  configurationIssue: null,
};

function fixture(owner = false) {
  const registry: ProtocolRegistry = {
    create: vi.fn(), open: vi.fn(), getState: vi.fn(), rename: vi.fn(), close: vi.fn(),
    fork: vi.fn(), prompt: vi.fn(), abort: vi.fn(), hasLiveWorkspace: vi.fn(() => false),
    getActiveOwner: vi.fn(() => owner
      ? { kind: "scheduled-job", jobId: job.id, runId: run.id }
      : undefined),
    subscribe: vi.fn(() => () => undefined),
  };
  const history: ProtocolHistory = {
    list: vi.fn(), resolve: vi.fn(), delete: vi.fn(),
  };
  const workspaces: ProtocolWorkspaceRepository = {
    list: vi.fn(() => []), requireAvailable: vi.fn(), requireUsable: vi.fn(),
    create: vi.fn(), update: vi.fn(), delete: vi.fn(),
  };
  const jobs: ProtocolJobs = {
    list: vi.fn(() => [job]),
    create: vi.fn(() => [job]),
    update: vi.fn(() => [job]),
    delete: vi.fn(() => []),
    referencesWorkspace: vi.fn(() => false),
    run: vi.fn(() => run),
    abort: vi.fn(async () => undefined),
    runs: vi.fn(() => ({ runs: [summaryOnly(run)], nextCursor: "next" })),
    runState: vi.fn(() => ({
      ...run,
      status: "failed",
      finishedAt: 2_000,
      revision: 2,
      errorCode: ERROR_CODES.JOB_PRE_RUN_FAILED,
      errorMessage: "The pre-run script failed.",
      preStdout: "detail only",
    })),
    subscribe: vi.fn(() => () => undefined),
  };
  return { registry, history, workspaces, jobs };
}

const commands = [
  { type: "job.list", requestId: "list" },
  {
    type: "job.create", requestId: "create", name: "Nightly", workspaceId: "workspace-1",
    prompt: "Run it", schedule: { kind: "interval", intervalMinutes: 60 }, enabled: true,
  },
  { type: "job.update", requestId: "update", jobId: "job-1", enabled: false },
  { type: "job.delete", requestId: "delete", jobId: "job-1" },
  { type: "job.run", requestId: "run", jobId: "job-1" },
  { type: "job.abort", requestId: "abort", jobId: "job-1", runId: "run-1" },
  { type: "job.runs", requestId: "runs", jobId: "job-1", cursor: "next" },
  { type: "job.run.state", requestId: "state", jobId: "job-1", runId: "run-1" },
] as const;

describe("scheduled-job wire protocol", () => {
  it("defines closed requestId-bearing commands and rejects browser authority", () => {
    for (const command of commands) expect(Value.Check(ClientCommandSchema, command)).toBe(true);
    for (const invalid of [
      { type: "job.list" },
      { ...commands[1], schedule: { kind: "interval", intervalMinutes: 60, anchorAt: 1 } },
      { ...commands[1], arguments: ["--unsafe"] },
      { ...commands[1], environment: { TOKEN: "secret" } },
      { ...commands[1], policy: { securityProfile: "unrestricted" } },
      { ...commands[1], destinations: ["example.com"] },
      { ...commands[6], limit: 1 },
    ]) expect(Value.Check(ClientCommandSchema, invalid)).toBe(false);

    expect(() => decodeClientCommand(Buffer.from(JSON.stringify({
      ...commands[2], unknown: true,
    })), false)).toThrow();
  });

  it("dispatches every command with one exact correlated response", async () => {
    const f = fixture();
    const dispatch = (command: ClientCommand) => dispatchClientCommand(
      command, f.registry, f.history, f.workspaces, false, f.jobs,
    );

    await expect(dispatch(commands[0] as ClientCommand)).resolves.toEqual({
      response: { type: "jobs", requestId: "list", jobs: [job] },
    });
    await expect(dispatch(commands[1] as ClientCommand)).resolves.toMatchObject({
      response: { type: "jobs", requestId: "create", jobs: [job] }, jobs: [job],
    });
    expect(f.jobs.create).toHaveBeenCalledWith(expect.not.objectContaining({
      anchorAt: expect.anything(),
    }));
    await expect(dispatch(commands[2] as ClientCommand)).resolves.toMatchObject({
      response: { type: "jobs", requestId: "update" }, jobs: [job],
    });
    await expect(dispatch(commands[3] as ClientCommand)).resolves.toMatchObject({
      response: { type: "ack", requestId: "delete", command: "job.delete" },
      jobsBroadcastIncludesSender: true,
    });
    await expect(dispatch(commands[4] as ClientCommand)).resolves.toEqual({
      response: { type: "job.run.state", requestId: "run", run },
    });
    await expect(dispatch(commands[5] as ClientCommand)).resolves.toEqual({
      response: { type: "ack", requestId: "abort", command: "job.abort" },
    });
    await expect(dispatch(commands[6] as ClientCommand)).resolves.toEqual({
      response: {
        type: "job.runs", requestId: "runs", jobId: "job-1",
        runs: [summaryOnly(run)], nextCursor: "next",
      },
    });
    const detail = await dispatch(commands[7] as ClientCommand);
    expect(detail.response).toMatchObject({
      type: "job.run.state", requestId: "state",
      run: { preStdout: "detail only", revision: 2 },
    });
  });

  it("keeps diagnostics out of summaries and validates all outbound shapes", () => {
    const detail = { ...run, preStdout: "secret hook output" };
    const summary = summaryOnly(detail);
    expect(summary).not.toHaveProperty("preStdout");
    expect(Value.Check(ServerMessageSchema, {
      type: "job.run.updated", jobId: job.id, runId: run.id,
      revision: run.revision, run: summary,
    })).toBe(true);
    expect(Value.Check(ServerMessageSchema, {
      type: "job.run.updated", jobId: job.id, runId: run.id,
      revision: run.revision, run: { ...summary, preStdout: "leak" },
    })).toBe(false);
    expect(Value.Check(ServerMessageSchema, {
      type: "job.run.state", requestId: "detail", run: detail,
    })).toBe(true);
  });

  it("checks workspace references and routes active conversation aborts to the job runner", async () => {
    const referenced = fixture(true);
    vi.mocked(referenced.jobs.referencesWorkspace).mockReturnValue(true);
    await expect(dispatchClientCommand(
      { type: "workspace.delete", requestId: "delete", workspaceId: "workspace-1" },
      referenced.registry, referenced.history, referenced.workspaces, false, referenced.jobs,
    )).rejects.toMatchObject({ code: ERROR_CODES.WORKSPACE_BUSY });
    expect(referenced.workspaces.delete).not.toHaveBeenCalled();

    await expect(dispatchClientCommand(
      { type: "conversation.abort", requestId: "abort", conversationId: "conversation-1" },
      referenced.registry, referenced.history, referenced.workspaces, false, referenced.jobs,
    )).resolves.toMatchObject({ response: { type: "ack" } });
    expect(referenced.jobs.abort).toHaveBeenCalledWith(job.id, run.id);
    expect(referenced.registry.abort).not.toHaveBeenCalled();

    for (const mutation of [
      { type: "conversation.rename", requestId: "x", conversationId: "conversation-1", title: "x" },
      { type: "conversation.close", requestId: "x", conversationId: "conversation-1" },
      { type: "prompt.submit", requestId: "x", conversationId: "conversation-1", text: "x", images: [] },
    ] as ClientCommand[]) {
      await expect(dispatchClientCommand(
        mutation, referenced.registry, referenced.history, referenced.workspaces, false, referenced.jobs,
      )).rejects.toMatchObject({ code: ERROR_CODES.CONVERSATION_BUSY });
    }
  });

  it("rejects all job admission during shutdown", async () => {
    const f = fixture();
    for (const command of commands) {
      await expect(dispatchClientCommand(
        command as ClientCommand, f.registry, f.history, f.workspaces, true, f.jobs,
      )).rejects.toMatchObject({ code: ERROR_CODES.SHUTTING_DOWN });
    }
    expect(f.jobs.list).not.toHaveBeenCalled();
  });
});
