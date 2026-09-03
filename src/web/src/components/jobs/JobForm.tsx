import { useId, useMemo, useRef, useState, type FormEvent } from "react";

import {
  JOB_DAILY_TIME_PATTERN,
  JOB_INTERVAL_MINUTES_MAX,
  JOB_INTERVAL_MINUTES_MIN,
  JOB_NAME_MAX_LENGTH,
  JOB_PROMPT_MAX_LENGTH,
  JOB_SCRIPT_PATH_MAX_LENGTH,
  type JobScheduleInput,
  type JobSummary,
  type PublicJobsConfig,
} from "../../../../shared/jobs.js";
import type { PublicManagedEgressConfig, WorkspaceSummary } from "../../../../shared/protocol.js";
import { networkPolicyLabel, securityProfileLabel } from "../WorkspaceForm.js";

export interface JobFormValues {
  readonly name: string;
  readonly workspaceId: string;
  readonly prompt: string;
  readonly schedule: JobScheduleInput;
  readonly preRunScript: string | null;
  readonly postRunScript: string | null;
  readonly enabled: boolean;
  readonly acknowledgeHostHooks?: true;
}

export interface JobFormProps {
  readonly job?: JobSummary;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly config: PublicJobsConfig;
  readonly managedEgressConfig: PublicManagedEgressConfig;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly titleId: string;
  readonly onSubmit: (values: JobFormValues) => Promise<void>;
  readonly onCancel: () => void;
}

function scheduleInput(job: JobSummary | undefined): JobScheduleInput {
  if (job?.schedule.kind === "daily") return job.schedule;
  return { kind: "interval", intervalMinutes: job?.schedule.intervalMinutes ?? 60 };
}

export function JobForm({ job, workspaces, config, managedEgressConfig, submitting, error, titleId, onSubmit, onCancel }: JobFormProps) {
  const id = useId().replaceAll(":", "");
  const nameRef = useRef<HTMLInputElement>(null);
  const editing = job !== undefined;
  const initialSchedule = scheduleInput(job);
  const [name, setName] = useState(job?.name ?? "");
  const [workspaceId, setWorkspaceId] = useState(job?.workspaceId ?? workspaces[0]?.id ?? "");
  const [prompt, setPrompt] = useState(job?.prompt ?? "");
  const [scheduleKind, setScheduleKind] = useState<JobScheduleInput["kind"]>(initialSchedule.kind);
  const [intervalMinutes, setIntervalMinutes] = useState(initialSchedule.kind === "interval" ? String(initialSchedule.intervalMinutes) : "60");
  const [localTime, setLocalTime] = useState(initialSchedule.kind === "daily" ? initialSchedule.localTime : "09:00");
  const [timeZone, setTimeZone] = useState(initialSchedule.kind === "daily" ? initialSchedule.timeZone : "UTC");
  const [preRunScript, setPreRunScript] = useState(job?.preRunScript ?? "");
  const [postRunScript, setPostRunScript] = useState(job?.postRunScript ?? "");
  const [enabled, setEnabled] = useState(job?.enabled ?? true);
  const [acknowledged, setAcknowledged] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
  const hooksPresent = preRunScript.trim().length > 0 || postRunScript.trim().length > 0;
  const hooksChanged = (
    preRunScript.trim() !== (job?.preRunScript ?? "") ||
    postRunScript.trim() !== (job?.postRunScript ?? "") ||
    (job !== undefined && workspaceId !== job.workspaceId && hooksPresent)
  );
  const effective = workspace?.effectiveSecurityProfile;
  const destinationSet = managedEgressConfig.policySets.find((set) => set.id === workspace?.effectiveNetworkPolicySetId);
  const errorId = `${id}-error`;
  const zoneOptions = useMemo(() => config.supportedTimeZones, [config.supportedTimeZones]);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedPrompt = prompt;
    const pre = preRunScript.trim();
    const post = postRunScript.trim();
    let message: string | null = null;
    if (normalizedName.length === 0 || normalizedName.length > JOB_NAME_MAX_LENGTH) message = `Enter a name of at most ${JOB_NAME_MAX_LENGTH} characters.`;
    else if (workspace === undefined) message = "Select a workspace.";
    else if (!/\S/u.test(normalizedPrompt) || normalizedPrompt.length > JOB_PROMPT_MAX_LENGTH) message = "Enter a non-empty saved prompt.";
    else if ((pre.length > 0 && (!pre.startsWith("/") || pre.length > JOB_SCRIPT_PATH_MAX_LENGTH)) || (post.length > 0 && (!post.startsWith("/") || post.length > JOB_SCRIPT_PATH_MAX_LENGTH))) message = "Hook scripts must use absolute server paths.";
    else if (hooksPresent && !config.hooksAvailable) message = "Hooks are not enabled by the administrator.";
    else if (hooksChanged && !acknowledged) message = "Acknowledge the host authority of hook scripts.";

    let schedule: JobScheduleInput;
    if (scheduleKind === "interval") {
      const interval = Number(intervalMinutes);
      if (!Number.isInteger(interval) || interval < config.minIntervalMinutes || interval > config.maxIntervalMinutes) message ??= `Interval must be ${config.minIntervalMinutes}–${config.maxIntervalMinutes} minutes.`;
      schedule = { kind: "interval", intervalMinutes: interval };
    } else {
      if (!new RegExp(JOB_DAILY_TIME_PATTERN, "u").test(localTime)) message ??= "Daily time must use HH:mm in 24-hour form.";
      if (!zoneOptions.includes(timeZone)) message ??= "Select a supported IANA timezone.";
      schedule = { kind: "daily", localTime, timeZone };
    }
    if (message !== null) {
      setValidationError(message);
      nameRef.current?.focus();
      return;
    }
    setValidationError(null);
    await onSubmit({
      name: normalizedName,
      workspaceId,
      prompt: normalizedPrompt,
      schedule,
      preRunScript: pre.length === 0 ? null : pre,
      postRunScript: post.length === 0 ? null : post,
      enabled,
      ...(hooksChanged && acknowledged ? { acknowledgeHostHooks: true as const } : {}),
    });
  }

  return (
    <form className="job-form" aria-label={editing ? "Edit job" : "Create job"} aria-describedby={validationError !== null || error !== null ? errorId : undefined} onSubmit={(event) => void submit(event)}>
      <header className="modal-header">
        <div><p className="eyebrow">Scheduled automation</p><h2 id={titleId}>{editing ? "Edit job" : "Create job"}</h2></div>
        <button type="button" className="icon-button" aria-label="Close job editor" disabled={submitting} onClick={onCancel}>×</button>
      </header>
      <div className="job-form-body">
        {(validationError ?? error) !== null && <p id={errorId} className="form-error" role="alert">{validationError ?? error}</p>}
        <label htmlFor={`${id}-name`}>Name</label>
        <input ref={nameRef} data-initial-focus id={`${id}-name`} value={name} maxLength={JOB_NAME_MAX_LENGTH} disabled={submitting} onChange={(event) => { setName(event.target.value); setValidationError(null); }} />
        <label htmlFor={`${id}-workspace`}>Workspace</label>
        <select id={`${id}-workspace`} value={workspaceId} disabled={submitting} onChange={(event) => { setWorkspaceId(event.target.value); setAcknowledged(false); }}>
          {workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}{!item.available ? " — unavailable" : !item.usable ? " — blocked" : ""}</option>)}
        </select>
        {workspace !== undefined && (
          <dl className="job-policy-summary" aria-label="Effective workspace policy">
            <div><dt>Availability</dt><dd>{workspace.available ? workspace.usable ? "Usable" : "Blocked by policy" : "Directory unavailable"}</dd></div>
            <div><dt>Security</dt><dd>{effective === null || effective === undefined ? "Unavailable" : securityProfileLabel(effective)}</dd></div>
            <div><dt>Network</dt><dd>{workspace.effectiveNetworkPolicy === null ? "Host network (unrestricted profile)" : networkPolicyLabel(workspace.effectiveNetworkPolicy)}</dd></div>
            <div><dt>Destination policy</dt><dd>{destinationSet === undefined ? workspace.effectiveNetworkPolicySetId ?? "Not applicable" : `${destinationSet.label} · ${destinationSet.allowedDomainPatterns.join(", ")} · ports ${destinationSet.allowedPorts.join(", ")}`}</dd></div>
          </dl>
        )}
        <label htmlFor={`${id}-prompt`}>Saved prompt</label>
        <textarea id={`${id}-prompt`} rows={7} value={prompt} maxLength={JOB_PROMPT_MAX_LENGTH} disabled={submitting} onChange={(event) => setPrompt(event.target.value)} />
        <fieldset className="schedule-fields"><legend>Schedule</legend>
          <div className="segmented-control" role="group" aria-label="Schedule type">
            <button type="button" aria-pressed={scheduleKind === "interval"} disabled={submitting} onClick={() => {
              const value = Number(intervalMinutes);
              if (!Number.isInteger(value) || value < config.minIntervalMinutes || value > config.maxIntervalMinutes) setIntervalMinutes("60");
              setScheduleKind("interval");
            }}>Interval</button>
            <button type="button" aria-pressed={scheduleKind === "daily"} disabled={submitting} onClick={() => {
              if (!new RegExp(JOB_DAILY_TIME_PATTERN, "u").test(localTime)) setLocalTime("09:00");
              if (!zoneOptions.includes(timeZone)) setTimeZone("UTC");
              setScheduleKind("daily");
            }}>Daily</button>
          </div>
          {scheduleKind === "interval" ? <>
            <label htmlFor={`${id}-interval`}>Interval minutes</label>
            <input id={`${id}-interval`} type="number" min={JOB_INTERVAL_MINUTES_MIN} max={JOB_INTERVAL_MINUTES_MAX} value={intervalMinutes} disabled={submitting} onChange={(event) => setIntervalMinutes(event.target.value)} />
          </> : <div className="daily-fields">
            <div><label htmlFor={`${id}-time`}>Local time</label><input id={`${id}-time`} type="time" step="60" value={localTime} disabled={submitting} onChange={(event) => setLocalTime(event.target.value)} /></div>
            <div><label htmlFor={`${id}-zone`}>Timezone</label><select id={`${id}-zone`} value={timeZone} disabled={submitting} onChange={(event) => setTimeZone(event.target.value)}>{zoneOptions.map((zone) => <option key={zone} value={zone}>{zone}</option>)}</select></div>
          </div>}
        </fieldset>
        <fieldset className="hook-fields" disabled={submitting}><legend>Trusted host hooks (optional)</legend>
          {!config.hooksAvailable ? <p>Hooks are disabled by the administrator.</p> : <p>Accepted roots: {config.scriptRoots.join(", ")}</p>}
          <label htmlFor={`${id}-pre`}>Pre-run script</label><input id={`${id}-pre`} value={preRunScript} maxLength={JOB_SCRIPT_PATH_MAX_LENGTH} placeholder="/absolute/path/script.sh" spellCheck={false} onChange={(event) => { setPreRunScript(event.target.value); setAcknowledged(false); }} />
          <label htmlFor={`${id}-post`}>Post-run script</label><input id={`${id}-post`} value={postRunScript} maxLength={JOB_SCRIPT_PATH_MAX_LENGTH} placeholder="/absolute/path/script.sh" spellCheck={false} onChange={(event) => { setPostRunScript(event.target.value); setAcknowledged(false); }} />
          {(hooksPresent || hooksChanged) && <div className="job-disclosure"><strong>Host authority</strong><p>{config.hostAuthorityWarning}</p>{hooksChanged && <label className="checkbox-row"><input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} /> I understand and trust this hook configuration.</label>}</div>}
        </fieldset>
        <div className="job-disclosure unattended"><strong>Unattended usage</strong><p>{config.unattendedUsageWarning}</p></div>
        <label className="checkbox-row"><input type="checkbox" checked={enabled} disabled={submitting} onChange={(event) => setEnabled(event.target.checked)} /> Enabled (will run without a connected browser)</label>
      </div>
      <footer className="modal-actions"><button type="button" className="secondary-button" disabled={submitting} onClick={onCancel}>Cancel</button><button type="submit" className="primary-button" disabled={submitting || workspaces.length === 0}>{submitting ? "Saving…" : editing ? "Save changes" : "Create job"}</button></footer>
    </form>
  );
}
