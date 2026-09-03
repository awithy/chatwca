import { AppError, ERROR_CODES, type ErrorCode } from "../shared/errors.js";
import type {
  ConversationOwner,
} from "../shared/protocol.js";
import type {
  JobRunPhase,
  JobRunState,
  JobSummary,
} from "../shared/jobs.js";
import type {
  ConversationRecord,
  JobPromptCompletion,
  RuntimeCapacityLease,
} from "./conversation-registry.js";
import type { JobHookWorkspacePolicy } from "./job-hook-path.js";
import type { JobHookResult, JobHookRunInput } from "./job-hook-runner.js";
import type { ClaimedJobRun, FinishJobRunInput, HookResultInput } from "./job-repository.js";
import { formatJobConversationTitle } from "./job-schedule.js";
import type { RuntimeWorkspacePolicy } from "./workspace-repository.js";

/** Persistence operations used by the runner, kept narrow for deterministic tests. */
export interface JobRunnerRepositoryPort {
  startRun(
    jobId: string,
    runId: string,
    phase?: JobRunPhase | null,
    startedAt?: number,
    expectedRevision?: number,
  ): JobRunState;
  setRunPhase(
    jobId: string,
    runId: string,
    phase: JobRunPhase,
    expectedRevision?: number,
  ): JobRunState;
  attachConversation(
    jobId: string,
    runId: string,
    conversationId: string,
    expectedRevision?: number,
  ): JobRunState;
  recordHookResult(
    jobId: string,
    runId: string,
    hook: "pre" | "post",
    result: HookResultInput,
  ): JobRunState;
  finishRun(jobId: string, runId: string, input: FinishJobRunInput): JobRunState;
  getRun(jobId: string, runId: string): JobRunState;
}

export interface JobRunnerWorkspacePort {
  requireUsable(workspaceId: string): RuntimeWorkspacePolicy | Promise<RuntimeWorkspacePolicy>;
}

export interface JobRunnerHookPathPort {
  validateForRun(
    scriptPath: string,
    workspace: JobHookWorkspacePolicy,
  ): string;
}

export interface JobRunnerHookPort {
  run(input: Readonly<JobHookRunInput>): Promise<JobHookResult>;
}

export interface JobRunnerRegistryPort {
  reserveRuntimeCapacity(): Promise<RuntimeCapacityLease>;
  createJobConversation(
    policy: RuntimeWorkspacePolicy,
    owner: ConversationOwner,
    lease: RuntimeCapacityLease,
  ): Promise<Pick<ConversationRecord, "id">>;
  setJobConversationTitle(
    conversationId: string,
    owner: ConversationOwner,
    title: string,
  ): Promise<void>;
  runJobPrompt(
    conversationId: string,
    owner: ConversationOwner,
    prompt: string,
  ): Promise<JobPromptCompletion>;
  releaseJobConversation(conversationId: string, owner: ConversationOwner): Promise<void>;
  abort(conversationId: string): Promise<void>;
  subscribeJobAborts?(listener: (owner: ConversationOwner) => void): () => void;
}

export interface JobRunnerOptions {
  readonly repository: JobRunnerRepositoryPort;
  readonly workspaces: JobRunnerWorkspacePort;
  readonly hookPaths: JobRunnerHookPathPort;
  readonly hooks: JobRunnerHookPort;
  readonly registry: JobRunnerRegistryPort;
  /** Revisioned state callback suitable for a later protocol broadcaster. */
  readonly onRunUpdated?: (run: JobRunState) => void;
  /** Signals that active/last job summaries should be re-listed and broadcast. */
  readonly onJobsChanged?: () => void;
  readonly onInternalError?: (error: unknown) => void;
}

type StopReason = "abort" | "shutdown";

interface ActiveRun {
  readonly job: JobSummary;
  state: JobRunState;
  readonly owner: ConversationOwner;
  readonly controller: AbortController;
  stopReason?: StopReason;
  conversationId?: string;
  completion?: Promise<JobRunState>;
}

function activeKey(jobId: string, runId: string): string {
  return `${jobId}\0${runId}`;
}

function freezePolicy(policy: RuntimeWorkspacePolicy): RuntimeWorkspacePolicy {
  return Object.freeze({
    ...policy,
    ...(policy.mounts === undefined
      ? {}
      : { mounts: Object.freeze(policy.mounts.map((mount) => Object.freeze({ ...mount }))) }),
  });
}

function safeErrorCode(error: unknown, fallback: ErrorCode): ErrorCode {
  return error instanceof AppError ? error.code : fallback;
}

/**
 * Executes already-claimed queued attempts. SQLite owns durable state while
 * this class owns only process-local cancellation and resource lifetimes.
 */
export class JobRunner {
  readonly #repository: JobRunnerRepositoryPort;
  readonly #workspaces: JobRunnerWorkspacePort;
  readonly #hookPaths: JobRunnerHookPathPort;
  readonly #hooks: JobRunnerHookPort;
  readonly #registry: JobRunnerRegistryPort;
  readonly #onRunUpdated: (run: JobRunState) => void;
  readonly #onJobsChanged: () => void;
  readonly #onInternalError: (error: unknown) => void;
  readonly #activeByJob = new Map<string, ActiveRun>();
  readonly #activeByKey = new Map<string, ActiveRun>();
  readonly #unsubscribeJobAborts: (() => void) | undefined;
  #closed = false;
  #persistenceSealed = false;

  constructor(options: Readonly<JobRunnerOptions>) {
    this.#repository = options.repository;
    this.#workspaces = options.workspaces;
    this.#hookPaths = options.hookPaths;
    this.#hooks = options.hooks;
    this.#registry = options.registry;
    this.#onRunUpdated = options.onRunUpdated ?? (() => undefined);
    this.#onJobsChanged = options.onJobsChanged ?? (() => undefined);
    this.#onInternalError = options.onInternalError ?? (() => undefined);
    this.#unsubscribeJobAborts = this.#registry.subscribeJobAborts?.((owner) => {
      void this.abort(owner.jobId, owner.runId).catch(this.#onInternalError);
    });
  }

  get activeCount(): number {
    return this.#activeByKey.size;
  }

  isActive(jobId: string, runId?: string): boolean {
    const active = this.#activeByJob.get(jobId);
    return active !== undefined && (runId === undefined || active.state.id === runId);
  }

  /** Dispatch one repository-claimed attempt. Different jobs run independently. */
  run(claim: Readonly<ClaimedJobRun>): Promise<JobRunState> {
    if (this.#closed) return Promise.reject(new AppError(ERROR_CODES.SHUTTING_DOWN));
    if (claim.run.status !== "queued") {
      this.#publish(claim.run);
      return Promise.resolve(claim.run);
    }
    if (this.#activeByJob.has(claim.job.id) || this.#activeByKey.has(activeKey(claim.job.id, claim.run.id))) {
      return Promise.reject(new AppError(ERROR_CODES.JOB_ALREADY_RUNNING));
    }

    const owner: ConversationOwner = Object.freeze({
      kind: "scheduled-job",
      jobId: claim.job.id,
      runId: claim.run.id,
    });
    const active: ActiveRun = {
      job: claim.job,
      state: claim.run,
      owner,
      controller: new AbortController(),
    };
    this.#activeByJob.set(claim.job.id, active);
    this.#activeByKey.set(activeKey(claim.job.id, claim.run.id), active);
    const completion = this.#execute(active).finally(() => {
      if (this.#activeByJob.get(claim.job.id) === active) this.#activeByJob.delete(claim.job.id);
      this.#activeByKey.delete(activeKey(claim.job.id, claim.run.id));
    });
    active.completion = completion;
    return completion;
  }

  /** Scheduler-facing synonym that makes fire-and-forget dispatch explicit. */
  dispatch(claim: Readonly<ClaimedJobRun>): Promise<JobRunState> {
    return this.run(claim);
  }

  /** Abort either a hook or Pi prompt without waiting for terminal persistence. */
  async abort(jobId: string, runId: string): Promise<void> {
    const active = this.#activeByKey.get(activeKey(jobId, runId));
    if (active === undefined) throw new AppError(ERROR_CODES.JOB_NOT_FOUND);
    this.#requestStop(active, "abort");
    if (active.conversationId !== undefined) {
      await this.#registry.abort(active.conversationId).catch((error) => {
        this.#onInternalError(error);
      });
    }
  }

  /** Close admission and make every unfinished execution classify as interrupted. */
  beginShutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribeJobAborts?.();
    for (const active of this.#activeByKey.values()) {
      this.#requestStop(active, "shutdown");
      if (active.conversationId !== undefined) {
        void this.#registry.abort(active.conversationId).catch(this.#onInternalError);
      }
    }
  }

  /**
   * Adopt the coordinator's transactionally interrupted rows and permanently
   * prevent asynchronous continuations from issuing later SQLite operations.
   */
  sealPersistence(interrupted: readonly JobRunState[]): void {
    if (this.#persistenceSealed) return;
    const byKey = new Map(interrupted.map((state) => [activeKey(state.jobId, state.id), state]));
    for (const [key, active] of this.#activeByKey) {
      const state = byKey.get(key);
      if (state !== undefined) active.state = state;
    }
    this.#persistenceSealed = true;
  }

  async dispose(): Promise<void> {
    this.beginShutdown();
    await Promise.allSettled(
      [...this.#activeByKey.values()].flatMap((active) =>
        active.completion === undefined ? [] : [active.completion]
      ),
    );
  }

  async #execute(active: ActiveRun): Promise<JobRunState> {
    let lease: RuntimeCapacityLease | undefined;
    try {
      active.state = this.#repository.startRun(
        active.job.id,
        active.state.id,
        null,
        undefined,
        active.state.revision,
      );
      this.#publish(active.state);
      if (this.#persistenceSealed) return active.state;

      let policy: RuntimeWorkspacePolicy;
      try {
        policy = freezePolicy(await this.#workspaces.requireUsable(active.job.workspaceId));
      } catch (error) {
        if (this.#persistenceSealed) return active.state;
        if (active.stopReason !== undefined) return this.#finishStopped(active);
        return this.#finish(active, "blocked", safeErrorCode(error, ERROR_CODES.WORKSPACE_UNAVAILABLE), null);
      }
      if (this.#persistenceSealed) return active.state;
      if (active.stopReason !== undefined) return this.#finishStopped(active);

      let preScript: string | null = null;
      let postScript: string | null = null;
      try {
        if (active.job.preRunScript !== null) {
          preScript = this.#hookPaths.validateForRun(active.job.preRunScript, policy);
        }
        if (active.job.postRunScript !== null) {
          postScript = this.#hookPaths.validateForRun(active.job.postRunScript, policy);
        }
      } catch (error) {
        const phase: JobRunPhase = preScript === null && active.job.preRunScript !== null
          ? "pre-hook"
          : "post-hook";
        return this.#finish(active, "blocked", safeErrorCode(error, ERROR_CODES.JOB_SCRIPT_UNAVAILABLE), phase);
      }
      if (active.stopReason !== undefined) return this.#finishStopped(active);

      try {
        lease = await this.#registry.reserveRuntimeCapacity();
      } catch (error) {
        if (this.#persistenceSealed) return active.state;
        if (active.stopReason !== undefined || (error instanceof AppError && error.code === ERROR_CODES.SHUTTING_DOWN)) {
          return this.#finishStopped(active);
        }
        return this.#finish(
          active,
          error instanceof AppError && error.code === ERROR_CODES.LIVE_RUNTIME_LIMIT ? "skipped" : "failed",
          safeErrorCode(error, ERROR_CODES.LIVE_RUNTIME_LIMIT),
          null,
        );
      }
      if (this.#persistenceSealed) return active.state;
      if (active.stopReason !== undefined) return this.#finishStopped(active);

      if (preScript !== null) {
        active.state = this.#repository.setRunPhase(
          active.job.id, active.state.id, "pre-hook", active.state.revision,
        );
        this.#publish(active.state);
        if (this.#persistenceSealed) return active.state;
        try {
          preScript = this.#hookPaths.validateForRun(active.job.preRunScript!, policy);
        } catch (error) {
          return this.#finish(active, "blocked", safeErrorCode(error, ERROR_CODES.JOB_SCRIPT_UNAVAILABLE), "pre-hook");
        }
        const result = await this.#runHook(active, policy, preScript, "pre-hook");
        if (this.#persistenceSealed) return active.state;
        active.state = this.#recordHook(active, "pre", result);
        this.#adoptHookStop(active, result);
        if (active.stopReason !== undefined) return this.#finishStopped(active, "pre-hook");
        if (!result.succeeded) {
          return this.#finish(active, "failed", result.errorCode ?? ERROR_CODES.JOB_PRE_RUN_FAILED, "pre-hook");
        }
      }

      active.state = this.#repository.setRunPhase(
        active.job.id, active.state.id, "prompt", active.state.revision,
      );
      this.#publish(active.state);
      if (this.#persistenceSealed) return active.state;
      if (active.stopReason !== undefined) return this.#finishStopped(active, "prompt");

      let conversation: Pick<ConversationRecord, "id">;
      try {
        conversation = await this.#registry.createJobConversation(policy, active.owner, lease);
        lease = undefined; // promoted into registry ownership
      } catch (error) {
        if (this.#persistenceSealed) return active.state;
        if (active.stopReason !== undefined) return this.#finishStopped(active, "prompt");
        return this.#finish(active, "failed", safeErrorCode(error, ERROR_CODES.JOB_PROMPT_FAILED), "prompt");
      }
      active.conversationId = conversation.id;
      if (this.#persistenceSealed) return active.state;
      active.state = this.#repository.attachConversation(
        active.job.id, active.state.id, conversation.id, active.state.revision,
      );
      this.#publish(active.state);
      if (this.#persistenceSealed) return active.state;
      await this.#registry.setJobConversationTitle(
        conversation.id,
        active.owner,
        formatJobConversationTitle(active.job.name, active.job.schedule, active.state.scheduledFor),
      );
      if (this.#persistenceSealed) return active.state;
      if (active.stopReason !== undefined) return this.#finishStopped(active, "prompt");

      const promptResult = await this.#registry.runJobPrompt(
        conversation.id,
        active.owner,
        active.job.prompt,
      );
      if (this.#persistenceSealed) return active.state;
      if (active.stopReason !== undefined || promptResult.kind === "aborted") {
        if (active.stopReason === undefined) active.stopReason = "abort";
        return this.#finishStopped(active, "prompt");
      }
      if (promptResult.kind === "failed") {
        return this.#finish(active, "failed", ERROR_CODES.JOB_PROMPT_FAILED, "prompt");
      }
      if (promptResult.kind === "runtime-failure") {
        return this.#finish(active, "failed", promptResult.error.code, "prompt");
      }

      if (postScript !== null) {
        active.state = this.#repository.setRunPhase(
          active.job.id, active.state.id, "post-hook", active.state.revision,
        );
        this.#publish(active.state);
        if (this.#persistenceSealed) return active.state;
        if (active.stopReason !== undefined) return this.#finishStopped(active, "post-hook");
        try {
          postScript = this.#hookPaths.validateForRun(active.job.postRunScript!, policy);
        } catch (error) {
          return this.#finish(active, "blocked", safeErrorCode(error, ERROR_CODES.JOB_SCRIPT_UNAVAILABLE), "post-hook");
        }
        const result = await this.#runHook(active, policy, postScript, "post-hook");
        if (this.#persistenceSealed) return active.state;
        active.state = this.#recordHook(active, "post", result);
        this.#adoptHookStop(active, result);
        if (active.stopReason !== undefined) return this.#finishStopped(active, "post-hook");
        if (!result.succeeded) {
          return this.#finish(active, "failed", result.errorCode ?? ERROR_CODES.JOB_POST_RUN_FAILED, "post-hook");
        }
      }

      return this.#finish(active, "succeeded", null, postScript === null ? "prompt" : "post-hook");
    } catch (error) {
      try {
        if (this.#persistenceSealed) return active.state;
        if (active.stopReason !== undefined) return this.#finishStopped(active);
        return this.#finish(active, "failed", safeErrorCode(error, ERROR_CODES.JOB_PROMPT_FAILED), active.state.phase);
      } catch (finishError) {
        this.#onInternalError(error);
        this.#onInternalError(finishError);
        return this.#repository.getRun(active.job.id, active.state.id);
      }
    } finally {
      lease?.release();
      if (active.conversationId !== undefined) {
        await this.#registry.releaseJobConversation(active.conversationId, active.owner)
          .catch(this.#onInternalError);
      }
    }
  }

  #runHook(
    active: ActiveRun,
    policy: RuntimeWorkspacePolicy,
    canonicalScriptPath: string,
    phase: "pre-hook" | "post-hook",
  ): Promise<JobHookResult> {
    return this.#hooks.run({
      canonicalScriptPath,
      jobId: active.job.id,
      jobName: active.job.name,
      runId: active.state.id,
      trigger: active.state.trigger,
      scheduledFor: active.state.scheduledFor,
      workspaceId: active.job.workspaceId,
      workspacePath: policy.cwd,
      conversationId: active.conversationId ?? null,
      phase,
      signal: active.controller.signal,
    });
  }

  #recordHook(active: ActiveRun, hook: "pre" | "post", result: JobHookResult): JobRunState {
    const state = this.#repository.recordHookResult(active.job.id, active.state.id, hook, {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      expectedRevision: active.state.revision,
    });
    this.#publish(state);
    return state;
  }

  #finishStopped(active: ActiveRun, phase: JobRunPhase | null = active.state.phase): JobRunState {
    return active.stopReason === "shutdown"
      ? this.#finish(active, "interrupted", ERROR_CODES.JOB_INTERRUPTED, phase)
      : this.#finish(active, "aborted", ERROR_CODES.JOB_ABORTED, phase);
  }

  #finish(
    active: ActiveRun,
    status: "succeeded" | "failed" | "blocked" | "skipped" | "aborted" | "interrupted",
    errorCode: ErrorCode | null,
    phase: JobRunPhase | null,
  ): JobRunState {
    if (this.#persistenceSealed) return active.state;
    try {
      const state = this.#repository.finishRun(active.job.id, active.state.id, {
        status,
        phase,
        errorCode,
        expectedRevision: active.state.revision,
      });
      active.state = state;
      this.#publish(state);
      return state;
    } catch (error) {
      if (error instanceof AppError && error.code === ERROR_CODES.JOB_BUSY) {
        const current = this.#repository.getRun(active.job.id, active.state.id);
        if (current.status !== "queued" && current.status !== "running") {
          active.state = current;
          return current;
        }
      }
      throw error;
    }
  }

  #adoptHookStop(active: ActiveRun, result: JobHookResult): void {
    if (active.stopReason !== undefined) return;
    if (result.errorCode === ERROR_CODES.JOB_INTERRUPTED) active.stopReason = "shutdown";
    else if (result.errorCode === ERROR_CODES.JOB_ABORTED) active.stopReason = "abort";
  }

  #requestStop(active: ActiveRun, reason: StopReason): void {
    if (active.stopReason === "shutdown" || active.stopReason === reason) return;
    // Shutdown wins over a concurrent operator abort.
    active.stopReason = reason;
    active.controller.abort();
  }

  #publish(state: JobRunState): void {
    try { this.#onRunUpdated(state); } catch (error) { this.#onInternalError(error); }
    try { this.#onJobsChanged(); } catch (error) { this.#onInternalError(error); }
  }
}
