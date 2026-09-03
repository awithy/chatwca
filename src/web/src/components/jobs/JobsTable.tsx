import type { JobRunStatus, JobSummary } from "../../../../shared/jobs.js";

export interface JobsTableProps {
  readonly jobs: readonly JobSummary[];
  readonly connected: boolean;
  readonly pendingJobId: string | null;
  readonly onRun: (job: JobSummary) => void;
  readonly onRuns: (job: JobSummary) => void;
  readonly onEdit: (job: JobSummary) => void;
  readonly onToggle: (job: JobSummary) => void;
  readonly onDelete: (job: JobSummary) => void;
  readonly onAbort: (job: JobSummary) => void;
}

export function statusLabel(status: JobRunStatus): string {
  return ({ queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed", blocked: "Blocked", skipped: "Skipped", aborted: "Aborted", interrupted: "Interrupted" } as const)[status];
}

export function ExactTime({ value, timeZone }: { readonly value: number | null; readonly timeZone?: string | undefined }) {
  if (value === null) return <span>—</span>;
  const date = new Date(value);
  const text = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(date);
  return <time dateTime={date.toISOString()} title={date.toISOString()} aria-label={`${text}; exact time ${date.toISOString()}`}>{text}</time>;
}

export function scheduleLabel(job: JobSummary): string {
  if (job.schedule.kind === "interval") {
    const minutes = job.schedule.intervalMinutes;
    if (minutes % 1_440 === 0) return `Every ${String(minutes / 1_440)} day${minutes === 1_440 ? "" : "s"}`;
    if (minutes % 60 === 0) return `Every ${String(minutes / 60)} hour${minutes === 60 ? "" : "s"}`;
    return `Every ${String(minutes)} minute${minutes === 1 ? "" : "s"}`;
  }
  return `Daily at ${job.schedule.localTime} ${job.schedule.timeZone}`;
}

function JobStatus({ job }: { readonly job: JobSummary }) {
  if (job.configurationIssue !== null) return <span className="status-badge status-blocked" title={job.configurationIssue.message}>Blocked · configuration</span>;
  const run = job.activeRun ?? job.lastRun;
  if (run === null) return <span className="status-badge status-never">Never run</span>;
  return <span className={`status-badge status-${run.status}`}>{statusLabel(run.status)}{run.phase === null ? "" : ` · ${run.phase}`}</span>;
}

export function JobsTable({ jobs, connected, pendingJobId, onRun, onRuns, onEdit, onToggle, onDelete, onAbort }: JobsTableProps) {
  if (jobs.length === 0) return <div className="jobs-empty"><h2>No matching jobs</h2><p>Create a scheduled prompt or adjust the filters.</p></div>;
  return (
    <div className="jobs-table-wrap">
      <table className="jobs-table">
        <caption className="visually-hidden">Scheduled jobs</caption>
        <thead><tr><th>Name</th><th>Workspace</th><th>Schedule</th><th>Last run</th><th>Next run</th><th>Status</th><th>Enabled</th><th>Actions</th></tr></thead>
        <tbody>{jobs.map((job) => {
          const locked = job.activeRun !== null;
          const pending = pendingJobId === job.id;
          const zone = job.schedule.kind === "daily" ? job.schedule.timeZone : undefined;
          return <tr key={job.id} data-job-id={job.id}>
            <th scope="row"><strong>{job.name}</strong>{job.configurationIssue !== null && <small>{job.configurationIssue.message}</small>}</th>
            <td><span>{job.workspaceName}</span>{!job.workspaceAvailable && <small className="danger-text">Unavailable</small>}</td>
            <td><span>{scheduleLabel(job)}</span>{job.schedule.kind === "interval" && <small>Anchor {new Date(job.schedule.anchorAt).toISOString()}</small>}</td>
            <td>{job.lastRun === null ? <span>Never</span> : <><ExactTime value={job.lastRun.finishedAt ?? job.lastRun.scheduledFor} timeZone={zone} /><small>{statusLabel(job.lastRun.status)}</small></>}</td>
            <td><ExactTime value={job.nextRunAt} timeZone={zone} /></td>
            <td><JobStatus job={job} /></td>
            <td><span className={`enabled-label ${job.enabled ? "is-enabled" : ""}`}>{job.enabled ? "Enabled" : "Disabled"}</span></td>
            <td><div className="job-row-actions">
              {locked ? <button type="button" className="danger-button" disabled={!connected || pending} onClick={() => onAbort(job)}>Abort</button> : <button type="button" disabled={!connected || !job.enabled || pending || job.configurationIssue !== null} onClick={() => onRun(job)}>Run now</button>}
              <button type="button" disabled={!connected || pending} onClick={() => onRuns(job)}>View runs</button>
              <button type="button" disabled={!connected || locked || pending} title={locked ? "Editing is locked while this job is active" : undefined} onClick={() => onEdit(job)}>Edit</button>
              <button type="button" disabled={!connected || pending || (locked && !job.enabled)} title={locked && !job.enabled ? "Re-enabling is locked while this job is active" : undefined} onClick={() => onToggle(job)}>{job.enabled ? "Disable" : "Enable"}</button>
              <button type="button" className="danger-link" disabled={!connected || locked || pending} title={locked ? "Deletion is locked while this job is active" : undefined} onClick={() => onDelete(job)}>Delete</button>
            </div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
  );
}
