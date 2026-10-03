# Workspace Conversation Search and Read Tools

**Status:** Implemented and locally validated (steps 1–8), including release gates, disposable PG17/pgvector checks and real Bubblewrap pair acceptance with synthetic cache/faux providers. Deployed on this workstation following explicit approval on 2026-10-03; health, search readiness, sandbox startup probes, schema-v9 migration and served UI verified. Workspace selection remains default-off. See [`checkpoint.md`](../checkpoint.md) for deployment details.

**Runtime:** Node.js 22.19+, TypeScript, Pi SDK 0.84.3

**Deployment:** One trusted user, one ChatWCA server process

## 1. Decision

Add an optional **Conversation history** capability to each workspace. Enabling it makes two ordinary Pi tools available to that workspace's agent:

- `conversation_search`: search cached conversation dialogue.
- `conversation_read`: retrieve cached dialogue from a conversation, with bounded pagination and message-focused context.

This is not a new agent or a special browser search mode. The tools are used like `network_brain_search`: enable them in Add/Edit Workspace, then the normal conversation agent can call them. One checkbox enables both tools.

The agreed scope is:

- Search and read across **all currently registered workspaces**, regardless of which workspace enabled the tools.
- Return **user and assistant text only**.
- Serve **cached indexed content**; source freshness and immediate deletion visibility are not guarantees.
- Keep workspace sandboxing intact. The tools execute in the parent process without exposing session files, PostgreSQL, or general host/network access to workspace processes.

This is a single-user convenience feature. Do not introduce per-source-workspace sharing permissions, approval prompts, privacy roles, or a general capability framework.

## 2. Goals and non-goals

### Goals

- Let an ordinary agent find earlier discussions and inspect enough dialogue to answer accurately.
- Reuse the existing lexical/vector search, optional Pi reranking, and PostgreSQL cache.
- Default the capability off for new and existing workspaces.
- Support unrestricted, isolated sandbox, and managed-egress conversations.
- Preserve immutable runtime tool selections and existing live-workspace edit restrictions.
- Return identifiable evidence: workspace, conversation, and message entry IDs.
- Bound execution, database reads, model-facing output, and pagination; propagate cancellation.
- Keep search failures independent of conversation creation, chat, and scheduled-job execution.

### Non-goals

- A dedicated search agent, subagent runner, or recursive model workflow
- A new index, embedding pipeline, transcript store, or MCP server
- Search/read of unregistered global Pi history
- Reading current JSONL or live in-memory dialogue during tool calls
- Tool calls/results, thinking, images, system/custom messages, or abandoned branches
- Conversation mutation, opening, deletion, branch navigation, or file access
- Agent-triggered refresh/rebuild maintenance
- Instant revocation, filesystem membership proofs, or distributed coordination
- Browser editing of tool definitions or operational limits

## 3. Existing implementation to reuse

| Component | Relevant behavior |
|---|---|
| `src/server/search/service.ts` | Process-owned optional search service, asynchronous startup, availability, freshness, shutdown |
| `src/server/search/query.ts` | Hybrid/lexical retrieval, RRF, conversation grouping, optional reranking, bounded admission/cancellation |
| `src/server/search/retrieval.ts` | Parameterized queries scoped to current registrations and source revisions |
| `src/server/search/extract.ts` | Saved-branch user/assistant text, retained pre-compaction dialogue, no tool/provider payloads |
| `src/server/search/chunk.ts` | Complete text coverage with overlapping message-local UTF-8 byte spans and conversation-wide chunk ordinals |
| `migrations/search/001_initial.sql` | Cached document metadata and chunk text, roles, entry IDs, timestamps, ordering, and document generations |
| `src/server/pi-runtime.ts` | Parent-owned custom tools in both security profiles and runtime reconstruction |
| `src/server/workspace-repository.ts` | Persisted workspace selections and immutable resolved runtime policy |
| `src/server/http-tool.ts` | Existing parent-owned tool execution pattern |

The cache already contains the dialogue needed for reading. No PostgreSQL schema change was needed. SQLite schema v9 adds workspace enablement.

## 4. Architecture

```text
Workspace: Conversation history enabled
                 |
                 v
       Normal Pi conversation agent
          |                 |
 conversation_search   conversation_read
          |                 |
          +---- parent -----+
          |                 |
 Existing query service   Cached transcript reader
          |                 |
          +--- PostgreSQL --+
                 ^
                 |
       Existing SearchIndexer
                 |
       Registered Pi session stores
```

Both tool implementations call internal TypeScript services. They do not make HTTP requests back to ChatWCA and are not entries in the fixed-destination HTTP catalog.

The existing browser search API remains unchanged. No new public HTTP endpoint is required for the tools.

`conversation_read` performs no embedding or model call. `conversation_search` uses the existing optional reranker and its bounded fallback behavior; the reranker remains a completion without tools, not an agent.

## 5. Tool contracts

Parameters use closed object schemas. Validate at the service boundary as well as through Pi. Neither tool accepts a filesystem path, database identifier, destination URL, or arbitrary SQL.

### 5.1 `conversation_search`

Example:

```json
{
  "query": "Why did we choose Bubblewrap instead of containers?",
  "limit": 5
}
```

Parameters:

| Field | Behavior |
|---|---|
| `query` | Required non-empty text; existing maximum of 2,048 code points / 8 KiB |
| `workspaceId` | Optional registered workspace ID; omitted means all registered workspaces |
| `limit` | Optional conversation limit, default 5, maximum 20 |
| `rerank` | Optional boolean, default true, matching the existing search API; false avoids the additional provider reranking call |

Return the existing grouped result shape, with service freshness added:

- `cached: true`, retrieval mode, warnings, and reranking outcome;
- workspace ID/name, session ID, title, and modified time;
- matching excerpts with entry ID, role, timestamp, text, truncation flag, and indexing time;
- freshness state, indexing indicator, last successful pass, and safe error metadata.

The tool prompt should tell the agent to use returned workspace/session/entry IDs with `conversation_read` when excerpts are insufficient. Search ordering is not a relevance probability.

Use a bounded compact serialization. If the model-facing budget is smaller than the existing 256 KiB public API limit, remove whole lowest-ranked groups/excerpts and report that reduction. Do not cut serialized JSON mid-object. The factory returns `reduction: { reduced, omittedConversations, omittedExcerpts }`, with omission counts relative to the grouped service response.

### 5.2 `conversation_read`

Read from the beginning:

```json
{
  "workspaceId": "workspace-id",
  "sessionId": "session-id"
}
```

Read context for a search hit:

```json
{
  "workspaceId": "workspace-id",
  "sessionId": "session-id",
  "aroundEntryId": "message-entry-id"
}
```

Continue a response:

```json
{
  "workspaceId": "workspace-id",
  "sessionId": "session-id",
  "cursor": "opaque-continuation"
}
```

Parameters:

| Field | Behavior |
|---|---|
| `workspaceId` | Required current registered workspace ID |
| `sessionId` | Required session ID, scoped by workspace |
| `aroundEntryId` | Optional user/assistant entry ID in the indexed saved branch; initial request only |
| `cursor` | Optional bounded continuation token; mutually exclusive with `aroundEntryId` |
| `limit` | Optional maximum messages represented in the page, default 10, maximum 20 |

Return:

- `cached: true`;
- workspace ID/name, session ID, title, modified time, and `indexedAt`;
- the cached document generation as an exact string;
- ordered user/assistant text segments with entry ID, role, timestamp, and message-local byte range;
- whether each segment begins/ends the message;
- `nextCursor`, or null when the selected forward range is exhausted;
- the requested anchor ID and whether preceding context was reduced, for focused reads;
- service freshness.

A page may contain only part of a large message. This must be explicit, with a cursor continuing the same message. Never skip the remainder because the message-count or byte limit was reached.

Focused reads begin with up to two preceding dialogue messages and continue through the anchor and later dialogue. The anchor must appear in the first response. Reduce or omit preceding context if necessary to fit the budget, and report that reduction. For a large anchor, include its initial segment and continue it on the next page. Focused mode is a context window, not a promise to return all preceding history.

A missing anchor returns a specific stale/missing-entry error. Do not silently read another branch or substitute a different message.

## 6. Cached transcript reading and pagination

### 6.1 Scope and lookup

At each call, obtain current registered workspaces and derive their existing `workspaceSourceRevision`. Resolve the requested document by workspace ID, session ID, and matching source revision, including the matching cached workspace revision.

This is the same ordinary registration filtering used by search, not an authorization-ticket system. Removed registrations and obsolete source revisions are excluded. A concurrent registration change may briefly overlap a response, consistent with the existing search contract.

Do not call `requireUsable()` for the source workspace. Reading its cache does not execute its tools and must not depend on its sandbox/network policy being usable. Do not require its directory to be currently available: retained cached content is useful during source outages.

Session IDs alone are insufficient because different registered scopes may contain the same ID.

### 6.2 Reconstruct text without duplicated overlaps

Order chunks by their stored conversation-wide `ordinal`. Group contiguous chunks by entry ID. Their byte spans are relative to the normalized text of that message, not the JSONL file.

For a message segment:

1. Read the necessary bounded chunk rows.
2. Validate ordering, role/entry identity, UTF-8 lengths, and span coverage.
3. Remove the byte prefix already covered by a preceding chunk.
4. Preserve all remaining source text, including whitespace and code fences.
5. Slice output only at UTF-8 code-point boundaries.

Never concatenate overlapping chunks unchanged. Do not trim, summarize, reformat, add synthetic fence delimiters, or merge separate messages into one message.

A gap or inconsistent overlap is a cache-read failure, not permission to invent missing text. The reader must not fall back to JSONL or publish a shortened transcript as complete.

Fetch bounded rows and bytes; do not load an entire potentially large conversation into memory to construct one page. Existing 12 KiB chunk limits make incremental reading straightforward.

### 6.3 Consistent pages and continuation

Read document metadata and selected chunks from one database snapshot: use a single statement where practical, or a short read transaction with snapshot consistency. Atomic document publication already supplies the underlying generation boundary.

A cursor identifies the cached document ID, exact generation, and next message/chunk position plus message-local byte offset. Keep its encoding versioned, length-bounded, and strictly validated. It is a continuation position, not a permission grant, and contains no paths or credentials.

On continuation:

- resolve the workspace/session through current registration filters again;
- reject a cursor for a different document or request identity;
- if the cached generation changed, return `conversation_cursor_stale` and ask the agent to restart the read;
- otherwise resume at exactly the next undisclosed byte, including inside a large message.

No cursor store, signatures, historical-generation retention, or long-lived transaction is needed in this trusted single-user environment.

### 6.4 Bounds

Use fixed internal defaults for v1, not more environment variables:

| Boundary | Implemented limit |
|---|---:|
| Model-facing complete tool output | 48 KiB UTF-8, including envelope and continuation metadata |
| Read page messages | Default 10, maximum 20 |
| Cursor input | 2 KiB |
| Read chunk rows per request, including context selection | 128 |
| Read database/text payload | 1 MiB aggregate |
| Aggregate read execution deadline | 10 seconds |
| Concurrent read calls | 2; reject excess work, no queue |
| Search execution | Existing 35-second aggregate deadline and two-query admission |

Count serialized bytes, not just dialogue text. Reserve space for metadata and continuation. At any paging bound, return a valid shorter page with continuation, not a raw truncated response. Tool details must remain bounded too and must not duplicate an unbounded transcript. The factories measure the complete serialized Pi result, including JSON-in-text escaping and details. Read uses an internal conservative 22-KiB page budget; non-tool readers retain the 44-KiB default. This budget is not a model-facing parameter.

Abort signals and shutdown propagate through database IO. A non-cooperative injected dependency must not hold the tool call past its deadline. Keep this within existing cancellation/deadline patterns rather than adding another lifecycle framework.

## 7. Workspace persistence and UI

### 7.1 Stored selection

`conversationToolsEnabled` is a persisted boolean in workspace metadata. SQLite schema v9 adds a checked integer column on `workspaces`, with default 0. Fresh and migrated workspaces start disabled. Workspace summaries expose `effectiveConversationTools`, resolved from the stored selection and startup search mode (not service readiness). Runtime policy and conversation state capture the same effective names immutably; the runtime factory supplies the selected pair through its existing parent-owned tools path.

- Create omission means false.
- Update omission preserves the stored value.
- Updating this field while the workspace has a live conversation returns `workspace_busy`, matching existing tool-authority edits.
- Renaming a workspace retains existing behavior.
- Deleting a workspace deletes the selection with its row.

Do not repurpose `workspace_http_tools` or put built-in selections into the external HTTP catalog.

### 7.2 Stored versus effective state

Resolve the selected pair into runtime policy when:

- `conversationToolsEnabled` is true; and
- startup search mode is `optional`.

Search readiness is **not** a runtime-authority toggle. In optional mode, initialization or dependency outages leave both selected tools advertised; calls return stable availability errors until the service can answer. A recovered service can then answer without reopening the conversation.

When search mode is disabled, retain the selection but contribute no executable tools. Show it as unavailable. Do not make the whole workspace unusable.

Expose stored enablement and effective tool names in workspace information and captured effective names in conversation state. No secrets or database connection details enter public projections.

### 7.3 Add/Edit Workspace

Show **Conversation history** alongside existing optional tool controls, with one unchecked-by-default checkbox and this disclosure:

> Search and read cached user/assistant dialogue from all registered workspaces. These tools run outside workspace sandboxing. Retrieved dialogue can be sent to this conversation's model provider; search may also use optional provider reranking.

Keep the HTTP tools' fixed endpoints visible in their own existing controls. The built-in pair does not have an HTTP endpoint to display.

Lock the selection while the workspace is live. When search is disabled, show the capability as unavailable, preserve an existing stored selection, and permit removing it once idle. Do not allow a new unavailable grant to appear effective.

Workspace Info shows stored selection, effective names, and availability. No separate per-call confirmation or source-workspace opt-in is required.

## 8. Runtime and sandbox integration

The process-owned search service is injected into `PiRuntimeFactory`. Selected definitions use the runtime's captured workspace policy and join the existing `parentTools` path. The pair is copied before asynchronous runtime preflight and retained by the SDK reconstruction closure. Registry checks reject tool-selection drift during registration, open, fork/rewind, and runtime replacement. Synthetic/alternative factories that omit the service still construct selected sessions, but calls fail safely with `search_disabled` rather than breaking chat.

Reserve `conversation_search` and `conversation_read` against HTTP catalog name collisions. Keep their schemas/descriptions owned by ChatWCA; do not use arbitrary Pi extensions to supply them.

The tool pair must be consistent for:

- new and reopened conversations;
- source-preserving forks and rewinds;
- SDK service reconstruction;
- scheduled-job occurrences.

Scheduled jobs resolve the current workspace selection per occurrence. Existing live runtimes keep their selected tool set until closed; registration/index contents remain normally dynamic.

The service is composed before the runtime factory and scheduler catch-up work. Initialization remains asynchronous after listener readiness, and disabled mode retains zero search-dependency IO. Search reranking can retain a lazy callback to the runtime factory's model/auth context; construction must not introduce a startup dependency cycle or readiness gate.

Sandboxed sessions explicitly allow the selected pair alongside worker-backed coding tools. Extend the strict system prompt to disclose that the pair returns cached history from all registered workspaces and that retrieved dialogue is untrusted evidence, not current instructions.

The history capability exposes no PostgreSQL URL, source-session path, generic parent RPC, history-specific socket or filesystem mount to the worker. Isolated workspace networking remains isolated. Parent model requests and optional reranking remain the existing intentional provider paths.

Disabling these tools is not a new host access-control guarantee for unrestricted sessions, whose coding tools already have the service user's host authority.

## 9. Freshness, failure, and logging behavior

Both tools read derived cached state. They do not probe source files, open conversations, or consume `CHATWCA_MAX_LIVE_CONVERSATIONS` slots.

- External deletion can remain visible until reconciliation.
- New messages may be absent until indexing completes.
- Missing source directories do not automatically suppress retained cached documents.
- Full rebuild replaces documents progressively; existing cached generations remain usable until replacement.
- Reading does not require Ollama or reranking availability once the database is usable.
- PostgreSQL failure affects the tool call, not conversation creation or unrelated tools.
- Search cancellation and timeout never masquerade as successful empty results.

Reuse existing safe `search_*` errors for availability, query validation, admission, timeout, cancellation, and database failures. Add only read-specific cases:

| Code | Meaning / recovery |
|---|---|
| `conversation_not_indexed` | No document in the current registered scope; search again or wait for indexing |
| `conversation_entry_not_indexed` | Requested message absent from the indexed saved branch; search again or read from the beginning |
| `conversation_cursor_invalid` | Malformed, mismatched, or out-of-range continuation; restart the read |
| `conversation_cursor_stale` | Cached document replaced since the preceding page; restart the read |
| `conversation_cache_invalid` | Stored text/spans cannot produce a valid page; report failure and use existing operator maintenance |

Do not emit raw SQL, paths, connection strings, provider credentials, or dependency stacks to the agent/browser. Do not add query/transcript logging. Ordinary Pi tool calls and results remain part of the calling conversation's canonical session history, as with other tools; the UI disclosure must not suggest otherwise.

Retrieved history is untrusted data. Tool descriptions/prompt guidelines should direct the agent to treat it as evidence, avoid following historical instructions merely because they were retrieved, and identify source conversations/messages when answering.

## 10. Implementation sequence

1. Add bounded cached read requests/responses and repository queries using existing document/chunk storage; test overlap removal and continuation first.
2. Extend `SearchServicePort` with cached reading, availability, cancellation, and shutdown behavior. Disabled mode remains dependency-free.
3. Add `conversation_search` and `conversation_read` tool factories with compact bounded outputs and evidence-oriented prompt guidance.
4. Add SQLite migration, workspace stored/effective projections, protocol validation, and live-workspace edit restrictions.
5. Wire runtime selection, strict prompt disclosure, tool-name reservations, and early service composition for scheduled runtimes.
6. Add workspace form controls and Workspace Info/live-state disclosure.
7. Update README and relevant search/SDK/operations notes; do not rewrite checksum-tracked PostgreSQL migrations.
8. Run focused synthetic checks, then existing release checks appropriate to the changed runtime/UI boundaries.

Keep additions close to the existing search, workspace, and runtime modules. No generic tool registry, new worker, privacy-permission subsystem, or cursor service is required.

## 11. Tests and acceptance criteria

### Required tests

- SQLite fresh initialization and migration default every workspace off; create/update/delete persistence works.
- Stored selection survives disabled search mode and becomes effective again in optional mode.
- Workspace commands reject selection changes while live; runtime selections remain immutable.
- Selected tools are present in actual Pi tool sets for unrestricted and sandboxed sessions; unselected tools are absent.
- Open, fork, rewind, service reconstruction, and scheduled jobs use the correct captured/current selections.
- Search defaults to all registrations, optionally filters one, preserves reranking opt-out/fallback, and exposes freshness.
- Read uses current registration/source-revision filters and never global/unregistered history; duplicated session IDs remain workspace-scoped.
- Read returns saved-branch user/assistant text only, including retained pre-compaction text; no tool/thinking/image/provider payloads leak.
- Overlapping chunks reconstruct text exactly, including multibyte Unicode, line endings, whitespace, and split code fences.
- Byte-limited reads resume within large messages without omission or duplication; message and row limits return valid continuation.
- Focused reads include their anchor, reduce preceding context explicitly, and report missing entries instead of switching branches.
- Malformed/mismatched/out-of-range cursors fail safely; generation replacement makes continuation stale.
- A page never mixes document generations during concurrent index publication.
- Calls leave Pi source files untouched, create no live runtime, and perform no source-file IO.
- Source outages and stale cached deletion hits remain acceptable; removed registrations and obsolete revisions are filtered normally.
- PostgreSQL outages, disabled/initializing service, admission limits, cancellation, deadlines, and shutdown yield safe errors without breaking chat/jobs.
- Browser controls default off, disclose global history/provider use, lock while live, and show stored/effective/unavailable state.

Use temporary SQLite/Pi state, faux providers, fake embeddings, and disposable pgvector PostgreSQL according to the existing search runbook. Synthetic validation does not require paid inference, production history, a live database migration, or a service restart.

### Acceptance

The feature is complete when a user can enable **Conversation history** in any workspace, ask its ordinary agent about an earlier discussion across registered workspaces, and see the agent search and read paginated cached evidence using the two tools. The same workflow works in an isolated sandbox without giving workspace processes access to host sessions or the search database. Defaults, freshness, failure isolation, output bounds, and live-runtime selection rules match this document.

### Local validation

`npm run test:release-gates` passed, along with the optional-outage history browser
cases and the full integration suite against disposable PG17/pgvector. Real Bubblewrap
acceptance covers selected parent search/read calls and exact pagination in isolated
and managed-egress sessions while protected stores and parent credentials remain
inaccessible to workspace processes. Source files, credentials, embeddings and model
responses used by these checks are synthetic; no production history or paid inference
was used. The separate resource-stress case remains opt-in and was not run. See
[`checkpoint.md`](../checkpoint.md) for counts and deployment status.

## 12. References

- [Conversation search design](search-design.md)
- [Search provisioning and operations](search-operations.md)
- [Workspace HTTP tools design](http-tools-design.md)
- [Validated Pi SDK integration notes](pi-sdk-notes.md)
- [Bubblewrap design](bubblewrap-design.md)
