# Scheduled jobs operations runbook

This runbook covers production operation of ChatWCA's process-global scheduler and trusted host hooks. Read [`jobs-design.md`](jobs-design.md) for the full contract. Bubblewrap and managed-egress operations remain documented separately.

## Trust and deployment invariants

- Run **exactly one ChatWCA process** for one `CHATWCA_DATA_DIR`/Pi-state universe. SQLite transactions prevent same-job overlap inside that process; they are not leader election. Do not run a second service instance or Pi CLI against a live generated session.
- ChatWCA has no application authentication or roles. Every client admitted by the reverse proxy/firewall can create, alter, run, disable, abort, and delete jobs and can read explicit hook diagnostics. Prefer loopback behind authenticated mTLS.
- Scheduled prompts run without a browser. They may send any model-readable workspace or mount content to the configured provider, incur cost, and use destinations allowed by the workspace's current managed-egress set.
- Hooks are administrator-trusted host programs, not Pi tools. They bypass Bubblewrap and managed-egress controls and have the service user's normal host filesystem and network authority. Keeping scripts outside workspaces prevents agent rewriting; it does not make an untrusted script safe.
- A job stores only a workspace ID. Each run freshly resolves the canonical path, session location, security profile, mounts, network mode, and named destination set. A run then retains that immutable resolved policy until completion.

## Configuration

All settings are startup-only and require a restart.

| Variable | Default | Requirement |
|---|---:|---|
| `CHATWCA_JOB_SCRIPT_ROOTS` | `[]` | JSON string array of existing absolute canonical directories. Roots must be unique, non-overlapping, readable/searchable, and disjoint from every workspace, workspace mount, ChatWCA data path, Pi state/session path, and protected helper/runtime path. Empty disables hooks only. |
| `CHATWCA_JOB_HOOK_TIMEOUT_MS` | `300000` | Positive safe integer per hook, capped at `3600000` ms. |
| `CHATWCA_JOB_HOOK_MAX_OUTPUT_BYTES` | `1048576` | Positive safe integer aggregate bound across stdout and stderr for one hook. |
| `CHATWCA_MAX_LIVE_CONVERSATIONS` | `8` | Shared by interactive and scheduled conversations. Idle runtimes may be evicted; active runtimes never are. |
| `CHATWCA_SHUTDOWN_GRACE_MS` | `10000` | Whole-service shutdown bound, capped at `300000` ms. |
| `PI_CODING_AGENT_DIR` | Pi default | Pi configuration, credentials, and default history universe. Back it up separately from SQLite. |

Startup fails before listening if a configured hook root is relative, missing, noncanonical, inaccessible, duplicated/overlapping, or if hooks are enabled and `/usr/bin/bash` is not an executable regular file. `/api/config` exposes only safe availability/disclosure data and accepted root display paths.

### Safe filesystem layout

Use dedicated sibling trees owned by an administrator, not nested trees:

```text
/var/lib/chatwca/data/             # CHATWCA_DATA_DIR; service read/write
/var/lib/chatwca/pi-agent/         # PI_CODING_AGENT_DIR; service read/write
/srv/chatwca/workspaces/news/      # agent workspace; service read/write
/srv/chatwca/workspaces/build/     # another workspace
/etc/chatwca/job-hooks/            # trusted scripts; admin write, service read/search
```

Example permissions, adjusted for the deployment user/group:

```sh
sudo install -d -o root -g chatwca -m 0750 /etc/chatwca/job-hooks
sudo install -o root -g chatwca -m 0550 ./post-news.sh \
  /etc/chatwca/job-hooks/post-news.sh
sudo -u chatwca test -r /etc/chatwca/job-hooks/post-news.sh
sudo -u chatwca test -x /etc/chatwca/job-hooks
```

Do not give the ChatWCA service user directory write permission on script roots if avoidable. Do not place roots above workspaces (for example `/srv`) or place workspaces/mounts above a root. Both containment directions are rejected. Final script paths cannot be symlinks. ChatWCA stores the canonical path and revalidates both configured hooks before any side effect and each hook again immediately before spawning it.

The service account also needs:

- read/search, and normally write, access to each workspace;
- write access to `CHATWCA_DATA_DIR`, Pi's agent/default session directories, and every selected workspace-local `.chatwca/sessions` path;
- access required by configured mounts and runtime tools; and
- read access to hook files plus search access to every parent directory.

## Hook process contract

ChatWCA constructs an argv array equivalent to:

```text
/usr/bin/bash -- /canonical/root/script.sh
```

It does not use `bash -c`, interpolate prompt/model text into shell source, or accept browser-authored arguments/environment. The child has the workspace as `cwd`, is a new process-group leader, has stdin closed, and receives only fixed execution essentials plus:

```text
CHATWCA_JOB_ID
CHATWCA_JOB_NAME
CHATWCA_RUN_ID
CHATWCA_RUN_TRIGGER
CHATWCA_SCHEDULED_FOR
CHATWCA_WORKSPACE_ID
CHATWCA_WORKSPACE
CHATWCA_CONVERSATION_ID
CHATWCA_RUN_PHASE
CHATWCA_RUN_STATUS
```

`CHATWCA_CONVERSATION_ID` is empty for pre-run and populated for post-run. Post-run receives `CHATWCA_RUN_STATUS=succeeded` because it executes only after prompt success. Prompt text, script paths, provider credentials, and arbitrary parent environment are not deliberately forwarded. A script can still read anything available through service-user files or credential mechanisms.

Stdout and stderr are retained separately in SQLite but share one byte counter. Overflow terminates the process group with `job_hook_output_limit`. Timeout, abort, shutdown, output overflow, and execution errors send `SIGTERM` to the group followed by bounded `SIGKILL` escalation. Diagnostics are visible only in explicit run detail, never jobs/run-summary broadcasts. Treat the SQLite backup as sensitive.

Write hooks to be idempotent where practical. ChatWCA never retries a failed hook or resumes one after restart, but a process can crash after an external side effect and before terminal persistence. Use run IDs as external idempotency keys and atomic file updates when consequences matter.

## Scheduling and lifecycle

### Interval and daily behavior

- Interval schedules are fixed durations anchored to the server time at create or interval-schedule edit. Completion duration does not move future occurrences. Disable/re-enable preserves the anchor and selects the first future occurrence.
- Daily schedules use canonical `HH:mm` and an explicit IANA timezone. They perform calendar arithmetic, not `+24h`. A spring-forward gap selects the first valid instant after the gap; a fallback overlap selects the earlier occurrence and runs once.
- `next_run_at` is an authoritative persisted UTC epoch-millisecond instant. **Run now** neither changes it nor changes an interval anchor.
- Keep the host clock synchronized. Updating timezone data can change future daily calculations but never rewrites historical run times. The process's local timezone does not override a job timezone.

### Misfires, overlap, and capacity

- Startup marks all old `queued`/`running` rows `interrupted`; it never resumes a prompt or partially completed hook.
- Each enabled overdue job creates at most one `catch-up` run. `next_run_at` advances directly to the first occurrence after startup; missed occurrences are not replayed individually.
- A late timer wake similarly creates at most one due attempt and advances past all already-missed instants.
- If the same job is already active, a due occurrence is persisted as `skipped/job_already_running`. A manual overlap is rejected and creates no second attempt.
- Jobs and interactive conversations share runtime capacity. Capacity is reserved before a pre-hook, preventing a known capacity failure after a successful pre-hook side effect. If every slot is active, the scheduled attempt is `skipped/live_runtime_limit`; there is no retry.
- Browser disconnect does not affect execution. Completed job runtimes close, while their Pi JSONL sessions remain ordinary history that can be reopened and continued.

### Graceful shutdown and systemd

On `SIGINT` or `SIGTERM`, ChatWCA synchronously closes scheduler/manual/CRUD admission, cancels timers, signals hook groups and Pi work, marks unfinished attempts `interrupted`, seals late SQLite callbacks, then disposes runtimes/transports before closing SQLite. It never changes that result to a late hook/prompt completion. The sequence is bounded by `CHATWCA_SHUTDOWN_GRACE_MS`.

Keep these properties in the provided unit:

```ini
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=310s
NoNewPrivileges=true
TasksMax=512
LimitNOFILE=8192
```

`KillMode=control-group` is defense in depth if application cleanup or the Node process fails. `TimeoutStopSec` should exceed the configured shutdown grace. Do not use `KillMode=process`, and do not launch hooks into a different systemd scope. Validate after changing the service user, hardening, runtime path, or timeout:

```sh
sudo systemctl restart chatwca.service
systemctl status chatwca.service
journalctl -u chatwca.service -f
sudo systemctl stop chatwca.service
systemctl show chatwca.service -p ControlGroup -p KillMode -p Result
```

For a release check, use a harmless trusted hook that starts a child, records parent/child PIDs, and waits. Stop the unit during pre-hook and post-hook separately; verify the run is interrupted and no recorded process remains in the cgroup or process table. Also stop during a fake/test model stream. Never test process cleanup with a production side-effecting hook.

## Backup and restore

SQLite schema v7 is canonical for definitions, next-run state, and bounded run diagnostics. Pi JSONL is canonical for generated conversation content. A complete backup needs all of:

1. the whole `CHATWCA_DATA_DIR` (including SQLite WAL/SHM sidecars when applicable);
2. `PI_CODING_AGENT_DIR`, or at minimum the corresponding Pi default session store and required Pi configuration/credentials; and
3. every workspace using workspace-local storage, including `<workspace>/.chatwca/sessions`.

The safest file-copy procedure is:

```sh
sudo systemctl stop chatwca.service
# Verify the process and cgroup are gone, then copy all three storage classes.
# Preserve owners, modes, timestamps, and symlinks intentionally.
sudo systemctl start chatwca.service
```

A SQLite-aware online backup may run while the service is active. A plain copy of only `chatwca.sqlite` in WAL mode is not a valid online procedure. Do not infer conversation durability from a run row alone; SQLite contains IDs, not message bodies.

Restore only while ChatWCA is stopped:

1. preserve the failed/current state for forensic recovery;
2. restore the SQLite data directory and matching Pi/default and workspace-local stores;
3. restore owners and service-user permissions;
4. verify `.env` paths and script roots refer to the intended host locations;
5. start one process and inspect health, jobs, workspace availability, and run links.

On first startup, restored nonterminal rows become `interrupted`; overdue enabled definitions follow the one-catch-up rule. A restored run whose Pi file is absent remains valid metadata and shows **Conversation unavailable**. Restoring Pi files without matching SQLite preserves them as normal workspace history but not as job-run links.

## Rollout and rollback

1. Stop the service and take a complete pre-upgrade backup.
2. Deploy dependencies/build artifacts and run the release gates.
3. Start with `CHATWCA_JOB_SCRIPT_ROOTS=[]`. Verify schema migration, health/config, job CRUD, a disabled scriptless definition, and one manual fake/low-risk prompt.
4. Create administrator-owned roots, verify disjoint paths and permissions as the service user, configure the roots, and restart. Test harmless pre/post scripts, output bounds, and process-tree shutdown.
5. Enable production schedules gradually. Confirm next-run timezone rendering, generated history in both configured storage modes, provider usage/cost controls, and blocked behavior for representative unrestricted/sandboxed/managed workspaces.

Schema v7 migration creates empty job tables when upgrading v6 and is not automatically reversible. Older binaries reject a newer schema version. Code rollback therefore requires stopping the service and restoring the complete pre-upgrade SQLite backup; reconcile separately created Pi sessions as ordinary retained history. Never decrement `PRAGMA user_version` or drop/edit job tables by hand.

Disabling a job prevents future occurrences and is allowed during an active run, but does not abort that run. Removing hook roots on rollback makes existing hook-bearing jobs unable to run; it does not erase their paths. Prefer disabling affected jobs before restart. An individual invalid persisted job remains visible for repair and does not prevent scheduler startup.

## Troubleshooting and stable errors

| Code | Operator action |
|---|---|
| `job_disabled` | Enable intentionally before manual execution. |
| `job_already_running` / `job_busy` | Wait for or abort the active run. Editing/deletion is locked while active; disabling remains allowed. |
| `live_runtime_limit` | Wait/abort active work, close idle work, or raise the startup-only global limit. Scheduled attempts are not retried. |
| `job_script_roots_unavailable` | Configure roots and restart, or remove hooks. Verify fixed Bash availability. |
| `job_script_invalid` | Correct create/edit input: canonical readable regular non-symlink file beneath exactly one root, outside all execution/protected paths. |
| `job_script_unavailable` | A previously stored script/root changed, disappeared, lost permission, or now conflicts with current policy. Repair it before retrying. |
| `job_pre_run_failed` | Inspect bounded detail/logs. No conversation was created. Check exit code, cwd assumptions, service-user permissions, and idempotency. |
| `job_post_run_failed` | The prompt conversation is retained. Repair the post action and decide manually whether its external effect needs reconciliation; there is no retry button for the same attempt. |
| `job_hook_timeout` | Fix the script/process tree or raise the bounded timeout deliberately. Verify TERM handling. |
| `job_hook_output_limit` | Reduce output or deliberately raise the aggregate bound; avoid secrets. |
| `job_prompt_failed` | Inspect the generated conversation and private provider logs/settings. No automatic retry occurs. |
| `job_aborted` | Operator/client abort won the terminal race. Descendant cleanup should already be complete. |
| `job_interrupted` | Expected shutdown/crash recovery result. It is not resumed; inspect any external side effects before the next occurrence. |
| workspace/sandbox/network/model codes | Repair current workspace/runtime admission. Policy is resolved afresh and no hook starts when policy resolution fails. |

Public errors intentionally omit paths, process output, provider diagnostics, SQL text, and stacks. Use explicit run detail only from a trusted client and correlate by job/run ID in private service logs. Never “repair” scheduler state with direct SQL.

## Incident response

For unexpected side effects, suspected script compromise, credential disclosure, runaway cost, or duplicate scheduling:

1. Disable affected jobs if the service is trustworthy; otherwise stop the unit immediately and confirm its cgroup has no hook/model descendants.
2. Block provider/network access as appropriate. Remember hooks bypass managed egress and may use service-user host credentials.
3. Preserve SQLite including WAL/SHM, relevant Pi JSONL files, workspace state, script bytes/metadata, unit logs, and configuration. Hook output may itself contain sensitive material.
4. Compare the canonical script/root ownership and permissions with the deployed baseline. Inspect run IDs, phases, timestamps, conversation IDs, provider usage, and external idempotency records.
5. Rotate any credential readable by or emitted from the compromised service/hook. Remove leaked diagnostics from all backups/log sinks according to policy; deleting a job removes its SQLite run diagnostics but not generated Pi sessions or workspace artifacts.
6. Restore or redeploy trusted scripts, repair path separation, run release/systemd cleanup checks, and re-enable one job at a time.
7. If duplicate runs occurred, verify that only one ChatWCA process and no duplicate unit/container was using the state. SQLite's active-row index is not multi-process leadership.

## Release checklist

In addition to the automated gates in the README, perform these deployment-specific checks under the actual systemd unit:

- a scriptless job succeeds with no browser connected;
- two manual/recurring attempts have distinct session IDs and JSONL files;
- Pi-default and workspace-local jobs write to the expected stores;
- changing workspace policy/path affects the next run, while an unavailable policy blocks before hooks;
- harmless pre/post hooks observe pre → prompt → post order, exact cwd, and documented environment only;
- pre failure creates no conversation; post failure retains one;
- interactive and scheduled work share capacity, active ownership blocks mutation, and abort works;
- restart marks a seeded/in-progress attempt interrupted and creates only one overdue catch-up;
- stop during pre-hook, prompt, and post-hook kills descendants and leaves `interrupted` without late SQLite writes;
- deleting a completed job removes metadata but retains its Pi session and workspace files; and
- representative unrestricted, isolated, and managed-egress workspaces use their current effective policy.
