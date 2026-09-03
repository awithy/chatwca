import { AppError, ERROR_CODES } from "../shared/errors.js";
import type { JobRunState, JobSummary } from "../shared/jobs.js";
import type { ClaimedJobRun } from "./job-repository.js";

/** Kept below Node's signed 32-bit timeout ceiling. */
export const JOB_SCHEDULER_MAX_TIMER_DELAY_MS = 2_147_000_000;

export interface JobSchedulerRepositoryPort {
  markAllInterrupted(at?: number): readonly JobRunState[];
  listEnabled(): readonly JobSummary[];
  listDue(now?: number): readonly JobSummary[];
  claimStartupCatchUp(jobId: string, startupAt?: number): ClaimedJobRun | null;
  claimDue(jobId: string, now?: number): ClaimedJobRun | null;
  claimManual(jobId: string, now?: number): ClaimedJobRun;
}

export interface JobSchedulerRunnerPort {
  dispatch(claim: Readonly<ClaimedJobRun>): Promise<JobRunState>;
}

export interface JobSchedulerTimerPort {
  readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface JobSchedulerOptions {
  readonly repository: JobSchedulerRepositoryPort;
  readonly runner: JobSchedulerRunnerPort;
  readonly clock?: () => number;
  readonly timers?: JobSchedulerTimerPort;
  readonly maxTimerDelayMs?: number;
  readonly onInternalError?: (error: unknown) => void;
}

function safeNow(clock: () => number): number {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Job scheduler clock must return a non-negative safe integer");
  }
  return value;
}

function hasValidPersistedSchedule(job: JobSummary): boolean {
  // Current workspace-policy issues are run-time admission results and must
  // still produce a blocked attempt. Only malformed persisted definitions are
  // omitted from dispatch/timer ownership until repaired.
  return job.enabled && job.nextRunAt !== null &&
    job.configurationIssue?.code !== ERROR_CODES.JOB_INVALID;
}

/**
 * Process-global owner of recurring occurrence admission.
 *
 * SQLite remains authoritative: every wake re-lists due definitions and every
 * claim rechecks/advances the persisted occurrence in its transaction. Runner
 * promises are deliberately not awaited, so one job cannot delay another.
 */
export class JobScheduler {
  readonly #repository: JobSchedulerRepositoryPort;
  readonly #runner: JobSchedulerRunnerPort;
  readonly #clock: () => number;
  readonly #timers: JobSchedulerTimerPort;
  readonly #maxTimerDelayMs: number;
  readonly #onInternalError: (error: unknown) => void;
  #timer: unknown;
  #running = false;
  #closed = false;
  #initialized = false;
  #generation = 0;
  #startPromise: Promise<void> | undefined;

  constructor(options: Readonly<JobSchedulerOptions>) {
    this.#repository = options.repository;
    this.#runner = options.runner;
    this.#clock = options.clock ?? Date.now;
    this.#timers = options.timers ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    };
    this.#maxTimerDelayMs = options.maxTimerDelayMs ?? JOB_SCHEDULER_MAX_TIMER_DELAY_MS;
    this.#onInternalError = options.onInternalError ?? (() => undefined);
    if (
      !Number.isSafeInteger(this.#maxTimerDelayMs) || this.#maxTimerDelayMs <= 0 ||
      this.#maxTimerDelayMs > 2_147_483_647
    ) {
      throw new RangeError("maxTimerDelayMs must fit Node's positive timer range");
    }
  }

  get running(): boolean {
    return this.#running;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Reconcile old attempts and claim at most one startup catch-up per job. */
  start(): Promise<void> {
    if (this.#closed) return Promise.reject(new AppError(ERROR_CODES.SHUTTING_DOWN));
    if (this.#running) return this.#startPromise ?? Promise.resolve();

    this.#running = true;
    const generation = ++this.#generation;
    this.#startPromise = Promise.resolve().then(() => {
      if (!this.#running || this.#closed || generation !== this.#generation) return;
      const startupAt = safeNow(this.#clock);
      if (!this.#initialized) {
        this.#repository.markAllInterrupted(startupAt);
        const enabled = this.#repository.listEnabled();
        for (const job of enabled) {
          if (!hasValidPersistedSchedule(job) || job.nextRunAt! > startupAt) continue;
          try {
            this.#dispatch(this.#repository.claimStartupCatchUp(job.id, startupAt));
          } catch (error) {
            if (!(error instanceof AppError && error.code === ERROR_CODES.JOB_INVALID)) throw error;
            // Persisted invalid definitions remain visible for repair but never dispatch.
          }
        }
        this.#initialized = true;
      } else {
        this.#claimDue(safeNow(this.#clock));
      }
      if (this.#running && !this.#closed && generation === this.#generation) {
        this.#arm();
      }
    }).catch((error: unknown) => {
      if (generation === this.#generation) {
        this.#running = false;
        this.#cancelTimer();
      }
      throw error;
    });
    return this.#startPromise;
  }

  /**
   * Claim a manual attempt without changing recurring state and await its
   * result. Capacity exhaustion is persisted as skipped and surfaced as the
   * same stable error to the caller.
   */
  async runNow(jobId: string): Promise<JobRunState> {
    this.#assertAccepting();
    const claim = this.#repository.claimManual(jobId, safeNow(this.#clock));
    const result = await this.#runner.dispatch(claim);
    if (result.status === "skipped" && result.errorCode === ERROR_CODES.LIVE_RUNTIME_LIMIT) {
      throw new AppError(ERROR_CODES.LIVE_RUNTIME_LIMIT);
    }
    return result;
  }

  /**
   * Protocol admission returns the durable queued attempt immediately. Runner
   * ownership is detached from the requesting socket, so a disconnect cannot
   * cancel execution or withhold the correlated acknowledgement.
   */
  runNowAccepted(jobId: string): JobRunState {
    this.#assertAccepting();
    const claim = this.#repository.claimManual(jobId, safeNow(this.#clock));
    setImmediate(() => this.#dispatch(claim));
    return claim.run;
  }

  /** Permanently close occurrence and manual admission and cancel the timer. */
  beginShutdown(): void {
    if (this.#closed) return;
    this.stop();
    this.#closed = true;
  }

  /** Pause timer/manual admission without repeating startup recovery on restart. */
  stop(): void {
    if (!this.#running) return;
    this.#running = false;
    this.#generation += 1;
    this.#startPromise = undefined;
    this.#cancelTimer();
  }

  dispose(): Promise<void> {
    this.beginShutdown();
    return Promise.resolve();
  }

  #wake(generation: number): void {
    if (!this.#running || this.#closed || generation !== this.#generation) return;
    this.#timer = undefined;
    try {
      this.#claimDue(safeNow(this.#clock));
    } catch (error) {
      this.#onInternalError(error);
    } finally {
      if (this.#running && !this.#closed && generation === this.#generation) {
        try { this.#arm(); } catch (error) { this.#onInternalError(error); }
      }
    }
  }

  #claimDue(now: number): void {
    // This query, rather than the preceding timer target, is authoritative.
    const due = this.#repository.listDue(now);
    for (const job of due) {
      if (!hasValidPersistedSchedule(job) || job.nextRunAt! > now) continue;
      try {
        this.#dispatch(this.#repository.claimDue(job.id, now));
      } catch (error) {
        // One corrupt/racing definition must not prevent independent jobs.
        if (error instanceof AppError && error.code === ERROR_CODES.JOB_INVALID) continue;
        this.#onInternalError(error);
      }
    }
  }

  #dispatch(claim: ClaimedJobRun | null): void {
    if (claim === null) return;
    try {
      void this.#runner.dispatch(claim).catch(this.#onInternalError);
    } catch (error) {
      this.#onInternalError(error);
    }
  }

  #arm(): void {
    this.#cancelTimer();
    // Re-query all enabled rows so invalid persisted definitions cannot pin a
    // zero-delay timer through a raw MIN(next_run_at) query.
    const enabled = this.#repository.listEnabled();
    let nearest: number | null = null;
    for (const job of enabled) {
      if (!hasValidPersistedSchedule(job)) continue;
      if (nearest === null || job.nextRunAt! < nearest) nearest = job.nextRunAt!;
    }
    if (nearest === null) return;

    const now = safeNow(this.#clock);
    const delay = Math.min(this.#maxTimerDelayMs, Math.max(0, nearest - now));
    const generation = this.#generation;
    this.#timer = this.#timers.setTimeout(() => this.#wake(generation), delay);
  }

  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#timers.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #assertAccepting(): void {
    if (this.#closed || !this.#running) throw new AppError(ERROR_CODES.SHUTTING_DOWN);
  }
}
