import { useId, type RefObject } from "react";

import type { JobRunState, JobRunSummary, JobSummary } from "../../../../shared/jobs.js";
import { Modal } from "../Modal.js";
import { ExactTime, statusLabel } from "./JobsTable.js";

interface RunHistoryDialogProps {
  readonly job: JobSummary;
  readonly runs: readonly JobRunSummary[];
  readonly detail: JobRunState | undefined;
  readonly selectedRunId: string | null;
  readonly loading: boolean;
  readonly nextCursor: string | null;
  readonly unavailable: boolean;
  readonly returnFocusRef?: RefObject<HTMLElement | null> | undefined;
  readonly onSelect: (run: JobRunSummary) => void;
  readonly onLoadMore: () => void;
  readonly onAbort: (run: JobRunSummary) => void;
  readonly onConversation: (run: JobRunState) => void;
  readonly onClose: () => void;
}

function duration(run: JobRunSummary): string {
  if (run.startedAt === null) return "Not started";
  if (run.finishedAt === null) return "In progress";
  const seconds = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1_000));
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`;
}

function Output({ label, value }: { readonly label: string; readonly value: string | null }) {
  if (value === null) return null;
  return <section className="hook-output"><h4>{label}</h4><pre>{value.length === 0 ? "(no output)" : value}</pre></section>;
}

export function RunHistoryDialog(props: RunHistoryDialogProps) {
  const titleId = `run-history-${useId().replaceAll(":", "")}-title`;
  const zone = props.job.schedule.kind === "daily" ? props.job.schedule.timeZone : undefined;
  return (
    <Modal labelledBy={titleId} returnFocusRef={props.returnFocusRef} className="run-dialog" onClose={props.onClose}>
      <div className="run-dialog-layout">
        <header className="modal-header run-dialog-header"><div><p className="eyebrow">{props.job.name}</p><h2 id={titleId}>Run history</h2></div><button type="button" className="icon-button" aria-label="Close run history" onClick={props.onClose}>×</button></header>
        <section className="run-list" aria-label="Runs">
          {props.runs.length === 0 && !props.loading ? <p className="run-empty">This job has not run yet.</p> : <ol>{props.runs.map((run) => <li key={run.id}><button type="button" className={props.selectedRunId === run.id ? "is-selected" : ""} aria-current={props.selectedRunId === run.id ? "true" : undefined} onClick={() => props.onSelect(run)}><span><strong>{statusLabel(run.status)}</strong><small>{run.trigger} · {run.phase ?? "no phase"}</small></span><ExactTime value={run.scheduledFor} timeZone={zone} /></button></li>)}</ol>}
          {props.nextCursor !== null && <button type="button" className="secondary-button load-more" disabled={props.loading} onClick={props.onLoadMore}>{props.loading ? "Loading…" : "Load older runs"}</button>}
        </section>
        <section className="run-detail" aria-live="polite">
          {props.selectedRunId === null ? <div className="run-detail-empty"><h3>Select a run</h3><p>Inspect status, hook diagnostics, and its generated conversation.</p></div> : props.detail === undefined ? <div className="run-detail-empty"><span className="loading-spinner" aria-hidden="true" /><p>Loading run detail…</p></div> : <>
            <div className="run-detail-heading"><div><span className={`status-badge status-${props.detail.status}`}>{statusLabel(props.detail.status)}</span><h3>{props.detail.trigger} run</h3></div>{(props.detail.status === "queued" || props.detail.status === "running") && <button type="button" className="danger-button" onClick={() => props.onAbort(props.detail!)}>Abort run</button>}</div>
            <dl className="run-facts">
              <div><dt>Scheduled</dt><dd><ExactTime value={props.detail.scheduledFor} timeZone={zone} /></dd></div>
              <div><dt>Started</dt><dd><ExactTime value={props.detail.startedAt} timeZone={zone} /></dd></div>
              <div><dt>Finished</dt><dd><ExactTime value={props.detail.finishedAt} timeZone={zone} /></dd></div>
              <div><dt>Duration</dt><dd>{duration(props.detail!)}</dd></div>
              <div><dt>Phase</dt><dd>{props.detail.phase ?? "—"}</dd></div>
              <div><dt>Revision</dt><dd>{props.detail.revision}</dd></div>
              <div><dt>Pre-hook exit</dt><dd>{props.detail.preExitCode ?? "—"}</dd></div>
              <div><dt>Post-hook exit</dt><dd>{props.detail.postExitCode ?? "—"}</dd></div>
            </dl>
            {props.detail.errorMessage !== null && <div className="run-error" role="status"><strong>{props.detail.errorCode ?? "Run error"}</strong><p>{props.detail.errorMessage}</p></div>}
            {props.detail.conversationId === null ? <p className="conversation-unavailable">No conversation was generated.</p> : props.unavailable || !props.detail.conversationAvailable ? <p className="conversation-unavailable">Conversation unavailable</p> : <button type="button" className="secondary-button conversation-link" onClick={() => props.onConversation(props.detail!)}>Open generated conversation</button>}
            <Output label="Pre-hook stdout" value={props.detail.preStdout} />
            <Output label="Pre-hook stderr" value={props.detail.preStderr} />
            <Output label="Post-hook stdout" value={props.detail.postStdout} />
            <Output label="Post-hook stderr" value={props.detail.postStderr} />
          </>}
        </section>
      </div>
    </Modal>
  );
}
