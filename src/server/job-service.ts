import type {
  JobRunState,
  JobRunSummary,
  JobSummary,
} from "../shared/jobs.js";
import type {
  CreateJobInput,
  JobRunPage,
  UpdateJobInput,
} from "./job-repository.js";
import type { SessionHistoryWorkspace } from "./session-history.js";

export type JobServiceEvent =
  | { readonly type: "jobs"; readonly jobs: readonly JobSummary[] }
  | { readonly type: "job.run.updated"; readonly run: JobRunSummary };

export type JobServiceListener = (event: JobServiceEvent) => void;

export interface JobServiceRepositoryPort {
  list(): JobSummary[];
  create(input: CreateJobInput): JobSummary;
  get(jobId: string): JobSummary;
  update(jobId: string, input: UpdateJobInput): JobSummary;
  delete(jobId: string): void;
  referencesWorkspace(workspaceId: string): boolean;
  listRuns(jobId: string, options?: { readonly cursor?: string }): JobRunPage;
  getRun(jobId: string, runId: string): JobRunState;
}

export interface JobServiceSchedulerPort {
  runNowAccepted(jobId: string): JobRunState;
  refreshSchedule(): void;
}

export interface JobServiceRunnerPort {
  abort(jobId: string, runId: string): Promise<void>;
}

export interface JobServiceWorkspacePort {
  requireAvailable(workspaceId: string): SessionHistoryWorkspace;
}

export interface JobServiceHistoryPort {
  resolve(workspace: SessionHistoryWorkspace, conversationId: string): Promise<unknown>;
}

export interface JobServiceOptions {
  readonly repository: JobServiceRepositoryPort;
  readonly scheduler: JobServiceSchedulerPort;
  readonly runner: JobServiceRunnerPort;
  readonly workspaces: JobServiceWorkspacePort;
  readonly history?: JobServiceHistoryPort;
  readonly onListenerError?: (error: unknown) => void;
}

/**
 * Narrow protocol facade for process-owned job services. It deliberately
 * accepts only definition data; workspace authority is resolved by the server
 * repository/runner and never supplied by a WebSocket peer.
 */
export class JobService {
  readonly #repository: JobServiceRepositoryPort;
  readonly #scheduler: JobServiceSchedulerPort;
  readonly #runner: JobServiceRunnerPort;
  readonly #workspaces: JobServiceWorkspacePort;
  readonly #history: JobServiceHistoryPort | undefined;
  readonly #onListenerError: (error: unknown) => void;
  readonly #listeners = new Set<JobServiceListener>();

  constructor(options: Readonly<JobServiceOptions>) {
    this.#repository = options.repository;
    this.#scheduler = options.scheduler;
    this.#runner = options.runner;
    this.#workspaces = options.workspaces;
    this.#history = options.history;
    this.#onListenerError = options.onListenerError ?? (() => undefined);
  }

  list(): readonly JobSummary[] {
    return this.#repository.list();
  }

  create(input: CreateJobInput): readonly JobSummary[] {
    this.#workspaces.requireAvailable(input.workspaceId);
    this.#repository.create(input);
    this.#scheduler.refreshSchedule();
    return this.#repository.list();
  }

  update(jobId: string, input: UpdateJobInput): readonly JobSummary[] {
    if (input.workspaceId !== undefined) this.#workspaces.requireAvailable(input.workspaceId);
    this.#repository.update(jobId, input);
    this.#scheduler.refreshSchedule();
    return this.#repository.list();
  }

  delete(jobId: string): readonly JobSummary[] {
    this.#repository.delete(jobId);
    this.#scheduler.refreshSchedule();
    return this.#repository.list();
  }

  referencesWorkspace(workspaceId: string): boolean {
    return this.#repository.referencesWorkspace(workspaceId);
  }

  run(jobId: string): JobRunState {
    return this.#scheduler.runNowAccepted(jobId);
  }

  abort(jobId: string, runId: string): Promise<void> {
    return this.#runner.abort(jobId, runId);
  }

  runs(jobId: string, cursor?: string): JobRunPage {
    return this.#repository.listRuns(jobId, cursor === undefined ? {} : { cursor });
  }

  async runState(jobId: string, runId: string): Promise<JobRunState> {
    const state = this.#repository.getRun(jobId, runId);
    if (state.conversationId === null || state.conversationAvailable || this.#history === undefined) {
      return state;
    }
    // Pi history is consulted only for explicit detail requests, never for
    // scheduler startup, summaries, or broadcasts.
    try {
      const job = this.#repository.get(jobId);
      const workspace = this.#workspaces.requireAvailable(job.workspaceId);
      await this.#history.resolve(workspace, state.conversationId);
      return { ...state, conversationAvailable: true };
    } catch {
      return state;
    }
  }

  subscribe(listener: JobServiceListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Called by the process runner after every persisted visible revision. */
  publishRunUpdated(state: JobRunState): void {
    const run = summaryOnly(state);
    this.#emit({ type: "job.run.updated", run });
  }

  /** Called after a summary-visible run transition. */
  publishJobsChanged(): void {
    try {
      this.#emit({ type: "jobs", jobs: this.#repository.list() });
    } catch (error) {
      this.#onListenerError(error);
    }
  }

  #emit(event: JobServiceEvent): void {
    for (const listener of this.#listeners) {
      try { listener(event); } catch (error) { this.#onListenerError(error); }
    }
  }
}

/** Explicit projection prevents hook diagnostics from reaching broadcasts. */
export function summaryOnly(state: JobRunState): JobRunSummary {
  return {
    id: state.id,
    jobId: state.jobId,
    trigger: state.trigger,
    scheduledFor: state.scheduledFor,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    status: state.status,
    phase: state.phase,
    errorCode: state.errorCode,
    errorMessage: state.errorMessage,
    conversationId: state.conversationId,
    revision: state.revision,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
  };
}
