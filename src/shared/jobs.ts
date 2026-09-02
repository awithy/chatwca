import { type Static, Type, type TSchema } from "@sinclair/typebox";

import { ErrorCodeSchema } from "./errors.js";

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

/** Shared application bounds used by the wire contract and job persistence. */
export const JOB_NAME_MIN_LENGTH = 1;
export const JOB_NAME_MAX_LENGTH = 200;
export const JOB_PROMPT_MAX_LENGTH = 100_000;
export const JOB_SCRIPT_PATH_MAX_LENGTH = 4_096;
export const JOB_INTERVAL_MINUTES_MIN = 1;
export const JOB_INTERVAL_MINUTES_MAX = 525_600;
export const JOB_IDENTIFIER_MAX_LENGTH = 512;
export const JOB_REQUEST_CURSOR_MAX_LENGTH = 512;
export const JOB_DAILY_TIME_PATTERN = "^(?:[01][0-9]|2[0-3]):[0-5][0-9]$";

export const JobIdentifierSchema = Type.String({
  minLength: 1,
  maxLength: JOB_IDENTIFIER_MAX_LENGTH,
});
export const JobRunCursorSchema = Type.String({
  minLength: 1,
  maxLength: JOB_REQUEST_CURSOR_MAX_LENGTH,
});
export const JobTimestampSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});
const SafeTimestampSchema = JobTimestampSchema;
const NullableSafeTimestampSchema = Type.Union([SafeTimestampSchema, Type.Null()]);
export const JobNameSchema = Type.String({
  minLength: JOB_NAME_MIN_LENGTH,
  maxLength: JOB_NAME_MAX_LENGTH,
  pattern: "^[\\s\\S]*\\S[\\s\\S]*$",
});
export const JobPromptSchema = Type.String({
  minLength: 1,
  maxLength: JOB_PROMPT_MAX_LENGTH,
  pattern: "^[\\s\\S]*\\S[\\s\\S]*$",
});
export const JobScriptPathSchema = Type.String({
  minLength: 1,
  maxLength: JOB_SCRIPT_PATH_MAX_LENGTH,
});

export const JobScheduleInputSchema = Type.Union([
  strictObject({
    kind: Type.Literal("interval"),
    intervalMinutes: Type.Integer({
      minimum: JOB_INTERVAL_MINUTES_MIN,
      maximum: JOB_INTERVAL_MINUTES_MAX,
    }),
  }),
  strictObject({
    kind: Type.Literal("daily"),
    localTime: Type.String({ pattern: JOB_DAILY_TIME_PATTERN }),
    timeZone: Type.String({ minLength: 1, maxLength: 255 }),
  }),
]);
export type JobScheduleInput = Static<typeof JobScheduleInputSchema>;

export const JobScheduleSchema = Type.Union([
  strictObject({
    kind: Type.Literal("interval"),
    intervalMinutes: Type.Integer({
      minimum: JOB_INTERVAL_MINUTES_MIN,
      maximum: JOB_INTERVAL_MINUTES_MAX,
    }),
    anchorAt: SafeTimestampSchema,
  }),
  strictObject({
    kind: Type.Literal("daily"),
    localTime: Type.String({ pattern: JOB_DAILY_TIME_PATTERN }),
    timeZone: Type.String({ minLength: 1, maxLength: 255 }),
  }),
]);
export type JobSchedule = Static<typeof JobScheduleSchema>;

export const JobRunTriggerSchema = Type.Union([
  Type.Literal("scheduled"),
  Type.Literal("manual"),
  Type.Literal("catch-up"),
]);
export type JobRunTrigger = Static<typeof JobRunTriggerSchema>;

export const JobRunStatusSchema = Type.Union([
  Type.Literal("queued"),
  Type.Literal("running"),
  Type.Literal("succeeded"),
  Type.Literal("failed"),
  Type.Literal("blocked"),
  Type.Literal("skipped"),
  Type.Literal("aborted"),
  Type.Literal("interrupted"),
]);
export type JobRunStatus = Static<typeof JobRunStatusSchema>;

export const JobRunPhaseSchema = Type.Union([
  Type.Literal("pre-hook"),
  Type.Literal("prompt"),
  Type.Literal("post-hook"),
]);
export type JobRunPhase = Static<typeof JobRunPhaseSchema>;

/** Job-owned stable failures. Existing direct-cause codes remain valid too. */
export const JobErrorCodeSchema = Type.Union([
  Type.Literal("job_not_found"),
  Type.Literal("job_invalid"),
  Type.Literal("job_busy"),
  Type.Literal("job_disabled"),
  Type.Literal("job_already_running"),
  Type.Literal("job_script_roots_unavailable"),
  Type.Literal("job_script_invalid"),
  Type.Literal("job_script_unavailable"),
  Type.Literal("job_pre_run_failed"),
  Type.Literal("job_post_run_failed"),
  Type.Literal("job_hook_timeout"),
  Type.Literal("job_hook_output_limit"),
  Type.Literal("job_prompt_failed"),
  Type.Literal("job_aborted"),
  Type.Literal("job_interrupted"),
]);
export type JobErrorCode = Static<typeof JobErrorCodeSchema>;

const JobRunSummaryProperties = {
  id: JobIdentifierSchema,
  jobId: JobIdentifierSchema,
  trigger: JobRunTriggerSchema,
  scheduledFor: SafeTimestampSchema,
  startedAt: NullableSafeTimestampSchema,
  finishedAt: NullableSafeTimestampSchema,
  status: JobRunStatusSchema,
  phase: Type.Union([JobRunPhaseSchema, Type.Null()]),
  errorCode: Type.Union([ErrorCodeSchema, Type.Null()]),
  errorMessage: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  conversationId: Type.Union([JobIdentifierSchema, Type.Null()]),
  revision: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  createdAt: SafeTimestampSchema,
  updatedAt: SafeTimestampSchema,
} as const;

export const JobRunSummarySchema = strictObject(JobRunSummaryProperties);
export type JobRunSummary = Static<typeof JobRunSummarySchema>;

export const JobConfigurationIssueSchema = Type.Union([
  strictObject({
    code: ErrorCodeSchema,
    message: Type.String({ minLength: 1 }),
  }),
  Type.Null(),
]);
export type JobConfigurationIssue = Static<typeof JobConfigurationIssueSchema>;

export const JobSummarySchema = strictObject({
  id: JobIdentifierSchema,
  name: JobNameSchema,
  workspaceId: JobIdentifierSchema,
  workspaceName: Type.String({ minLength: 1 }),
  workspaceAvailable: Type.Boolean(),
  prompt: JobPromptSchema,
  schedule: JobScheduleSchema,
  preRunScript: Type.Union([JobScriptPathSchema, Type.Null()]),
  postRunScript: Type.Union([JobScriptPathSchema, Type.Null()]),
  enabled: Type.Boolean(),
  nextRunAt: NullableSafeTimestampSchema,
  createdAt: SafeTimestampSchema,
  updatedAt: SafeTimestampSchema,
  activeRun: Type.Union([JobRunSummarySchema, Type.Null()]),
  lastRun: Type.Union([JobRunSummarySchema, Type.Null()]),
  configurationIssue: JobConfigurationIssueSchema,
});
export type JobSummary = Static<typeof JobSummarySchema>;

export const JobRunStateSchema = strictObject({
  ...JobRunSummaryProperties,
  preExitCode: Type.Union([Type.Integer(), Type.Null()]),
  preStdout: Type.Union([Type.String(), Type.Null()]),
  preStderr: Type.Union([Type.String(), Type.Null()]),
  postExitCode: Type.Union([Type.Integer(), Type.Null()]),
  postStdout: Type.Union([Type.String(), Type.Null()]),
  postStderr: Type.Union([Type.String(), Type.Null()]),
  conversationAvailable: Type.Boolean(),
});
export type JobRunState = Static<typeof JobRunStateSchema>;

export const PublicJobsConfigSchema = strictObject({
  schedulerAvailable: Type.Boolean(),
  hooksAvailable: Type.Boolean(),
  scriptRoots: Type.Array(Type.String({ minLength: 1 })),
  minIntervalMinutes: Type.Literal(JOB_INTERVAL_MINUTES_MIN),
  maxIntervalMinutes: Type.Literal(JOB_INTERVAL_MINUTES_MAX),
  supportedTimeZones: Type.Array(Type.String({ minLength: 1 })),
  hostAuthorityWarning: Type.String({ minLength: 1 }),
  unattendedUsageWarning: Type.String({ minLength: 1 }),
});
export type PublicJobsConfig = Static<typeof PublicJobsConfigSchema>;

const supportedTimeZones = new Set<string>([
  "UTC",
  ...Intl.supportedValuesOf("timeZone"),
]);

/** Stable, sorted runtime-supported IANA zones advertised to the browser. */
export const SUPPORTED_JOB_TIME_ZONES: readonly string[] = Object.freeze(
  [...supportedTimeZones].sort(),
);

export function isSupportedJobTimeZone(value: string): boolean {
  return supportedTimeZones.has(value);
}

export function isSafeJobTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Repository-side normalization for the schema's trimmed-name contract. */
export function normalizeJobName(value: string): string | undefined {
  const normalized = value.trim();
  return normalized.length >= JOB_NAME_MIN_LENGTH &&
      normalized.length <= JOB_NAME_MAX_LENGTH
    ? normalized
    : undefined;
}

export function isValidJobPrompt(value: string): boolean {
  return value.length <= JOB_PROMPT_MAX_LENGTH && /\S/u.test(value);
}
