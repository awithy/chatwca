import { describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import type { ConversationOwner } from "../../src/shared/protocol.js";
import type { JobRunState, JobSummary } from "../../src/shared/jobs.js";
import {
  JobRunner,
  type JobRunnerRegistryPort,
  type JobRunnerRepositoryPort,
} from "../../src/server/job-runner.js";
import type { JobHookResult } from "../../src/server/job-hook-runner.js";
import type { RuntimeCapacityLease } from "../../src/server/conversation-registry.js";
import type { RuntimeWorkspacePolicy } from "../../src/server/workspace-repository.js";

const policy: RuntimeWorkspacePolicy = Object.freeze({
  workspaceId: "workspace-1",
  cwd: "/workspace",
  sessionDirectory: null,
  securityProfile: "unrestricted",
  networkPolicy: null,
  networkPolicySetId: "default",
  effectiveNetworkPolicySetId: null,
  networkPolicySet: null,
});

function runState(overrides: Partial<JobRunState> = {}): JobRunState {
  return {
    id: "run-1",
    jobId: "job-1",
    trigger: "scheduled",
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
    ...overrides,
  };
}

function job(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "job-1",
    name: "Daily report",
    workspaceId: "workspace-1",
    workspaceName: "Workspace",
    workspaceAvailable: true,
    prompt: "Write the report",
    schedule: { kind: "interval", intervalMinutes: 60, anchorAt: 0 },
    preRunScript: null,
    postRunScript: null,
    enabled: true,
    nextRunAt: 3_600_000,
    createdAt: 0,
    updatedAt: 0,
    activeRun: null,
    lastRun: null,
    configurationIssue: null,
    ...overrides,
  };
}

class FakeRepository implements JobRunnerRepositoryPort {
  state = runState();
  readonly states: JobRunState[] = [];
  readonly terminalCalls: Array<{ status: string; expectedRevision?: number }> = [];

  private update(changes: Partial<JobRunState>): JobRunState {
    this.state = { ...this.state, ...changes, revision: this.state.revision + 1 };
    this.states.push(this.state);
    return this.state;
  }

  startRun(_jobId: string, _runId: string, phase = null): JobRunState {
    return this.update({ status: "running", phase, startedAt: 1_001 });
  }

  setRunPhase(_jobId: string, _runId: string, phase: NonNullable<JobRunState["phase"]>): JobRunState {
    return this.update({ phase });
  }

  attachConversation(_jobId: string, _runId: string, conversationId: string): JobRunState {
    return this.update({ conversationId });
  }

  recordHookResult(
    _jobId: string,
    _runId: string,
    hook: "pre" | "post",
    result: { exitCode: number | null; stdout: string; stderr: string },
  ): JobRunState {
    return this.update(hook === "pre"
      ? { preExitCode: result.exitCode, preStdout: result.stdout, preStderr: result.stderr }
      : { postExitCode: result.exitCode, postStdout: result.stdout, postStderr: result.stderr });
  }

  finishRun(
    _jobId: string,
    _runId: string,
    input: Parameters<JobRunnerRepositoryPort["finishRun"]>[2],
  ): JobRunState {
    this.terminalCalls.push({ status: input.status, expectedRevision: input.expectedRevision });
    return this.update({
      status: input.status,
      phase: input.phase ?? this.state.phase,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorCode === null || input.errorCode === undefined
        ? null
        : new AppError(input.errorCode).message,
      finishedAt: 2_000,
    });
  }

  getRun(): JobRunState {
    return this.state;
  }
}

class FakeRegistry implements JobRunnerRegistryPort {
  completion: Awaited<ReturnType<JobRunnerRegistryPort["runJobPrompt"]>> = {
    kind: "succeeded",
    assistant: { entryId: "assistant", role: "assistant", blocks: [], stopReason: "stop" },
  };
  reserveError: unknown;
  readonly events: string[] = [];
  readonly reserveRuntimeCapacity = vi.fn(async (): Promise<RuntimeCapacityLease> => {
    if (this.reserveError !== undefined) throw this.reserveError;
    let settled = false;
    return {
      promote: () => { if (!settled) { settled = true; this.events.push("lease-promote"); } },
      release: () => { if (!settled) { settled = true; this.events.push("lease-release"); } },
    };
  });
  readonly createJobConversation = vi.fn(async (
    _policy: RuntimeWorkspacePolicy,
    _owner: ConversationOwner,
    lease: RuntimeCapacityLease,
  ) => {
    this.events.push("conversation-create");
    lease.promote();
    return { id: "conversation-1" };
  });
  readonly setJobConversationTitle = vi.fn(async () => { this.events.push("title"); });
  readonly runJobPrompt = vi.fn(async () => {
    this.events.push("prompt");
    return this.completion;
  });
  readonly releaseJobConversation = vi.fn(async () => { this.events.push("conversation-release"); });
  readonly abort = vi.fn(async () => { this.events.push("pi-abort"); });
  abortListener: ((owner: ConversationOwner) => void) | undefined;

  subscribeJobAborts(listener: (owner: ConversationOwner) => void): () => void {
    this.abortListener = listener;
    return () => { this.abortListener = undefined; };
  }
}

const hookSuccess: JobHookResult = {
  succeeded: true,
  exitCode: 0,
  signal: null,
  stdout: "ok",
  stderr: "",
  errorCode: null,
};

function fixture(options: {
  readonly definition?: JobSummary;
  readonly repository?: FakeRepository;
  readonly registry?: FakeRegistry;
  readonly requireUsable?: () => RuntimeWorkspacePolicy | Promise<RuntimeWorkspacePolicy>;
  readonly validate?: (script: string) => string;
  readonly runHook?: (phase: "pre-hook" | "post-hook", signal: AbortSignal) => Promise<JobHookResult>;
} = {}) {
  const repository = options.repository ?? new FakeRepository();
  const registry = options.registry ?? new FakeRegistry();
  const hookCalls: string[] = [];
  const updates: JobRunState[] = [];
  const jobsChanged = vi.fn();
  const runner = new JobRunner({
    repository,
    registry,
    workspaces: { requireUsable: options.requireUsable ?? (() => policy) },
    hookPaths: { validateForRun: (script) => options.validate?.(script) ?? `/canonical/${script.split("/").at(-1)}` },
    hooks: {
      run: async (input) => {
        hookCalls.push(input.phase);
        return options.runHook?.(input.phase, input.signal ?? new AbortController().signal) ?? hookSuccess;
      },
    },
    onRunUpdated: (state) => updates.push(state),
    onJobsChanged: jobsChanged,
  });
  return {
    runner,
    repository,
    registry,
    hookCalls,
    updates,
    jobsChanged,
    claim: { job: options.definition ?? job(), run: repository.state },
  };
}

describe("JobRunner", () => {
  it("runs the revisioned happy path and releases ownership only after terminal CAS", async () => {
    const f = fixture();
    const result = await f.runner.run(f.claim);

    expect(result).toMatchObject({ status: "succeeded", phase: "prompt", revision: 4 });
    expect(f.registry.events).toEqual([
      "conversation-create", "lease-promote", "title", "prompt", "conversation-release",
    ]);
    expect(f.repository.terminalCalls).toEqual([{ status: "succeeded", expectedRevision: 3 }]);
    expect(f.updates.map(({ status, phase }) => [status, phase])).toEqual([
      ["running", null], ["running", "prompt"], ["running", "prompt"], ["succeeded", "prompt"],
    ]);
    expect(f.jobsChanged).toHaveBeenCalledTimes(4);
    expect(f.runner.activeCount).toBe(0);
  });

  it("validates both hooks before capacity or side effects and blocks on current policy failures", async () => {
    const invalidPost = fixture({
      definition: job({ preRunScript: "/hooks/pre.sh", postRunScript: "/hooks/post.sh" }),
      validate: (script) => {
        if (script.endsWith("post.sh")) throw new AppError(ERROR_CODES.JOB_SCRIPT_UNAVAILABLE);
        return script;
      },
    });
    await expect(invalidPost.runner.run(invalidPost.claim)).resolves.toMatchObject({
      status: "blocked", phase: "post-hook", errorCode: ERROR_CODES.JOB_SCRIPT_UNAVAILABLE,
    });
    expect(invalidPost.registry.reserveRuntimeCapacity).not.toHaveBeenCalled();
    expect(invalidPost.hookCalls).toEqual([]);

    const unusable = fixture({
      definition: job({ preRunScript: "/hooks/pre.sh" }),
      requireUsable: () => { throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED); },
    });
    await expect(unusable.runner.run(unusable.claim)).resolves.toMatchObject({
      status: "blocked", errorCode: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED,
    });
    expect(unusable.registry.reserveRuntimeCapacity).not.toHaveBeenCalled();
  });

  it("skips capacity exhaustion before pre-hook and releases a lease after pre-hook failure", async () => {
    const capacity = new FakeRegistry();
    capacity.reserveError = new AppError(ERROR_CODES.LIVE_RUNTIME_LIMIT);
    const skipped = fixture({
      registry: capacity,
      definition: job({ preRunScript: "/hooks/pre.sh" }),
    });
    await expect(skipped.runner.run(skipped.claim)).resolves.toMatchObject({
      status: "skipped", errorCode: ERROR_CODES.LIVE_RUNTIME_LIMIT,
    });
    expect(skipped.hookCalls).toEqual([]);

    const failed = fixture({
      definition: job({ preRunScript: "/hooks/pre.sh" }),
      runHook: async () => ({
        ...hookSuccess,
        succeeded: false,
        exitCode: 7,
        stderr: "private diagnostic",
        errorCode: ERROR_CODES.JOB_PRE_RUN_FAILED,
      }),
    });
    await expect(failed.runner.run(failed.claim)).resolves.toMatchObject({
      status: "failed",
      phase: "pre-hook",
      preExitCode: 7,
      errorCode: ERROR_CODES.JOB_PRE_RUN_FAILED,
      conversationId: null,
    });
    expect(failed.registry.events).toEqual(["lease-release"]);
    expect(failed.registry.createJobConversation).not.toHaveBeenCalled();
  });

  it("runs post-hook only after prompt success and retains its conversation through failure persistence", async () => {
    const f = fixture({
      definition: job({ postRunScript: "/hooks/post.sh" }),
      runHook: async () => ({
        ...hookSuccess,
        succeeded: false,
        exitCode: 9,
        errorCode: ERROR_CODES.JOB_POST_RUN_FAILED,
      }),
    });
    const result = await f.runner.run(f.claim);
    expect(result).toMatchObject({
      status: "failed", phase: "post-hook", postExitCode: 9,
      conversationId: "conversation-1", errorCode: ERROR_CODES.JOB_POST_RUN_FAILED,
    });
    expect(f.hookCalls).toEqual(["post-hook"]);
    expect(f.registry.events.indexOf("conversation-release"))
      .toBeGreaterThan(f.registry.events.indexOf("prompt"));
    expect(f.repository.states.at(-1)?.status).toBe("failed");
  });

  it("classifies canonical provider failure and external conversation abort", async () => {
    const providerRegistry = new FakeRegistry();
    providerRegistry.completion = {
      kind: "failed",
      assistant: {
        entryId: "assistant", role: "assistant", blocks: [], stopReason: "error",
        error: { code: ERROR_CODES.MODEL_FAILED, message: "The model failed while processing the prompt." },
      },
    };
    const provider = fixture({ registry: providerRegistry });
    await expect(provider.runner.run(provider.claim)).resolves.toMatchObject({
      status: "failed", phase: "prompt", errorCode: ERROR_CODES.JOB_PROMPT_FAILED,
    });

    const abortRegistry = new FakeRegistry();
    let complete!: (value: FakeRegistry["completion"]) => void;
    abortRegistry.runJobPrompt.mockImplementation(async () =>
      new Promise((resolve) => { complete = resolve; }),
    );
    const aborted = fixture({ registry: abortRegistry });
    const pending = aborted.runner.run(aborted.claim);
    await vi.waitFor(() => expect(abortRegistry.runJobPrompt).toHaveBeenCalledOnce());
    abortRegistry.abortListener?.({ kind: "scheduled-job", jobId: "job-1", runId: "run-1" });
    complete({ kind: "aborted" });
    await expect(pending).resolves.toMatchObject({
      status: "aborted", errorCode: ERROR_CODES.JOB_ABORTED,
    });
    expect(abortRegistry.abort).toHaveBeenCalledWith("conversation-1");
  });

  it("revalidates immediately before a hook and releases capacity without running a swapped script", async () => {
    let validations = 0;
    const f = fixture({
      definition: job({ preRunScript: "/hooks/pre.sh" }),
      validate: (script) => {
        validations += 1;
        if (validations === 2) throw new AppError(ERROR_CODES.JOB_SCRIPT_UNAVAILABLE);
        return script;
      },
    });

    await expect(f.runner.run(f.claim)).resolves.toMatchObject({
      status: "blocked", phase: "pre-hook", errorCode: ERROR_CODES.JOB_SCRIPT_UNAVAILABLE,
    });
    expect(validations).toBe(2);
    expect(f.hookCalls).toEqual([]);
    expect(f.registry.events).toEqual(["lease-release"]);
  });

  it("classifies shutdown during an owned prompt as interrupted", async () => {
    const registry = new FakeRegistry();
    let complete!: (value: FakeRegistry["completion"]) => void;
    registry.runJobPrompt.mockImplementation(async () =>
      new Promise((resolve) => { complete = resolve; }),
    );
    const f = fixture({ registry });
    const pending = f.runner.run(f.claim);
    await vi.waitFor(() => expect(registry.runJobPrompt).toHaveBeenCalledOnce());
    f.runner.beginShutdown();
    complete({ kind: "aborted" });

    await expect(pending).resolves.toMatchObject({
      status: "interrupted", errorCode: ERROR_CODES.JOB_INTERRUPTED,
    });
    expect(registry.abort).toHaveBeenCalledWith("conversation-1");
    expect(registry.releaseJobConversation).toHaveBeenCalledOnce();
  });

  it("does not overwrite a terminal state won by a shutdown/CAS race", async () => {
    const repository = new FakeRepository();
    const originalFinish = repository.finishRun.bind(repository);
    let race = true;
    repository.finishRun = ((jobId, runId, input) => {
      if (race) {
        race = false;
        repository.state = runState({
          ...repository.state,
          status: "interrupted",
          errorCode: ERROR_CODES.JOB_INTERRUPTED,
          errorMessage: new AppError(ERROR_CODES.JOB_INTERRUPTED).message,
          revision: repository.state.revision + 1,
          finishedAt: 1_500,
        });
        throw new AppError(ERROR_CODES.JOB_BUSY);
      }
      return originalFinish(jobId, runId, input);
    }) as FakeRepository["finishRun"];
    const f = fixture({ repository });

    await expect(f.runner.run(f.claim)).resolves.toMatchObject({
      status: "interrupted", errorCode: ERROR_CODES.JOB_INTERRUPTED,
    });
    expect(f.registry.releaseJobConversation).toHaveBeenCalledOnce();
    expect(repository.terminalCalls).toEqual([]);
  });

  it("performs no late repository operation after shutdown seals persistence", async () => {
    let resolvePolicy!: (value: RuntimeWorkspacePolicy) => void;
    const policyPending = new Promise<RuntimeWorkspacePolicy>((resolve) => {
      resolvePolicy = resolve;
    });
    const repository = new FakeRepository();
    const f = fixture({ repository, requireUsable: () => policyPending });
    const pending = f.runner.run(f.claim);
    await vi.waitFor(() => expect(repository.state.status).toBe("running"));

    const recovered = runState({
      ...repository.state,
      status: "interrupted",
      errorCode: ERROR_CODES.JOB_INTERRUPTED,
      errorMessage: new AppError(ERROR_CODES.JOB_INTERRUPTED).message,
      finishedAt: 1_500,
      revision: repository.state.revision + 1,
    });
    f.runner.beginShutdown();
    f.runner.sealPersistence([recovered]);
    const stateCount = repository.states.length;
    resolvePolicy(policy);

    await expect(pending).resolves.toEqual(recovered);
    expect(repository.states).toHaveLength(stateCount);
    expect(repository.terminalCalls).toEqual([]);
    expect(f.registry.reserveRuntimeCapacity).not.toHaveBeenCalled();
  });
});
