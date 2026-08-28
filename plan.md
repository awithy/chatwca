# ChatWCA Implementation Plan

This plan implements the proposed design in `docs/design.md`. The repository currently contains documentation only, so the work begins with project scaffolding. Tasks are ordered by dependency; each milestone should leave the repository buildable and tested.

## Delivery principles

- Keep Pi's JSONL session store canonical; do not add an application message database.
- Keep one process-wide conversation registry and one shared Pi `ModelRuntime`.
- Give each live conversation exactly one runtime and prevent duplicate writers for a session file.
- Treat the server as authoritative. Browser state must be replaceable from a full conversation snapshot.
- Preserve Pi session entry IDs through serialization so forking is reliable.
- Validate all WebSocket input at runtime and expose stable application errors rather than raw SDK errors.
- Bind to `0.0.0.0` by default, but do not add authentication or broad CORS support.
- Introduce a narrow Pi adapter boundary so server behavior can be integration-tested with fake sessions/models.

## Milestone 0 — Validate Pi SDK assumptions

### T0.1 Pin and inspect the SDK

**Status:** Complete — pinned 0.84.3; findings and adaptations are recorded in [`docs/pi-sdk-notes.md`](docs/pi-sdk-notes.md).

- Select and pin a compatible `@earendil-works/pi-coding-agent` version.
- Verify the concrete APIs and event types for:
  - `ModelRuntime` creation and refresh;
  - `createAgentSessionServices()`;
  - `createAgentSessionFromServices()`;
  - `createAgentSessionRuntime()`;
  - `SessionManager.create()`, `open()`, `list()`, and `listAll()`;
  - runtime/session disposal and abort;
  - `switchSession()`, `fork()`, and session replacement;
  - prompt images and `streamingBehavior`;
  - active-branch entry IDs and session metadata; and
  - history deletion, if supported by the SDK.
- Record any necessary adaptation from the conceptual APIs in the design as short implementation notes in the relevant source files or project documentation.

### T0.2 Build a disposable SDK smoke test

**Status:** Complete — `npm run test:sdk-smoke` exercises persistence and reopening with Pi's faux provider in isolated temporary directories.

- Create a temporary-session script/test that creates a session in a temporary CWD, subscribes to events, disposes it, and reopens it.
- Use a fake model/provider where the SDK supports one; the smoke test must not require paid model access in CI.
- Confirm when session files and message entries become durable.

**Exit criteria:** The SDK version is locked, the required lifecycle operations are understood, and no core design requirement depends on a nonexistent API without an identified adapter or fallback.

## Milestone 1 — Project foundation

### T1.1 Scaffold the TypeScript application

**Status:** Complete — strict server/web TypeScript builds, Vite/React, Express static delivery, and Vitest/Playwright scaffolding are configured.

Create the initial structure:

```text
src/server/
src/shared/
src/web/
tests/unit/
tests/integration/
tests/browser/
```

- Add `package.json` and lockfile.
- Configure strict TypeScript for server, shared code, and the Vite browser build.
- Add React, Vite, Express, `ws`, TypeBox, `react-markdown`, `remark-gfm`, Vitest, and Playwright.
- Add scripts for development, build, start, typecheck, unit/integration tests, and browser tests.
- Configure production build output so Express serves the Vite assets and supports SPA fallback without intercepting `/api/*` or `/ws`.
- Add `.gitignore` and test/build configuration.

### T1.2 Implement typed configuration

**Status:** Complete — server-only environment parsing, defaults, startup errors, and validation tests are implemented in [`src/server/config.ts`](src/server/config.ts).

In `src/server/config.ts`:

- Parse all variables defined in the design.
- Validate ports, positive size/count limits, and the live-runtime limit.
- Apply defaults for host, port, CWD, image limits, and aggregate image bytes.
- Fail startup with a useful message for invalid configuration.
- Keep Pi credentials and provider settings server-only.

### T1.3 Add the HTTP/server shell

**Status:** Complete — Express and WebSocket share one HTTP server, operational endpoints expose safe startup data, and the React shell verifies both HTTP and socket connectivity.

In `src/server/index.ts`:

- Create one HTTP server shared by Express and `ws`.
- Implement `GET /api/health` with readiness and version information.
- Implement `GET /api/config` with browser-safe settings only, such as image limits and default CWD; never expose credentials.
- Listen on `0.0.0.0:8787` by default.
- Add a placeholder WebSocket connection that sends `ready`.
- Add a minimal React shell proving development proxying and production static serving work.

### T1.4 Establish baseline automation

**Status:** Complete — configuration coverage, an HTTP/WebSocket server smoke test, and CI build/typecheck/test gates are in place.

- Add unit tests for configuration defaults and invalid values.
- Add a build/typecheck test in CI.
- Add a server smoke test for health, config, and WebSocket readiness.

**Exit criteria:** A production build starts on the configured host/port, serves the React shell, and accepts a same-authority WebSocket connection.

## Milestone 2 — Shared protocol and normalized state

### T2.1 Define protocol schemas

**Status:** Complete — the closed-object TypeBox wire contract, inferred types, normalized content model, snapshots, acknowledgements, and event envelopes are implemented in [`src/shared/protocol.ts`](src/shared/protocol.ts).

In `src/shared/protocol.ts`, create TypeBox schemas and inferred TypeScript types for:

- every command listed in the design;
- required client-generated `requestId` values;
- command acknowledgements and correlated errors;
- `ready`, history, full state, normalized event envelopes, and status notices;
- conversation summaries and full conversation state;
- normalized user, assistant, thinking, image, tool-call, and tool-result blocks; and
- image payload metadata and data encoding.

Use discriminated unions and reject unknown command types. Decide and document whether extra object properties are rejected; apply the choice consistently.

### T2.2 Define stable errors

**Status:** Complete — stable public codes, boundary-specific safe conversion, closed error schemas, and redaction tests are implemented in [`src/shared/errors.ts`](src/shared/errors.ts).

In `src/shared/errors.ts`:

- Define error codes for every case in design section 16.
- Add safe conversion from validation, filesystem, registry, image, and Pi errors.
- Ensure internal paths/stacks are not accidentally returned unless they are intentionally part of a requested CWD/session response.

### T2.3 Define state/revision semantics

**Status:** Complete — revision rules, command success mappings, reconciliation helpers, and gap/schema tests are implemented in [`docs/revision-semantics.md`](docs/revision-semantics.md) and [`src/shared/revisions.ts`](src/shared/revisions.ts).

- Specify which server-side changes increment a conversation revision.
- Require monotonically increasing revisions on all conversation events and snapshots.
- Define command success responses, including newly created/opened/forked state.
- Define client behavior for stale/duplicate events and revision gaps.
- Unit-test schema acceptance/rejection and revision-gap detection.

**Exit criteria:** Client and server can import one wire contract, malformed commands are rejected predictably, and state/event revision rules are unambiguous.

## Milestone 3 — Pi sessions, history, and serialization

### T3.1 Implement CWD handling

**Status:** Complete — canonical CWD resolution, directory/access validation, stored-CWD availability inspection, and filesystem coverage are implemented in [`src/server/cwd.ts`](src/server/cwd.ts).

- Resolve requested paths to absolute paths.
- Canonicalize with `realpath` when possible.
- Require an existing directory for new conversations.
- Preserve enough information to report a missing stored CWD when reopening history.
- Unit-test relative paths, symlinks, files, missing paths, and permission failures.

### T3.2 Implement the shared Pi services and runtime factory

**Status:** Complete — the process-wide model runtime, persistent create/open factory, replacement-safe conversation adapter, capability metadata, and isolated faux-provider integration coverage are implemented in [`src/server/pi-runtime.ts`](src/server/pi-runtime.ts).

In `src/server/pi-runtime.ts`:

- Create one process-wide `ModelRuntime`.
- Create CWD-bound services separately for every conversation runtime.
- Support creating a persistent session and opening an existing session file.
- Return a wrapper exposing the active `AgentSession`, session identity/file/CWD, prompt, abort, fork, subscribe, and dispose operations.
- Centralize runtime replacement handling so old subscriptions are always removed and record metadata can be refreshed.
- Expose model capability information needed for image validation and header display.

### T3.3 Implement session history

**Status:** Complete — Pi-native listing normalization, canonical open/delete allow-sets, missing-CWD visibility, live deletion guards, and history tests are implemented in [`src/server/session-history.ts`](src/server/session-history.ts).

In `src/server/session-history.ts`:

- Discover sessions only through Pi listing APIs.
- Normalize them into `ConversationSummary` values.
- Use the first non-empty user prompt as the fallback title while respecting an explicit Pi session name when present.
- Report missing CWDs as visible but not runnable.
- Build a canonical allow-set of listed session files for open/delete operations.
- Delete only sessions returned by the current listing API and reject live-session deletion.
- Refresh history after create, prompt/title derivation, close, fork, and delete.

### T3.4 Implement message serialization

**Status:** Complete — active-branch projection, defensive normalized message conversion, linked tools, UTF-8-safe output bounds, and fixture-driven coverage are implemented in [`src/server/serialize.ts`](src/server/serialize.ts).

In `src/server/serialize.ts`:

- Convert Pi session entries into the normalized UI model.
- Preserve entry IDs, role, text, thinking, images, tool links/results, timestamps, stop reasons, and errors.
- Serialize only the active branch for the v1 timeline.
- Bound tool output sent to the browser while retaining truncation metadata.
- Never render or pass raw HTML as trusted content.
- Add fixture-driven unit tests for text, images, thinking, tools, failures, compaction/branch entries, and malformed optional fields.

**Exit criteria:** Temporary Pi sessions can be created, listed, serialized, disposed, and reopened without directly parsing or rewriting JSONL application-side.

## Milestone 4 — Conversation registry and lifecycle

### T4.1 Implement registry ownership and indexes

In `src/server/conversation-registry.ts`:

- Store records by Pi session ID and canonical session-file path.
- Return an existing record when opening an already-live session.
- Track status, creation/activity times, revision, active session reference, and unsubscribe function.
- Make create/open operations atomic enough that concurrent requests cannot create duplicate live writers.
- Emit registry events independently of any browser connection.

### T4.2 Implement lifecycle operations

- Create, open, get state, close, and dispose conversations.
- Refuse close while streaming/aborting unless the run has first completed or been aborted.
- Keep persisted history after close.
- Update indexes safely when a runtime replacement changes session ID or file.
- Handle externally removed session files with a stable error and history refresh.

### T4.3 Implement the live-runtime limit

- Enforce `CHATWCA_MAX_LIVE_CONVERSATIONS` before opening/creating/forking.
- Evict the least-recently-used idle record.
- Never evict streaming or aborting records.
- Return a stable error if no idle eviction candidate exists.
- Update activity timestamps on open/state access, prompting, and relevant session activity.

### T4.4 Normalize Pi events

- Subscribe once per active `AgentSession`.
- Map Pi events to message, tool, queue, status, retry, and compaction events.
- Increment revisions in emission order.
- Set status to streaming on agent start, aborting on abort request, idle on agent end, and error only for unrecoverable runtime failures.
- Ensure accepted-prompt model failures appear in the event/state stream rather than retroactively failing the command.
- Replace subscriptions correctly after any session replacement.

### T4.5 Add registry tests

Cover:

- duplicate open suppression;
- canonical path indexing;
- independent simultaneous runtimes;
- idle LRU order;
- no eviction of active runs;
- status transitions and revisions;
- runtime replacement and re-subscription; and
- full disposal without leaked listeners.

**Exit criteria:** Multiple conversations can remain live independently, with deterministic status, revisions, eviction, and cleanup.

## Milestone 5 — WebSocket command layer and core chat

### T5.1 Secure the WebSocket upgrade boundary

- Attach `ws` to `/ws` only.
- Accept browser upgrades only when `Origin` authority matches `Host`.
- Accept direct clients that omit `Origin` as designed.
- Reject malformed origins and unrelated paths.
- Do not enable broad CORS or introduce authentication.

### T5.2 Implement command dispatch

In `src/server/protocol.ts`:

- Parse JSON safely, enforce an inbound message-size limit, validate against TypeBox, and dispatch by command type.
- Implement history list, conversation create/open/state/close/delete, prompt submit/steer/follow-up, abort, and later fork.
- Correlate every acknowledgement/error with `requestId`.
- Require `conversationId` for conversation-specific commands.
- Broadcast authoritative conversation events and history changes to connected clients.
- Isolate socket send failures so they cannot affect Pi runs.

### T5.3 Implement text prompt and abort flows

- Permit normal submit only while idle.
- While streaming, require explicit steer or follow-up commands.
- Validate non-empty text when no image is supplied.
- Forward Pi queue updates.
- Make abort idempotent where practical and preserve final `agent_end` reconciliation.
- Return an immediate acceptance acknowledgement; stream subsequent completion/failure events separately.

### T5.4 Implement snapshots and reconnect support

- Return a complete state on create, open, explicit state request, and later fork.
- Include the current revision and enough queue/status data to rebuild the selected UI.
- On socket reconnection, let the client reload history and request state for its selected conversation.
- Test disconnecting a client during a run: the server runtime must continue, and a new client must recover from a snapshot.

**Exit criteria:** A protocol-level client can create/open sessions, submit/abort text prompts, receive incremental normalized events, and recover after disconnecting.

## Milestone 6 — Core React interface

### T6.1 Build the socket client and reducer

In `src/web/api/`:

- Implement connection state, command request IDs, pending request correlation, and timeout/error handling.
- Reconnect with bounded exponential backoff.
- Reload history and selected conversation state after reconnect.
- Maintain browser-local selection.
- Apply deltas only when revisions are contiguous; ignore duplicates and request a full state on gaps.
- Keep draft composer text browser-local and conversation-specific.

### T6.2 Build the application layout

Implement:

- `ConversationSidebar` grouped/filterable by CWD with closed/idle/streaming/error states;
- new-conversation flow with editable CWD and validation feedback;
- lazy opening when a closed history item is selected;
- `ConversationHeader` with title, full CWD, model, and status; and
- responsive sidebar collapse for laptop-sized and narrower screens.

### T6.3 Build text chat interactions

- Render user and assistant text incrementally.
- Add a multiline composer with keyboard-accessible submit behavior.
- Show submit while idle and explicit steer/follow-up/abort controls while streaming.
- Keep background conversation status updating while another conversation is selected.
- Support close and delete with appropriate disabled states and confirmation for deletion.

### T6.4 Add the dark-only design system

In `src/web/styles/app.css`:

- Define a single dark palette with CSS custom properties.
- Add WCAG AA text/control contrast, visible focus states, readable code/diff colors, and bounded scroll regions.
- Honor reduced-motion preferences without implementing theme selection.
- Do not inspect `prefers-color-scheme`.

**Exit criteria:** A user can create, open, switch, close, and delete conversations and run text chats, including while another conversation continues in the background.

## Milestone 7 — Rich message rendering

### T7.1 Render safe Markdown

- Use `react-markdown` and `remark-gfm`.
- Do not enable raw HTML rendering.
- Style code blocks, tables, blockquotes, links, and long unbroken content.
- Ensure streamed partial Markdown degrades safely.

### T7.2 Render thinking and tools

- Add collapsed-by-default `ThinkingBlock` components.
- Add `ToolCallCard` components linked to matching results.
- Update active tools incrementally and distinguish success, failure, and running states.
- Bound and scroll long tool output and clearly label browser-side truncation.

### T7.3 Render run metadata and notices

- Display stop reason and message errors where relevant.
- Render retry, compaction, queue, and runtime notices without mixing them into assistant prose.
- Add usage metadata only where the SDK provides reliable values.

**Exit criteria:** Text, thinking, tool calls, tool results, notices, and failures are understandable during and after a streamed run.

## Milestone 8 — Image prompts

### T8.1 Build browser image ingestion

In the composer:

- Support paste, drag/drop, and file selection for PNG, JPEG, and WebP.
- Correct orientation and resize to a maximum 2048-pixel edge using browser image APIs.
- Produce previews with remove/reorder controls and accessible labels.
- Enforce image count and preliminary size/type limits before submission.
- Release object URLs/canvas resources after removal or submission.

### T8.2 Validate images on the server

In `src/server/images.ts`:

- Validate the data URL/base64 shape and declared MIME type.
- Check encoded payload bounds before allocating decoded buffers.
- Verify decoded MIME signatures rather than trusting browser metadata.
- Enforce per-image, aggregate decoded-byte, and image-count limits.
- Convert accepted payloads to Pi `ImageContent` without adding a second upload store.
- Reject image prompts when the selected model lacks image capability.

### T8.3 Test image behavior

- Unit-test valid formats, spoofed MIME values, malformed base64, count limits, individual/aggregate size limits, and text-only model rejection.
- Browser-test paste, drop, selection, preview removal, resizing, and successful submission.

**Exit criteria:** Supported image prompts persist in Pi history and reopen correctly; invalid or unsupported images fail with stable, clear errors.

## Milestone 9 — Forking

### T9.1 Validate fork targets

- Expose Fork only on user messages with valid Pi entry IDs.
- On the server, require the source conversation to be idle.
- Verify the target entry is a user message on the source's current active branch.
- Reserve runtime capacity before creating the fork.

### T9.2 Implement source-preserving fork creation

- Open the source session in an unregistered temporary runtime rather than calling `fork()` on the source record.
- Invoke `runtime.fork(entryId)` on the temporary runtime.
- Handle the resulting session replacement using the same replacement helper as other runtime operations.
- Register the resulting fork only after creation succeeds.
- Inherit the source CWD and current model where the SDK supports it.
- Dispose all temporary resources on failure and leave the source record/session untouched.
- Return the new full conversation state and the SDK-provided `editorText`.

### T9.3 Build the fork UI

- Add Fork actions to eligible user messages.
- Select the new conversation after successful fork.
- Prefill its composer with `editorText` without automatically submitting it.
- Allow the user to edit or clear the copied prompt.
- Keep the source available and unchanged in history.

### T9.4 Add fork integration tests

Verify:

- source history/file/runtime do not change;
- target entry validation rejects off-branch and non-user entries;
- streaming sources cannot be forked;
- failed forks leak no runtime/listener;
- forked state has a new session identity and expected history; and
- editor text is returned and editable.

**Exit criteria:** A user can fork from an earlier active-branch user message into a separate persisted conversation without mutating the source.

## Milestone 10 — Resilience, shutdown, and release hardening

### T10.1 Add outbound flow control

- Track WebSocket buffered bytes.
- Preserve high-priority text/status events.
- Coalesce safe high-frequency tool updates where possible.
- Close or resynchronize persistently slow clients without interrupting server-side runs.
- Bound serialized tool output and all inbound command payloads.

### T10.2 Implement graceful shutdown

- On `SIGINT`/`SIGTERM`, reject new prompt/create/open/fork commands.
- Stop accepting HTTP/WebSocket connections and notify/close clients.
- Ask active sessions to abort.
- Wait for a configurable bounded grace period.
- Unsubscribe and dispose every runtime, then close the HTTP server.
- Make shutdown idempotent and ensure it cannot hang indefinitely.

### T10.3 Complete integration coverage

Using temporary Pi session roots and a deterministic fake model/provider, cover:

- create → prompt → persist → dispose → reopen;
- concurrent independent conversations;
- background streaming while switching;
- steer and follow-up queue behavior;
- abort and model failure behavior;
- reconnect and full-state reconciliation;
- runtime replacement subscription correctness;
- idle LRU eviction and capacity failure;
- guarded deletion; and
- missing workspace/session files.

### T10.4 Complete browser coverage

Use Playwright to verify:

- create, switch, close, reopen, and delete;
- streaming text and background status;
- thinking/tool collapse behavior;
- image paste/drop/select;
- fork/prefill/edit flow;
- reconnect after socket interruption;
- keyboard focus and primary controls;
- responsive dark-only layout; and
- access through a non-loopback/LAN-style host while the test server binds to `0.0.0.0`.

### T10.5 Operational documentation

Update `README.md` with:

- install, development, build, and start commands;
- Node and Pi prerequisites;
- all supported environment variables and payload defaults;
- trusted-LAN/no-auth security warning;
- session compatibility and storage behavior;
- graceful shutdown expectations; and
- troubleshooting for no model, missing CWD, origin mismatch, and session/runtime errors.

**Exit criteria:** All automated suites pass, shutdown is bounded, slow/disconnected clients do not stop runs, and setup/security behavior is documented.

## Cross-cutting test gates

Run these at the end of every milestone:

1. TypeScript strict typecheck.
2. Production server and web build.
3. Unit tests.
4. Relevant integration tests.
5. Relevant Playwright tests once the UI exists.
6. A check that no test has written sessions into the operator's real Pi session directory.

## Release acceptance checklist

- [ ] Server defaults to `0.0.0.0:8787` and works from another LAN machine.
- [ ] There is no authentication/authorization flow and same-authority WebSocket origin checks work.
- [ ] Any valid accessible local directory can be used for a conversation.
- [ ] Pi-native history survives browser/server restarts and remains Pi CLI-compatible.
- [ ] Multiple live conversations run independently and switching does not interrupt background work.
- [ ] Text, thinking, tool calls, tool results, queue changes, and errors stream incrementally.
- [ ] Reconnects and revision gaps recover through authoritative snapshots.
- [ ] PNG, JPEG, and WebP prompts work within configured limits on vision-capable models.
- [ ] Forking creates a new persisted session, prefills the editor, and leaves the source unchanged.
- [ ] Idle LRU eviction, close, deletion guardrails, abort, and graceful shutdown behave as designed.
- [ ] The dark-only UI is keyboard accessible, responsive at common laptop sizes, and does not render raw model HTML.
- [ ] Unit, integration, and browser test suites pass with isolated temporary Pi state.

## Explicitly deferred

Do not include these in the v1 implementation unless the design is revised: authentication, internet-facing hardening, multi-user isolation, a light theme, terminal/file/SCM panels, Pi configuration screens, arbitrary file attachments, a vision bridge, horizontal scaling, in-place branch-tree navigation, or “clone through here” fork positioning.
