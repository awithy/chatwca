import * as React from "react";

import type {
  QueueState,
  QueuedPrompt,
  StatusNotice,
} from "../../../shared/protocol.js";

export interface RunActivityProps {
  readonly notices: readonly StatusNotice[];
  readonly queue: QueueState;
}

function retryDetails(notice: Extract<StatusNotice, { kind: "retry" }>): string | null {
  const details: string[] = [];
  if (notice.attempt !== undefined) {
    details.push(
      notice.maxAttempts === undefined
        ? `Attempt ${notice.attempt}`
        : `Attempt ${notice.attempt} of ${notice.maxAttempts}`,
    );
  }
  if (notice.delayMs !== undefined) {
    const delay = notice.delayMs >= 1000
      ? `${(notice.delayMs / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} s`
      : `${notice.delayMs} ms`;
    details.push(`retry delay ${delay}`);
  }
  return details.length === 0 ? null : details.join(" · ");
}

function noticeLabel(notice: StatusNotice): string {
  switch (notice.kind) {
    case "retry":
      return notice.phase === "scheduled"
        ? "Retry scheduled"
        : notice.phase === "started"
          ? "Retry started"
          : "Retry completed";
    case "compaction":
      return `Compaction ${notice.phase}`;
    case "runtime":
      return `Runtime ${notice.level}`;
  }
}

function queueText(prompt: QueuedPrompt): string {
  const text = prompt.text.trim();
  if (text.length > 0) return text;
  return prompt.imageCount === 1 ? "1 image" : `${prompt.imageCount} images`;
}

function QueueNotice({
  prompt,
  mode,
}: {
  readonly prompt: QueuedPrompt;
  readonly mode: "steering" | "follow-up";
}) {
  return (
    <li className="run-notice notice-queue">
      <span className="run-notice-mark" aria-hidden="true">↳</span>
      <div>
        <strong>{mode === "steering" ? "Steering prompt queued" : "Follow-up prompt queued"}</strong>
        <p>{queueText(prompt)}</p>
        {prompt.imageCount > 0 && prompt.text.trim().length > 0 && (
          <small>{prompt.imageCount === 1 ? "1 image attached" : `${prompt.imageCount} images attached`}</small>
        )}
      </div>
    </li>
  );
}

/** Run lifecycle information is intentionally separate from model-authored prose. */
export function RunActivity({ notices, queue }: RunActivityProps) {
  const hasQueue = queue.steering.length > 0 || queue.followUp.length > 0;
  if (notices.length === 0 && !hasQueue) return null;

  return (
    <section className="run-activity" aria-label="Run notices" aria-live="polite">
      <ul>
        {notices.map((notice, index) => {
          const details = notice.kind === "retry" ? retryDetails(notice) : null;
          const variant = notice.kind === "runtime" ? notice.level : notice.phase;
          return (
            <li
              className={`run-notice notice-${notice.kind} notice-${variant}`}
              key={`notice-${index}`}
            >
              <span className="run-notice-mark" aria-hidden="true">
                {notice.kind === "retry" ? "↻" : notice.kind === "compaction" ? "◇" : "!"}
              </span>
              <div>
                <strong>{noticeLabel(notice)}</strong>
                <p>{notice.message}</p>
                {details !== null && <small>{details}</small>}
              </div>
            </li>
          );
        })}
        {queue.steering.map((prompt, index) => (
          <QueueNotice prompt={prompt} mode="steering" key={`steering-${index}`} />
        ))}
        {queue.followUp.map((prompt, index) => (
          <QueueNotice prompt={prompt} mode="follow-up" key={`follow-up-${index}`} />
        ))}
      </ul>
    </section>
  );
}
