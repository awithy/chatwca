import { Temporal } from "@js-temporal/polyfill";

import { AppError, ERROR_CODES } from "../shared/errors.js";
import {
  JOB_DAILY_TIME_PATTERN,
  JOB_INTERVAL_MINUTES_MAX,
  JOB_INTERVAL_MINUTES_MIN,
  isSafeJobTimestamp,
  isSupportedJobTimeZone,
  type JobSchedule,
  type JobScheduleInput,
} from "../shared/jobs.js";

const MINUTE_MS = 60_000;
const DAILY_TIME = new RegExp(JOB_DAILY_TIME_PATTERN, "u");

function invalid(cause?: unknown): AppError {
  return new AppError(ERROR_CODES.JOB_INVALID, cause === undefined ? {} : { cause });
}

function requireTimestamp(value: unknown): asserts value is number {
  if (!isSafeJobTimestamp(value)) throw invalid();
}

function parseDailyTime(localTime: string): readonly [number, number] {
  if (!DAILY_TIME.test(localTime)) throw invalid();
  return [Number(localTime.slice(0, 2)), Number(localTime.slice(3, 5))];
}

/** Validate an untrusted schedule input and return a detached canonical value. */
export function normalizeJobScheduleInput(input: JobScheduleInput): JobScheduleInput {
  if (typeof input !== "object" || input === null || !("kind" in input)) {
    throw invalid();
  }
  const keys = Object.keys(input);
  if (input.kind === "interval") {
    if (
      keys.length !== 2 || !keys.includes("kind") || !keys.includes("intervalMinutes") ||
      !Number.isSafeInteger(input.intervalMinutes) ||
      input.intervalMinutes < JOB_INTERVAL_MINUTES_MIN ||
      input.intervalMinutes > JOB_INTERVAL_MINUTES_MAX
    ) {
      throw invalid();
    }
    return { kind: "interval", intervalMinutes: input.intervalMinutes };
  }
  if (input.kind === "daily") {
    if (
      keys.length !== 3 || !keys.includes("kind") || !keys.includes("localTime") ||
      !keys.includes("timeZone") ||
      typeof input.localTime !== "string" ||
      typeof input.timeZone !== "string" ||
      !DAILY_TIME.test(input.localTime) ||
      !isSupportedJobTimeZone(input.timeZone)
    ) {
      throw invalid();
    }
    // Ask Temporal as well as Intl. This catches zones unavailable to the
    // polyfill/runtime combination without depending on the process zone.
    try {
      Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(input.timeZone);
    } catch (error) {
      throw invalid(error);
    }
    return {
      kind: "daily",
      localTime: input.localTime,
      timeZone: input.timeZone,
    };
  }
  throw invalid();
}

/** Establish the server-owned interval anchor used on create/schedule edit. */
export function establishJobSchedule(
  input: JobScheduleInput,
  anchorAt: number,
): JobSchedule {
  requireTimestamp(anchorAt);
  const normalized = normalizeJobScheduleInput(input);
  return normalized.kind === "interval"
    ? { ...normalized, anchorAt }
    : normalized;
}

/** Validate an authoritative schedule loaded from persistence. */
export function normalizeJobSchedule(schedule: JobSchedule): JobSchedule {
  if (typeof schedule !== "object" || schedule === null) throw invalid();
  if (schedule.kind === "interval") {
    const keys = Object.keys(schedule);
    if (
      keys.length !== 3 || !keys.includes("kind") ||
      !keys.includes("intervalMinutes") || !keys.includes("anchorAt")
    ) throw invalid();
    requireTimestamp(schedule.anchorAt);
    const input = normalizeJobScheduleInput({
      kind: "interval",
      intervalMinutes: schedule.intervalMinutes,
    });
    if (input.kind !== "interval") throw invalid();
    return { ...input, anchorAt: schedule.anchorAt };
  }
  const normalized = normalizeJobScheduleInput(schedule);
  if (normalized.kind !== "daily") throw invalid();
  return normalized;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw invalid();
  return result;
}

function intervalOccurrenceAfter(
  schedule: Extract<JobSchedule, { kind: "interval" }>,
  after: number,
): number {
  const duration = schedule.intervalMinutes * MINUTE_MS;
  // The configured maximum keeps duration safe, but retain this guard so a
  // corrupted persisted value cannot influence arithmetic.
  if (!Number.isSafeInteger(duration) || duration <= 0) throw invalid();
  if (after < schedule.anchorAt) return schedule.anchorAt;
  const elapsed = after - schedule.anchorAt;
  if (!Number.isSafeInteger(elapsed)) throw invalid();
  const periods = Math.floor(elapsed / duration) + 1;
  if (!Number.isSafeInteger(periods)) throw invalid();
  const offset = periods * duration;
  if (!Number.isSafeInteger(offset)) throw invalid();
  return safeAdd(schedule.anchorAt, offset);
}

function dailyOccurrenceAfter(
  schedule: Extract<JobSchedule, { kind: "daily" }>,
  after: number,
): number {
  const [hour, minute] = parseDailyTime(schedule.localTime);
  try {
    const instant = Temporal.Instant.fromEpochMilliseconds(after);
    const localNow = instant.toZonedDateTimeISO(schedule.timeZone);
    let date = localNow.toPlainDate();
    let candidate = Temporal.ZonedDateTime.from(
      {
        timeZone: schedule.timeZone,
        year: date.year,
        month: date.month,
        day: date.day,
        hour,
        minute,
        second: 0,
        millisecond: 0,
      },
      { disambiguation: "compatible" },
    );
    if (candidate.epochMilliseconds <= after) {
      date = date.add({ days: 1 });
      candidate = Temporal.ZonedDateTime.from(
        {
          timeZone: schedule.timeZone,
          year: date.year,
          month: date.month,
          day: date.day,
          hour,
          minute,
          second: 0,
          millisecond: 0,
        },
        { disambiguation: "compatible" },
      );
    }
    const result = candidate.epochMilliseconds;
    requireTimestamp(result);
    return result;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid(error);
  }
}

/** Compute the first scheduled instant strictly after `after`. */
export function firstJobOccurrenceAfter(
  scheduleInput: JobSchedule,
  after: number,
): number {
  requireTimestamp(after);
  const schedule = normalizeJobSchedule(scheduleInput);
  return schedule.kind === "interval"
    ? intervalOccurrenceAfter(schedule, after)
    : dailyOccurrenceAfter(schedule, after);
}

/**
 * Advance a claimed persisted occurrence directly past `now`.
 *
 * The persisted value is validated and acts as the lower bound. Interval
 * arithmetic still derives from the anchor, and daily arithmetic still moves
 * calendar dates, so neither run duration nor a large misfire causes drift.
 */
export function advanceJobOccurrence(
  scheduleInput: JobSchedule,
  persistedOccurrence: number,
  now: number,
): number {
  requireTimestamp(persistedOccurrence);
  requireTimestamp(now);
  return firstJobOccurrenceAfter(
    scheduleInput,
    Math.max(persistedOccurrence, now),
  );
}

function partsRecord(
  formatter: Intl.DateTimeFormat,
  instant: number,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    formatter.formatToParts(new Date(instant)).map(({ type, value }) => [type, value]),
  );
}

/** Format the occurrence suffix used by generated job-conversation titles. */
export function formatJobScheduledInstant(
  scheduleInput: JobSchedule,
  scheduledFor: number,
): string {
  requireTimestamp(scheduledFor);
  const schedule = normalizeJobSchedule(scheduleInput);
  if (schedule.kind === "interval") {
    try {
      return new Date(scheduledFor).toISOString().replace(".000Z", "Z");
    } catch (error) {
      throw invalid(error);
    }
  }

  try {
    const parts = partsRecord(new Intl.DateTimeFormat("en-US", {
      timeZone: schedule.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "short",
    }), scheduledFor);
    const zone = parts.timeZoneName;
    if (
      parts.year === undefined || parts.month === undefined ||
      parts.day === undefined || parts.hour === undefined ||
      parts.minute === undefined || zone === undefined
    ) {
      throw new Error("Incomplete date-time format");
    }
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${zone}`;
  } catch (error) {
    throw invalid(error);
  }
}

// Concise aliases for scheduler/repository callers.
export const validateJobScheduleInput = normalizeJobScheduleInput;
export const validateAndNormalizeJobScheduleInput = normalizeJobScheduleInput;
export const createJobSchedule = establishJobSchedule;
export const establishIntervalAnchor = establishJobSchedule;
export const nextJobOccurrenceAfter = firstJobOccurrenceAfter;
export const computeFirstOccurrenceAfter = firstJobOccurrenceAfter;
export const advanceToFirstOccurrenceAfter = advanceJobOccurrence;
export function formatJobConversationTitle(
  jobName: string,
  schedule: JobSchedule,
  scheduledFor: number,
): string {
  return `[Job] ${jobName} — ${formatJobScheduledInstant(schedule, scheduledFor)}`;
}

export const formatJobScheduledTime = formatJobScheduledInstant;
export const formatScheduledInstantForTitle = formatJobScheduledInstant;
