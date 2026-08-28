import { describe, expect, it } from "vitest";

import {
  decideEventRevision,
  decideSnapshotRevision,
  nextRevision,
} from "../../src/shared/revisions.js";

describe("decideEventRevision", () => {
  it("applies only the next contiguous event", () => {
    expect(decideEventRevision(0, 1)).toBe("apply");
    expect(decideEventRevision(41, 42)).toBe("apply");
  });

  it("ignores stale and duplicate events", () => {
    expect(decideEventRevision(4, 4)).toBe("ignore");
    expect(decideEventRevision(4, 2)).toBe("ignore");
  });

  it("requests resynchronization when an event creates a gap", () => {
    expect(decideEventRevision(4, 6)).toBe("resync");
    expect(decideEventRevision(0, 100)).toBe("resync");
  });

  it("requests resynchronization for invalid local or incoming revisions", () => {
    expect(decideEventRevision(-1, 0)).toBe("resync");
    expect(decideEventRevision(0, -1)).toBe("resync");
    expect(decideEventRevision(0.5, 1)).toBe("resync");
    expect(decideEventRevision(0, Number.MAX_SAFE_INTEGER + 1)).toBe("resync");
  });
});

describe("decideSnapshotRevision", () => {
  it("accepts a snapshot when there is no local projection", () => {
    expect(decideSnapshotRevision(undefined, 0)).toBe("replace");
  });

  it("replaces local state with equal or newer snapshots", () => {
    expect(decideSnapshotRevision(3, 3)).toBe("replace");
    expect(decideSnapshotRevision(3, 8)).toBe("replace");
  });

  it("ignores stale or invalid snapshots", () => {
    expect(decideSnapshotRevision(3, 2)).toBe("ignore");
    expect(decideSnapshotRevision(3, -1)).toBe("ignore");
    expect(decideSnapshotRevision(3, 3.5)).toBe("ignore");
  });
});

describe("nextRevision", () => {
  it("increments a valid revision", () => {
    expect(nextRevision(0)).toBe(1);
    expect(nextRevision(9)).toBe(10);
  });

  it("rejects invalid or exhausted revisions", () => {
    expect(() => nextRevision(-1)).toThrow(RangeError);
    expect(() => nextRevision(1.5)).toThrow(RangeError);
    expect(() => nextRevision(Number.MAX_SAFE_INTEGER)).toThrow(RangeError);
  });
});
