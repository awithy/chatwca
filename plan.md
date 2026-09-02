# Scheduled Jobs Implementation Plan

## Objective

Implement [`docs/jobs-design.md`](docs/jobs-design.md) as a process-global scheduled-job service that persists job definitions and bounded run diagnostics in SQLite, executes each prompt in a fresh Pi conversation, and applies the workspace's current effective policy at the start of every run.

The central invariants are:

- Scheduling and execution do not depend on a browser connection.
- A job never has more than one queued/running run.
- Every prompt run gets a new persistent Pi session and uses the existing global runtime capacity limit.
- A job stores only `workspaceId`; runtime authority is freshly resolved for every run.
- Hooks are administrator-trusted host processes, never browser-authored shell source and never Pi tools.
- Hook roots cannot overlap any workspace or workspace mount, so sandboxed tools cannot rewrite a configured hook.
- SQLite is canonical for jobs/runs; Pi JSONL remains canonical for conversation content.
- Shutdown or restart never resumes an unfinished run or repeats a partially completed hook.

## Implementation decisions

These decisions close gaps in the proposed design and fit the current codebase:

1. **Use Temporal for calendar arithmetic.** Add `@js-temporal/polyfill` and calculate daily occurrences with `disambiguation: "compatible"`. This selects the first valid instant after a spring gap and the earlier instant during a fallback overlap. Do not perform daily calculations by adding 24 hours.
2. **Separate schedule input from stored schedule.** Browser interval input contains only `intervalMinutes`; the server assigns `anchorAt = now` on create or interval-schedule edit. The authoritative returned schedule includes `anchorAt`. Disabling/re-enabling preserves that anchor and computes the first future occurrence. This prevents browser clocks from establishing scheduling authority.
3. **Persist run revisions.** Add `revision INTEGER NOT NULL DEFAULT 0` to `job_runs`, although it is missing from the abbreviated design schema. A persisted revision is required for monotonic `job.run.updated` events and restart reconciliation.
4. **Back same-job exclusion with SQLite.** Add a partial unique index on `job_runs(job_id)` for `queued`/`running` rows. Repository transactions and an in-memory active map remain the normal coordination path; the index is the final same-process race guard, not multi-process leader election.
5. **Make job ownership atomic in `ConversationRegistry`.** A job conversation is registered with `{jobId, runId}` before any registry event is emitted. Browser mutation checks therefore cannot race conversation creation. Job-owned methods use the same registry capacity, runtime, event, and cleanup machinery as interactive conversations.
6. **Reserve runtime capacity before hooks.** Add a registry capacity lease used by the job runner. If no slot can be obtained, a scheduled run is immediately `skipped/live_runtime_limit`; a manual command records that skipped attempt and returns the same stable error. Holding the lease during the pre-hook prevents a successful host-side side effect from being followed by a known capacity rejection.
7. **Await actual prompt completion internally.** Keep browser `prompt.submit` acknowledgement semantics unchanged. Add a job-only registry operation that awaits `PiConversationRuntime.prompt()`, inspects the canonical terminal assistant entry, and reports success, provider failure, or abort to the runner.
8. **Validate both hooks before any side effect.** At run start, resolve the workspace policy and validate the pre- and post-hook paths. Revalidate each configured hook immediately before spawning it. Thus an invalid post-hook blocks the run before the pre-hook, while a later path replacement is still detected before that phase.
9. **Treat startup as the catch-up boundary.** Startup creates at most one `catch-up` run per overdue valid job and advances directly to the first occurrence after startup time. Later timer wakeups create at most one `scheduled` run per due job and likewise advance past all already-missed instants, avoiding replay storms after event-loop or clock delays.
10. **Use full snapshots for job definitions and revisions for run events.** CRUD broadcasts a complete `jobs` list. Active run changes use lightweight `job.run.updated` events; clients detecting a revision gap request `job.run.state`. Hook output appears only in explicit run detail responses.
11. **Keep completed sessions ordinary.** Job ownership exists only while the run owns a live runtime. Once the runner closes/disposes it, the session is an ordinary closed Pi conversation and can be reopened or continued without affecting the run row.
12. **Use bounded, opaque run cursors.** Run history is ordered by `(scheduled_for DESC, id DESC)` and uses a base64url cursor containing those two validated values. Default and maximum page sizes are server constants; the browser cannot submit SQL offsets.

## Phase 1 — Shared contract, configuration, and schema v7

### 1.1 Shared job types and validation

Add `src/shared/jobs.ts` and import its schemas into `src/shared/protocol.ts`.

Define closed TypeBox schemas and TypeScript types for:

- `JobScheduleInput`:
  - `{ kind: "interval"; intervalMinutes: number }`
  - `{ kind: "daily"; localTime: string; timeZone: string }`
- Authoritative `JobSchedule`, adding `anchorAt` to the interval variant.
- `JobSummary`, including definition fields, enabled/next-run state, workspace display data, active run summary, last run summary, and a safe configuration issue when a persisted row cannot run.
- `JobRunSummary`, excluding hook stdout/stderr.
- `JobRunState`, including bounded pre/post diagnostics and generated-conversation availability.
- Trigger, status, phase, and stable error-code unions.

Centralize application limits in the shared module so wire and repository validation agree. Use explicit initial limits such as:

- name: 1–200 trimmed characters;
- prompt: non-whitespace and at most 100,000 characters;
- script path: at most 4,096 characters;
- interval: 1–525,600 minutes;
- `HH:mm`: canonical zero-padded 24-hour form;
- IDs/request cursors: existing identifier/request limits.

The server must also reject unsafe integer timestamps and unsupported timezones even when a value passes structural TypeBox checks.

### 1.2 Stable errors

Extend `src/shared/errors.ts` with the job codes from the design:

- lookup/validation/lifecycle: `job_not_found`, `job_invalid`, `job_busy`, `job_disabled`, `job_already_running`;
- hook policy/execution: `job_script_roots_unavailable`, `job_script_invalid`, `job_script_unavailable`, `job_pre_run_failed`, `job_post_run_failed`, `job_hook_timeout`, `job_hook_output_limit`;
- prompt/lifecycle: `job_prompt_failed`, `job_aborted`, `job_interrupted`.

Add a `job` error context and client-safe default messages. Continue reusing existing workspace, sandbox, network, model, runtime, and `live_runtime_limit` codes where they are the direct cause. Never serialize host paths, child-process diagnostics, stacks, provider errors, or SQL messages.

### 1.3 Job process configuration

Add `src/server/job-config.ts` and compose it from `src/server/config.ts` as `ServerConfig.jobs`.

Parse and validate:

- `CHATWCA_JOB_SCRIPT_ROOTS`, default `[]`, as a JSON string array;
- `CHATWCA_JOB_HOOK_TIMEOUT_MS`, default `300000`, positive and capped at `3600000`;
- `CHATWCA_JOB_HOOK_MAX_OUTPUT_BYTES`, default `1048576`, positive safe integer.

At startup:

- require absolute, canonical, existing directories;
- require read/search access;
- reject canonical duplicates and overlapping roots, ensuring a script can be beneath exactly one root;
- validate `/usr/bin/bash` as an executable regular file when hooks are enabled;
- freeze the resulting configuration.

Extend `PublicConfigSchema` and `/api/config` with a safe jobs projection containing scheduler availability, hooks availability, accepted root display paths, interval bounds, supported IANA timezones, and the host-authority/unattended-usage disclosures. Do not expose unrelated protected paths or private root validation details.

Update `.env.example` and configuration tests. Add `tests/unit/job-config.test.ts` for malformed JSON, empty entries, relative/missing/inaccessible roots, duplicates/overlap, timeout cap, output bounds, and disabled-hook behavior.

### 1.4 SQLite migration

Update `src/server/database.ts`:

- Set `DATABASE_SCHEMA_VERSION` to `7`.
- Add `jobs` and `job_runs` to `INITIAL_SCHEMA` with the checks and foreign keys in the design.
- Include persisted `job_runs.revision`.
- Add `jobs_due_idx`, `job_runs_job_time_idx`, and the partial active-run unique index.
- Add a transaction-scoped `migrateVersionSix()` that creates only these empty tables/indexes and then sets `user_version = 7`.
- Route all prior migration paths through v6 and then v7 while preserving the current stepwise rollback behavior.

Extend `tests/unit/database.test.ts` for fresh v7 creation, v6→v7 migration, prior-version chains, all CHECK/FK/index constraints, empty migrated job data, rollback, and rejection of versions above 7.

## Phase 2 — Recurrence calculations and repositories

### 2.1 Deterministic schedule engine

Add `src/server/job-schedule.ts` with pure functions:

- validate and normalize schedule input;
- establish an interval anchor on create/edit;
- compute the first occurrence strictly after a supplied instant;
- advance from a persisted occurrence to the first occurrence strictly after `now`;
- format the scheduled instant for the generated conversation title.

For intervals, use integer arithmetic from `anchorAt`; never advance from run completion. Guard multiplication/addition against unsafe integers.

For daily schedules, build a local date/time in the selected IANA zone with Temporal and `disambiguation: "compatible"`, then move calendar dates rather than adding milliseconds. Daily titles use the job timezone and abbreviation; interval titles use an unambiguous UTC timestamp.

Add `tests/unit/job-schedule.test.ts` covering:

- exact-boundary and first-future behavior;
- no drift after long runs;
- large missed intervals without per-occurrence loops;
- safe-integer boundaries;
- invalid/canonical times and unsupported zones;
- spring gaps and fallback ambiguity in representative zones;
- non-hour DST transitions;
- process-local-timezone independence.

### 2.2 Job repository

Add `src/server/job-repository.ts`. Prepare statements once and wrap all unknown SQLite failures with `database_error`.

Provide transactional operations for:

- list/get job definitions and summaries;
- create/update/enable/disable/delete;
- detect jobs referencing a workspace;
- claim a manual run without changing `next_run_at`;
- claim a due scheduled run while advancing `next_run_at` in the same transaction;
- claim one startup catch-up and advance directly past startup time;
- persist `queued → running → terminal` state transitions with compare-and-set predicates;
- increment and return the persisted run revision for every externally visible update;
- attach a conversation ID immediately after registry creation;
- persist each hook's exit code/output before moving phases;
- mark all leftover queued/running rows `interrupted` during startup;
- list cursor-paginated summaries and fetch explicit run detail.

Validation and update rules:

- Create computes the first future occurrence if enabled; disabled creates `next_run_at = NULL`.
- Schedule edits compute a new first future occurrence. Interval edits establish a new server anchor.
- Prompt/name/hook/workspace-only edits preserve schedule state.
- Disabling sets `next_run_at = NULL`; enabling computes from the stored schedule/anchor.
- `Run now` rejects disabled jobs and leaves schedule/anchor unchanged.
- Any definition edit or delete is rejected while active, except disabling an active job.
- Deleting cascades run rows but never touches Pi files.
- Hook acknowledgement is required when adding/changing a hook or changing the workspace while hooks remain configured; reject a meaningless acknowledgement.
- Partial update of a structurally invalid persisted row is not allowed to hide the problem; the editor sends a complete valid replacement to repair it.

A due claim that finds the job active creates one terminal `skipped/job_already_running` row and still advances the schedule. A manual overlap returns `job_already_running` and creates no second run.

Add `tests/unit/job-repository.test.ts` for CRUD, sorting, validation, enabled/next invariants, anchor changes, manual schedule preservation, claims, overlap races, revisions, pagination, FK restrictions, deletion behavior, and interrupted recovery.

### 2.3 Workspace deletion and protected-path integration

Extend `WorkspacePolicyInputs` in `src/server/workspace-repository.ts` with canonical job script roots.

- Treat script roots as protected against every workspace path and every mount, not only at hook execution time.
- Reuse `canonicalPathsOverlap` from `sandbox/admission.ts` rather than duplicating containment logic.
- Mark an existing overlapping workspace unusable with the existing safe `protected_path_overlap` issue.
- Reject create/path/mount updates that introduce overlap.
- Before `workspace.delete`, have protocol/job services report configured references as `workspace_busy`; the database FK remains the final `RESTRICT` guard.

Pass script roots into network-helper validation, sandbox hidden/protected paths, and workspace repository construction in `src/server/index.ts` where applicable.

Extend workspace policy/repository tests for roots above, below, and equal to workspace/mount paths, including unrestricted workspace definitions and roots introduced on restart.

## Phase 3 — Trusted hook execution

### 3.1 Hook path admission

Add `src/server/job-hook-path.ts` with injectable filesystem operations for deterministic tests.

For job create/update and every run:

1. reject NUL, non-absolute, overlong, or empty paths;
2. `lstat` the submitted final component and reject symlinks;
3. `realpath` and normalize it;
4. require a readable regular file;
5. require containment beneath exactly one configured root;
6. reject overlap/containment with the selected workspace, all workspace mounts, ChatWCA data, Pi state/session locations, native helper/worker paths, sandbox runtime mounts, and other protected runtime paths;
7. ensure canonical identity has not changed at the end of validation.

An empty root set accepts jobs without hooks and rejects any non-null hook. Store canonical script paths only. Distinguish invalid create/update input (`job_script_invalid`) from a previously valid path unavailable at run time (`job_script_unavailable`).

### 3.2 Hook process owner

Add `src/server/job-hook-runner.ts`.

Spawn exactly:

```ts
spawn("/usr/bin/bash", ["--", canonicalScriptPath], {
  cwd: policy.cwd,
  env: buildHookEnvironment(run),
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
```

Build the environment from an explicit allowlist only:

- execution essentials: `HOME`, `LANG`, fixed safe `PATH`;
- the documented `CHATWCA_*` job/run metadata.

Do not spread `process.env`; do not include prompt text, script paths, provider credentials, arbitrary arguments, or browser-provided environment values.

Capture stdout/stderr as raw buffers while enforcing one aggregate byte counter. If the next chunk crosses the limit, retain only bytes up to the configured bound, terminate the process group, and return `job_hook_output_limit`. Decode once with UTF-8 replacement before persistence. Handle spawn failure, nonzero exit, signals, timeout, abort, and shutdown with one idempotent completion path.

On timeout/abort/shutdown, signal `-pid` with `SIGTERM`, wait a short fixed grace interval, then `SIGKILL` the process group. Clear all timers/listeners and tolerate already-exited groups. Track active groups so process shutdown can synchronously close admission and terminate every hook descendant.

Add `tests/unit/job-hook-path.test.ts` and `tests/unit/job-hook-runner.test.ts` for containment, final symlinks, type/permission changes, path swaps, environment sanitation, exact argv/cwd, aggregate interleaved output, UTF-8 boundaries, exit/signal mapping, timeout, abort, TERM→KILL escalation, and idempotent cleanup. Integration tests should use harmless temporary scripts and verify process-tree termination on Linux.

## Phase 4 — Conversation ownership and job runner

### 4.1 Extend `ConversationRegistry`

Update `src/server/conversation-registry.ts`, `src/server/session-history.ts`, and shared conversation projections.

Add optional live ownership metadata:

```ts
{ kind: "scheduled-job"; jobId: string; runId: string }
```

Expose only safe IDs in `ConversationState`/`ConversationSummary` so the UI can render a **Scheduled job** badge and run link. Session history gets this metadata through its existing live-registry lookup; closed sessions have no owner badge.

Add registry operations to:

- reserve/release/promote a runtime-capacity lease using the existing serialized LRU capacity logic;
- atomically create and register a persistent job-owned conversation from a resolved policy and lease;
- assign the generated title through Pi session metadata;
- run a prompt for the matching run owner and await its terminal result;
- release ownership and dispose the runtime after the job reaches a terminal state;
- query an active owner for protocol guards.

Reject browser prompt, steer, follow-up, fork, rewind, rename, close, and delete operations while job ownership is active. Permit state/history observation, images, and abort. Keep the owner attached between prompt idle/error and disposal so there is no continuation race. An allowed `conversation.abort` must abort the owning run as well as Pi work.

Do not change immediate acknowledgement behavior for ordinary interactive prompts. Add focused registry tests for atomic ownership, global capacity/LRU interaction, mutation rejection, external abort, title persistence, completion classification, and ordinary behavior after disposal/reopen.

### 4.2 Job runner state machine

Add `src/server/job-runner.ts`. It owns an in-memory map keyed by job ID/run ID and accepts already-persisted queued runs from scheduler/manual claims.

For each run:

1. mark it running and broadcast revisioned state;
2. resolve `WorkspaceRepository.requireUsable(job.workspaceId)` once and retain the frozen policy;
3. validate both configured hooks against that policy and current protected paths;
4. acquire/promote the reserved registry capacity lease;
5. run and persist the pre-hook result, if configured;
6. create a fresh job-owned conversation, persist its ID immediately, and assign `[Job] … — <scheduled time>`;
7. submit the saved prompt through the job-only completion API;
8. classify terminal assistant success, provider failure, external abort, or runtime failure;
9. run/persist the post-hook only after prompt success, with conversation ID and prompt status in the environment;
10. atomically mark the final run status/error/phase;
11. release job ownership and close the runtime while retaining the Pi session.

Acquire capacity before step 5 but do not create a conversation until the pre-hook succeeds. Release the lease on every pre-conversation failure. Validate both hooks before capacity admission where possible, but perform no hook side effect before capacity is secured.

State/error classification:

- unusable current policy or invalid/unavailable hook path before execution: `blocked`;
- capacity or scheduled overlap: `skipped`;
- nonzero/timeout/output-limit hook, accepted prompt failure, or post-hook failure: `failed` with phase;
- operator/browser abort: `aborted/job_aborted`;
- shutdown or startup recovery: `interrupted/job_interrupted`;
- successful prompt and required post-hook: `succeeded`.

A pre-hook failure leaves `conversation_id` null. A post-hook failure retains and links the completed conversation. Cleanup errors are logged privately and must not overwrite an already committed terminal result.

Use compare-and-set terminal updates so abort, runtime completion, hook exit, and shutdown cannot each finalize the same run. Add `tests/unit/job-runner.test.ts` with fake registry/workspace/hook ports for every state transition and race.

## Phase 5 — Scheduler and process lifecycle

### 5.1 Scheduler

Add `src/server/job-scheduler.ts` with injected clock/timer functions.

Startup sequence:

1. mark all old queued/running rows interrupted in one transaction;
2. load enabled jobs without scanning Pi history;
3. ignore invalid persisted definitions for dispatch while exposing their blocked configuration state;
4. claim at most one catch-up run per overdue job and advance each to its first future occurrence;
5. dispatch claimed runs without awaiting their completion;
6. arm one timer for the nearest valid future occurrence.

Timer wakeup behavior:

- cap delay below Node's maximum timer delay and re-query SQLite on every wake;
- compare persisted timestamps with the wall clock rather than trusting timer punctuality;
- transactionally claim each due job and advance its schedule;
- dispatch different jobs independently;
- record one skipped row when the same job is active;
- re-arm from authoritative persisted state after all claims.

`Run now` goes through the same runner and active map but never changes `next_run_at`. It rejects disabled/busy jobs and reports capacity failure with `live_runtime_limit`.

Add `tests/unit/job-scheduler.test.ts` for distant capped timers, early/late wakeups, multiple due jobs, no drift, active overlap, one catch-up after many misses, invalid rows, manual schedule preservation, clock jumps, and stop/restart idempotence.

### 5.2 Startup and graceful shutdown

Add a process-level coordinator (for example `src/server/runtime-coordinator.ts`) implementing the existing `ShutdownRuntimeOwner` contract for both jobs and the conversation registry.

Wire `src/server/index.ts` in this order:

1. configuration and database migration;
2. sandbox/network validation;
3. workspace and job repositories;
4. Pi runtime factory and conversation registry;
5. hook runner, job runner, and scheduler;
6. scheduler recovery/start;
7. HTTP/WebSocket server construction and listener binding.

Scheduler initialization failure must unwind all resources and prevent listening. A catch-up run may continue after readiness, but its claim/recovery must complete before the listener reports ready.

On shutdown, synchronously:

- reject scheduler/manual/CRUD admission;
- cancel scheduler timers;
- terminate hook process groups;
- request aborts for job-owned and interactive Pi runs;
- mark every unfinished job row interrupted and prevent late runner callbacks from writing another terminal result;
- detach protocol listeners;
- dispose all registry runtimes;
- close transports and SQLite under the existing grace deadline.

Extend `tests/unit/startup.test.ts`, `tests/unit/shutdown.test.ts`, and integration shutdown tests to assert ordering, no startup history scan, interrupted persistence, hook descendants terminated, no post-close SQLite callbacks, and complete unwind on initialization/listen failure.

## Phase 6 — WebSocket protocol and broadcasts

### 6.1 Commands and responses

Extend `src/shared/protocol.ts`, `src/server/protocol.ts`, and browser client response correlation with closed schemas for all design commands, each requiring `requestId`:

- `job.list`, `job.create`, `job.update`, `job.delete`;
- `job.run`, `job.abort`;
- `job.runs`, `job.run.state`.

Use these success responses:

- list/create/update: correlated full `jobs` snapshot;
- delete/abort: correlated `ack`;
- run: correlated `job.run.state` for the accepted attempt;
- runs: correlated paginated `job.runs`;
- run state: correlated detailed `job.run.state`.

Add uncorrelated broadcasts:

- full `jobs` after definition changes and whenever summary-visible active/last/next state changes;
- `job.run.updated` with summary-only data and persisted revision.

Never put hook output in `jobs` or `job.run.updated`. Add job-run subscription/revision-gap handling without changing conversation revisions. Extend `OutboundFlowController` only if needed to coalesce adjacent uncorrelated `jobs` snapshots; correlated details and run terminal updates must remain non-droppable.

### 6.2 Authorization and lifecycle guards

The dispatcher must:

- call only server-owned workspace policy resolution;
- reject browser-authored anchors, shell arguments, environment maps, policies, and destinations at TypeBox decoding;
- check job references before workspace deletion;
- reject edit/delete while active, but allow disable;
- route conversation abort to the owning job runner;
- reject all other mutation of active job conversations;
- stop all job commands after shutdown admission closes.

Add protocol unit/integration tests for every command/response pair, unknown fields, hook acknowledgement, broadcasts, pagination, revision resync, workspace deletion restriction, active conversation guards, redacted errors, disconnected execution, and slow-client behavior.

## Phase 7 — Frontend

### 7.1 Application shell and client state

Refactor `src/web/src/App.tsx` into a small top-level section coordinator and move the existing conversation UI into a `ConversationsPage` component without changing its behavior.

Add `AppNavigation` and a browser-memory-only section state (`"conversations" | "jobs"`). The rail must have text/tooltip labels, selected state, visible keyboard focus, responsive collapse behavior, and no effect on active server work.

Extend `src/web/src/api/state.ts` and `client.ts` with:

- authoritative jobs snapshot;
- per-job run pages/details;
- persisted revision handling for active run updates;
- selected job/run browser state;
- reconnect recovery (`workspace.list` and `job.list`, then only selected run detail/history as needed);
- helpers to navigate from a run to its active or persisted conversation.

### 7.2 Jobs table

Add components under `src/web/src/components/jobs/`:

- `JobsPage.tsx` and `JobsTable.tsx`;
- text search and workspace filter, local to the Jobs section;
- columns for name, workspace, schedule, last run, next run, status, enabled, and actions;
- `Run now`, `View runs`, `Edit`, enable/disable, and delete actions;
- explicit text/icon status so color is not the only signal;
- exact accessible timestamps and schedule-zone formatting.

Use `Intl.DateTimeFormat` with the job timezone for daily rows. Display interval instants unambiguously and never calculate authoritative next-run state in the browser.

### 7.3 Job editor

Reuse the focus trap/portal behavior currently implemented by `WorkspaceDialog` by extracting a generic modal shell, then add `JobDialog.tsx` and `JobForm.tsx`.

The form includes all design fields and:

- switches interval/daily controls without retaining invalid hidden values;
- uses the server-provided timezone list;
- shows workspace availability and effective security/network/destination policy;
- shows accepted hook-root display paths only when hooks are enabled;
- requires a host-authority checkbox when adding/changing hooks;
- warns about unattended provider cost/data disclosure;
- performs preliminary bounds/time/path checks but renders server errors authoritatively;
- locks edits/deletion during active runs while keeping disable and abort separate.

Delete confirmation must state that run metadata is removed but generated conversations/workspace files remain.

### 7.4 Run history/detail and conversation integration

Add cursor-paginated run history and a detail panel/modal showing trigger, timestamps, duration, status, phase, stable error, hook exit codes, and escaped `<pre>` stdout/stderr. Never render hook output as Markdown or HTML.

For generated-conversation links:

- if live, switch to Conversations, select its workspace, and request `conversation.state`;
- if closed, switch/select workspace, refresh scoped history, and open it through the existing guarded path;
- if absent from Pi's scoped listing, show “Conversation unavailable” without treating the run as corrupt.

Update `ConversationHeader` (and history rows where applicable) to show a **Scheduled job** badge/link only for an active job owner. Disable all forbidden controls while retaining Abort.

Extend `app.css` with the global shell/rail, responsive Jobs table/cards, modal, status badges, output panes, narrow viewport behavior, and dark-only focus/contrast states.

## Phase 8 — Documentation, integration, and release gates

### 8.1 Documentation

Update `README.md` and `.env.example` with:

- all job environment variables and defaults;
- single-process scheduler requirement;
- schedule/DST/misfire/restart behavior;
- host-side hook trust boundary and fixed Bash invocation;
- unattended model usage/data disclosure;
- backup/restore behavior for SQLite and Pi sessions;
- job/script/workspace troubleshooting and stable errors;
- shutdown behavior and service-user permissions.

Add `docs/jobs-operations.md` if the README section becomes too large, covering safe script-root layout, systemd process cleanup, rollout/rollback, restore, and incident response.

### 8.2 Integration tests

Add integration fixtures with temporary SQLite, Pi state, workspaces, script roots, and a fake deterministic provider. Cover the complete matrix from the design, especially:

- execution with zero WebSocket clients;
- distinct session IDs/files for repeated occurrences;
- workspace-local versus Pi-default session storage;
- fresh policy resolution on every run;
- blocked policy before any hook;
- pre/post ordering and environment;
- pre failure with no conversation;
- post failure with retained conversation;
- runtime capacity shared with interactive conversations;
- active owner mutation rejection and external abort;
- manual schedule preservation and same-job exclusion;
- startup interruption and one catch-up;
- graceful shutdown during each phase;
- deletion retaining generated sessions.

### 8.3 Browser tests

Extend the deterministic browser fixture with an in-memory jobs service and add Playwright coverage for:

- accessible rail navigation and narrow layout;
- interval/daily creation and timezone display;
- hook warning/acknowledgement;
- filtering and all row actions;
- live status updates and abort;
- edit/delete locks with disable still available;
- escaped/bounded hook detail;
- conversation navigation and missing-session fallback;
- focus containment/restoration, labels, and keyboard operation.

### 8.4 Final verification

Run and fix the complete project gates:

```sh
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm run test:browser
npm run test:sdk-smoke
npm run test:native
npm run test:native:architectures
npm run test:sandbox-real
```

Manually smoke-test under the provided systemd unit with a real trusted hook containing a child process. Verify schedule behavior across a restart, process-group cleanup, generated Pi history, workspace-local sessions, and both unrestricted and sandboxed workspace policies.

## Completion criteria

Implementation is complete when every acceptance criterion in `docs/jobs-design.md` is covered by an automated test or an explicit systemd/manual release check, and when the following cross-cutting guarantees hold:

- no browser field can widen runtime or hook authority;
- no hook output or host diagnostic leaks through summary broadcasts;
- no same-job overlap survives repository/runner races;
- no restart resumes a nonterminal run;
- no run completion callback can write after shutdown closes SQLite;
- no job path can bypass current workspace admission or registry capacity;
- no job deletion removes a Pi session or workspace artifact;
- interactive conversation behavior and revision semantics remain backward-compatible.
