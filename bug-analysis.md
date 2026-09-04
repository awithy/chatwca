# Stuck scheduled-job abort analysis

## Summary

On September 4, 2026, the scheduled **Daily dom news** job became stuck while executing a sandboxed `bash` tool call. An operator abort terminated the Bubblewrap worker and its command process, but the abort operation itself deadlocked. ChatWCA consequently retained the live conversation in `aborting` state and the durable job-run row in `running` state.

The underlying problem is a circular wait between the sandbox controller's worker-replacement transition and Pi's agent-settlement path. This is an application lifecycle bug, not a still-running shell process, SQLite locking problem, or model-provider connection that remains active.

The failure was reproduced independently using a sandboxed Pi runtime whose Bash tool ran `sleep 300`. Calling `runtime.abort()` terminated the worker immediately but did not resolve within 10 seconds; Pi remained streaming. Instrumentation showed that worker invalidation completed and execution then blocked inside Pi's `session.abort()`.

## Impact

- One scheduled run remains incorrectly reported as active.
- The job cannot run again while same-job exclusion sees the active run.
- The associated conversation remains in `aborting` state.
- The requested output file, `09-04-domestic-news.md`, was not created.
- The dead Bash process is no longer consuming resources, but the in-memory runtime and job ownership remain retained.
- The other three jobs scheduled for the same time completed successfully.

## Affected records

| Field | Value |
|---|---|
| Job | `Daily dom news` |
| Job ID | `c6a4602d-d0ef-4499-8562-178d273a06f6` |
| Run ID | `d05a40fd-9cae-43e9-9c3e-7e56709af390` |
| Conversation ID | `01a06c9c-a411-7c44-9d5d-364b448e3319` |
| Workspace | `web-research` |
| Security profile | `workspace-sandboxed` |
| Network policy | `managed-egress` |
| Scheduled/start time | September 4, 2026 at 06:30 PDT |
| Durable run status | `running` |
| Durable run phase | `prompt` |
| Live conversation status | `aborting` |
| Last durable run revision | `3` |

## Timeline and observed evidence

1. All four daily briefing jobs were scheduled for 06:30 PDT.
2. `Daily dom news` started at `1788528600043` (06:30:00.043 PDT).
3. Its Pi JSONL transcript advanced normally through multiple searches and Bash calls.
4. At 06:33:57.625 PDT, the model emitted its final persisted assistant entry with a `bash` tool call. The command used Python `requests` to inspect three public news pages and specified a 60-second tool timeout.
5. No matching tool result was appended. The JSONL file stopped changing at that point and contains 118 entries.
6. A live `conversation.state` query reported:
   - status `aborting`;
   - revision `508`;
   - the final Bash tool call still marked `pending`.
7. A live `job.run.state` query and a read-only SQLite inspection both reported the run as `running` in the `prompt` phase.
8. Process inspection found no Bubblewrap worker or Bash command for the affected `web-research` conversation. This confirms that the abort successfully tore down the command namespace.
9. No active model-provider socket attributable to the run was found.
10. `09-04-domestic-news.md` does not exist.

The three sibling runs completed as follows:

| Job | Result | Completion time |
|---|---|---|
| Daily CIO/CTO breifing | Succeeded | 06:34:39 PDT |
| Daily cyber briefing | Succeeded | 06:35:46 PDT |
| Daily intl news | Succeeded | 06:36:44 PDT |

## Root cause

### Relevant code paths

The sandbox controller coordinates command cancellation and worker replacement:

- `src/server/sandbox/worker-controller.ts:150` races a worker operation against command timeout or the Pi-provided abort signal.
- `src/server/sandbox/worker-controller.ts:155` awaits `#plannedRestart()` when timeout or abort wins that race.
- `src/server/sandbox/worker-controller.ts:209-211` performs the planned restart by:
  1. invalidating the old worker;
  2. awaiting `abortActiveRun()`; and
  3. awaiting `waitForPiIdle()`.
- `src/server/pi-runtime.ts:881-882` binds those callbacks to Pi's `session.abort()` and `session.agent.waitForIdle()`.
- `src/server/conversation-registry.ts:1093` waits for `record.runtime.abort()` before returning the conversation to idle.
- `src/server/job-runner.ts:211` waits for the registry abort before the run can be finalized as aborted.

### Circular wait

When an operator aborts during an active sandbox Bash call, the following sequence occurs:

```text
operator abort
  -> SandboxController.#plannedRestart()
     -> old worker.invalidate() completes
     -> Pi session.abort()
        -> aborts the active agent signal
        -> waits for the Pi agent to become idle

active Bash tool observes the same aborted signal
  -> SandboxController.exec() selects its "abort" race branch
     -> awaits SandboxController.#plannedRestart()
        -> returns the already-running restart promise

Pi agent waits for Bash tool to settle
Bash tool waits for restart to settle
restart waits for Pi session.abort() / Pi idle
```

This is a self-coalescing promise cycle. Worker invalidation itself succeeds, so the operating-system process disappears, but the JavaScript promises cannot settle.

There is a narrow asynchronous race after worker invalidation: invalidating the worker rejects the pending worker operation, while the restart immediately aborts Pi's signal. In the observed and reproduced case, the signal-driven branch in `SandboxController.exec()` wins and waits for the same restart transition that is currently waiting for Pi.

### Why normal safeguards did not resolve it

- The Bash command timeout is enforced by the same `SandboxController.exec()` path. Once abort enters the circular wait, the command process is already gone and its original timeout cannot unwind the JavaScript dependency cycle.
- Repeated abort requests coalesce onto the same pending abort and restart promises, so they cannot break the cycle.
- The job-run row is finalized only after prompt/abort completion. Since that completion never occurs, SQLite correctly continues to reflect the process-local owner as `running`.
- The existing sandbox controller unit test verifies coalesced aborts with mocked workers and immediately settling Pi callbacks. It does not exercise a real active tool whose abort signal re-enters `#plannedRestart()`.
- The existing real Pi runtime test invokes `runtime.abort()` while the runtime is idle, so it does not cover this dependency cycle.

## Independent reproduction

A temporary isolated reproduction used the production `PiRuntimeFactory`, a faux provider, and a real Bubblewrap worker:

1. Configure the faux provider to request `bash` with `sleep 300`.
2. Start `runtime.prompt()` without awaiting its completion.
3. Wait for `tool_execution_start` for Bash.
4. Call `runtime.abort()`.
5. Race abort against a 10-second diagnostic timeout.

Observed result:

```text
tool started; aborting
abort result { kind: 'timeout' } elapsedMs 10002 isStreaming true
```

Additional instrumentation produced:

```text
calling runtime.abort
invalidate begin
invalidate end
session.abort begin true
... no session.abort completion ...
after5s streaming true
```

This reproduces the production symptom and localizes the wait to Pi settlement after successful worker invalidation.

## Recommended code change

The signal-driven abort path in `SandboxController.exec()` must not await the worker-replacement transition before allowing the active tool promise to reject. It should initiate or coalesce the restart, observe any eventual rejection, and immediately throw the abort reason. The outer `runtime.abort()` remains responsible for awaiting the full replacement transition.

Conceptually:

```ts
const restart = this.#plannedRestart();

if (outcome.reason === "abort") {
  void restart.catch(() => undefined);
  throw options.signal?.reason ?? new SandboxWorkerOperationError("cancelled");
}

await restart;
throw new SandboxWorkerOperationError("timeout");
```

The timeout path should continue awaiting worker replacement before returning a timeout failure. That preserves the invariant that a command timeout does not return control while the old namespace or replacement lifecycle is unresolved.

This change breaks the abort cycle:

1. the Bash tool rejects immediately after seeing Pi's abort signal;
2. Pi emits terminal tool/run events and becomes idle;
3. `session.abort()` resolves;
4. the already-running restart creates and handshakes a replacement worker; and
5. the outer abort resolves, allowing the job runner to persist `aborted`.

The implementation should continue to observe the detached restart promise so a replacement failure cannot become an unhandled rejection. Existing fatal-state notification remains responsible for publishing a terminal sandbox failure.

## Recommended regression coverage

Add a real sandbox/Pi integration test that:

1. uses a faux provider to issue a long-running Bash call;
2. waits for `tool_execution_start`;
3. calls `runtime.abort()`;
4. asserts that abort completes within a short bound;
5. asserts that the prompt settles as aborted;
6. asserts that the old worker and command descendants are gone;
7. asserts that the controller completes replacement and becomes healthy; and
8. submits a second prompt to prove the replacement worker is usable.

Also add unit coverage for an `exec()` abort signal arriving while an externally initiated `#plannedRestart()` is already in progress. The test should fail if the operation awaits that same transition before rejecting.

At the job-runner level, an integration test should verify that aborting a job during an active sandbox Bash call transitions the run from `running` to `aborted` with `job_aborted`, releases same-job exclusion, and disposes the job-owned conversation.

## Operational recovery

Restarting `chatwca.service` is the appropriate recovery for the currently wedged in-memory state. ChatWCA startup recovery will convert the nonterminal run to `interrupted`; the run must not be edited directly in SQLite.

A restart will close all currently live runtimes, although their completed Pi history remains persisted. After restart:

1. verify the affected run is `interrupted` rather than `running`;
2. verify no stale worker/helper process or private proxy socket remains for the affected conversation;
3. optionally use **Run now** to regenerate the missing domestic briefing; and
4. verify that a future abort during an active Bash call completes after the code fix is deployed.

## Investigation safety

The investigation used read-only SQLite access, process and journal inspection, read-only WebSocket state queries, and temporary isolated reproduction files. It did not modify the production database, restart the service, alter a production session, or change repository source files before this report was created.
