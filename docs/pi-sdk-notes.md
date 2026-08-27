# Pi SDK integration notes

**Validated version:** `@earendil-works/pi-coding-agent` 0.84.3

**Required Node version:** 22.19.0 or newer

These notes record the concrete SDK behavior on which ChatWCA relies. They are an adapter checklist, not a replacement for Pi's SDK documentation.

## Process-wide models

- Create the shared catalog/auth object with `await ModelRuntime.create(options?)`.
- `create()` restores cached catalogs and does not use the network by default. A bounded refresh is available through `refresh({ allowNetwork: true, force?, signal? })`; `PI_OFFLINE` disables model network access.
- Available authenticated models come from `await modelRuntime.getAvailable()`. A model advertises vision support when `model.input.includes("image")`.
- `ModelRuntime` has no disposal method in this version. It is safe to retain for the process lifetime.

## CWD-bound services and sessions

The advanced runtime factory in the design maps directly to the SDK:

```ts
const createRuntime: CreateAgentSessionRuntimeFactory = async ({
  cwd,
  sessionManager,
  sessionStartEvent,
}) => {
  const services = await createAgentSessionServices({
    cwd,
    modelRuntime: sharedModelRuntime,
  });

  return {
    ...(await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
    })),
    services,
    diagnostics: services.diagnostics,
  };
};
```

`createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager })` returns an `AgentSessionRuntime`. The runtime exposes `session`, `services`, `cwd`, diagnostics, `newSession()`, `switchSession()`, `fork()`, `importFromJsonl()`, and asynchronous `dispose()`.

After replacement preflight succeeds, the operation aborts and disposes the old session before constructing its replacement. Consequently, a construction failure after teardown does **not** leave the old session usable (validation errors and extension cancellation can still occur before teardown). ChatWCA's adapter must unsubscribe before replacement, refresh all registry indexes after success, and move the record to a stable error/closed state after a post-teardown failure. `runtime.setRebindSession()` exists, but registry-owned subscription and metadata replacement will remain centralized in the ChatWCA adapter.

`runtime.dispose()` emits extension shutdown and disposes the session, but does not itself abort an active run. Graceful shutdown must call `session.abort()` first and then await `runtime.dispose()`.

## SessionManager

Concrete factories and listing signatures are:

```ts
SessionManager.create(cwd, sessionDir?)
SessionManager.open(sessionFile, sessionDir?, cwdOverride?)
SessionManager.inMemory(cwd?)
SessionManager.list(cwd, sessionDir?, onProgress?)
SessionManager.listAll(onProgress?)
SessionManager.listAll(sessionDir?, onProgress?)
```

`listAll()` does not take a CWD. It scans Pi's complete default session root, or the supplied session directory. `SessionInfo` includes `path`, `id`, `cwd`, optional `name`, optional `parentSessionPath`, `created`, `modified`, `messageCount`, `firstMessage`, and `allMessagesText`.

There is no exported session-deletion API. Pi's own TUI tries the external `trash` command and falls back to `fs.unlink`. ChatWCA will implement deletion at its filesystem boundary, but only after resolving the requested file through a fresh `SessionManager.list()`/`listAll()` allow-set and confirming that it is not live.

## Persistence and durability

Pi persistence is synchronous and append-only once a session file exists, but a new persistent session intentionally delays file creation:

1. `SessionManager.create(cwd)` allocates an ID and prospective file path without creating the file.
2. User entries are appended on `message_end`, but a user-only session remains memory-only.
3. On the first assistant `message_end` (including terminal error/abort responses), Pi writes the header and accumulated entries synchronously.
4. Later entries are appended synchronously.

Therefore empty and user-only conversations are not returned by listing APIs and do not survive process exit. ChatWCA must not claim that a newly created session is durable until the first assistant message has ended. This is accepted SDK behavior; no application JSONL writer will be added.

Opening uses the CWD from the session header unless `cwdOverride` is passed. Runtime creation rejects a missing stored CWD. History can still expose the `SessionInfo`, so ChatWCA should check CWD availability before constructing a runtime.

## Events, prompting, and abort

`AgentSession.subscribe(listener)` returns an unsubscribe function. Subscriptions belong to that exact session object and do not move when `runtime.session` is replaced.

The event union includes core lifecycle and stream events:

- `agent_start`, `agent_end`, `agent_settled`;
- `turn_start`, `turn_end`;
- `message_start`, `message_update`, `message_end`;
- `tool_execution_start`, `tool_execution_update`, `tool_execution_end`;
- `queue_update`;
- `entry_appended`, `session_info_changed`, and `thinking_level_changed`;
- compaction, automatic retry, summarization retry, and bash update events.

`message_update.assistantMessageEvent` is the provider-neutral delta stream. Tool events carry `toolCallId`, `toolName`, arguments, partial/final result, and final `isError`. `agent_end` includes new messages and `willRetry`; `agent_settled` is the stronger indication that retry/continuation work has finished.

`session.prompt(text, options)` accepts Pi `ImageContent[]` and `streamingBehavior: "steer" | "followUp"`. In this SDK version image content is:

```ts
{ type: "image", data: "<base64>", mimeType: "image/png" }
```

It is not the nested `{ source: ... }` shape shown in the original conceptual design example. `steer(text, images?)` and `followUp(text, images?)` are also available directly.

Prompt preflight can be observed with `preflightResult(success)`. A `true` callback means accepted/queued; the returned promise still waits for the whole run. Errors after acceptance are represented by messages/events. `abort()` waits for the agent to become idle and is suitable for lifecycle coordination.

## Active branch and entry IDs

Use the session manager rather than `session.messages` whenever entry identity matters:

- `session.sessionManager.getBranch()` returns the complete root-to-current-leaf path and preserves each Pi entry's `id`.
- `getEntry(id)` and `getChildren(id)` support fork validation.
- `buildContextEntries()` is active-branch and compaction-aware, so it may omit summarized historical entries. It is appropriate for model-context inspection, not for rendering the complete active branch.
- `getEntries()` returns every branch and must not be used directly for the v1 linear timeline.

The serializer will project message entries from `getBranch()` and retain their entry IDs. Non-message entries on that same path provide compaction, model, thinking, label, and session-name metadata.

## Fork adaptation

`runtime.fork(entryId)` defaults to `position: "before"`. It requires a user-message entry, creates a new session containing the path before that message, replaces `runtime.session`, and returns:

```ts
{ cancelled: boolean, selectedText?: string }
```

The design's `editorText` is therefore an application wire-field name mapped from SDK `selectedText`. `runtime.fork(entryId, { position: "at" })` clones through an entry and does not return selected text.

To preserve a live source conversation, ChatWCA must follow the design and invoke `fork()` on a separate temporary runtime opened from the source file. The temporary runtime is then promoted only after successful replacement; the source runtime is never switched.

## Test model support

`@earendil-works/pi-ai` 0.84.3 exports a deterministic faux provider (`fauxProvider`, `fauxAssistantMessage`, `fauxText`, `fauxThinking`, and `fauxToolCall`). It supports scripted responses, configurable streaming rate, text/image model declarations, and no paid provider.

The disposable smoke test runs with:

```sh
npm run test:sdk-smoke
```

It uses in-memory credentials/settings and temporary agent, workspace, model-store, and session directories. The test confirms that an empty/user-only session file is absent, the first completed assistant message flushes all accumulated entries, listing then discovers the session, and session/message entry IDs survive runtime disposal and reopening. It does not require provider credentials or network access.
