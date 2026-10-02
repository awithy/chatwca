# Pi SDK integration notes

**Validated version:** `@earendil-works/pi-coding-agent` 0.84.3

**Required Node version:** 22.19.0 or newer

These notes record the concrete SDK behavior on which ChatWCA relies. They are an adapter checklist, not a replacement for Pi's SDK documentation.

## Process-wide models

- Create the shared catalog/auth object with `await ModelRuntime.create(options?)`.
- `create()` restores cached catalogs and does not use the network by default. A bounded refresh is available through `refresh({ allowNetwork: true, force?, signal? })`; `PI_OFFLINE` disables model network access.
- Available authenticated models come from `await modelRuntime.getAvailable()`. A model advertises vision support when `model.input.includes("image")`.
- `ModelRuntime` has no disposal method in this version. It is safe to retain for the process lifetime.
- An explicit `model` passed to `createAgentSessionFromServices()` takes precedence over both session-restored models and settings defaults. ChatWCA snapshots global `defaultProvider`/`defaultModel` at startup, resolves them in the profile-specific catalog, and passes that model explicitly on creation, open, and fork replacement. Incomplete/unavailable configured defaults fail with `model_unavailable`; absent defaults retain Pi automatic selection. The fork adapter does not reapply the source's model. Selecting the model this way does not rewrite historical messages or append a model change to a resumed source merely to construct a temporary fork runtime; subsequent assistant messages record the model actually used.

## Optional conversation-search reranking adapter

- `src/server/search/rerank.ts` calls only `ModelRuntime.getModel()`,
  `hasConfiguredAuth()` and `completeSimple()`. Its caller supplies the existing
  runtime plus a startup snapshot of the global default pair (or the paired search
  override). No automatic model selection, AgentSession, tools, raw auth lookup,
  credential copying or search-specific API key is used.
- Supported provider/API pairs are `openai` with `openai-responses` or
  `openai-completions`, and `openai-codex` with `openai-codex-responses`. Availability
  checks use the local catalog/auth snapshot only. Unsupported/missing models or
  missing auth retain local ordering without inference.
- `completeSimple()` accepts `signal`, `timeoutMs`, `maxRetries: 0`,
  `maxRetryDelayMs: 0`, `maxTokens`, `transport: "sse"` and `cacheRetention: "none"`.
  `SimpleStreamOptions.reasoning` does **not** accept `"off"`; the adapter omits it
  and lets the native provider apply its model's default/off behavior. The adapter
  owns a deadline race even when injected completion IO ignores cancellation.
- A single call receives only query and bounded role/text excerpts with request-local
  opaque IDs. Only a successful exact JSON ID permutation changes ordering. Errors,
  output limits, malformed/partial replies and own-deadline expiry retain original
  candidate objects/order with a stable reason; caller cancellation, aggregate query
  expiry and shutdown propagate instead of becoming successful fallback.
- Synthetic tests exercise the actual pinned `ModelRuntime` auth/stream facade with
  in-memory faux OpenAI/Codex providers, not live credentials or inference. Native
  provider registration starts a local asynchronous refresh; tests await a complete
  availability snapshot before asserting `hasConfiguredAuth()`.
- The optional service now receives the existing `PiRuntimeFactory.modelRuntime`
  and a copied global-only startup model pair asynchronously after listener readiness.
  No extra ModelRuntime or SettingsManager is constructed for search. Query reranking
  runs after RRF/overlap collapse and before grouping, within the aggregate deadline
  and two-reader admission. API default-on/opt-out, capability and stable fallback
  reasons are wired and synthetically tested through the actual pinned runtime facade.
  The browser defaults on with an App-memory user toggle and safe applied/local-fallback
  labels. Synthetic browser-to-real-API/faux-Pi checks cover ordering, opt-out, message
  focus, fallback and cancellation reaching provider IO; workstation search
  remains disabled.

## Strict sandbox resources and tools (Phase 6)

The installed package and runtime exports were re-verified at `0.84.3` before implementing the strict adapter:

- `createReadToolDefinition`, `createWriteToolDefinition`, `createEditToolDefinition`, `createBashToolDefinition`, `createLsToolDefinition`, `createGrepToolDefinition`, and `createFindToolDefinition` are exported. ChatWCA uses them only to obtain pinned names, labels, descriptions, TypeBox schemas, prompt snippets/guidelines, and edit argument preparation; none of their `execute` functions or TUI renderers are retained.
- `createAgentSessionFromServices()` accepts both `customTools` and a `tools` allowlist. In 0.84.3 a custom definition replaces the same-name built-in in the final registry, while the allowlist filters built-in, extension, and SDK tools. Sandboxed sessions pass the same explicit seven names in both places and contract-test `session.agent.state.tools`.
- `ResourceLoader` is a small public interface, and `createExtensionRuntime()` is exported. The strict loader follows the SDK's `examples/sdk/12-full-control.ts` pattern rather than wrapping `DefaultResourceLoader`; therefore package, extension, skill, prompt, theme, system/append-prompt, and ancestor-context discovery never starts.
- A custom system prompt is still followed by Pi's `Current working directory: ...` line. Strict `AgentSessionServices.cwd` is consequently `/workspace`, while the parent-owned `SessionManager` and `AgentSessionRuntime` retain the canonical host workspace for persistence and ownership checks.
- `SettingsManager.inMemory()` performs no settings file I/O. ChatWCA snapshots only safe administrator global model/thinking/retry/compaction/transport fields and omits project, package, resource, tool, shell, proxy, and session-path fields.
- `createBashToolDefinition(..., { exposeSessionEnvironment: false })` omits the `PI_*` prompt guideline. ChatWCA's app-owned bash executor also bypasses Pi shell operations entirely, so no Pi session environment reaches the worker.
- `ModelRuntime.create()` accepts explicit `authPath`, `modelsPath`, and `modelsStorePath`. The unrestricted and strict instances use the same administrator-owned files but are distinct objects; only the unrestricted instance is ever supplied to extension-capable services.

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

`listAll()` does not take a CWD. It scans Pi's complete default session root, or the supplied session directory. It is an SDK capability, but ChatWCA normal operation does not call it. ChatWCA uses `SessionManager.list(workspace.path, workspace.sessionDirectory ?? undefined)` only after a browser selects a workspace, and repeats that same scoped listing to authorize open and delete operations. Startup, browser connection, and workspace listing do not list Pi sessions. `SessionInfo` includes `path`, `id`, `cwd`, optional `name`, optional `parentSessionPath`, `created`, `modified`, `messageCount`, `firstMessage`, and `allMessagesText`.

There is no exported session-deletion API. Pi's own TUI tries the external `trash` command and falls back to `fs.unlink`. ChatWCA implements deletion at its filesystem boundary, but only after resolving the requested file through a fresh workspace-configured `SessionManager.list()` allow-set, verifying workspace ownership, and confirming that it is not live.

### Conversation search implementation boundary

The [search foundations](search-operations.md) now include configuration/schema tooling
and read-only source/extraction/chunking adapters, but no service workers or search model
runtime/credential access. They do not change these SDK history paths. Canonical
workspace/header-CWD checks are shared through `session-scope.ts`.

`tests/integration/search-session-source.test.ts` validates the exact default/local
store convention, saved-branch reopen parity, compaction retention, multiple roots,
transient live cursors, SDK forks, source bytes/mtime, and large image-bearing records.
A user-only fork has a prospective path but remains undiscoverable until its first
assistant response, just like a new session. Search never uses writable
`SessionManager.open()`: the SDK's last persisted tree entry determines the saved leaf.
Its internal default-directory helper creates missing stores and is not publicly
exported, so search derives the pinned convention without touching the filesystem.
Fresh scoped SDK listings remain the authority for open/delete. Background indexing
and the new opt-in JSONL projection are not wired to application startup yet.

## Persistence and durability

Pi persistence is synchronous and append-only once a session file exists, but a new persistent session intentionally delays file creation:

1. `SessionManager.create(cwd, sessionDir?)` allocates an ID and prospective file path without creating the file. ChatWCA supplies `<workspace>/.chatwca/sessions` for a workspace whose immutable storage policy selects local sessions.
2. User entries are appended on `message_end`, but a user-only session remains memory-only.
3. On the first assistant `message_end` (including terminal error/abort responses), Pi writes the header and accumulated entries synchronously.
4. Later entries are appended synchronously.

Therefore empty and user-only conversations are not returned by listing APIs and do not survive process exit. ChatWCA must not claim that a newly created session is durable until the first assistant message has ended. This is accepted SDK behavior; no application JSONL writer will be added.

Opening uses the CWD from the session header unless `cwdOverride` is passed. Runtime creation rejects a missing stored CWD. ChatWCA does not pass a CWD override: it verifies that each scoped listing result's canonical header CWD equals the selected workspace path before the session may be opened.

## Events, prompting, and abort

`AgentSession.subscribe(listener)` returns an unsubscribe function. Subscriptions belong to that exact session object and do not move when `runtime.session` is replaced.

`session.getContextUsage()` returns Pi's active-context estimate as `{ tokens, contextWindow, percent }`. After compaction, `tokens` and `percent` are `null` until a reliable assistant response occurs; `contextWindow` remains available. ChatWCA includes this value in authoritative snapshots and completed-message events so the header stays current without reimplementing Pi's compaction-aware accounting.

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
