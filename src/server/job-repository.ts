import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { AppError, ERROR_CODES, toAppError, type ErrorCode } from "../shared/errors.js";
import {
  JOB_IDENTIFIER_MAX_LENGTH,
  JOB_REQUEST_CURSOR_MAX_LENGTH,
  JOB_SCRIPT_PATH_MAX_LENGTH,
  isSafeJobTimestamp,
  isValidJobPrompt,
  normalizeJobName,
  type JobConfigurationIssue,
  type JobRunPhase,
  type JobRunState,
  type JobRunStatus,
  type JobRunSummary,
  type JobRunTrigger,
  type JobSchedule,
  type JobScheduleInput,
  type JobSummary,
} from "../shared/jobs.js";
import type {
  JobHookPathAdmission,
  JobHookWorkspacePolicy,
} from "./job-hook-path.js";
import {
  advanceJobOccurrence,
  establishJobSchedule,
  firstJobOccurrenceAfter,
  normalizeJobSchedule,
} from "./job-schedule.js";

export const JOB_RUN_PAGE_DEFAULT_LIMIT = 50;
export const JOB_RUN_PAGE_MAX_LIMIT = 100;

const ACTIVE_STATUSES = new Set<JobRunStatus>(["queued", "running"]);
const TERMINAL_STATUSES = new Set<JobRunStatus>([
  "succeeded", "failed", "blocked", "skipped", "aborted", "interrupted",
]);
const ERROR_CODE_VALUES = new Set<string>(Object.values(ERROR_CODES));

interface JobRow {
  readonly id: string;
  readonly name: string;
  readonly workspace_id: string;
  readonly workspace_name: string;
  readonly prompt: string;
  readonly schedule_kind: string;
  readonly interval_minutes: number | null;
  readonly anchor_at: number | null;
  readonly daily_time: string | null;
  readonly time_zone: string | null;
  readonly pre_run_script: string | null;
  readonly post_run_script: string | null;
  readonly enabled: number;
  readonly next_run_at: number | null;
  readonly created_at: number;
  readonly updated_at: number;
}

interface RunRow {
  readonly id: string;
  readonly job_id: string;
  readonly conversation_id: string | null;
  readonly trigger: string;
  readonly scheduled_for: number;
  readonly started_at: number | null;
  readonly finished_at: number | null;
  readonly status: string;
  readonly phase: string | null;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly pre_exit_code: number | null;
  readonly pre_stdout: string | null;
  readonly pre_stderr: string | null;
  readonly post_exit_code: number | null;
  readonly post_stdout: string | null;
  readonly post_stderr: string | null;
  readonly revision: number;
  readonly created_at: number;
  readonly updated_at: number;
}

export interface CreateJobInput {
  readonly name: string;
  readonly workspaceId: string;
  readonly prompt: string;
  readonly schedule: JobScheduleInput;
  readonly preRunScript?: string | null;
  readonly postRunScript?: string | null;
  readonly enabled: boolean;
  readonly acknowledgeHostHooks?: true;
}

export interface UpdateJobInput {
  readonly name?: string;
  readonly workspaceId?: string;
  readonly prompt?: string;
  readonly schedule?: JobScheduleInput;
  readonly preRunScript?: string | null;
  readonly postRunScript?: string | null;
  readonly enabled?: boolean;
  readonly acknowledgeHostHooks?: true;
}

export interface JobRepositoryOptions {
  readonly uuid?: () => string;
  readonly clock?: () => number;
  /** Optional current workspace projection used by list/detail responses. */
  readonly workspaceStatus?: (workspaceId: string) => {
    readonly name?: string;
    readonly available: boolean;
  };
  readonly workspaceRepository?: {
    readonly get: (workspaceId: string) => {
      readonly name: string;
      readonly available: boolean;
      readonly path?: string;
      readonly mounts?: readonly { readonly source: string }[];
    };
  };
  /** Canonical hook admission used by trusted create/update callers. */
  readonly hookPathAdmission?: Pick<JobHookPathAdmission, "validateForConfiguration">;
  /** Supplies canonical workspace and mount paths for hook admission. */
  readonly hookWorkspacePolicy?: (workspaceId: string) => Readonly<JobHookWorkspacePolicy>;
  /** Optional Pi-history probe used only by explicit run detail. */
  readonly conversationAvailable?: (conversationId: string) => boolean;
}

export interface ClaimedJobRun {
  readonly job: JobSummary;
  readonly run: JobRunState;
}

export interface JobRunPage {
  readonly runs: readonly JobRunSummary[];
  readonly nextCursor?: string;
}

export interface FinishJobRunInput {
  readonly status: Exclude<JobRunStatus, "queued" | "running">;
  readonly phase?: JobRunPhase | null;
  readonly errorCode?: ErrorCode | null;
  /** Must already be client-safe; omitted messages use the stable default. */
  readonly errorMessage?: string | null;
  readonly finishedAt?: number;
  readonly expectedRevision?: number;
}

export interface HookResultInput {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly expectedRevision?: number;
}

const JOB_COLUMNS = `
  j.id, j.name, j.workspace_id, w.name AS workspace_name, j.prompt,
  j.schedule_kind, j.interval_minutes, j.anchor_at, j.daily_time, j.time_zone,
  j.pre_run_script, j.post_run_script, j.enabled, j.next_run_at,
  j.created_at, j.updated_at
`;
const RUN_COLUMNS = `
  id, job_id, conversation_id, trigger, scheduled_for, started_at, finished_at,
  status, phase, error_code, error_message, pre_exit_code, pre_stdout, pre_stderr,
  post_exit_code, post_stdout, post_stderr, revision, created_at, updated_at
`;

function jobInvalid(cause?: unknown): AppError {
  return new AppError(ERROR_CODES.JOB_INVALID, cause === undefined ? {} : { cause });
}

function requireTimestamp(value: unknown): asserts value is number {
  if (!isSafeJobTimestamp(value)) throw jobInvalid();
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= JOB_IDENTIFIER_MAX_LENGTH;
}

function validHook(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string" && value.length > 0 && value.length <= JOB_SCRIPT_PATH_MAX_LENGTH
  );
}

function stableIssue(code: ErrorCode): JobConfigurationIssue {
  const error = new AppError(code);
  return { code, message: error.message };
}

function compareJobs(left: JobSummary, right: JobSummary): number {
  const byName = left.name.localeCompare(right.name, "en", { sensitivity: "base" });
  return byName !== 0 ? byName : left.id.localeCompare(right.id);
}

function own(input: object, key: keyof UpdateJobInput): boolean {
  return Object.prototype.hasOwnProperty.call(input, key);
}

function encodeCursor(run: JobRunSummary): string {
  return Buffer.from(JSON.stringify({ scheduledFor: run.scheduledFor, id: run.id }), "utf8")
    .toString("base64url");
}

function decodeCursor(cursor: string): { readonly scheduledFor: number; readonly id: string } {
  try {
    if (
      typeof cursor !== "string" || cursor.length === 0 ||
      cursor.length > JOB_REQUEST_CURSOR_MAX_LENGTH
    ) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error();
    const keys = Object.keys(parsed);
    const candidate = parsed as { readonly scheduledFor?: unknown; readonly id?: unknown };
    if (
      keys.length !== 2 || !keys.includes("scheduledFor") || !keys.includes("id") ||
      !isSafeJobTimestamp(candidate.scheduledFor) || !validIdentifier(candidate.id)
    ) {
      throw new Error();
    }
    return { scheduledFor: candidate.scheduledFor, id: candidate.id };
  } catch (error) {
    throw jobInvalid(error);
  }
}

/** SQLite-backed canonical store for scheduled job definitions and run metadata. */
export class JobRepository {
  readonly #connection: Database.Database;
  readonly #uuid: () => string;
  readonly #clock: () => number;
  readonly #workspaceStatus: JobRepositoryOptions["workspaceStatus"];
  readonly #conversationAvailable: JobRepositoryOptions["conversationAvailable"];
  readonly #hookPathAdmission: JobRepositoryOptions["hookPathAdmission"];
  readonly #hookWorkspacePolicy: JobRepositoryOptions["hookWorkspacePolicy"];
  readonly #statements: {
    readonly listJobs: Database.Statement<[], JobRow>;
    readonly getJob: Database.Statement<[string], JobRow>;
    readonly workspaceExists: Database.Statement<[string], { readonly found: number }>;
    readonly insertJob: Database.Statement<unknown[]>;
    readonly updateJob: Database.Statement<unknown[]>;
    readonly deleteJob: Database.Statement<[string]>;
    readonly activeRun: Database.Statement<[string], RunRow>;
    readonly lastRun: Database.Statement<[string], RunRow>;
    readonly getRun: Database.Statement<[string, string], RunRow>;
    readonly getRunById: Database.Statement<[string], RunRow>;
    readonly insertRun: Database.Statement<unknown[]>;
    readonly listRuns: Database.Statement<[string, number], RunRow>;
    readonly listRunsAfter: Database.Statement<[string, number, number, string, number], RunRow>;
    readonly referencingWorkspace: Database.Statement<[string], { readonly found: number }>;
    readonly dueJobs: Database.Statement<[number], JobRow>;
    readonly enabledJobs: Database.Statement<[], JobRow>;
    readonly nextDue: Database.Statement<[], { readonly next_run_at: number }>;
    readonly advanceDue: Database.Statement<[number, number, string, number]>;
    readonly finishSkippedClaim: Database.Statement<[number, string]>;
    readonly startRun: Database.Statement<[JobRunPhase | null, number, number, string, number]>;
    readonly setRunPhase: Database.Statement<[JobRunPhase, number, string, number]>;
    readonly attachConversation: Database.Statement<[string, number, string, number]>;
    readonly recordPreHook: Database.Statement<[number | null, string, string, number, string, JobRunPhase, number]>;
    readonly recordPostHook: Database.Statement<[number | null, string, string, number, string, JobRunPhase, number]>;
    readonly finishRun: Database.Statement<[JobRunStatus, JobRunPhase | null, ErrorCode | null, string | null, number, number, string, number]>;
    readonly allActiveRuns: Database.Statement<[], RunRow>;
    readonly interruptRun: Database.Statement<[ErrorCode, string, number, number, string, number]>;
    readonly disableJob: Database.Statement<[number, string]>;
  };

  constructor(connection: Database.Database, options: JobRepositoryOptions = {}) {
    this.#connection = connection;
    this.#uuid = options.uuid ?? randomUUID;
    this.#clock = options.clock ?? Date.now;
    this.#workspaceStatus = options.workspaceStatus ??
      (options.workspaceRepository === undefined
        ? undefined
        : (workspaceId) => options.workspaceRepository!.get(workspaceId));
    this.#conversationAvailable = options.conversationAvailable;
    this.#hookPathAdmission = options.hookPathAdmission;
    this.#hookWorkspacePolicy = options.hookWorkspacePolicy ??
      (options.hookPathAdmission === undefined || options.workspaceRepository === undefined
        ? undefined
        : (workspaceId) => {
            const workspace = options.workspaceRepository!.get(workspaceId);
            if (workspace.path === undefined) throw jobInvalid();
            return { cwd: workspace.path, mounts: workspace.mounts ?? [] };
          });
    if ((this.#hookPathAdmission === undefined) !== (this.#hookWorkspacePolicy === undefined)) {
      throw new TypeError("Hook path admission and workspace policy must be configured together");
    }
    try {
      this.#statements = {
        listJobs: connection.prepare<[], JobRow>(
          `SELECT ${JOB_COLUMNS} FROM jobs j JOIN workspaces w ON w.id = j.workspace_id`,
        ),
        getJob: connection.prepare<[string], JobRow>(
          `SELECT ${JOB_COLUMNS} FROM jobs j JOIN workspaces w ON w.id = j.workspace_id WHERE j.id = ?`,
        ),
        workspaceExists: connection.prepare<[string], { readonly found: number }>(
          "SELECT 1 AS found FROM workspaces WHERE id = ?",
        ),
        insertJob: connection.prepare(`
          INSERT INTO jobs (
            id, name, workspace_id, prompt, schedule_kind, interval_minutes,
            anchor_at, daily_time, time_zone, pre_run_script, post_run_script,
            enabled, next_run_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `),
        updateJob: connection.prepare(`
          UPDATE jobs SET name = ?, workspace_id = ?, prompt = ?, schedule_kind = ?,
            interval_minutes = ?, anchor_at = ?, daily_time = ?, time_zone = ?,
            pre_run_script = ?, post_run_script = ?, enabled = ?, next_run_at = ?,
            updated_at = ? WHERE id = ?
        `),
        deleteJob: connection.prepare<[string]>("DELETE FROM jobs WHERE id = ?"),
        activeRun: connection.prepare<[string], RunRow>(
          `SELECT ${RUN_COLUMNS} FROM job_runs WHERE job_id = ? AND status IN ('queued', 'running') LIMIT 1`,
        ),
        lastRun: connection.prepare<[string], RunRow>(
          `SELECT ${RUN_COLUMNS} FROM job_runs WHERE job_id = ? AND status NOT IN ('queued', 'running') ORDER BY scheduled_for DESC, id DESC LIMIT 1`,
        ),
        getRun: connection.prepare<[string, string], RunRow>(
          `SELECT ${RUN_COLUMNS} FROM job_runs WHERE job_id = ? AND id = ?`,
        ),
        getRunById: connection.prepare<[string], RunRow>(
          `SELECT ${RUN_COLUMNS} FROM job_runs WHERE id = ?`,
        ),
        insertRun: connection.prepare(`
          INSERT INTO job_runs (
            id, job_id, trigger, scheduled_for, status, phase, error_code,
            error_message, revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `),
        listRuns: connection.prepare<[string, number], RunRow>(
          `SELECT ${RUN_COLUMNS} FROM job_runs WHERE job_id = ? ORDER BY scheduled_for DESC, id DESC LIMIT ?`,
        ),
        listRunsAfter: connection.prepare<[string, number, number, string, number], RunRow>(
          `SELECT ${RUN_COLUMNS} FROM job_runs WHERE job_id = ? AND (scheduled_for < ? OR (scheduled_for = ? AND id < ?)) ORDER BY scheduled_for DESC, id DESC LIMIT ?`,
        ),
        referencingWorkspace: connection.prepare<[string], { readonly found: number }>(
          "SELECT 1 AS found FROM jobs WHERE workspace_id = ? LIMIT 1",
        ),
        dueJobs: connection.prepare<[number], JobRow>(
          `SELECT ${JOB_COLUMNS} FROM jobs j JOIN workspaces w ON w.id = j.workspace_id WHERE j.enabled = 1 AND j.next_run_at <= ? ORDER BY j.next_run_at, j.id`,
        ),
        enabledJobs: connection.prepare<[], JobRow>(
          `SELECT ${JOB_COLUMNS} FROM jobs j JOIN workspaces w ON w.id = j.workspace_id WHERE j.enabled = 1 ORDER BY j.next_run_at, j.id`,
        ),
        nextDue: connection.prepare<[], { readonly next_run_at: number }>(
          "SELECT next_run_at FROM jobs WHERE enabled = 1 ORDER BY next_run_at LIMIT 1",
        ),
        advanceDue: connection.prepare<[number, number, string, number]>(
          "UPDATE jobs SET next_run_at = ?, updated_at = ? WHERE id = ? AND enabled = 1 AND next_run_at = ?",
        ),
        finishSkippedClaim: connection.prepare<[number, string]>(
          "UPDATE job_runs SET finished_at = ? WHERE id = ?",
        ),
        startRun: connection.prepare<[JobRunPhase | null, number, number, string, number]>(`
          UPDATE job_runs SET status = 'running', phase = ?, started_at = ?,
            revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'queued' AND revision = ?
        `),
        setRunPhase: connection.prepare<[JobRunPhase, number, string, number]>(`
          UPDATE job_runs SET phase = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'running' AND revision = ?
        `),
        attachConversation: connection.prepare<[string, number, string, number]>(`
          UPDATE job_runs SET conversation_id = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'running' AND revision = ? AND conversation_id IS NULL
        `),
        recordPreHook: connection.prepare<[number | null, string, string, number, string, JobRunPhase, number]>(`
          UPDATE job_runs SET pre_exit_code = ?, pre_stdout = ?, pre_stderr = ?,
            revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'running' AND phase = ? AND revision = ?
        `),
        recordPostHook: connection.prepare<[number | null, string, string, number, string, JobRunPhase, number]>(`
          UPDATE job_runs SET post_exit_code = ?, post_stdout = ?, post_stderr = ?,
            revision = revision + 1, updated_at = ?
          WHERE id = ? AND status = 'running' AND phase = ? AND revision = ?
        `),
        finishRun: connection.prepare<[JobRunStatus, JobRunPhase | null, ErrorCode | null, string | null, number, number, string, number]>(`
          UPDATE job_runs SET status = ?, phase = ?, error_code = ?, error_message = ?,
            finished_at = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running') AND revision = ?
        `),
        allActiveRuns: connection.prepare<[], RunRow>(
          `SELECT ${RUN_COLUMNS} FROM job_runs WHERE status IN ('queued', 'running') ORDER BY created_at, id`,
        ),
        interruptRun: connection.prepare<[ErrorCode, string, number, number, string, number]>(`
          UPDATE job_runs SET status = 'interrupted', error_code = ?, error_message = ?,
            finished_at = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND status IN ('queued', 'running') AND revision = ?
        `),
        disableJob: connection.prepare<[number, string]>(
          "UPDATE jobs SET enabled = 0, next_run_at = NULL, updated_at = ? WHERE id = ?",
        ),
      };
    } catch (error) {
      throw toAppError(error, { source: "database" });
    }
  }

  list(): JobSummary[] {
    return this.#database(() => this.#statements.listJobs.all()
      .map((row) => this.#summary(row))
      .sort(compareJobs));
  }

  listDefinitions(): JobSummary[] {
    return this.list();
  }

  get(jobId: string): JobSummary {
    return this.#database(() => this.#summary(this.#requireJobRow(jobId)));
  }

  getDefinition(jobId: string): JobSummary {
    return this.get(jobId);
  }

  create(input: CreateJobInput): JobSummary {
    const now = this.#now();
    const name = this.#name(input.name);
    const workspaceId = this.#workspaceId(input.workspaceId);
    const prompt = this.#prompt(input.prompt);
    const preRunScript = this.#hook(input.preRunScript ?? null, workspaceId);
    const postRunScript = this.#hook(input.postRunScript ?? null, workspaceId);
    if (typeof input.enabled !== "boolean") throw jobInvalid();
    this.#validateHookAcknowledgement(
      preRunScript !== null || postRunScript !== null,
      input.acknowledgeHostHooks,
    );
    const schedule = establishJobSchedule(input.schedule, now);
    const nextRunAt = input.enabled ? firstJobOccurrenceAfter(schedule, now) : null;
    const id = this.#newId();

    this.#database(() => {
      if (this.#statements.workspaceExists.get(workspaceId) === undefined) throw jobInvalid();
      this.#statements.insertJob.run(
        id, name, workspaceId, prompt, schedule.kind,
        schedule.kind === "interval" ? schedule.intervalMinutes : null,
        schedule.kind === "interval" ? schedule.anchorAt : null,
        schedule.kind === "daily" ? schedule.localTime : null,
        schedule.kind === "daily" ? schedule.timeZone : null,
        preRunScript, postRunScript, input.enabled ? 1 : 0, nextRunAt, now, now,
      );
    });
    return this.get(id);
  }

  update(jobId: string, changes: UpdateJobInput): JobSummary {
    const keys: readonly (keyof UpdateJobInput)[] = [
      "name", "workspaceId", "prompt", "schedule", "preRunScript", "postRunScript", "enabled",
    ];
    if (!keys.some((key) => own(changes, key))) throw jobInvalid();
    const now = this.#now();
    return this.#database(() => this.#connection.transaction(() => {
      const current = this.#requireJobRow(jobId);
      const active = this.#statements.activeRun.get(jobId) !== undefined;
      const changedKeys = keys.filter((key) => own(changes, key));
      const activeDisable =
        active && changedKeys.length === 1 && changedKeys[0] === "enabled" && changes.enabled === false;
      if (active && !activeDisable) throw new AppError(ERROR_CODES.JOB_BUSY);
      if (activeDisable) {
        if (changes.acknowledgeHostHooks === true) throw jobInvalid();
        this.#statements.disableJob.run(now, jobId);
        return this.#summary(this.#requireJobRow(jobId));
      }

      const currentValidation = this.#validatedSchedule(current);
      if (currentValidation.issue !== null) {
        const complete =
          changes.name !== undefined && changes.workspaceId !== undefined &&
          changes.prompt !== undefined && changes.schedule !== undefined &&
          own(changes, "preRunScript") && own(changes, "postRunScript") &&
          changes.enabled !== undefined;
        if (!complete) throw jobInvalid();
      }

      const name = changes.name === undefined ? this.#name(current.name) : this.#name(changes.name);
      const workspaceId = changes.workspaceId === undefined
        ? this.#workspaceId(current.workspace_id)
        : this.#workspaceId(changes.workspaceId);
      const prompt = changes.prompt === undefined ? this.#prompt(current.prompt) : this.#prompt(changes.prompt);
      const preRunScript = changes.preRunScript === undefined
        ? this.#hook(current.pre_run_script, workspaceId)
        : this.#hook(changes.preRunScript, workspaceId);
      const postRunScript = changes.postRunScript === undefined
        ? this.#hook(current.post_run_script, workspaceId)
        : this.#hook(changes.postRunScript, workspaceId);
      const enabled = changes.enabled === undefined ? current.enabled === 1 : changes.enabled;
      if (typeof enabled !== "boolean") throw jobInvalid();

      const hookAuthorityChanged =
        (changes.preRunScript !== undefined && preRunScript !== current.pre_run_script) ||
        (changes.postRunScript !== undefined && postRunScript !== current.post_run_script) ||
        (changes.workspaceId !== undefined && workspaceId !== current.workspace_id &&
          (preRunScript !== null || postRunScript !== null));
      this.#validateHookAcknowledgement(hookAuthorityChanged, changes.acknowledgeHostHooks);
      if (this.#statements.workspaceExists.get(workspaceId) === undefined) throw jobInvalid();

      let schedule: JobSchedule;
      let nextRunAt: number | null;
      if (changes.schedule !== undefined) {
        schedule = establishJobSchedule(changes.schedule, now);
        nextRunAt = enabled ? firstJobOccurrenceAfter(schedule, now) : null;
      } else {
        if (currentValidation.schedule === null) throw jobInvalid();
        schedule = currentValidation.schedule;
        if (!enabled) nextRunAt = null;
        else if (current.enabled !== 1) nextRunAt = firstJobOccurrenceAfter(schedule, now);
        else nextRunAt = current.next_run_at;
      }
      if (enabled && nextRunAt === null) throw jobInvalid();

      const result = this.#statements.updateJob.run(
        name, workspaceId, prompt, schedule.kind,
        schedule.kind === "interval" ? schedule.intervalMinutes : null,
        schedule.kind === "interval" ? schedule.anchorAt : null,
        schedule.kind === "daily" ? schedule.localTime : null,
        schedule.kind === "daily" ? schedule.timeZone : null,
        preRunScript, postRunScript, enabled ? 1 : 0, nextRunAt, now, jobId,
      );
      if (result.changes !== 1) throw new AppError(ERROR_CODES.JOB_NOT_FOUND);
      return this.#summary(this.#requireJobRow(jobId));
    })());
  }

  enable(jobId: string): JobSummary {
    return this.update(jobId, { enabled: true });
  }

  disable(jobId: string): JobSummary {
    return this.update(jobId, { enabled: false });
  }

  delete(jobId: string): void {
    this.#database(() => this.#connection.transaction(() => {
      this.#requireJobRow(jobId);
      if (this.#statements.activeRun.get(jobId) !== undefined) {
        throw new AppError(ERROR_CODES.JOB_BUSY);
      }
      const result = this.#statements.deleteJob.run(jobId);
      if (result.changes !== 1) throw new AppError(ERROR_CODES.JOB_NOT_FOUND);
    })());
  }

  referencesWorkspace(workspaceId: string): boolean {
    return this.#database(() => this.#statements.referencingWorkspace.get(workspaceId) !== undefined);
  }

  hasWorkspaceReferences(workspaceId: string): boolean {
    return this.referencesWorkspace(workspaceId);
  }

  listEnabled(): JobSummary[] {
    return this.#database(() => this.#statements.enabledJobs.all().map((row) => this.#summary(row)));
  }

  listDue(now: number = this.#now()): JobSummary[] {
    requireTimestamp(now);
    return this.#database(() => this.#statements.dueJobs.all(now).map((row) => this.#summary(row)));
  }

  nextDueAt(): number | null {
    return this.#database(() => this.#statements.nextDue.get()?.next_run_at ?? null);
  }

  claimManual(jobId: string, now: number = this.#now()): ClaimedJobRun {
    requireTimestamp(now);
    return this.#database(() => this.#connection.transaction(() => {
      const row = this.#requireRunnableJob(jobId);
      if (row.enabled !== 1) throw new AppError(ERROR_CODES.JOB_DISABLED);
      if (this.#statements.activeRun.get(jobId) !== undefined) {
        throw new AppError(ERROR_CODES.JOB_ALREADY_RUNNING);
      }
      return this.#insertClaim(row, "manual", now, "queued", null, null, now);
    })());
  }

  claimDue(jobId: string, now: number = this.#now()): ClaimedJobRun | null {
    return this.#claimScheduled(jobId, now, "scheduled");
  }

  claimStartupCatchUp(jobId: string, startupAt: number = this.#now()): ClaimedJobRun | null {
    return this.#claimScheduled(jobId, startupAt, "catch-up");
  }

  claimManualRun(jobId: string, now: number = this.#now()): ClaimedJobRun {
    return this.claimManual(jobId, now);
  }

  claimDueRun(jobId: string, now: number = this.#now()): ClaimedJobRun | null {
    return this.claimDue(jobId, now);
  }

  claimCatchUpRun(jobId: string, startupAt: number = this.#now()): ClaimedJobRun | null {
    return this.claimStartupCatchUp(jobId, startupAt);
  }

  #claimScheduled(jobId: string, now: number, trigger: "scheduled" | "catch-up"): ClaimedJobRun | null {
    requireTimestamp(now);
    return this.#database(() => this.#connection.transaction(() => {
      const row = this.#requireRunnableJob(jobId);
      if (row.enabled !== 1 || row.next_run_at === null || row.next_run_at > now) return null;
      const scheduledFor = row.next_run_at;
      const schedule = this.#validatedSchedule(row).schedule;
      if (schedule === null) throw jobInvalid();
      const following = advanceJobOccurrence(schedule, scheduledFor, now);
      const update = this.#statements.advanceDue.run(following, now, jobId, scheduledFor);
      if (update.changes !== 1) return null;

      if (this.#statements.activeRun.get(jobId) !== undefined) {
        const error = new AppError(ERROR_CODES.JOB_ALREADY_RUNNING);
        return this.#insertClaim(
          row, trigger, scheduledFor, "skipped", ERROR_CODES.JOB_ALREADY_RUNNING,
          error.message, now,
        );
      }
      return this.#insertClaim(row, trigger, scheduledFor, "queued", null, null, now);
    })());
  }

  startRun(
    jobId: string,
    runId: string,
    phase: JobRunPhase | null = null,
    startedAt: number = this.#now(),
    expectedRevision?: number,
  ): JobRunState {
    requireTimestamp(startedAt);
    this.#phase(phase);
    return this.#mutateRun(jobId, runId, ["queued"], expectedRevision, (row) => {
      return this.#statements.startRun.run(
        phase, startedAt, startedAt, runId, row.revision,
      ).changes;
    });
  }

  setRunPhase(
    jobId: string,
    runId: string,
    phase: JobRunPhase,
    expectedRevision?: number,
  ): JobRunState {
    this.#phase(phase);
    const now = this.#now();
    return this.#mutateRun(jobId, runId, ["running"], expectedRevision, (row) =>
      this.#statements.setRunPhase.run(phase, now, runId, row.revision).changes
    );
  }

  attachConversation(
    jobId: string,
    runId: string,
    conversationId: string,
    expectedRevision?: number,
  ): JobRunState {
    if (!validIdentifier(conversationId)) throw jobInvalid();
    const now = this.#now();
    return this.#mutateRun(jobId, runId, ["running"], expectedRevision, (row) => {
      if (row.conversation_id !== null) throw new AppError(ERROR_CODES.JOB_BUSY);
      return this.#statements.attachConversation.run(
        conversationId, now, runId, row.revision,
      ).changes;
    });
  }

  recordHookResult(
    jobId: string,
    runId: string,
    hook: "pre" | "post",
    result: HookResultInput,
  ): JobRunState {
    if (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) throw jobInvalid();
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string") throw jobInvalid();
    const phase: JobRunPhase = hook === "pre" ? "pre-hook" : "post-hook";
    const now = this.#now();
    return this.#mutateRun(jobId, runId, ["running"], result.expectedRevision, (row) => {
      if (row.phase !== phase) throw new AppError(ERROR_CODES.JOB_BUSY);
      const statement = hook === "pre"
        ? this.#statements.recordPreHook
        : this.#statements.recordPostHook;
      return statement.run(
        result.exitCode, result.stdout, result.stderr, now, runId, phase, row.revision,
      ).changes;
    });
  }

  finishRun(jobId: string, runId: string, input: FinishJobRunInput): JobRunState {
    if (!TERMINAL_STATUSES.has(input.status)) throw jobInvalid();
    this.#phase(input.phase ?? null);
    const finishedAt = input.finishedAt ?? this.#now();
    requireTimestamp(finishedAt);
    if (input.errorCode !== undefined && input.errorCode !== null && !ERROR_CODE_VALUES.has(input.errorCode)) {
      throw jobInvalid();
    }
    if (input.errorMessage !== undefined && input.errorMessage !== null && input.errorMessage.length === 0) {
      throw jobInvalid();
    }
    const errorCode = input.errorCode ?? null;
    const errorMessage = input.errorMessage === undefined
      ? (errorCode === null ? null : new AppError(errorCode).message)
      : input.errorMessage;
    if (input.status === "succeeded" && (errorCode !== null || errorMessage !== null)) throw jobInvalid();
    if (input.status !== "succeeded" && errorCode === null) throw jobInvalid();
    const expectedStatuses: readonly JobRunStatus[] = input.status === "interrupted"
      ? ["queued", "running"]
      : input.status === "skipped"
        ? ["queued"]
        : ["running"];
    return this.#mutateRun(jobId, runId, expectedStatuses, input.expectedRevision, (row) =>
      this.#statements.finishRun.run(
        input.status, input.phase ?? (row.phase as JobRunPhase | null), errorCode,
        errorMessage, finishedAt, finishedAt, runId, row.revision,
      ).changes
    );
  }

  markAllInterrupted(at: number = this.#now()): JobRunState[] {
    requireTimestamp(at);
    return this.#database(() => this.#connection.transaction(() => {
      const active = this.#statements.allActiveRuns.all();
      const error = new AppError(ERROR_CODES.JOB_INTERRUPTED);
      const states: JobRunState[] = [];
      for (const row of active) {
        if (this.#statements.interruptRun.run(
          ERROR_CODES.JOB_INTERRUPTED, error.message, at, at, row.id, row.revision,
        ).changes === 1) {
          const updated = this.#statements.getRunById.get(row.id);
          if (updated !== undefined) states.push(this.#runState(updated));
        }
      }
      return states;
    })());
  }

  interruptActiveRuns(at: number = this.#now()): JobRunState[] {
    return this.markAllInterrupted(at);
  }

  recoverInterruptedRuns(at: number = this.#now()): JobRunState[] {
    return this.markAllInterrupted(at);
  }

  listRuns(
    jobId: string,
    options: { readonly cursor?: string; readonly limit?: number } = {},
  ): JobRunPage {
    const limit = options.limit ?? JOB_RUN_PAGE_DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > JOB_RUN_PAGE_MAX_LIMIT) throw jobInvalid();
    return this.#database(() => {
      this.#requireJobRow(jobId);
      const rows = options.cursor === undefined
        ? this.#statements.listRuns.all(jobId, limit + 1)
        : (() => {
            const cursor = decodeCursor(options.cursor);
            return this.#statements.listRunsAfter.all(
              jobId, cursor.scheduledFor, cursor.scheduledFor, cursor.id, limit + 1,
            );
          })();
      const hasMore = rows.length > limit;
      const runs = rows.slice(0, limit).map((row) => this.#runSummary(row));
      const last = runs.at(-1);
      return hasMore && last !== undefined
        ? { runs, nextCursor: encodeCursor(last) }
        : { runs };
    });
  }

  getRun(jobId: string, runId: string): JobRunState {
    return this.#database(() => {
      this.#requireJobRow(jobId);
      const row = this.#statements.getRun.get(jobId, runId);
      if (row === undefined) throw new AppError(ERROR_CODES.JOB_NOT_FOUND);
      return this.#runState(row);
    });
  }

  getRunDetail(jobId: string, runId: string): JobRunState {
    return this.getRun(jobId, runId);
  }

  #insertClaim(
    row: JobRow,
    trigger: JobRunTrigger,
    scheduledFor: number,
    status: "queued" | "skipped",
    errorCode: ErrorCode | null,
    errorMessage: string | null,
    now: number,
  ): ClaimedJobRun {
    const runId = this.#newId();
    const finishedAt = status === "skipped" ? now : null;
    // finished_at is assigned separately because the compact prepared insert is
    // shared by queued and overlap claims.
    this.#statements.insertRun.run(
      runId, row.id, trigger, scheduledFor, status, null, errorCode, errorMessage, now, now,
    );
    if (finishedAt !== null) {
      this.#statements.finishSkippedClaim.run(finishedAt, runId);
    }
    const updatedJob = this.#requireJobRow(row.id);
    const run = this.#statements.getRunById.get(runId);
    if (run === undefined) throw new Error("Inserted job run disappeared");
    return { job: this.#summary(updatedJob), run: this.#runState(run) };
  }

  #mutateRun(
    jobId: string,
    runId: string,
    expectedStatuses: readonly JobRunStatus[],
    expectedRevision: number | undefined,
    update: (row: RunRow) => number,
  ): JobRunState {
    return this.#database(() => this.#connection.transaction(() => {
      const row = this.#statements.getRun.get(jobId, runId);
      if (row === undefined) throw new AppError(ERROR_CODES.JOB_NOT_FOUND);
      if (!expectedStatuses.includes(row.status as JobRunStatus)) {
        throw new AppError(ERROR_CODES.JOB_BUSY);
      }
      if (expectedRevision !== undefined && row.revision !== expectedRevision) {
        throw new AppError(ERROR_CODES.JOB_BUSY);
      }
      if (update(row) !== 1) throw new AppError(ERROR_CODES.JOB_BUSY);
      const changed = this.#statements.getRun.get(jobId, runId);
      if (changed === undefined) throw new Error("Updated job run disappeared");
      return this.#runState(changed);
    })());
  }

  #summary(row: JobRow): JobSummary {
    const validated = this.#validatedSchedule(row);
    // Database CHECKs guarantee shape. This fallback only keeps a corrupted
    // unsupported-zone row inspectable and repairable.
    const schedule = validated.schedule ?? this.#rawSchedule(row);
    const active = this.#statements.activeRun.get(row.id);
    const last = this.#statements.lastRun.get(row.id);
    let workspaceName = row.workspace_name;
    let workspaceAvailable = true;
    let issue = validated.issue;
    if (this.#workspaceStatus !== undefined) {
      try {
        const status = this.#workspaceStatus(row.workspace_id);
        workspaceName = status.name ?? workspaceName;
        workspaceAvailable = status.available;
        if (!status.available && issue === null) issue = stableIssue(ERROR_CODES.WORKSPACE_UNAVAILABLE);
      } catch {
        workspaceAvailable = false;
        if (issue === null) issue = stableIssue(ERROR_CODES.WORKSPACE_UNAVAILABLE);
      }
    }
    return {
      id: row.id,
      name: row.name.trim(),
      workspaceId: row.workspace_id,
      workspaceName,
      workspaceAvailable,
      prompt: row.prompt,
      schedule,
      preRunScript: row.pre_run_script,
      postRunScript: row.post_run_script,
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      activeRun: active === undefined ? null : this.#runSummary(active),
      lastRun: last === undefined ? null : this.#runSummary(last),
      configurationIssue: issue,
    };
  }

  #validatedSchedule(row: JobRow): { readonly schedule: JobSchedule | null; readonly issue: JobConfigurationIssue } {
    try {
      const schedule = normalizeJobSchedule(this.#rawSchedule(row));
      if (
        !validIdentifier(row.id) || !validIdentifier(row.workspace_id) ||
        normalizeJobName(row.name) === undefined || !isValidJobPrompt(row.prompt) ||
        !validHook(row.pre_run_script) || !validHook(row.post_run_script) ||
        (row.enabled !== 0 && row.enabled !== 1) ||
        (row.enabled === 1 ? !isSafeJobTimestamp(row.next_run_at) : row.next_run_at !== null) ||
        !isSafeJobTimestamp(row.created_at) || !isSafeJobTimestamp(row.updated_at)
      ) {
        throw jobInvalid();
      }
      return { schedule, issue: null };
    } catch {
      return { schedule: null, issue: stableIssue(ERROR_CODES.JOB_INVALID) };
    }
  }

  #rawSchedule(row: JobRow): JobSchedule {
    if (row.schedule_kind === "interval") {
      return {
        kind: "interval",
        intervalMinutes: row.interval_minutes as number,
        anchorAt: row.anchor_at as number,
      };
    }
    return {
      kind: "daily",
      localTime: row.daily_time as string,
      timeZone: row.time_zone as string,
    };
  }

  #runSummary(row: RunRow): JobRunSummary {
    if (
      !validIdentifier(row.id) || !validIdentifier(row.job_id) ||
      (row.conversation_id !== null && !validIdentifier(row.conversation_id)) ||
      !isSafeJobTimestamp(row.scheduled_for) ||
      (row.started_at !== null && !isSafeJobTimestamp(row.started_at)) ||
      (row.finished_at !== null && !isSafeJobTimestamp(row.finished_at)) ||
      !ACTIVE_STATUSES.has(row.status as JobRunStatus) && !TERMINAL_STATUSES.has(row.status as JobRunStatus) ||
      !["scheduled", "manual", "catch-up"].includes(row.trigger) ||
      (row.phase !== null && !["pre-hook", "prompt", "post-hook"].includes(row.phase)) ||
      (row.error_code !== null && !ERROR_CODE_VALUES.has(row.error_code)) ||
      !isSafeJobTimestamp(row.revision) || !isSafeJobTimestamp(row.created_at) ||
      !isSafeJobTimestamp(row.updated_at)
    ) {
      throw new AppError(ERROR_CODES.DATABASE_ERROR);
    }
    return {
      id: row.id,
      jobId: row.job_id,
      trigger: row.trigger as JobRunTrigger,
      scheduledFor: row.scheduled_for,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      status: row.status as JobRunStatus,
      phase: row.phase as JobRunPhase | null,
      errorCode: row.error_code as ErrorCode | null,
      errorMessage: row.error_message,
      conversationId: row.conversation_id,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  #runState(row: RunRow): JobRunState {
    const summary = this.#runSummary(row);
    let conversationAvailable = false;
    if (row.conversation_id !== null) {
      try {
        conversationAvailable = this.#conversationAvailable?.(row.conversation_id) ?? false;
      } catch {
        conversationAvailable = false;
      }
    }
    return {
      ...summary,
      preExitCode: row.pre_exit_code,
      preStdout: row.pre_stdout,
      preStderr: row.pre_stderr,
      postExitCode: row.post_exit_code,
      postStdout: row.post_stdout,
      postStderr: row.post_stderr,
      conversationAvailable,
    };
  }

  #requireJobRow(jobId: string): JobRow {
    if (!validIdentifier(jobId)) throw new AppError(ERROR_CODES.JOB_NOT_FOUND);
    const row = this.#statements.getJob.get(jobId);
    if (row === undefined) throw new AppError(ERROR_CODES.JOB_NOT_FOUND);
    return row;
  }

  #requireRunnableJob(jobId: string): JobRow {
    const row = this.#requireJobRow(jobId);
    if (this.#validatedSchedule(row).issue !== null) throw jobInvalid();
    return row;
  }

  #name(value: unknown): string {
    if (typeof value !== "string") throw jobInvalid();
    const normalized = normalizeJobName(value);
    if (normalized === undefined) throw jobInvalid();
    return normalized;
  }

  #prompt(value: unknown): string {
    if (typeof value !== "string" || !isValidJobPrompt(value)) throw jobInvalid();
    return value;
  }

  #workspaceId(value: unknown): string {
    if (!validIdentifier(value)) throw jobInvalid();
    return value;
  }

  #hook(value: unknown, workspaceId: string): string | null {
    if (!validHook(value)) throw jobInvalid();
    if (value === null) return null;
    if (this.#hookPathAdmission === undefined || this.#hookWorkspacePolicy === undefined) {
      throw new AppError(ERROR_CODES.JOB_SCRIPT_ROOTS_UNAVAILABLE);
    }
    return this.#hookPathAdmission.validateForConfiguration(
      value,
      this.#hookWorkspacePolicy(workspaceId),
    );
  }

  #phase(value: unknown): asserts value is JobRunPhase | null {
    if (value !== null && value !== "pre-hook" && value !== "prompt" && value !== "post-hook") {
      throw jobInvalid();
    }
  }

  #validateHookAcknowledgement(required: boolean, acknowledgement: true | undefined): void {
    if (required !== (acknowledgement === true)) throw jobInvalid();
  }

  #newId(): string {
    const id = this.#uuid();
    if (!validIdentifier(id)) throw jobInvalid();
    return id;
  }

  #now(): number {
    const now = this.#clock();
    requireTimestamp(now);
    return now;
  }

  #database<T>(operation: () => T): T {
    try {
      return operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw toAppError(error, { source: "database" });
    }
  }
}
