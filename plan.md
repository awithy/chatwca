# ChatWCA Workspace Changes Plan

This plan records the completed migration to the workspace design in [`docs/design.md`](docs/design.md). The previous implementation used a global Pi history list; the migration replaced that behavior with SQLite-backed workspace definitions and workspace-scoped Pi session discovery.

**Status: Complete.** All phases and tasks below have been implemented and validated.

## Delivery principles

- A workspace is a ChatWCA-owned record containing a stable ID, name, and canonical directory path.
- SQLite is canonical only for workspace definitions. Pi JSONL remains canonical for conversations and messages.
- Opening ChatWCA or connecting a browser must not scan Pi session history.
- Pi sessions are listed only after a browser selects a workspace, using `SessionManager.list(workspace.path)`.
- Normal application code must not call `SessionManager.listAll()`.
- Workspace selection is browser-local and is not persisted in SQLite.
- Conversation runtimes remain process-wide and may continue running when another workspace is selected.
- Workspace IDs and conversation IDs supplied by the browser are never trusted as filesystem authority. Open and delete operations use a fresh workspace-scoped Pi listing.
- No migration or automatic import from the previous global-history behavior is required.

## Out of scope

- Storing conversations, messages, or Pi session files in SQLite
- Automatically discovering workspaces by scanning all Pi sessions
- Migrating a pre-release workspace database or old browser state
- Persisting the selected workspace across a full page reload
- Deleting workspace directories or their Pi sessions when a workspace is removed
- Supporting multiple ChatWCA processes writing the same database or Pi sessions
- Recursive session discovery beneath a workspace path; a workspace maps to one exact Pi CWD

## Phase 1 — SQLite foundation and configuration

### T1.1 Add SQLite dependencies and ignored storage

- Add `better-sqlite3` and its TypeScript declarations to `package.json` and `package-lock.json`.
- Add `/data/` to `.gitignore` so the database, WAL, shared-memory, and journal files are ignored.
- Do not commit a placeholder inside `data`; create the directory at runtime.
- Verify `npm ci` works on the minimum supported Node.js version and in CI.

### T1.2 Replace default-CWD configuration with data-directory configuration

Update `src/server/config.ts`:

- Add `CHATWCA_DATA_DIR`, defaulting to `./data` relative to the server process CWD.
- Resolve the configured value to an absolute path.
- Reject an explicitly empty value.
- Remove `CHATWCA_DEFAULT_CWD` and `ServerConfig.defaultCwd`.
- Keep database paths out of `/api/config`; the browser does not need them.
- Remove `defaultCwd` from the browser-safe config response and frontend config type.

Update configuration tests to cover default, relative, absolute, and empty data-directory values, and remove default-CWD expectations.

### T1.3 Implement database lifecycle

Add `src/server/database.ts` with a narrow database-opening boundary:

- Create the configured data directory recursively before opening the database.
- Open `<dataDir>/chatwca.sqlite` with `better-sqlite3`.
- Configure a bounded busy timeout, foreign keys, and WAL mode.
- Initialize a new database transactionally when `PRAGMA user_version` is `0`.
- Create the `workspaces` table and set `user_version` to `1`.
- Accept schema version `1`; fail startup for unsupported versions rather than guessing or migrating.
- Expose an idempotent `close()` operation.
- Ensure startup failures close a partially opened database and produce a useful server-side diagnostic without exposing local details over WebSocket.

Initial schema:

```sql
CREATE TABLE workspaces (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  path       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Add unit tests using temporary files and `:memory:` databases for initialization, reopening, unsupported versions, and close behavior.

**Phase 1 exit criteria:** A clean checkout creates a gitignored `data/chatwca.sqlite` at startup, configuration no longer exposes a default CWD, and database initialization is deterministic and tested.

## Phase 2 — Workspace domain and repository

### T2.1 Define workspace wire types

In `src/shared/protocol.ts`, add closed TypeBox schemas and inferred types for:

```ts
interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  updatedAt: number;
}

interface WorkspaceSummary extends Workspace {
  available: boolean;
}
```

Add commands:

```ts
workspace.list
workspace.create { name, path }
workspace.update { workspaceId, name?, path? }
workspace.delete { workspaceId }
```

Define exact correlated responses:

- `workspace.list`, `workspace.create`, and `workspace.update` return a `workspaces` message containing the authoritative ordered workspace list.
- `workspace.delete` returns an acknowledgement; the server also broadcasts an uncorrelated authoritative `workspaces` message.
- Workspace create/update also broadcast the authoritative list to other sockets.

Make `requestId` optional only on server broadcasts and required on correlated responses, following the existing history-message pattern. Reject an update containing neither `name` nor `path`.

### T2.2 Add workspace errors

Extend `src/shared/errors.ts` with stable codes and safe messages for:

- workspace not found;
- invalid workspace name;
- invalid workspace path;
- duplicate workspace path;
- unavailable workspace path;
- workspace busy because it owns a live runtime; and
- database operation failure.

Keep filesystem and SQLite details in server logs/causes. Do not return raw paths in generic errors.

### T2.3 Implement the workspace repository

Add `src/server/workspace-repository.ts`:

- Use prepared statements for list/get/insert/update/delete.
- Generate stable UUIDs server-side; inject UUID, clock, and filesystem boundaries in tests.
- Trim names and reject empty names.
- Resolve paths against the server process CWD, require an existing accessible directory, and canonicalize with `realpath` before create or path update.
- Enforce canonical-path uniqueness and map SQLite constraint failures to the duplicate-path error.
- Sort workspace lists deterministically by case-insensitive name and then ID.
- Compute `available` when projecting rows: the stored canonical path must currently exist, be a directory, and be searchable/readable.
- Preserve rows when paths disappear; only path-dependent operations fail.
- Rename without revalidating an unchanged path.
- Update `updated_at` only after successful mutations.

Workspace removal deletes only the row. Repository code must never recursively remove a path or unlink a Pi session.

Add focused unit tests for CRUD, persistence after reopen, trimming, duplicate canonical paths, symlink canonicalization, missing/inaccessible paths, availability changes, ordering, and safe error conversion.

**Phase 2 exit criteria:** Workspaces can be created, listed, renamed, repointed, and removed through a tested repository, while filesystem content remains untouched.

## Phase 3 — Workspace-scoped protocol

### T3.1 Make conversation protocol objects workspace-aware

Update shared schemas and types:

- Add `workspaceId` to `ConversationSummary` and `ConversationState`.
- Add `workspaceId` to every conversation event envelope.
- Change `history.list` to require `workspaceId`.
- Change `conversation.create` to require `workspaceId` and remove `cwd`.
- Change `conversation.open` and `conversation.delete` to require both `workspaceId` and `conversationId`.
- Add `workspaceId` to every history response/broadcast.
- Extend acknowledgement and `CommandSuccessByType` mappings for workspace commands.

Conversation state/close/prompt/abort commands may continue using the live `conversationId`; the registry record supplies their authoritative workspace ownership.

Update protocol schema tests first so server and browser compilation failures expose every affected call site.

### T3.2 Implement workspace command dispatch

Update `src/server/protocol.ts` to receive a `WorkspaceRepository` dependency and dispatch workspace CRUD commands.

Before mutating a workspace path or deleting a workspace:

- Ask the conversation registry whether that workspace owns any live record.
- Reject path changes and deletion with `workspace_busy` when it does.
- Permit a name-only update while conversations are live.

After successful workspace mutation, send/broadcast an authoritative workspace list. Keep per-socket command ordering and outbound flow-control behavior unchanged.

### T3.3 Track per-socket history subscriptions

Replace the single global history broadcast behavior:

- Track the most recent successful `history.list(workspaceId)` for each WebSocket.
- Clear subscription state when the socket closes.
- A history change carries an affected `workspaceId`.
- Refresh and send history only to sockets subscribed to that workspace.
- Include `workspaceId` in every history message so clients can reject stale responses.
- Coalesce simultaneous refreshes per workspace, not globally.
- Never refresh histories for unselected/unsubscribed workspaces merely because a runtime event occurs.

Workspace-list broadcasts remain global because the SQLite row set is small and does not touch Pi history.

**Phase 3 exit criteria:** The wire protocol is workspace-aware, workspace CRUD works over WebSocket, and history broadcasts are isolated by each socket's selected workspace.

## Phase 4 — Replace global Pi history discovery

### T4.1 Refactor `SessionHistory`

Change `src/server/session-history.ts` from a process-wide `listAll()` service to a workspace-scoped service:

- Inject a boundary equivalent to `(cwd) => SessionManager.list(cwd)` for tests.
- Require a resolved, available workspace for `list`, `refresh`, `resolve`, and `delete`.
- Normalize only sessions returned for that workspace.
- Include `workspaceId` in summaries.
- Retain newest-first deterministic sorting and canonical session-file allow-sets.
- Key any latest snapshots/caches by workspace ID; do not keep one global snapshot.
- For `resolve` and `delete`, always perform a fresh workspace-scoped listing before accepting the conversation ID.
- Verify the listed session's canonical stored CWD equals the workspace's canonical path.
- Reject cross-workspace session IDs even if a browser learned them elsewhere.
- Keep live status decoration by session ID/file, but require the live record's workspace ID to agree.
- Keep deletion limited to the canonical file returned by the fresh scoped listing.

Remove normal application references to `SessionManager.listAll()`. The SDK smoke test and documentation may still mention the API when validating Pi itself, but server behavior must not use it.

### T4.2 Add no-global-scan regression tests

Add tests that fail if the global listing boundary is invoked during:

- server construction/startup;
- WebSocket connection and `ready`;
- `workspace.list`;
- workspace create/update/delete;
- conversation events in a workspace with no subscribed socket; and
- history refresh for a different selected workspace.

Also verify:

- selecting workspace A calls only `SessionManager.list(A.path)`;
- switching to B then calls only `SessionManager.list(B.path)`;
- open/delete perform a fresh listing for the supplied workspace;
- a missing workspace path is reported unavailable without falling back to global history; and
- stale session files removed between list and open remain safely rejected.

**Phase 4 exit criteria:** No normal startup, connection, or history-refresh path calls `SessionManager.listAll()`, and cross-workspace session access is prevented by fresh scoped listings.

## Phase 5 — Runtime and registry ownership

### T5.1 Add workspace ownership to conversation records

Update `src/server/conversation-registry.ts`:

- Add `workspaceId` to `ConversationRecord`.
- Accept an authoritative workspace ID/path when creating or opening a runtime.
- Include `workspaceId` in full state snapshots and emitted events.
- Add queries such as `hasLiveWorkspace(workspaceId)` for workspace mutation guards.
- Preserve workspace ownership through runtime identity replacement.
- Ensure duplicate-open suppression verifies workspace ownership as well as session ID/file identity.
- Change history-refresh callbacks/events to carry the affected workspace ID.
- Keep the live-runtime limit and idle LRU eviction process-wide.

### T5.2 Bind lifecycle operations to workspace resolution

Update command dispatch and registry boundaries:

- `conversation.create` resolves the workspace row, checks current availability, and passes its canonical path internally to `PiRuntimeFactory.createPersistent()`.
- `conversation.open` first resolves the conversation through fresh scoped history, then registers the runtime under that workspace ID.
- `conversation.delete` resolves and deletes only through scoped history.
- `conversation.fork` inherits the source record's workspace ID and path.
- Closing or evicting a runtime keeps the workspace row and Pi session intact.
- Removing a workspace is blocked until all of its live runtimes are closed; active runs must finish or be aborted first.

The Pi runtime factory may retain CWD-based internal methods, but arbitrary browser CWD input must no longer reach it.

### T5.3 Update event normalization and outbound flow keys

- Add authoritative `workspaceId` to normalized events at the registry/normalizer boundary.
- Update outbound coalescing keys and tests where event identity now includes workspace ownership.
- Ensure background events from live conversations in non-selected workspaces can still update client runtime projections without triggering Pi history scans for those workspaces.

**Phase 5 exit criteria:** Every live conversation has immutable workspace ownership, create/open/delete/fork obey that ownership, and switching workspaces does not stop background runs.

## Phase 6 — Server startup and shutdown wiring

### T6.1 Wire the database and workspace repository

Update `src/server/index.ts`:

1. Parse configuration.
2. Open/initialize SQLite.
3. Create the process-wide workspace repository.
4. Create shared Pi model/runtime services.
5. Create workspace-scoped history and the conversation registry.
6. Start HTTP/WebSocket listeners.

Do not perform a Pi history list in these steps. If startup fails after opening SQLite, close the database before returning.

### T6.2 Extend graceful shutdown

Update `src/server/shutdown.ts` and server ownership interfaces:

- Stop command/network admission first.
- Abort and dispose active Pi runtimes as today.
- Dispose protocol subscriptions.
- Close SQLite exactly once after no new workspace commands can run.
- Preserve the existing bounded shutdown deadline and forced socket cleanup.
- Add shutdown tests for normal close, repeated signals, and initialization/close failures.

### T6.3 Update operational endpoints

- Remove `defaultCwd` from `/api/config`.
- Keep `CHATWCA_DATA_DIR` and the resolved database path server-only.
- Health readiness should become true only after SQLite and required Pi process-wide services initialize successfully.
- Do not expose workspace rows through HTTP; use the validated WebSocket protocol.

**Phase 6 exit criteria:** Startup initializes SQLite without listing Pi sessions, partial startup cleans up correctly, and graceful shutdown closes both Pi runtimes and SQLite.

## Phase 7 — Browser state and socket recovery

### T7.1 Refactor client state

Update `src/web/src/api/state.ts` with:

- `workspaces: WorkspaceSummary[]`;
- `selectedWorkspaceId: string | null`;
- selected-workspace history plus its authoritative `historyWorkspaceId`;
- `workspaceId` on stored conversation projections through `ConversationState`; and
- workspace-specific pending/error state where needed.

Reducer rules:

- A workspace list never triggers history loading by itself.
- Selecting a workspace clears the selected conversation and current history projection, then the client requests that workspace's history.
- Apply a history message only when its `workspaceId` equals the current selection.
- Replacing workspace A's history must not discard live snapshots belonging to workspace B.
- If the selected workspace is removed, clear workspace/conversation selection and history.
- Continue applying revisioned background events using their workspace and conversation IDs.

### T7.2 Change connection and reconnect behavior

Update `src/web/src/api/client.ts`:

- On initial connection, send only `workspace.list`; do not send `history.list`.
- Add `selectWorkspace(workspaceId | null)` that changes local state and requests scoped history only for a non-null selection.
- During WebSocket reconnect in the same browser instance, re-list workspaces, then re-list only the previously selected workspace if it still exists.
- Reopen/request state only for the previously selected conversation if it belongs to that workspace.
- Keep full page reload behavior unselected; do not add localStorage/sessionStorage persistence.
- Ignore stale history responses from a workspace that was deselected while the request was in flight.

Update expected-response matching and command helpers for workspace commands.

### T7.3 Preserve drafts and background projections

- Keep drafts keyed by conversation ID.
- Do not delete a draft merely because its workspace is temporarily unselected.
- Clear a draft when its conversation is explicitly deleted.
- Keep background live conversation snapshots so events remain contiguous across workspace switches.
- Request a fresh state if an event revision gap is detected, independent of selected workspace.

**Phase 7 exit criteria:** Connecting loads only workspace rows, workspace selection causes the first scoped Pi history request, and rapid switching/reconnects cannot display history from the wrong workspace.

## Phase 8 — Workspace-first UI

### T8.1 Replace the CWD-grouped conversation sidebar

Refactor `ConversationSidebar` into workspace-first components, following the proposed source layout:

- `WorkspaceSidebar` for workspace selection and management;
- `WorkspaceForm` for create/update name and path fields; and
- `ConversationList` for the selected workspace's sessions.

Remove:

- the working-directory grouping/filter;
- editable CWD from the new-conversation flow; and
- all use of browser `defaultCwd`.

When no workspace is selected:

- show workspace onboarding/selection;
- do not show conversation history; and
- disable new-conversation actions.

### T8.2 Implement workspace management UX

- Add create, rename/edit, and remove controls with accessible labels and keyboard focus handling.
- Display both workspace name and full path.
- Mark unavailable workspaces clearly and disable history/new-conversation actions for them.
- Confirm removal with copy that explicitly says the directory and Pi sessions will not be deleted.
- Surface duplicate, invalid, unavailable, busy, and database errors with stable messages.
- After creation, refresh the authoritative workspace list; automatic selection is optional and must use a server-returned workspace ID rather than the raw path.
- Prevent overlapping workspace mutations and conversation lifecycle actions.

### T8.3 Make conversation actions workspace-aware

Update `src/web/src/App.tsx` and components:

- Create conversations using the selected `workspaceId`.
- Open/delete using both selected workspace ID and conversation ID.
- Show workspace name/path in the conversation header.
- Clear conversation selection when switching workspaces.
- Keep close, prompt, abort, and fork flows operating on live conversation IDs.
- Handle a workspace becoming unavailable or being removed by another tab.
- Update empty/welcome states to guide users to add or select a workspace first.

### T8.4 Preserve responsive and accessibility behavior

- Retain the current dark-only styling, reduced-motion behavior, and mobile sidebar backdrop.
- Ensure workspace menus/forms are keyboard accessible and have visible focus states.
- Keep long paths bounded/wrapping without breaking the layout.
- Update ARIA labels from “conversations” to “workspaces and conversations” where appropriate.

**Phase 8 exit criteria:** A user can manage workspaces and perform all existing conversation operations inside the selected workspace without entering a CWD for each conversation.

## Phase 9 — Test-suite conversion

### T9.1 Unit tests

Update/add tests for:

- configuration and SQLite lifecycle;
- workspace repository and error mapping;
- workspace protocol schemas and command-response typing;
- scoped session-history authorization and deletion;
- registry workspace ownership and busy checks;
- per-socket workspace subscriptions and scoped broadcasts;
- client state selection, stale-history rejection, and background projections;
- reconnect behavior with and without a selected workspace; and
- workspace forms/sidebar/list rendering and accessibility.

Likely affected existing files include:

```text
tests/unit/config.test.ts
tests/unit/errors.test.ts
tests/unit/protocol.test.ts
tests/unit/server-protocol.test.ts
tests/unit/session-history.test.ts
tests/unit/conversation-registry.test.ts
tests/unit/normalize-events.test.ts
tests/unit/outbound-flow.test.ts
tests/unit/web-client.test.ts
tests/unit/web-state.test.ts
tests/unit/web-conversation-list.test.ts
tests/unit/web-chat-interactions.test.ts
```

### T9.2 Integration tests

Update temporary server/Pi fixtures so every conversation belongs to an explicitly created workspace. Cover:

- server startup and socket connection with a list boundary that fails if called;
- workspace persistence across server restart;
- selecting one workspace without listing another;
- workspace create/update/delete and multi-client broadcasts;
- path disappearance/restoration;
- path-update/delete rejection while live;
- create/open/fork inheritance within a workspace;
- cross-workspace open/delete rejection;
- simultaneous runs in different workspaces;
- scoped history updates after prompt, close, fork, and delete;
- reconnect recovery for only the selected workspace; and
- SQLite close during graceful shutdown.

Likely affected files include all server protocol, lifecycle, fork, smoke, and shutdown integration suites.

### T9.3 Browser fixture and Playwright tests

Update `tests/browser/fixture-server.ts` to model:

- workspace CRUD and availability;
- workspace-scoped histories;
- workspace IDs on states/events; and
- selected-workspace history responses.

Update browser specs to cover:

- no history request before workspace selection;
- create/select/edit/remove workspace;
- unavailable workspace UI;
- conversations isolated by workspace;
- rapid workspace switching with out-of-order history responses;
- background streaming while viewing another workspace;
- reconnect restoring only in-memory selection;
- confirmation that workspace removal retains sessions in the fixture; and
- existing image, fork, rich rendering, accessibility, and responsive behavior after the sidebar redesign.

### T9.4 Required regression assertion

Add a repository test or static assertion that production server source does not call `SessionManager.listAll()`. Runtime tests remain the primary guarantee; the static check prevents an accidental direct reintroduction.

**Phase 9 exit criteria:** Unit, integration, and browser suites cover workspace behavior and retain all existing chat, image, fork, streaming, reconnect, and shutdown guarantees.

## Phase 10 — Documentation and final cleanup

### T10.1 Update user documentation — Complete

Update `README.md` to describe:

- creating a workspace before creating/opening conversations;
- `./data/chatwca.sqlite` and the `/data/` gitignore rule;
- `CHATWCA_DATA_DIR` and removal of `CHATWCA_DEFAULT_CWD`;
- startup loading workspace definitions but not Pi history;
- workspace-scoped history behavior;
- workspace removal retaining directories and sessions;
- unavailable workspace recovery; and
- SQLite backup considerations, including WAL-aware shutdown before copying.

Keep `docs/pi-sdk-notes.md` accurate: `listAll()` may remain documented as an SDK capability, but state that ChatWCA normal operation uses `SessionManager.list(cwd)`.

### T10.2 Remove obsolete global-history code and copy — Complete

- Remove dead default-CWD UI/config paths.
- Remove global history caches, broadcasts, and `listAll()` adapters.
- Rename CWD-grouped sidebar helpers/tests where appropriate.
- Ensure public errors and UI text consistently use “workspace” for the registered entity and “working directory” only for the underlying path.
- Confirm no generated database or WAL file is tracked by Git.

### T10.3 Run final gates — Complete

Run:

```sh
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm run test:browser
npm run test:sdk-smoke
```

Also verify manually:

1. Start with no `data` directory and confirm it is created.
2. Connect a browser and confirm no Pi history scan occurs.
3. Add two workspaces with existing Pi sessions.
4. Select each workspace and confirm only its sessions appear.
5. Start a run in workspace A, switch to B, and confirm A continues.
6. Restart the server and confirm workspace rows persist while browser selection resets after a full reload.
7. Remove a workspace and confirm its directory and Pi session files remain.
8. Shut down and confirm SQLite, WebSockets, HTTP, and Pi runtimes close cleanly.

**Phase 10 exit criteria:** Documentation matches behavior, obsolete global-history paths are gone, all automated checks pass, and manual workspace isolation/persistence checks succeed.

## Implementation order and commit boundaries

Use small commits in this order so the repository remains reviewable:

1. SQLite dependency, config, `.gitignore`, database lifecycle, and repository tests.
2. Workspace domain schemas, errors, and repository CRUD.
3. Workspace protocol commands and server dispatch.
4. Workspace-scoped `SessionHistory` with no-global-scan tests.
5. Registry/runtime workspace ownership and scoped history broadcasts.
6. Startup/shutdown database wiring.
7. Browser client state and reconnect behavior.
8. Workspace-first UI and styles.
9. Integration/browser fixture conversion and regression coverage.
10. README/docs cleanup and final gates.

Temporary compilation breaks should be confined to a commit while shared protocol changes are propagated across server, client, and fixtures. Prefer landing protocol schema changes together with all required compile-time call-site updates.

## Completion checklist

- [x] `/data/` is gitignored.
- [x] `better-sqlite3` is installed and locked.
- [x] `CHATWCA_DATA_DIR` defaults to `./data`; `CHATWCA_DEFAULT_CWD` is removed.
- [x] SQLite initializes `data/chatwca.sqlite` and persists workspace rows.
- [x] Workspace CRUD validates names and canonical directory paths.
- [x] Workspace removal never deletes directories or Pi sessions.
- [x] Startup and browser connection do not list Pi sessions.
- [x] Selecting a workspace uses `SessionManager.list(workspace.path)`.
- [x] Production server code does not call `SessionManager.listAll()`.
- [x] History responses and broadcasts are workspace-scoped.
- [x] Fresh scoped listings authorize conversation open and delete.
- [x] Conversation records, states, summaries, and events carry workspace ownership.
- [x] Forks inherit source workspace ownership.
- [x] Live-runtime LRU remains process-wide and background runs survive workspace switches.
- [x] Path update/removal is rejected while the workspace owns a live runtime.
- [x] Initial connection lists workspaces only; reconnect lists only the selected workspace's history.
- [x] The UI supports workspace create/select/edit/remove and no longer requests a CWD per conversation.
- [x] Unit, integration, browser, build, typecheck, and SDK smoke checks pass.
- [x] README and operational documentation match the workspace behavior.
