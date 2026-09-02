import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { homedir } from "node:os";

import { ERROR_CODES, type ErrorCode } from "../shared/errors.js";
import type { JobRunTrigger } from "../shared/jobs.js";
import { JOB_BASH_PATH, type JobConfig } from "./job-config.js";

export const JOB_HOOK_SAFE_PATH = "/usr/local/bin:/usr/bin:/bin";
export const JOB_HOOK_TERMINATION_GRACE_MS = 250;

export type JobHookPhase = "pre-hook" | "post-hook";

export interface JobHookRunMetadata {
  readonly jobId: string;
  readonly jobName: string;
  readonly runId: string;
  readonly trigger: JobRunTrigger;
  readonly scheduledFor: number;
  readonly workspaceId: string;
  readonly workspacePath: string;
  readonly conversationId?: string | null;
  readonly phase: JobHookPhase;
}

export interface JobHookRunInput extends JobHookRunMetadata {
  /** Canonical path returned by JobHookPathAdmission immediately before run. */
  readonly canonicalScriptPath: string;
  readonly signal?: AbortSignal;
}

export interface JobHookResult {
  readonly succeeded: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode: ErrorCode | null;
}

interface HookReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): this;
  on(event: "error", listener: (error: unknown) => void): this;
  off(event: "data", listener: (chunk: Buffer | string) => void): this;
  off(event: "error", listener: (error: unknown) => void): this;
  destroy(): void;
}

export interface JobHookChild {
  readonly pid?: number;
  readonly stdout: HookReadable | null;
  readonly stderr: HookReadable | null;
  once(event: "error", listener: (error: unknown) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
  off(event: "error", listener: (error: unknown) => void): this;
  off(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export type JobHookSpawn = (
  executable: string,
  argv: readonly string[],
  options: SpawnOptions,
) => JobHookChild;

export interface JobHookRunnerOptions {
  readonly config: Pick<JobConfig, "hookTimeoutMs" | "hookMaxOutputBytes">;
  readonly spawn?: JobHookSpawn;
  readonly killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
  readonly environment?: Readonly<{ readonly HOME?: string; readonly LANG?: string }>;
  readonly terminationGraceMs?: number;
}

type TerminationReason = "timeout" | "output-limit" | "abort" | "shutdown" | "execution";

interface ActiveHook {
  readonly terminate: (reason: TerminationReason) => void;
  readonly completion: Promise<JobHookResult>;
}

/** Build the complete hook environment without inheriting arbitrary process state. */
export function buildHookEnvironment(
  run: Readonly<JobHookRunMetadata>,
  essentials: Readonly<{ readonly HOME?: string; readonly LANG?: string }> = process.env,
): NodeJS.ProcessEnv {
  return {
    HOME: essentials.HOME ?? homedir(),
    LANG: essentials.LANG ?? "C.UTF-8",
    PATH: JOB_HOOK_SAFE_PATH,
    CHATWCA_JOB_ID: run.jobId,
    CHATWCA_JOB_NAME: run.jobName,
    CHATWCA_RUN_ID: run.runId,
    CHATWCA_RUN_TRIGGER: run.trigger,
    CHATWCA_SCHEDULED_FOR: new Date(run.scheduledFor).toISOString(),
    CHATWCA_WORKSPACE_ID: run.workspaceId,
    CHATWCA_WORKSPACE: run.workspacePath,
    CHATWCA_CONVERSATION_ID: run.conversationId ?? "",
    CHATWCA_RUN_PHASE: run.phase,
    CHATWCA_RUN_STATUS: run.phase === "post-hook" ? "succeeded" : "running",
  };
}

function phaseFailure(phase: JobHookPhase): ErrorCode {
  return phase === "pre-hook"
    ? ERROR_CODES.JOB_PRE_RUN_FAILED
    : ERROR_CODES.JOB_POST_RUN_FAILED;
}

function reasonCode(reason: TerminationReason, phase: JobHookPhase): ErrorCode {
  switch (reason) {
    case "timeout": return ERROR_CODES.JOB_HOOK_TIMEOUT;
    case "output-limit": return ERROR_CODES.JOB_HOOK_OUTPUT_LIMIT;
    case "abort": return ERROR_CODES.JOB_ABORTED;
    case "shutdown": return ERROR_CODES.JOB_INTERRUPTED;
    case "execution": return phaseFailure(phase);
  }
}

/** Owns all trusted Bash process groups and their bounded diagnostics. */
export class JobHookRunner {
  readonly #timeoutMs: number;
  readonly #maxOutputBytes: number;
  readonly #spawn: JobHookSpawn;
  readonly #killProcessGroup: (pid: number, signal: NodeJS.Signals) => void;
  readonly #environment: Readonly<{ readonly HOME?: string; readonly LANG?: string }>;
  readonly #terminationGraceMs: number;
  readonly #active = new Set<ActiveHook>();
  #closed = false;

  constructor(options: Readonly<JobHookRunnerOptions>) {
    this.#timeoutMs = options.config.hookTimeoutMs;
    this.#maxOutputBytes = options.config.hookMaxOutputBytes;
    this.#spawn = options.spawn ?? ((executable, argv, spawnOptions) =>
      nodeSpawn(executable, argv, spawnOptions) as JobHookChild);
    this.#killProcessGroup = options.killProcessGroup ?? ((pid, signal) => {
      process.kill(-pid, signal);
    });
    const essentials = options.environment ?? process.env;
    this.#environment = Object.freeze({
      ...(essentials.HOME === undefined ? {} : { HOME: essentials.HOME }),
      ...(essentials.LANG === undefined ? {} : { LANG: essentials.LANG }),
    });
    this.#terminationGraceMs = options.terminationGraceMs ?? JOB_HOOK_TERMINATION_GRACE_MS;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0 ||
        !Number.isSafeInteger(this.#maxOutputBytes) || this.#maxOutputBytes <= 0 ||
        !Number.isSafeInteger(this.#terminationGraceMs) || this.#terminationGraceMs <= 0) {
      throw new RangeError("Job hook runner bounds must be positive safe integers");
    }
  }

  get activeCount(): number {
    return this.#active.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  run(input: Readonly<JobHookRunInput>): Promise<JobHookResult> {
    if (this.#closed) return Promise.resolve(this.#emptyFailure(input.phase, "shutdown"));
    if (input.signal?.aborted === true) {
      return Promise.resolve(this.#emptyFailure(input.phase, "abort"));
    }

    let child: JobHookChild;
    try {
      child = this.#spawn(
        JOB_BASH_PATH,
        ["--", input.canonicalScriptPath],
        {
          cwd: input.workspacePath,
          env: buildHookEnvironment(input, this.#environment),
          stdio: ["ignore", "pipe", "pipe"],
          detached: true,
        },
      );
      if (child.pid === undefined || child.stdout === null || child.stderr === null) {
        throw new Error("hook child did not expose its process group and output pipes");
      }
    } catch {
      return Promise.resolve(this.#emptyFailure(input.phase, "execution"));
    }

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let retainedBytes = 0;
    let closeCode: number | null = null;
    let closeSignal: NodeJS.Signals | null = null;
    let terminationReason: TerminationReason | undefined;
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    let escalation: NodeJS.Timeout | undefined;
    let resolveCompletion!: (result: JobHookResult) => void;

    const completion = new Promise<JobHookResult>((resolve) => {
      resolveCompletion = resolve;
    });

    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        this.#killProcessGroup(child.pid!, signal);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? (error as { readonly code?: unknown }).code
          : undefined;
        // ESRCH means the group has already exited. Other failures are private
        // cleanup diagnostics and cannot change the stable public result.
        if (code !== "ESRCH") { /* tolerate cleanup failure */ }
      }
    };

    const cleanup = () => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (escalation !== undefined) clearTimeout(escalation);
      input.signal?.removeEventListener("abort", onAbort);
      child.off("error", onChildError);
      child.off("close", onClose);
      child.stdout?.off("data", onStdout);
      child.stdout?.off("error", onStreamError);
      child.stderr?.off("data", onStderr);
      child.stderr?.off("error", onStreamError);
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    const finish = (result: JobHookResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      this.#active.delete(active);
      resolveCompletion(result);
    };

    const capturedResult = (errorCode: ErrorCode | null): JobHookResult => ({
      succeeded: errorCode === null,
      exitCode: closeCode,
      signal: closeSignal,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      errorCode,
    });

    const terminate = (reason: TerminationReason) => {
      if (settled || terminationReason !== undefined) return;
      terminationReason = reason;
      if (timeout !== undefined) clearTimeout(timeout);
      signalGroup("SIGTERM");
      escalation = setTimeout(() => {
        signalGroup("SIGKILL");
        finish(capturedResult(reasonCode(reason, input.phase)));
      }, this.#terminationGraceMs);
    };

    const capture = (stream: "stdout" | "stderr", value: Buffer | string) => {
      if (settled || terminationReason !== undefined) return;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = this.#maxOutputBytes - retainedBytes;
      if (chunk.byteLength <= remaining) {
        (stream === "stdout" ? stdoutChunks : stderrChunks).push(Buffer.from(chunk));
        retainedBytes += chunk.byteLength;
        return;
      }
      if (remaining > 0) {
        (stream === "stdout" ? stdoutChunks : stderrChunks).push(Buffer.from(chunk.subarray(0, remaining)));
        retainedBytes += remaining;
      }
      terminate("output-limit");
    };

    const onStdout = (chunk: Buffer | string) => capture("stdout", chunk);
    const onStderr = (chunk: Buffer | string) => capture("stderr", chunk);
    const onStreamError = () => terminate("execution");
    const onChildError = () => terminate("execution");
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      closeCode = code;
      closeSignal = signal;
      if (terminationReason !== undefined) return;
      const errorCode = code === 0 && signal === null ? null : phaseFailure(input.phase);
      finish(capturedResult(errorCode));
    };
    const onAbort = () => terminate("abort");

    const active: ActiveHook = { terminate, completion };
    this.#active.add(active);
    child.stdout.on("data", onStdout);
    child.stdout.on("error", onStreamError);
    child.stderr.on("data", onStderr);
    child.stderr.on("error", onStreamError);
    child.once("error", onChildError);
    child.once("close", onClose);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => terminate("timeout"), this.#timeoutMs);

    // Shutdown may have raced spawn and active registration in the same turn.
    if (this.#closed) terminate("shutdown");
    return completion;
  }

  /** Synchronously close admission and begin terminating every active group. */
  beginShutdown(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const active of [...this.#active]) active.terminate("shutdown");
  }

  async dispose(): Promise<void> {
    this.beginShutdown();
    await Promise.allSettled([...this.#active].map((active) => active.completion));
  }

  #emptyFailure(phase: JobHookPhase, reason: TerminationReason): JobHookResult {
    return {
      succeeded: false,
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      errorCode: reasonCode(reason, phase),
    };
  }
}
