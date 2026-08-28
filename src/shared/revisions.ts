export type EventRevisionDecision = "apply" | "ignore" | "resync";
export type SnapshotRevisionDecision = "replace" | "ignore";

function isRevision(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Decide how a client projection should handle an incremental event.
 *
 * Events must be exactly contiguous. Older/equal revisions are stale or
 * duplicate deliveries; a future revision means at least one event was missed
 * and requires an authoritative snapshot.
 */
export function decideEventRevision(
  currentRevision: number,
  incomingRevision: number,
): EventRevisionDecision {
  if (!isRevision(currentRevision) || !isRevision(incomingRevision)) {
    return "resync";
  }
  if (incomingRevision <= currentRevision) {
    return "ignore";
  }
  return incomingRevision === currentRevision + 1 ? "apply" : "resync";
}

/**
 * Decide how to handle a complete server snapshot. An equal-revision snapshot
 * is still useful for explicit reconciliation and replaces local state. A
 * snapshot older than the current projection is ignored as an out-of-order
 * response. With no local projection, every schema-valid snapshot is accepted.
 */
export function decideSnapshotRevision(
  currentRevision: number | undefined,
  incomingRevision: number,
): SnapshotRevisionDecision {
  if (!isRevision(incomingRevision)) {
    return "ignore";
  }
  if (currentRevision === undefined) {
    return "replace";
  }
  if (!isRevision(currentRevision) || incomingRevision < currentRevision) {
    return "ignore";
  }
  return "replace";
}

/** Return the next event revision, refusing values unsafe on the JSON wire. */
export function nextRevision(currentRevision: number): number {
  if (!isRevision(currentRevision) || currentRevision >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Conversation revision cannot be incremented safely");
  }
  return currentRevision + 1;
}
