# Conversation Search Design

**Status:** Local search/API vertical slice implemented and tested: optional async
startup, one indexing worker, timer/mutation refresh, retrieval/grouping, status and
shutdown. Browser Global Search/navigation, retained state and message-focused opening
are implemented and synthetically tested. The bounded Pi reranking adapter and
query/runtime/API/browser wiring are tested, including the default-on App-memory toggle,
safe fallback labels and real browser-to-API/faux-Pi composition. The workstation's
explicitly approved rollout is live and verified, including real-history search,
message navigation and Pi reranking. Retired authority/cleanup/workspace-preparation
modules and obsolete tests are removed. This plan supersedes the earlier
authority/ticket/membership lifecycle. See [checkpoint.md](../checkpoint.md).

**Deployment:** One trusted user, one ChatWCA server process, local workspaces.

**Stack:** Existing PostgreSQL 17/pgvector schema, local Ollama
`qwen3-embedding:0.6b` (1,024 dimensions), Pi-configured OpenAI reranking.

## 1. Product and assumptions

Add **Global Search** alongside Conversations and Jobs. Search saved user/assistant
messages in one workspace or all registered workspaces; show conversation-grouped
excerpts that open the matching message. Combine lexical and vector retrieval,
with optional OpenAI reranking using Pi's existing authentication.

This is a single-user convenience feature, not a multi-tenant search system.
Workspace selection is an organizational filter, not a privacy or authorization
boundary. All accepted clients already have full application authority.

SQLite owns workspace/job metadata. Pi JSONL owns conversations. PostgreSQL is a
rebuildable cache. Briefly stale titles, excerpts and deleted-session hits are
acceptable; opening a stale result may fail normally. Do not build instant
revocation or proof-of-current-membership machinery.

Search is disabled by default. When enabled, reconcile asynchronously after server
startup and every 15 minutes, with manual Refresh and Rebuild. Dependency failure
affects search only, never conversations or jobs.

## 2. Keep, simplify, defer

**Keep the useful implemented foundations:**

- Explicit PostgreSQL migrations and current tables/indexes.
- Exact configured session-store discovery; no global Pi history scan.
- Read-only snapshots, saved-branch extraction and deterministic message chunks.
- Local bounded embeddings, model-space signatures and exact-input reuse.
- Atomic per-document publication, successful fingerprints and lexical metadata.
- Per-operation timeouts, cancellation, parameterized SQL and bounded responses.

**Excluded from the architecture:**

- Workspace incarnation seals and path/session epochs.
- Permanent suppression tombstones, capacity blocking and suppression-release protocols.
- Cleanup tickets, attempt-based ticket revocation and conditional cleanup continuations.
- Repeated filesystem/SQLite admission and authority checks around every await/COMMIT.
- Mandatory authoritative membership recovery before serving cached search results.
- Distributed/advisory writer coordination and a separate fair cleanup queue.

The retired modules and obsolete tests have been removed after approved rollout.
The document-indexer contract takes ordinary inputs without authority callbacks;
the serialized worker uses repository operations directly. Useful conditional-deletion
coverage remains in the repository suites; working SQL and migrations are unchanged.

**Defer unless actual use warrants them:** persistent run history, resumable scan
checkpoints, sophisticated backoff/fairness, HNSW, exhaustive pagination, query
rewriting, evaluation infrastructure and additional security/race abstractions.
The existing run table need not be used or removed for v1.

### Complexity budget and delivery priority

The earlier foundations overcomplicated a trusted single-user feature and delayed
proving the complete user experience. The design reset is the architecture to keep:
**one worker → cached index → local search → optional reranking**.

The browser toggle/fallback increment, synthetic end-to-end validation and approved
live rollout are complete. Do not add infrastructure, lifecycle frameworks,
new guarantees or another layer of standalone primitives.
Reranking remains optional; it must not obstruct usable local search.

Preserve safeguards with direct value: no source mutation, atomic replacement,
model-space consistency, bounded IO/responses and cancellation, and search failures
isolated from chat/jobs. Accepted staleness is not a defect to fix with more machinery.
Use existing tests and focused synthetic composition checks; do not grow an evaluation
or test framework to prove guarantees outside this product contract.

Retired foundations and obsolete tests are removed. Further abstraction cleanup,
optimization and reliability work should follow observed problems. The next product question is **“Does search work well for
the operator?”**, not “What additional guarantees can we build?”

## 3. Small architecture

```text
SQLite registrations --> one SearchIndexer --> read-only Pi JSONL
                                 |                  |
                                 |             extract/chunk
                                 |                  |
                                 +---------- local Ollama
                                 |                  |
                                 v                  v
                             PostgreSQL search cache
                                      |
Browser --> Search API --> lexical/vector --> RRF --> optional Pi rerank
   ^                                  |
   +----- grouped excerpts -----------+
   +----- existing conversation open, then message focus
```

Use one process-owned indexer for **all index mutations**: workspace synchronization,
document updates, deletion reconciliation and rebuild. A timer and manual refresh
call the same worker; a busy request sets one pending flag, with rebuild promoting
that flag to forced rereading. Do not add separate cleanup/scheduling services.

Retain the existing source, chunk, embedding and repository modules, and the
implemented query service/routes and optional reranker adapter.
Keep injectable IO boundaries for ordinary deterministic tests, not an interface
or lifecycle framework for every stage.

## 4. Corpus and extraction

Enumerate only each registered workspace's configured Pi-default or workspace-local
session directory. **All workspaces** means current registrations, not
`SessionManager.listAll()`. Keep existing directory/header validation; it helps
avoid accidental imports, but is not a promise of race-proof confidentiality.
Sandbox/tool policy does not govern whether the operator can search saved history.

Never use writable `SessionManager.open()` to index. Read version-3 JSONL without
modifying it; report unsupported/malformed files and continue to the next file.
Index the durable saved branch, including retained pre-compaction dialogue:

- User strings/text blocks and assistant text blocks only.
- Exclude thinking, images, tool calls/results, Bash, system/custom roles and summaries.
- Preserve entry ID, role, time, source text and source spans.
- Normalize line endings only. Context edits do not redact historical dialogue.
- Unsaved streaming content and prospective user-only forks are not searchable yet.

Keep current message chunks: at most 3,200 code points / 12 KiB UTF-8, up to 400
code points overlap, no cross-entry merging. Role prefix plus text is the embedding
input; titles/workspace names are lexical/display metadata only. Keep versioned
input hashes for reuse.

Existing bounds remain: 128 MiB snapshot, 48 MiB record, 20,000 chunks per document,
100,000 discovered paths per workspace. Over-limit/unstable files are skipped with
an error; never silently publish a shortened transcript.

## 5. Straightforward reconciliation

### One pass

1. Snapshot current SQLite registrations. For each workspace derive the existing
   source revision and synchronize its PostgreSQL metadata using the repository.
   The revision is a cache/source identity, not an authority capability.
2. Enumerate its session store. Record encountered paths (including unreadable or
   malformed JSONL) and admitted canonical targets in an in-memory seen set.
3. Compare candidate fingerprint/profile to the last successful checkpoint. Skip
   unchanged files; read new/changed/forced files through the existing snapshot API.
4. Extract/chunk, reuse exact-input embeddings in the same space, embed missing inputs
   in batches of at most 16, then atomically publish the conversation/checkpoint.
5. After a complete enumeration and a simple final directory-witness check, page
   through indexed checkpoints and delete rows whose source paths are absent from
   the seen set. Incomplete/missing/unreadable stores never authorize absence pruning.
6. Remove derived rows for registrations no longer present, and publish simple
   in-memory progress, last-success time and stable errors.

All these writes run through the same worker, so cleanup cannot overlap publication.
Use existing repository revision/generation checks where already required; do not
add a second epoch/ticket layer. Workspace sync reads/synchronizes derived metadata
directly, without a separate workspace synchronizer.

`SearchDocumentIndexer` now takes ordinary workspace/candidate/space/options,
without authority capabilities, and retains stable snapshot checking and a final source
fingerprint/model-space check. A straightforward current-registration comparison
at a workspace boundary is enough; a change during work can discard that workspace's
remaining work and request another pass. No repeated name/incarnation/pre-commit seals.

If a successfully published file now has a different session ID, remove prior IDs
at that canonical source path in this same worker. For failed reads/embeddings,
retain previous content and its successful checkpoint. Aliases should converge on
canonical targets; preserve encountered alias paths when considering absence.

### Mutations and eventual consistency

After successful app deletion/rewind or workspace changes, request a refresh. These
hooks do not suppress results, construct deletion capabilities or block the source
operation on PostgreSQL. External changes are found on the next scheduled/manual pass.
A file deleted during embedding may leave a stale cached generation until the next
pass; this is an accepted v1 tradeoff, not a reason to introduce tombstones.

Queries use current registered workspace IDs and the corresponding source revision
as ordinary SQL filters. They do not check source files per result, apply negative
suppression or revalidate candidates before responding. A query concurrent with a
workspace change may briefly return old results.

Missing stores retain cached rows and may still return cached results, clearly
marked stale/unavailable. Restart/restored-cache results are usable immediately;
background reconciliation improves freshness. No initial membership barrier.

### Refresh, rebuild, failures and shutdown

Refresh runs the normal pass. Rebuild forces rereading but can reuse matching input
vectors; a recompute option can bypass reuse later if needed. Replace documents
progressively, never truncate the whole index first.

Process one document at a time with existing IO bounds; yield between documents and
honor shutdown cancellation. A large pass may take time, but need not have resumable
checkpoints or a fairness framework. One failed document does not fail every workspace.
Retry on the next scheduled/manual pass; no automatic interactive or paid-call retries.

On PostgreSQL failure stop that pass and report search unavailable. On an ambiguous
COMMIT acknowledgement do not blindly retry; the next pass reads committed metadata.
On restart simply begin a new pass. Stop admission/timers, cancel work and close the
pool within the server's existing shutdown deadline.

## 6. Storage and embeddings

Keep `search_workspaces`, `search_documents`, `search_chunks`, `search_index_runs`
and migrations `001_initial.sql` / `002_checkpoint_lookup.sql`. Do not rewrite
checksum-tracked migrations. Add only repository operations needed for reconciliation,
retrieval and basic status; no new schema is required for the proposed v1 lifecycle.

PostgreSQL stays separate from SQLite/Network Brain. Use the existing explicit
`npm run search:migrate` command and loopback provisioning recipe. Application
startup checks compatibility but never applies DDL.

Retain local Qwen embeddings, normalized finite 1,024-dimensional vectors and exact
model-space filtering. Never compare vectors from different digests. If Ollama is
unavailable or the digest changes, serve lexical results while vector coverage catches
up. Do not pull models or reconfigure the shared daemon automatically.

Reuse Network Brain's batches of 16, cosine retrieval, lexical retrieval and RRF
`k=60` as references, not runtime imports. Existing adapters' size/time limits are
sufficient; do not add more admission abstractions before measuring a problem.

## 7. Retrieval and optional reranking

Validate a query (at most 2,048 code points / 8 KiB), workspace ID or All, and result
limit (default 10, maximum 20). Parameterize SQL. Filter both lexical and vector
channels by the selected current registrations/revisions; vector retrieval also
filters by embedding-space signature. This is predictable filtering, not multi-user
access control.

Retrieve `min(100, max(30, limit * 5))` candidates per channel, merge by chunk ID using
RRF `sum(1 / (60 + rank))`, collapse overlapping entry chunks and cap at five chunks
per conversation / 100 overall. Use exact vector search initially, with deterministic
ties. English and simple full-text indexes form one lexical channel.

Group by workspace/session, ordered by the best chunk, showing up to three excerpts.
Do not label similarity scores as relevance probabilities. Ollama failure falls back
to lexical; PostgreSQL failure returns a search-only unavailable error.

Local hybrid search is the first usable milestone. Add default-on, user-toggleable
reranking afterward; its absence is not a blocker for wiring or testing local search.
Use Pi's pinned `ModelRuntime.completeSimple()` with the configured native
`openai`/`openai-codex` model and auth. No agent session, tools, CLI subprocess, copied
OAuth token or separate API key. If no supported configured model is available,
return local results rather than blocking search.

Send only the query and bounded candidate excerpts with opaque IDs. Require an exact
JSON permutation of submitted IDs; never trust partial/malformed ordering. Use one
bounded call; on failure keep local ordering and show a warning. Skip remote calls
for zero/one candidate. Keep the existing planned bounds: 2,400 characters per
candidate, 80,000 candidate characters, 128 KiB prompt and 64 KiB output.

The operator accepts sending selected excerpts to the configured provider. Do not
add workspace-specific disclosure permissions or provider-isolation machinery.

The first reranking subincrement implements `search/rerank.ts`: supported configured
model selection, query/role/text-only opaque-ID prompts, character/UTF-8/JSON byte
bounds, exact permutation validation, one deadline-bounded `completeSimple()` call,
local fallback and cancellation/shutdown. Unit tests and actual pinned-SDK faux-provider
composition tests pass. The service now supplies the existing Pi runtime and copied
global default pair asynchronously only in optional mode. Queries apply the adapter
to the collapsed RRF pool before grouping, under the existing aggregate deadline and
two-reader admission. API requests default to reranking unless `rerank: false`; responses
carry requested/applied/stable reason, and safe capability reflects local model/auth
availability. Own rerank timeout/failure retains local ordering; aggregate timeout,
disconnect and shutdown propagate cancellation. Synthetic real-HTTP/pinned-runtime
composition tests cover these paths. The browser now sends its default-on App-memory
selection and labels actual response metadata, including safe local-fallback reasons.
Browser-to-real-API/faux-Pi tests also cover ordering, opt-out, scope, exact-message
navigation and cancellation reaching provider IO.

## 8. API, UI and configuration

```text
POST /api/search           query, workspaceId (null = All), limit, rerank
GET  /api/search/status    availability, progress, counts, freshness, errors
POST /api/search/refresh   workspaceId (null = All)
POST /api/search/rebuild   workspaceId (null = All), confirmed by UI
```

Return grouped titles, workspace names/IDs, session IDs, modified times and excerpts
with entry IDs/roles/times. Source paths, vectors and credentials are not needed in
public responses. Bound responses to 256 KiB, 20 groups, three excerpts each and
1,200 characters per excerpt. Bound full searches to 35 seconds; cancel superseded
requests. Maintenance requests return `202` and coalesce while busy.

Use the app's existing trusted-client/same-origin conventions; no new authentication
or permission layer. Do not log query bodies, excerpts or credentials.

The implemented Global Search page has submit/Enter, All/one-workspace selector,
explicit cancellation, freshness/error status, Refresh and confirmed Rebuild. Reranking
has a default-on user toggle retained in App memory, a provider disclosure/capability
hint, and safe applied/opt-out/too-few/local-fallback labels from each response.
Unavailable capability never disables search or resets the selection; the hint is
advisory startup configuration, not a health probe. Turning the toggle off keeps
query/excerpts local. Changing it does not relabel previous results. Search state
stays in browser memory while switching pages, not reload/local storage. Result selection uses the existing conversation-open
flow, then focuses `data-entry-id`; missing conversations/entries show a stale-result
notice. Never switch Pi branches automatically to satisfy a stale match.

Keep current startup-only settings and defaults:

| Variable | Default |
|---|---|
| `CHATWCA_SEARCH_MODE` | `disabled` |
| `CHATWCA_SEARCH_DATABASE_URL` | unset; required for optional mode |
| `CHATWCA_SEARCH_OLLAMA_URL` | `http://127.0.0.1:11434` |
| `CHATWCA_SEARCH_EMBEDDING_MODEL` | `qwen3-embedding:0.6b` |
| `CHATWCA_SEARCH_INDEX_INTERVAL_MS` | `900000` |
| `CHATWCA_SEARCH_EMBEDDING_TIMEOUT_MS` | `30000` |
| `CHATWCA_SEARCH_RERANK_TIMEOUT_MS` | `20000` |
| `CHATWCA_SEARCH_RERANK_PROVIDER` / `CHATWCA_SEARCH_RERANK_MODEL` | paired override or Pi global default |

Disabled mode does not scan history, construct a search pool or probe dependencies.
Enabled mode initializes asynchronously and advertises real capability/status in
`/api/config` once routes exist. Cached results need not wait for a successful pass.
Keep the pool of four and existing per-operation bounds; use a small search concurrency
limit and reject excess work instead of adding complex queues.

## 9. Finish-line plan and acceptance

Deliver user-visible vertical slices, not more standalone foundations:

1. **Working local search:** authority coupling is removed and the worker's
   sync/index/prune loop, coalescing, minimal status and local lexical/vector retrieval
   with RRF/grouping, startup/timer/mutation refresh/shutdown and search/status/
   refresh/rebuild routes are implemented. The full server path is tested with
   temporary sessions/SQLite, fake Ollama and disposable PostgreSQL.
2. **Browser increment complete:** Global Search and optional Pi reranking now have
   the default-on App-memory toggle and safe applied/local-fallback labels. Synthetic
   fixtures cover opt-out, unavailable capability, timeout/invalid-response fallback
   and cancellation/navigation. No additional backend foundations are needed.
3. **Released and verified:** typecheck/build/unit, integration and browser validation
   passed before explicit rollout approval. Live HTTP and browser checks verified real
   history search, exact-message opening and Pi reranking. Assess everyday operator
   relevance rather than adding infrastructure gates. Future synthetic checks need
   no production restart, real history, shared providers or paid calls.
4. **Post-rollout cleanup complete:** retired authority/cleanup/workspace-sync modules
   and obsolete tests are removed. Useful repository tests are retained. Working SQL
   and checksum-tracked migrations are unchanged. Consolidate other abstractions only
   when the maintenance benefit is clear.

Required tests cover source non-mutation/saved branches, unchanged-file skipping and
vector reuse, atomic replacement/rollback, complete versus incomplete-store pruning,
ordinary workspace filtering, single-flight/coalescing, restart using cached results,
lexical fallback, shutdown, RRF/grouping, rerank validation and result navigation.
No ABA, instant-revocation, tombstone-capacity, ticket-recovery or authoritative
membership proof tests are release requirements. Retired-module tests have been
removed; they do not dictate the current design.

The feature is done when a user can search one/all registered workspaces, find exact
and semantic matches, open the matching conversation/message, refresh/rebuild, and
see understandable freshness/fallback status; source history is untouched and search
outages leave chat/jobs working. Stale results between passes are explicitly acceptable.

## 10. Implementation inventory and references

Implemented and reusable: configuration; lazy PostgreSQL pool and migrations;
read-only session sources/extraction/chunking; bounded Ollama/signatures; atomic
repository/checkpoints/reuse/workspace pages; per-document indexing (ordinary inputs,
no authority coupling); serialized sync/discovery/index/prune worker with coalescing,
cancellation and in-memory progress/freshness/errors; parameterized local lexical/exact
vector retrieval with ordinary registration/revision/model-space filters; bounded query
service with RRF, overlap collapse, conversation grouping, lexical fallback, admission
and cancellation; process-owned optional lifecycle and HTTP search/status/refresh/rebuild
routes. Server composition tests use temporary SQLite/Pi stores, fresh fake Ollama and
disposable pgvector PostgreSQL, including actual WebSocket mutation hooks and shutdown.
Startup validates schema asynchronously without DDL; cached queries wait only for
compatibility, not a successful pass. `/api/config` reports nonsecret capability and
local reranking availability. Disabled startup never constructs search dependencies. Browser
Global Search uses configured-mode desktop/mobile navigation, page-active bounded
status polling, retained App-memory state, cancellable local searches, scoped maintenance,
plain-text grouped excerpts and existing conversation-open + exact-entry focus. Synthetic
browser tests cover initialization/outages, scopes, navigation retention, cancellation,
stale sessions/entries, grouped/empty results, mobile layout, the default-on retained
rerank selection and safe fallback reasons. Additional tests load the built app
against real same-origin HTTP/config/status/search and WebSocket routes, real
service/query/adapter and pinned Pi runtime with in-memory faux providers; only
storage/history/embedding/inference boundaries are synthetic. They cover OpenAI/Codex
ordering, scope/opt-out, message focus, fallback and provider IO cancellation.

Removed after rollout: the retired authority, cleanup and guarded workspace-preparation
modules, their ticket/incarnation/suppression-dependent tests and the unused source-error
suppression hint. Ownership validation, cached-content retention and repository
version-conditional deletion remain.

- [Technical design](design.md)
- [Checkpoint / next actions](../checkpoint.md)
- [Provisioning and existing adapter runbook](search-operations.md)
- Network Brain: `/home/adrian/projects/network-brain` (reference only)
- [Ollama embeddings](https://docs.ollama.com/api/embed)
- [pgvector](https://github.com/pgvector/pgvector)
