import { AppError } from "../../src/shared/errors.js";
import {
  advanceJobOccurrence,
  establishJobSchedule,
  firstJobOccurrenceAfter,
  formatJobScheduledInstant,
  normalizeJobScheduleInput,
} from "../../src/server/job-schedule.js";
import { describe, expect, it } from "vitest";

const utc = (value: string): number => Date.parse(`${value}Z`);

describe("job schedule engine", () => {
  it("establishes server interval anchors and returns strictly future boundaries", () => {
    const schedule = establishJobSchedule({ kind: "interval", intervalMinutes: 15 }, 1_000);
    expect(schedule).toEqual({ kind: "interval", intervalMinutes: 15, anchorAt: 1_000 });
    expect(firstJobOccurrenceAfter(schedule, 999)).toBe(1_000);
    expect(firstJobOccurrenceAfter(schedule, 1_000)).toBe(901_000);
    expect(firstJobOccurrenceAfter(schedule, 901_000)).toBe(1_801_000);
  });

  it("uses anchor arithmetic without drift and skips huge missed ranges in one calculation", () => {
    const schedule = { kind: "interval", intervalMinutes: 1, anchorAt: 0 } as const;
    expect(advanceJobOccurrence(schedule, 60_000, 60_000 * 10_000_000 + 12)).toBe(
      60_000 * 10_000_001,
    );
    // Completion time is irrelevant; a late wake still lands on the anchor grid.
    expect(advanceJobOccurrence(schedule, 60_000, 123_456)).toBe(180_000);
  });

  it("rejects unsafe arithmetic, noncanonical times, ranges, and unsupported zones", () => {
    for (const input of [
      { kind: "interval", intervalMinutes: 0 },
      { kind: "interval", intervalMinutes: 1.5 },
      { kind: "daily", localTime: "7:00", timeZone: "UTC" },
      { kind: "daily", localTime: "24:00", timeZone: "UTC" },
      { kind: "daily", localTime: "07:00", timeZone: "Mars/Olympus" },
      { kind: "interval", intervalMinutes: 5, anchorAt: 1 },
    ]) {
      expect(() => normalizeJobScheduleInput(input as never)).toThrow(AppError);
    }
    expect(() => establishJobSchedule({ kind: "interval", intervalMinutes: 1 }, -1)).toThrow();
    expect(() => firstJobOccurrenceAfter(
      { kind: "interval", intervalMinutes: 1, anchorAt: Number.MAX_SAFE_INTEGER - 1 },
      Number.MAX_SAFE_INTEGER - 1,
    )).toThrow();
  });

  it("uses compatible disambiguation for New York spring gaps and fallback overlap", () => {
    const gap = { kind: "daily", localTime: "02:30", timeZone: "America/New_York" } as const;
    expect(firstJobOccurrenceAfter(gap, utc("2024-03-10T00:00:00"))).toBe(
      utc("2024-03-10T07:30:00"),
    );

    const overlap = { kind: "daily", localTime: "01:30", timeZone: "America/New_York" } as const;
    expect(firstJobOccurrenceAfter(overlap, utc("2024-11-03T00:00:00"))).toBe(
      utc("2024-11-03T05:30:00"),
    );
    // Once the earlier occurrence has passed, an overlap runs only once that day.
    expect(firstJobOccurrenceAfter(overlap, utc("2024-11-03T05:30:00"))).toBe(
      utc("2024-11-04T06:30:00"),
    );
  });

  it("moves calendar dates across DST and non-hour transitions", () => {
    const ny = { kind: "daily", localTime: "07:00", timeZone: "America/New_York" } as const;
    const before = firstJobOccurrenceAfter(ny, utc("2024-03-08T12:01:00"));
    const after = advanceJobOccurrence(ny, before, before);
    expect(before).toBe(utc("2024-03-09T12:00:00"));
    expect(after).toBe(utc("2024-03-10T11:00:00"));
    expect(after - before).toBe(23 * 60 * 60 * 1_000);

    const lordHowe = { kind: "daily", localTime: "02:15", timeZone: "Australia/Lord_Howe" } as const;
    expect(firstJobOccurrenceAfter(lordHowe, utc("2024-10-05T12:00:00"))).toBe(
      utc("2024-10-05T15:45:00"),
    );
  });

  it("formats interval times unambiguously and daily times in the explicit zone", () => {
    expect(formatJobScheduledInstant(
      { kind: "interval", intervalMinutes: 60, anchorAt: 0 },
      utc("2026-03-23T12:34:56"),
    )).toBe("2026-03-23T12:34:56Z");
    expect(formatJobScheduledInstant(
      { kind: "daily", localTime: "08:34", timeZone: "America/New_York" },
      utc("2026-03-23T12:34:00"),
    )).toMatch(/^2026-03-23 08:34 (EDT|GMT-4)$/);
  });

  it("does not consult the process local timezone", () => {
    const previous = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Honolulu";
      const schedule = { kind: "daily", localTime: "09:00", timeZone: "Asia/Tokyo" } as const;
      const first = firstJobOccurrenceAfter(schedule, utc("2025-01-01T00:00:00"));
      process.env.TZ = "Europe/London";
      expect(firstJobOccurrenceAfter(schedule, utc("2025-01-01T00:00:00"))).toBe(first);
      expect(first).toBe(utc("2025-01-02T00:00:00"));
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
