import * as React from "react";

import type { NetworkBlockedEvent } from "../../../shared/protocol.js";

export interface NetworkBlockedNoticesProps {
  readonly notices: readonly NetworkBlockedEvent[];
}

/** Browser-safe policy denials only; intentionally no approval or retry control. */
export function NetworkBlockedNotices({ notices }: NetworkBlockedNoticesProps) {
  if (notices.length === 0) return null;

  return (
    <section className="network-blocked-notices" aria-label="Blocked network destinations" aria-live="polite">
      <strong>Network request blocked</strong>
      <ul>
        {notices.slice(-5).map((notice) => (
          <li key={notice.revision}>
            <code>{notice.payload.host}</code>
            <span>port {notice.payload.port}</span>
            <span>{notice.payload.protocol}</span>
            <span>reason <code>{notice.payload.reason}</code></span>
            {(notice.payload.occurrenceCount ?? 1) > 1 && (
              <span>{notice.payload.occurrenceCount} occurrences</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
