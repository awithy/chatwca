import { useEffect, useMemo, useRef, useState } from "react";

import type { JobRunState, JobRunSummary, JobSummary } from "../../../../shared/jobs.js";
import type { PublicConfig } from "../../../../shared/protocol.js";
import type { ChatSocketClient } from "../../api/client.js";
import type { ChatViewState } from "../../api/view-state.js";
import { JobDialog } from "./JobDialog.js";
import type { JobFormValues } from "./JobForm.js";
import { JobsTable } from "./JobsTable.js";
import { RunHistoryDialog } from "./RunHistoryDialog.js";

export interface JobsPageProps {
  readonly client: ChatSocketClient;
  readonly state: ChatViewState;
  readonly config: PublicConfig | undefined;
  readonly onOpenConversations: () => void;
  readonly onOpenConversation: (workspaceId: string, conversationId: string) => Promise<boolean>;
}

function message(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function JobsPage({ client, state, config, onOpenConversations, onOpenConversation }: JobsPageProps) {
  const jobsConfig = config?.jobs;
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const mobileNavigationTrigger = useRef<HTMLButtonElement>(null);
  const mobileNavigationClose = useRef<HTMLButtonElement>(null);
  const [search, setSearch] = useState("");
  const [workspaceFilter, setWorkspaceFilter] = useState("");
  const [editing, setEditing] = useState<JobSummary | "create" | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conversationUnavailable, setConversationUnavailable] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const connected = state.connection === "connected";
  const selectedJob = state.jobs.find((job) => job.id === state.selectedJobId);
  const page = selectedJob === undefined ? undefined : state.jobRunPages[selectedJob.id];
  const runs = (page?.runIds ?? []).map((id) => state.jobRuns[id]).filter((run): run is JobRunSummary => run !== undefined);
  const detail = state.selectedJobRunId === null ? undefined : state.jobRunDetails[state.selectedJobRunId];
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return state.jobs.filter((job) =>
      (workspaceFilter.length === 0 || job.workspaceId === workspaceFilter) &&
      (query.length === 0 || `${job.name}\n${job.workspaceName}\n${job.prompt}`.toLocaleLowerCase().includes(query)),
    );
  }, [search, state.jobs, workspaceFilter]);

  useEffect(() => {
    if (!mobileNavigationOpen) return;
    mobileNavigationClose.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setMobileNavigationOpen(false);
      window.requestAnimationFrame(() => mobileNavigationTrigger.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileNavigationOpen]);

  function closeMobileNavigation(): void {
    setMobileNavigationOpen(false);
    window.requestAnimationFrame(() => mobileNavigationTrigger.current?.focus());
  }

  function rememberFocus(): void {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  async function submitJob(values: JobFormValues): Promise<void> {
    setSubmitting(true);
    setError(null);
    try {
      if (editing === "create") {
        await client.send({
          type: "job.create",
          name: values.name,
          workspaceId: values.workspaceId,
          prompt: values.prompt,
          schedule: values.schedule,
          enabled: values.enabled,
          ...(values.preRunScript === null ? {} : { preRunScript: values.preRunScript }),
          ...(values.postRunScript === null ? {} : { postRunScript: values.postRunScript }),
          ...(values.acknowledgeHostHooks === true ? { acknowledgeHostHooks: true as const } : {}),
        });
      } else if (editing !== null) {
        const repair = editing.configurationIssue !== null;
        const scheduleChanged = values.schedule.kind !== editing.schedule.kind ||
          (values.schedule.kind === "interval" && editing.schedule.kind === "interval" && values.schedule.intervalMinutes !== editing.schedule.intervalMinutes) ||
          (values.schedule.kind === "daily" && editing.schedule.kind === "daily" && (values.schedule.localTime !== editing.schedule.localTime || values.schedule.timeZone !== editing.schedule.timeZone));
        await client.send({
          type: "job.update",
          jobId: editing.id,
          // A harmless name replacement ensures an unchanged valid form still
          // has one update field without resetting an interval anchor.
          name: values.name,
          ...(repair || values.workspaceId !== editing.workspaceId ? { workspaceId: values.workspaceId } : {}),
          ...(repair || values.prompt !== editing.prompt ? { prompt: values.prompt } : {}),
          ...(repair || scheduleChanged ? { schedule: values.schedule } : {}),
          ...(repair || values.preRunScript !== editing.preRunScript ? { preRunScript: values.preRunScript } : {}),
          ...(repair || values.postRunScript !== editing.postRunScript ? { postRunScript: values.postRunScript } : {}),
          ...(repair || values.enabled !== editing.enabled ? { enabled: values.enabled } : {}),
          ...(values.acknowledgeHostHooks === true ? { acknowledgeHostHooks: true as const } : {}),
        });
      }
      setEditing(null);
    } catch (cause) {
      setError(message(cause, "Unable to save the job."));
    } finally {
      setSubmitting(false);
    }
  }

  async function act(job: JobSummary, action: () => Promise<unknown>, fallback: string): Promise<void> {
    setPendingJobId(job.id);
    setError(null);
    try { await action(); } catch (cause) { setError(message(cause, fallback)); } finally { setPendingJobId(null); }
  }

  async function openRuns(job: JobSummary): Promise<void> {
    rememberFocus();
    client.selectJob(job.id);
    client.selectJobRun(null);
    setConversationUnavailable(false);
    setError(null);
    try { await client.loadJobRuns(job.id); } catch (cause) { setError(message(cause, "Unable to load run history.")); }
  }

  async function selectRun(run: JobRunSummary): Promise<void> {
    client.selectJobRun(run.id);
    setConversationUnavailable(false);
    try { await client.loadJobRun(run.jobId, run.id); } catch (cause) { setError(message(cause, "Unable to load the run detail.")); }
  }

  async function abort(job: JobSummary, run: JobRunSummary): Promise<void> {
    await act(job, async () => {
      await client.send({ type: "job.abort", jobId: job.id, runId: run.id });
      await client.loadJobRun(job.id, run.id);
    }, "Unable to abort the run.");
  }

  return (
    <div className="jobs-shell">
      <div className="jobs-mobile-app-bar">
        <button
          ref={mobileNavigationTrigger}
          className="icon-button"
          type="button"
          aria-label="Open application navigation"
          aria-expanded={mobileNavigationOpen}
          onClick={() => setMobileNavigationOpen(true)}
        >
          <span aria-hidden="true">☰</span>
        </button>
        <strong>Jobs</strong>
        <span className={`connection-dot${connected ? " is-connected" : ""}`} title={connected ? "Connected" : "Disconnected"} />
      </div>
      {mobileNavigationOpen && (
        <>
          <button
            className="mobile-section-backdrop"
            type="button"
            aria-label="Close application navigation"
            onClick={closeMobileNavigation}
          />
          <aside className="mobile-section-drawer" aria-label="Application navigation">
            <div className="sidebar-brand">
              <div><strong>ChatWCA</strong><small>Local agent platform</small></div>
              <button
                ref={mobileNavigationClose}
                className="icon-button"
                type="button"
                aria-label="Close application navigation"
                onClick={closeMobileNavigation}
              >
                <span aria-hidden="true">×</span>
              </button>
            </div>
            <nav className="mobile-section-navigation is-standalone" aria-label="Mobile application sections">
              <button
                type="button"
                onClick={() => {
                  setMobileNavigationOpen(false);
                  onOpenConversations();
                }}
              >
                Conversations
              </button>
              <button type="button" aria-current="page" onClick={() => setMobileNavigationOpen(false)}>
                Jobs
              </button>
            </nav>
          </aside>
        </>
      )}
      <main className="jobs-page">
        <header className="jobs-header"><div><p className="eyebrow">Server-owned automation</p><h1>Scheduled jobs</h1><p>Saved prompts run under each workspace’s current policy, even when no browser is connected.</p></div><button type="button" className="primary-button" disabled={!connected || jobsConfig === undefined || state.workspaces.length === 0} onClick={() => { rememberFocus(); setError(null); setEditing("create"); }}>New job</button></header>
      <section className="jobs-toolbar" aria-label="Filter jobs">
        <label><span>Search</span><input type="search" value={search} placeholder="Name, workspace, or prompt" onChange={(event) => setSearch(event.target.value)} /></label>
        <label><span>Workspace</span><select value={workspaceFilter} onChange={(event) => setWorkspaceFilter(event.target.value)}><option value="">All workspaces</option>{state.workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
        <span className={`connection-state ${connected ? "is-connected" : ""}`}>{connected ? "Connected" : "Reconnecting…"}</span>
      </section>
      {error !== null && <p className="page-error jobs-error" role="alert">{error}</p>}
      {jobsConfig === undefined ? <div className="jobs-empty"><span className="loading-spinner" aria-hidden="true" /><p>Loading job configuration…</p></div> : !jobsConfig.schedulerAvailable ? <div className="jobs-empty"><h2>Scheduler unavailable</h2><p>Scheduled jobs are disabled by server configuration.</p></div> : <JobsTable jobs={filtered} connected={connected} pendingJobId={pendingJobId} onRun={(job) => void act(job, async () => { await client.send<"job.run">({ type: "job.run", jobId: job.id }); }, "Unable to start the job.")} onRuns={(job) => void openRuns(job)} onEdit={(job) => { rememberFocus(); setError(null); setEditing(job); }} onToggle={(job) => void act(job, () => client.send({ type: "job.update", jobId: job.id, enabled: !job.enabled }), `Unable to ${job.enabled ? "disable" : "enable"} the job.`)} onDelete={(job) => { if (!window.confirm(`Delete “${job.name}”? Run metadata will be removed. Generated conversations and workspace files will remain.`)) return; void act(job, () => client.send({ type: "job.delete", jobId: job.id }), "Unable to delete the job."); }} onAbort={(job) => { if (job.activeRun !== null) void abort(job, job.activeRun); }} />}
      {editing !== null && jobsConfig !== undefined && config !== undefined && <JobDialog job={editing === "create" ? undefined : editing} workspaces={state.workspaces} config={jobsConfig} managedEgressConfig={config.managedEgress} submitting={submitting} error={error} returnFocusRef={returnFocusRef} onSubmit={submitJob} onClose={() => { if (!submitting) { setEditing(null); setError(null); } }} />}
        {selectedJob !== undefined && <RunHistoryDialog job={selectedJob} runs={runs} detail={detail} selectedRunId={state.selectedJobRunId} loading={page?.loading ?? false} nextCursor={page?.nextCursor ?? null} unavailable={conversationUnavailable} returnFocusRef={returnFocusRef} onSelect={(run) => void selectRun(run)} onLoadMore={() => { const cursor = page?.nextCursor; if (cursor !== null && cursor !== undefined) void client.loadJobRuns(selectedJob.id, cursor).catch((cause: unknown) => setError(message(cause, "Unable to load older runs."))); }} onAbort={(run) => void abort(selectedJob, run)} onConversation={(run: JobRunState) => { if (run.conversationId === null) return; void onOpenConversation(selectedJob.workspaceId, run.conversationId).then((opened) => setConversationUnavailable(!opened)); }} onClose={() => { client.selectJob(null); client.selectJobRun(null); setConversationUnavailable(false); setError(null); }} />}
      </main>
    </div>
  );
}
