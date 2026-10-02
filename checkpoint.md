# ChatWCA Conversation Search Checkpoint

**Updated:** 2026-10-01T19:44:42-07:00

## Approved rollout: live and verified

The operator explicitly approved release on 2026-10-01: **“Let's go. I approve release.”**
This approval supersedes the disabled-until-approval instructions in historical
increments below. Enablement and service restart are now authorized.

- `npm run typecheck`, `npm run build:server`, `npm run build:web` passed again;
  the existing web chunk-size warning remains. Existing uncommitted work preserved.
- Provisioned dedicated `chatwca-search-postgres-1` from the existing Compose recipe:
  PostgreSQL 17/pgvector, loopback `127.0.0.1:55432`, persistent named volume
  `chatwca-search_postgres-data`, restart policy `unless-stopped`. Other databases
  were not touched. Applied the two existing checksum-tracked migrations unchanged.
- Dedicated `chatwca_search` application role has DML and migration-metadata SELECT,
  not superuser/CREATEDB/CREATEROLE. Unique administrator/application passwords are
  in `/home/adrian/.config/chatwca/search-postgres.env` (0600), outside the checkout.
  Compose operations require `--env-file` pointing at that protected file.
- Actual gitignored `.env` now has `CHATWCA_SEARCH_MODE=optional`, the application
  database URL, existing local Ollama and `qwen3-embedding:0.6b`; permissions tightened
  to 0600. Pre-change backup:
  `/home/adrian/.local/state/chatwca/env-before-search-20261001T191933` (0600).
- Ran sequential one-off production SearchService instances against **read-only**
  existing SQLite registrations and real configured history/local Ollama, without
  a second HTTP server, scheduler, chat runtime or paid inference. These preparation
  runs populated **212 conversations / 3,090 chunks** before their smoke windows
  ended; services were closed/cancelled normally, with no worker errors observed.
  The production initial pass subsequently reused them and completed the cache:
  **14 workspace rows / 273 conversations / 3,210 chunks**.
- Two all-workspace exact/topic and semantic-paraphrase queries and corresponding
  one-workspace queries returned hybrid results, no warnings; all-workspace calls
  took about 0.55–0.70 seconds. Query-only injected unreachable Ollama endpoint
  returned cached lexical results with `search_embedding_unavailable`.
- The operator performed the privileged restart at **2026-10-01 19:42:00 PDT**.
  `chatwca.service` is active, PID **4162468**. `/api/health` returns ready/200;
  `/api/config.search` is optional/ready/available with `rerankAvailable: true`.
  Initial production indexing finished at 19:42:16: 61 published, 212 unchanged,
  273 discovered, zero failed/deleted/errors. No one-off writer remains.
- **Real HTTP validation:** two all-workspace exact/topic and semantic-paraphrase
  queries plus corresponding one-workspace queries returned hybrid results without
  warnings. Warm all-workspace calls took about 71–153 ms with reranking off.
- **Real Chromium/browser validation:** default-on toggle and configured-provider
  disclosure visible; one real Pi provider completion returned a validated ordering
  (`requested: true`, `applied: true`, `reason: applied`) and the applied UI label.
  Opt-out returned `not_requested` and the local-order label. Real result opening
  focused exactly one matching `data-entry-id`. Back to search retained query,
  results and opt-out. Scoped browser search returned only the selected workspace.
  Refresh returned 202 and displayed its notice; rebuild confirmation was shown
  and cancelled (no forced rebuild). Reload restored an empty query/default-on
  toggle. No browser page errors observed. No prompts or transcript edits submitted.
- The first ad-hoc browser check's final assertion incorrectly expected the entire
  refresh notice to equal “Refresh queued.”; the UI correctly includes additional
  explanatory text. Rechecked against the existing full notice and passed; no
  production fix needed. All preceding rerank/navigation checks passed that run.
- Final refresh finished at 19:44:24: all 273 documents unchanged, idle/no pending
  work, zero errors, same 3,210 chunks. Health still ready; startup journal clean.

**Next:** reload the operator's browser and use Global Search for actual questions.
Deployment/local retrieval/navigation and one real rerank completion are verified;
operator relevance remains a usage assessment, not another infrastructure gate.
Fallback is covered by the real-cache query-only unreachable-provider check and
existing synthetic UI/API tests, not a deliberate outage of live dependencies.
Do not run another writer alongside production search. Retired-module cleanup is
separate; add reliability/optimization only for observed problems. No commit made.

## Design reset: finish the single-user feature

The operator explicitly rejected the earlier privacy/scoping-heavy design as
unnecessary for this single-user app. **The simplified plan in
[`docs/search-design.md`](docs/search-design.md) supersedes the old increment roadmap.**
[`docs/design.md`](docs/design.md), section 17.4, summarizes it.

Do not continue building authority/ticket/membership foundations. Workspace scope
is a search filter, not a security boundary. Briefly stale/deleted-session hits
are acceptable. Cached results may be served after restart or while a source store
is unavailable, with freshness/error status; opening a stale hit may fail normally.

Build one serialized indexer and a working local search/API vertical slice, then
Global Search UI and optional Pi reranking. Get user-visible search working rather
than adding another layer of unwired primitives.

**The local search/API vertical slice is implemented and validated.** Optional mode
now initializes asynchronously after listener readiness, checks schema compatibility
without DDL, starts the indexing/pruning worker and timer, serves hybrid/cached search,
status/refresh/rebuild routes, and cancels/closes search during shutdown. Browser Global
Search/navigation/message focus is now implemented and validated. The Pi reranking
adapter is wired into query/service/API/browser and synthetically tested. The browser
now has its default-on App-memory toggle and safe applied/local-fallback labels; focused
browser-to-real-API/faux-Pi composition closes the remaining synthetic gap.
Rollout approval is now explicit; configuration/database/build are prepared. Live
activation and live HTTP/browser checks are complete, as detailed above.

## Latest direction: stop adding complexity and finish

The operator agrees the earlier authority/ticket foundations overcomplicated this
trusted single-user feature and delayed proving the complete user experience. The
reset architecture is sufficient: **one worker → cached index → local search →
optional reranking**. Retired modules/tests and low-value abstractions are maintenance
debt, not missing production prerequisites.

1. **Done:** browser default-on rerank toggle, App-memory selection and visible
   applied/local-fallback reasons. Reranking stays optional and local search usable.
2. **Done:** validate search/navigation/fallback with existing suites and focused
   synthetic browser/HTTP fixtures, including browser-to-real-API/faux-Pi composition.
   No new evaluation/test framework or backend infrastructure.
3. **Released/verified:** operator restart completed; initial production indexing,
   real HTTP search, browser exact-message navigation and real Pi reranking passed.
   Assess useful search in everyday operator use (see top section).
4. After approved rollout, separately remove retired authority/cleanup/workspace-sync
   modules and obsolete tests, and consolidate abstractions that do not earn their
   maintenance cost. Cleanup is not a release gate; do not rewrite working SQL or
   checksum-tracked migrations just to reduce apparent size.

Do not add infrastructure, lifecycle frameworks, another foundation increment or new
race/security guarantees. Preserve the valuable safeguards: no source mutation,
atomic replacement, model-space consistency, bounded IO/responses and cancellation,
and search failures isolated from chat/jobs. Accepted staleness needs no new machinery.
Further optimization/reliability work must follow observed problems in actual use.
The next question is **“Does search work well for the operator?”**

The implementation increments below are historical. The approved rollout above
changes workstation provisioning/configuration and populates the derived index,
without changing backend implementation or checksum-tracked migrations.

## New implementation decisions

- One trusted user, one server process. No distributed writers, per-client roles,
  race-proof confidentiality or instant revocation requirement.
- SQLite owns workspace/job metadata; Pi JSONL owns conversations; PostgreSQL is a
  disposable derived cache.
- One process-owned worker performs **all index writes**: workspace sync, document
  publication, pruning and rebuild. No separate cleanup worker/queue.
- Timer/manual refresh coalesce into one pending pass; rebuild promotes it to forced
  rereading. App deletion/rewind/workspace changes just request refresh after success.
- Reconcile asynchronously after enabled startup and every 15 minutes. Disabled
  mode does not scan history, construct a search pool or probe search dependencies.
- All means registered stores, not global Pi discovery. Query current workspace IDs
  and source revisions as ordinary SQL filters; do not check files per result or
  revalidate candidate eligibility before responding.
- Keep stable read-only snapshots and a final source/model check. A simple current
  registration comparison at workspace boundaries suffices; no repeated incarnation,
  name, path/session epoch or pre-commit authority seals.
- Complete store enumeration plus a final directory-witness check permits absence
  pruning. Preserve encountered unreadable/malformed paths and canonical aliases;
  missing/incomplete stores never mean empty history.
- Cached old excerpts can remain after read/provider failures. A deletion during
  indexing may leave a stale generation until the next pass; that is accepted.
- Successful file replacement with a new session ID removes prior IDs at that source
  path within the same worker. All document replacement remains atomic.
- Restart simply starts another pass; no positive-membership recovery barrier.
  Persistent run history, resumable scans, sophisticated fairness/backoff and HNSW
  are deferred. Existing unused schema tables do not need removal.
- Search outages must not break conversations/jobs. Do not hold DB transactions
  during source/provider IO. Ambiguous COMMIT acknowledgement is reconciled by a
  fresh read on the next pass, not a blind retry.

## Keep and reuse

Implemented, tested and reused by the optional service (disabled by default):

| Area | Files / useful contract |
|---|---|
| Settings | `src/server/search/config.ts`, composed into `src/server/config.ts`; disabled default, startup-only validation |
| PostgreSQL | `postgres.ts`, `migrations.ts`, `database.ts`; lazy pool of four, explicit migrations, bounded operations |
| Schema | `migrations/search/001_initial.sql`, `002_checkpoint_lookup.sql`; workspaces, documents, chunks, runs; `vector(1024)`, English/simple GIN |
| Provisioning | `scripts/migrate-search.mjs`, `npm run search:migrate`, `deploy/search/compose.yml`, `docs/search-operations.md` |
| Session sources | `session-source.ts`, `src/server/session-scope.ts`; exact configured store, cheap fingerprints, seen paths, read-only snapshots |
| Extraction | `extract.ts`; version-3 durable saved branch, user/assistant text, retained pre-compaction history |
| Chunking | `chunk.ts`; per-entry text/source spans, deterministic keys and exact input hashes |
| Embeddings | `embeddings.ts`, `signatures.ts`; local Ollama, digest spaces, normalized vectors, bounded batches/query calls |
| Repository | `repository.ts`; workspace sync and derived workspace pages, checkpoints/pages/path lookup, exact-input reuse, atomic publication and deletion |
| Document pipeline | `document-indexer.ts`; ordinary workspace/candidate/space/options, unchanged-file skip, reuse/batching/title projection, cancellation, final source/model checks and atomic publication; **authority coupling removed** |
| Serialized worker | `indexer.ts`; registration sync, configured-store discovery, sequential indexing, successful path-ID replacement, complete-store pruning, orphan workspace removal, refresh/rebuild coalescing, cancellation and bounded in-memory status |
| Local retrieval/query | `retrieval.ts`, `query.ts`; parameterized English/simple lexical channel, exact cosine/model-space filtering, current registration/revision filters, RRF, overlap collapse, bounded conversation grouping, lexical fallback and cancellation |
| Runtime/API | `service.ts`, `routes.ts`, `src/server/index.ts`, `protocol.ts`; optional async compatibility/startup, timer/manual/mutation refresh, safe capability/status/counts, bounded same-authority HTTP routes, disconnect cancellation and shutdown |
| Pi reranker (API/browser wired) | `rerank.ts`, query/service/routes; configured native model/auth snapshot, opaque bounded query/excerpt prompt, one `completeSimple()` call, exact permutation validation, local fallback, aggregate deadline/cancellation/shutdown, safe capability and reasons |
| Browser search | `src/web/src/api/search.ts`, `GlobalSearchPage.tsx`, App/navigation/timeline; retained default-on rerank toggle, safe fallback labels, scopes/status/maintenance, plain-text excerpts and exact-message opening |

Use repository workspace read/sync directly from the single worker. Existing CAS
and generation fields can remain; removing working SQL is not required to simplify
the orchestration. Keep current checksum-tracked migrations unchanged.

### Superseded, not production prerequisites

These modules/tests still exist but should **not** drive the next implementation:

- `src/server/search/authority.ts`: incarnation/epoch seals and suppression tombstones.
- `src/server/search/cleanup.ts`: private revocable tickets and bounded continuations.
- `src/server/search/workspace-sync.ts`: authority-dependent guarded preparation.

Do not wire these modules, implement suppression release, add tombstone recovery,
construct cleanup capabilities or extend their race tests. Mandatory
`SearchDocumentAuthority` coupling is now removed from the pipeline (no no-op seals).
The legacy interface lives only in `authority.ts`; standalone retired-module tests
remain, but the authority/document composition tests have been removed.
Retain ordinary worker-boundary registration checks and cancellation without the
framework. Retired modules remain unwired.

## Practical contracts still worth preserving

- Indexing never writes/migrates Pi JSONL; do not use writable `SessionManager.open()`.
  Existing history/open/delete behavior and sandbox/network controls are unchanged.
- Index durable saved-branch user/assistant visible text, not thinking, images,
  tool/results, Bash, system/custom roles or synthesized summaries. Context edits
  are not historical redaction. Unsaved streaming text is absent.
- Use local `qwen3-embedding:0.6b`, fixed 1,024 dimensions; never mix model-digest spaces.
  Titles/workspace names are lexical metadata, not embedding context.
- Keep batches <=16, reuse reads <=128 hashes and checkpoint pages <=64. Current
  snapshot/record/chunk limits: 128 MiB / 48 MiB / 20,000 chunks. Discovery cap:
  100,000 paths; hitting it makes enumeration incomplete for pruning.
- Network Brain (`/home/adrian/projects/network-brain`) is a reference only:
  cosine, lexical retrieval, RRF k=60, expanded candidates and exact rerank permutations.
- Reranking uses Pi's in-process `ModelRuntime.completeSimple()` and configured native
  OpenAI/OpenAI-Codex auth; no raw OAuth token, separate API key, CLI or AgentSession.
  It is optional, with local fallback, and not a blocker for working local search.
- Keep credentials out of browser responses/logs and source text safely rendered.
  No new search-specific authorization or disclosure-permission framework.

## Latest implementation increment: browser rerank toggle and end-to-end validation

- `src/web/src/api/search.ts` retains the default-on boolean rerank selection in App
  memory, sends it explicitly and preserves existing submit/supersession/cancellation
  behavior. Navigation retains selection/query/results; reload resets them. No local
  storage or query/excerpt persistence.
- `GlobalSearchPage.tsx` enables the user checkbox, with configured-provider disclosure
  and an advisory local-capability hint supplied by App. Unavailable capability does
  not gate local search, disable the toggle or silently change the user's preference.
  Actual response metadata labels applied reranking, explicit opt-out, too few matches
  or local fallback with safe unavailable/unsupported/input-limit/invalid-order/timeout
  reasons. Unknown reasons use a generic safe label, not dependency diagnostics.
  Changing the next request's preference never relabels retained results.
- Extended `tests/browser/global-search.spec.ts` to **10 tests**, including default-on,
  opt-out, navigation retention/reload reset, advisory unavailable capability and all
  safe reason labels. Existing navigation/stale/open/mobile/cancellation coverage passes.
- Added **4 focused composition tests** in `tests/browser/search-rerank-api.spec.ts`:
  built browser against ephemeral same-origin real config/status/search HTTP and
  WebSocket routes, service/query/adapter and pinned Pi ModelRuntime with in-memory
  OpenAI/Codex faux providers. Only storage/history/embeddings/inference are synthetic;
  no search HTTP mocking or proxy. Covers reranked/local ordering, one/all scope,
  exact message focus and return, malformed completion/own timeout/lost-auth fallback,
  explicit cancel/supersession/navigation abort reaching provider IO and late replies
  not replacing/relabeling results. No new test framework or backend infrastructure.
- Updated README/design/SDK notes/runbook and `.env.example` comments only. No actual
  `.env` changes, runtime enablement, service restart, source persistence or migrations.

Validation:

- `npm run typecheck`, `npm run build:server`, `npm run build:web` passed. Browser tests
  are covered by the existing strict test tsconfig; web build retains its existing
  large-chunk warning.
- Focused browser: **2 files / 14 tests passed**. The initial composition run exposed
  a synthetic history fixture reporting an opened session as closed; fixed the fixture
  to reflect live opening, then all focused tests passed. No production navigation fix
  was needed.
- Full units, run alone: **84 files / 1,397 tests passed**.
- Full integration: **19 passed, 11 skipped / 113 tests passed, 90 skipped**;
  PostgreSQL and real-sandbox opt-in flags explicitly omitted.
- Full browser suite: **62 tests passed**, including six added in this increment.
- `git diff --check` passed. Prior isolated PostgreSQL validation retained; no rerun
  needed for these browser/test-only changes. No real history, shared Ollama, real
  auth-file access or paid provider call.

**Next:** seek explicit rollout approval. Do not enable search or restart this
workstation's service without it. Synthetic composition/validation is complete, not
proof of operator relevance on real history. After approved rollout, assess useful
search in actual use and separately remove retired foundations/obsolete tests. No
additional backend prerequisites or cleanup release gate.

## Previous implementation increment: Pi query/runtime/API wiring

This small increment wires the tested adapter into the server path. **The browser
still sends `rerank: false`** and its disabled control is unchanged. Workstation search
remains disabled; no service restart or rollout authorization.

- `SearchQueryService` now accepts a boolean rerank flag (default on), fuses/collapses
  candidates once, optionally reorders the bounded pool, then groups/limits conversations
  and excerpts. Existing local ordering is unchanged for explicit opt-out or fallback.
  Zero/one collapsed candidates skip the adapter. The same two-reader admission and
  35-second aggregate deadline cover retrieval plus reranking; metadata is included
  in the existing response byte bound.
- Query responses carry `rerank.requested/applied/reason`. Stable reasons are `applied`,
  `not_requested`, `too_few_candidates`, `unsupported_model`, `unavailable`, `input_limit`,
  `invalid_response` and `timeout`. Own adapter timeout/error retains local results;
  aggregate timeout, caller disconnect and shutdown propagate instead of becoming
  successful fallback. Unexpected optional adapter failures do not become DB outages.
- `PiRuntimeFactory.globalModelDefaults` exposes only a copied global startup pair,
  not settings, project/session selection or credentials. Enabled server startup supplies
  the existing runtime plus this snapshot via a callback invoked asynchronously only
  after listener readiness. Search creates no extra ModelRuntime/SettingsManager or
  conversation/session. Failed optional Pi setup leaves local search usable.
- The service owns/closes the adapter synchronously with query admission/IO cancellation.
  Safe capability reflects local configured native model/auth availability only; no
  remote probes. Disabled construction/start/status/close and immediate shutdown never
  request the Pi context. Schema readiness still controls search admission, not worker
  freshness. Search routes default reranking on unless explicitly false and forward
  actual metadata without overwriting fallback/applied reasons.
- Added **20 units** for ordering before grouping, collapsed-pool bounds/skips,
  default-on/opt-out, stable local fallback, malformed flags, aggregate deadline,
  admission/cancellation and optional lifecycle/capability. Extended API and startup
  tests and added a global-only/copy/startup snapshot composition test. Corrected that
  existing fixture's incomplete workspace policy for strict standalone typechecking.
- Added **5 real HTTP/service/query/adapter/pinned-ModelRuntime composition tests** in
  `tests/integration/search-rerank-api.test.ts`: native OpenAI/Codex success, explicit
  opt-out, opaque safe payloads, malformed completion, lost auth, own timeout, actual
  HTTP disconnect and synchronous server-shutdown cancellation. All retrieval/history
  and inference inputs are synthetic; Pi uses in-memory faux providers/auth.
- Updated README/design/SDK notes/runbook. No SQL, schema, source persistence, indexer
  behavior or browser changes.

Validation:

- `npm run typecheck`, `npm run build:server` and strict standalone TypeScript checking
  of all changed/new suites passed.
- Focused query/service/API/reranker/startup/runtime-default tests: **8 files / 182 tests passed**.
- Full units, run alone: **84 files / 1,397 tests passed**.
- Full integration: **19 passed, 11 skipped / 113 tests passed, 90 skipped**; search
  PostgreSQL and real-sandbox opt-in flags explicitly omitted. No PostgreSQL/browser
  rerun for this server-only increment.
- `git diff --check` passed. No actual `.env` change, service restart, search enablement,
  real history/shared Ollama, real auth-file access or paid provider call.

**Historical next increment (now completed above):** enable the browser's default-on user rerank toggle, retain its
selection in App memory, and visibly label applied/local fallback results with safe
reasons. Test explicit opt-out, unavailable capability, own-timeout/invalid-response
fallback and cancellation/navigation using synthetic Playwright/HTTP fixtures. Then
validate the complete user experience and seek rollout approval, without adding more
backend infrastructure. Keep workstation search disabled. A focused synthetic
browser-to-real API/faux-Pi composition check should follow before rollout; retired-code
cleanup belongs after approved rollout, not on the critical path.

## Previous implementation increment: bounded Pi reranking adapter

This deliberately small subincrement completes the adapter before runtime/query/API/UI
wiring. **No production capability or behavior has changed:** browser requests still
set `rerank: false`, `/api/config.search.rerankAvailable` remains false, and routes still
report unapplied reranking. Do not enable/restart workstation search.

- Read the Pi SDK documentation/references and verified the installed **0.84.3**
  declarations/implementation. Added `src/server/search/rerank.ts`, using only injected
  `ModelRuntime.getModel()`, `hasConfiguredAuth()` and `completeSimple()`. No
  AgentSession, tools, CLI, raw OAuth/auth lookup, copied credentials or separate key.
- Snapshots the paired search override or complete global default pair; no automatic,
  project or conversation model selection. Accepts native OpenAI Responses/Completions
  and OpenAI-Codex Responses with locally configured Pi auth. Availability is local
  snapshot checking, not remote probing. Zero/one candidates skip even catalog/auth IO.
- Sends only query and bounded role/text excerpts with opaque request-local IDs.
  Uniform allocation keeps every candidate represented: <=100 candidates,
  <=2,400 code points each / 80,000 total, <=128 KiB serialized prompt including
  system instructions. Over-byte-limit Unicode/JSON-escaped pools fall back without
  dropping candidates. Bounds returned text plus thinking to 64 KiB.
- One in-process completion with provider retries disabled, SSE transport,
  no session/cache key and <=8,192 requested output tokens. Own deadline races even
  non-cooperative injected IO. The pinned SimpleStreamOptions does not accept
  `reasoning: "off"`; omission uses native model default/off behavior.
- Requires a successful exact JSON permutation of all submitted IDs: no missing,
  duplicate, unknown, rewritten or non-string IDs, markdown fences or partial ordering.
  Returns original candidate objects reordered only after validation. Errors, own timeout,
  unsupported/unavailable model and malformed/oversized output retain local order with
  stable reasons. Caller/aggregate-query cancellation and close propagate, not fallback.
- Added **48 unit tests** and **4 actual pinned-ModelRuntime composition tests** using
  in-memory faux OpenAI/Codex providers. Tests cover native auth/stream delegation,
  safe payloads, all bounds, permutation validation, one-call failures, stuck IO,
  cancellation/shutdown and late replies. Native registration's async local availability
  refresh is settled explicitly in the synthetic SDK fixtures.
- Updated SDK notes/design; no schema, local search, service, HTTP, browser or source
  persistence changes.

Validation:

- `npm run typecheck`, `npm run build:server`, and strict standalone TypeScript checking
  of both new suites passed.
- Focused reranking: **2 files / 52 tests passed**.
- Full units: **84 files / 1,377 tests passed**. The first run, concurrently with
  integration/typechecking, hit an existing 10-second sandbox framed-protocol test
  timeout; the unchanged full suite passed when rerun alone.
- Full integration: **18 passed, 11 skipped / 107 tests passed, 90 skipped**;
  search PostgreSQL and real-sandbox opt-in flags explicitly omitted. No PostgreSQL
  or browser rerun for this adapter-only subincrement.
- `git diff --check` passed. No actual `.env` changes, service restart, search enablement,
  real history/shared Ollama access, real auth-file access or paid provider call.

Query/runtime/API wiring is now implemented in the increment above. Next enable
and test the browser's default-on user toggle with visible local fallback. Keep the
workstation disabled until explicit rollout approval.

## Previous implementation increment: browser Global Search

- Added `src/web/src/api/search.ts`: App-owned in-memory query/scope, last submitted
  query/results, status and notices survive page navigation, not reload/local storage.
  Search submit/Enter supersedes prior IO; explicit Cancel and navigation abort requests.
  Abort/generation checks prevent late replies from replacing retained results. Safe
  errors preserve cached results; local query admission does not depend on worker readiness.
- Added `src/web/src/components/GlobalSearchPage.tsx`: All/one-workspace filter,
  local hybrid/lexical fallback labels, grouped plain-text excerpts with role/time/indexing
  metadata, cached/freshness/error status, Refresh and confirmed scoped Rebuild. Removed
  workspace selections are retained visibly and require a new scope. Pi reranking is a
  disabled, explicitly unavailable control; requests set `rerank: false`.
- Desktop rail and both existing mobile navigation surfaces use configured optional
  mode, not transient `available`. Search polls status only while its page is active,
  serially with bounded IO (3 seconds through initialization/indexing/outages, 15 seconds
  when ready/idle). Status failures still allow cached search attempts. Disabled config
  does not expose the page or issue search HTTP requests.
- Results use existing `openGeneratedConversation()` workspace/history/open flow.
  App guards late opens against navigation-away; `MessageTimeline` focuses/scrolls an
  exact `data-entry-id` via data comparison, not a constructed source-ID selector,
  marks the match and stops automatic output-following from overriding focus. Missing
  conversations retain results with a stale notice. Missing branch entries open normally
  with an explicit stale notice; no branch switching. Back to search retains results.
  Search notices share timeline layout without clipping the composer.
- Extended `src/shared/search.ts` with public excerpt/result/HTTP/status types; server
  query exports reuse excerpt/result types and API/status compile-check these shared
  contracts. No SQL/schema, indexer lifecycle, conversation protocol or policy changes.
- Added **8** synthetic Playwright tests in `tests/browser/global-search.spec.ts`:
  disabled no-probe behavior, polling through initialization/worker failure, safe local
  fallback/plain text, scoped maintenance/confirmation, navigation retention, superseded/
  cancelled/navigated-away replies, real fixture WebSocket open + message focus, missing
  entries/sessions, grouped/empty results, safe HTTP/status errors, query limits and
  mobile navigation/long-excerpt layout. Search/config HTTP responses are mocked;
  conversation opening uses the existing deterministic fixture server, not real history.
- Updated README/design/runbook to document the usable local browser slice.

Validation:

- `npm run typecheck`, `npm run build:server` and `npm run build:web` passed
  (web build retains the existing large-chunk warning).
- Full units: **83 files / 1,329 tests passed**.
- Full integration: **17 passed, 11 skipped / 103 tests passed, 90 skipped**;
  database and real sandbox opt-in environment flags explicitly omitted. No PostgreSQL
  suite was rerun in this browser increment; prior isolated validation remains above/below.
- Full browser suite: **56 tests passed**, including **8** new Global Search tests.
- `git diff --check` passed. No actual `.env` change, workstation service restart,
  rollout enablement, shared Ollama/real history access or paid provider call.

The optional Pi reranking adapter and query/runtime/API wiring are now implemented
above; browser toggle/fallback wiring remains next. Do not use
raw OAuth tokens, separate API keys, a CLI or `AgentSession`. Keep the workstation
disabled until explicit rollout approval. A synthetic browser-to-real-local-API composition test may be useful
before rollout; current browser tests mock search HTTP and prior server tests cover
real local API/retrieval with disposable PostgreSQL separately.

## Previous implementation increment: optional runtime and local API

- Added `src/server/search/service.ts`. Disabled construction/start/status performs
  no pool construction, registration scan or dependency probe. Optional service starts
  asynchronously **after listener readiness**, checks schema before indexing/queries,
  then requests initial reconciliation and installs the configured (default 15-minute)
  unref'd timer. Chat/job startup never awaits search readiness or succeeds only if
  search dependencies work. Initialization failure is safe status and retries on
  timer/manual refresh; no DDL or blind write retries.
- `checkSearchSchema()` now uses a bounded, cancellable read-only repository
  transaction. Existing migrations/checksums are unchanged. `SearchSchemaError`
  preserves its stable code through the database boundary.
- Added `src/server/search/routes.ts` and wired it into the HTTP server:
  `POST /api/search`, `GET /api/search/status`, `POST /api/search/refresh`,
  `POST /api/search/rebuild`. Mutation requests return 202 and use the one worker.
  JSON is bounded to 32 KiB; unknown/malformed fields have safe 400 errors. Existing
  same-authority Origin/direct-client conventions are reused; cross-site fetches
  are rejected, with no new authorization framework. Responses are private/no-store;
  disconnect cancellation reaches search IO. Search-only errors map to 400/404/429/
  503/504 without raw dependency diagnostics.
- Added registered-ID/revision-filtered persisted total counts to the read-only
  retrieval adapter. Full status separates corpus counts from per-pass progress and
  exposes bounded stable errors. Search responses include cached/local mode/warnings,
  compact freshness/error count and explicit unapplied rerank metadata while retaining
  the 256 KiB response cap. `/api/config.search` exposes only mode/state/available/
  rerankAvailable (false). Shared public config accepts this additive safe projection.
- Successful WebSocket workspace create/update/delete, conversation deletion/rewind
  and rename request refresh after the source mutation. Refresh failures cannot fail
  the completed operation. Retired authority/cleanup/workspace-sync remain unwired.
- Server shutdown seals search admission and synchronously cancels queries/indexing
  before SQLite teardown. Embedder/repositories/pool closure shares the existing
  grace deadline; no late initialization can start indexing after close.
- Added lifecycle units, HTTP boundary/error/cancellation tests and seven full-server
  PostgreSQL composition tests. These exercise real optional startup/API, temporary
  SQLite and both synthetic store kinds, vector reuse/rebuild, restart with missing
  store/provider, actual WebSocket rename/delete hooks, schema migration recovery,
  source non-mutation and shutdown with blocked query/indexing provider requests.
  Existing partial/readonly protocol fixtures were corrected for strict checking.

Validation:

- `npm run typecheck` and `npm run build:server` passed.
- Strict standalone TypeScript checking of new/changed suites passed.
- Search units: **18 files / 557 tests passed**.
- Full units: **83 files / 1,329 tests passed**.
- Full integration: **17 passed, 11 skipped / 103 tests passed, 90 skipped**.
- Isolated pgvector/PG17: **8 files / 79 tests passed**, including seven full-server
  tests. Fresh loopback container, random credentials, tmpfs data, explicit pgvector
  provisioning and random suite schemas; container/schemas removed. Fake loopback
  Ollama, temporary SQLite and synthetic JSONL only; no credentials persisted.
- `git diff --check` passed. No actual `.env` change, workstation service restart,
  real history/shared-provider access, paid call or rollout enablement.

Browser Global Search is now implemented in the increment above. Optional Pi reranking
is next; keep this workstation disabled until explicit rollout approval.

## Previous implementation increment: local hybrid retrieval

- Added `src/server/search/retrieval.ts`: lazy read-only PostgreSQL retrieval, one
  English/simple lexical channel, exact cosine ordering and deterministic UUID ties.
  Both channels filter current workspace IDs/source revisions; vector queries also
  require matching document/chunk embedding-space signatures. No source-file checks,
  membership barrier, authority callbacks, schema changes or runtime wiring.
- Added `src/server/search/query.ts`: validates <=2,048 code points / 8 KiB and
  1–20 groups (default 10), snapshots ordinary SQLite registrations once, expands
  each channel to `min(100, max(30, limit * 5))`, merges RRF k=60, collapses overlapping
  entry spans, caps five candidates per conversation / 100 overall, and returns
  up to three plain-text excerpts per group. Scores, vectors and paths stay private.
- Public results are explicitly cached. Missing/unavailable sources and restart do
  not block queries; changed/unregistered workspace scopes filter cached rows without
  waiting for reconciliation. Ollama errors produce lexical results with stable
  warnings; no current-space vector hits report lexical mode. PostgreSQL failure
  returns a search-only safe error.
- Added `OllamaSearchEmbeddings.embedSearchQuery()` to resolve capability/digest and
  embed under one query-lane deadline, independently of busy background indexing;
  pre/post embedding digest checks prevent mixed-space results.
- Two readers are admitted without a service wait queue, independent of the writer's
  maintenance transaction slot. Search has a 35-second aggregate deadline,
  cancellation/close handling even for non-cooperative injected IO, and a 256 KiB
  serialized response cap (<=1,200 code points per excerpt, bounded display metadata).
- Added query/retrieval units, embedding query-lane tests, seven PostgreSQL retrieval
  tests and two worker-to-query composition tests. Fixtures use synthetic data,
  temporary SQLite/Pi stores and fresh fake Ollama only.

Validation:

- `npm run typecheck` and `npm run build:server` passed.
- Strict standalone TypeScript checking of new/changed test suites passed.
- Search units: **17 files / 536 tests passed**.
- Full units: **82 files / 1,298 tests passed**.
- Full integration: **16 passed, 10 skipped / 78 tests passed, 83 skipped**.
- Isolated pgvector/PG17: **7 files / 72 tests passed**, including seven retrieval
  and 12 worker composition tests. Fresh loopback container, random credentials,
  tmpfs data and random suite schemas; container/schemas removed. The first isolated
  attempt correctly rejected missing pgvector extension; the passing run explicitly
  provisioned it before migrations. No credentials persisted.
- `git diff --check` passed. No `.env` changes, shared history/provider access,
  service restart or startup/API wiring.

Runtime/API wiring is now complete in the increment above. Browser UI/navigation
is next; keep workstation search disabled.

## Previous implementation increment: serialized worker

- Added `src/server/search/indexer.ts`. `SearchIndexer` performs every maintenance
  write through one serialized pass: ordinary registration sync, configured-store
  discovery, sequential documents, successful canonical-path ID replacement,
  complete-store absence pruning and unregistered-workspace removal.
- `requestRefresh({ workspaceId?, rebuild? })` returns immediately. Busy requests
  union scopes into one pending pass; rebuild promotes that pending scope to force.
  `idle()` awaits coalesced work; `close()` drops pending work and cancels IO. There
  is no timer, startup admission or API wiring yet, and no authority/ticket queue.
- Added repository `readWorkspacePage()` (C-order keyset, <=64 rows, lookahead),
  so orphan cleanup works after restart without persisted membership state.
  Existing checksum-tracked migrations are unchanged.
- Preserves encountered malformed/unreadable paths and canonical aliases. Missing,
  incomplete or directory-witness-changed stores never permit absence pruning.
  Source/provider failures retain prior content. Model-resolution failure skips
  embedding work but still allows safe deletion reconciliation. PostgreSQL failure
  stops the pass; later refresh reconciles from fresh metadata without blind retry.
- Registration comparisons occur at workspace boundaries; changes queue a fresh
  pass. Status is in memory with per-pass progress (not total cached coverage),
  freshness times and <=100 stable errors without source paths/diagnostics.
- Added **22 worker unit tests** and **10 worker PostgreSQL composition tests**;
  added workspace-page unit/integration coverage. Composition uses real temporary
  SQLite registrations, both store types, synthetic JSONL, fresh fake Ollama and
  disposable PostgreSQL, not real history/shared dependencies.

Validation:

- `npm run typecheck` and `npm run build:server` passed.
- Strict standalone TypeScript checking of new/changed suites passed.
- Search units: **15 files / 463 tests passed** (included in full units).
- Full units: **80 files / 1,225 tests passed**.
- Full integration: **16 passed, 9 skipped / 78 tests passed, 74 skipped**.
- Isolated pgvector/PG17: **6 files / 63 tests passed** (10 worker, 13 document,
  19 repository, 3 schema, 7 retired workspace preparation, 11 retired cleanup).
  Fresh loopback container, random credentials, tmpfs data, random suite schemas;
  container/schemas removed. No credentials persisted.
- `git diff --check` passed. No `.env` changes, service restart or runtime wiring.

The local lexical/vector retrieval increment is now completed above. Runtime/API
wiring is next; do not add another authority foundation.

## Previous increment: simplify document pipeline

Completed the first small implementation step after the design reset:

- `SearchDocumentIndexRequest` no longer requires authority capabilities. Inputs are
  workspace/candidate/space/scan ID and optional force/recompute/cancellation settings.
- Removed registration/epoch revalidation and ownership suppression callbacks from
  `SearchDocumentIndexer`. Kept stable snapshots, fingerprint/profile skips, exact
  vector reuse, bounded batches, atomic publication, cancellation and final
  model-then-source checks. Registration comparison belongs to the worker.
- Cancellation listeners are removed even when an injected dependency never settles.
- Updated unit/composition tests: read/ownership/provider failures retain cached
  generations, cancellation can roll back before COMMIT, and a source deletion
  **after** the final witness may publish stale content for the next pass to prune.
- Moved the retired document-authority interface into `authority.ts` and removed its
  obsolete document-indexer composition tests. Did not expand/wire retired modules.
- Updated README/design/runbook to describe the simplified contract.

Validation for this increment:

- `npm run typecheck`, `npm run build:server` passed.
- Strict standalone TypeScript checking of changed unit/integration suites passed
  (the normal test tsconfig still does not include these suites).
- Search units: **14 files / 427 tests passed**.
- Full units: **79 files / 1,189 tests passed**.
- Full integration: **16 passed, 8 skipped / 78 tests passed, 63 skipped**.
- Isolated pgvector/PG17: **5 files / 52 tests passed**, including **13** document
  composition tests plus repository/schema and existing retired-module suites.
  Fresh loopback container, random credentials, tmpfs data, random suite schemas,
  temporary synthetic JSONL and fresh fake Ollama only; container/schemas removed.
- `git diff --check` passed.
- No `.env` changes, shared history/provider access, startup wiring or service restart.

This first increment was followed by the serialized-worker implementation above;
search remains non-operational until retrieval/API and runtime wiring are completed.

## Next work: vertical slices

### 1. Working local search/API (implemented)

Follow the simplified search design and existing source/repository/document/embedding
contracts. Complete the useful path incrementally:

1. **Done:** simplify the per-document request and remove mandatory authority
   capabilities while preserving fingerprint/profile skip, exact reuse, atomic
   publication, cancellation and final source/model checks.
2. **Done:** one worker's registration sync, store discovery, sequential document
   work, successful path-ID replacement, complete-store pruning, orphan removal,
   coalescing and minimal in-memory status. Checkpoint pages compare stored paths
   to discovered paths; they are not proof of store enumeration.
3. **Done:** lexical/vector retrieval, model-space filtering, RRF and conversation
   grouping, ordinary current-registration/revision scope filters, cached stale results,
   lexical fallback and bounded query admission/cancellation.
4. **Done:** optional async startup, timer, refresh/rebuild coalescing, mutation refresh
   and shutdown; search/status/refresh/rebuild routes. No live conversations or runtime
   capacity are created/consumed for search.
5. **Done:** synthetic full-server composition through retrieval/API with temporary
   SQLite/Pi sessions, fresh loopback fake Ollama and disposable PostgreSQL; actual
   WebSocket mutation hooks, cached restart, schema recovery and bounded shutdown.
   No real history/shared providers.

### 2. Browser feature and reranking

**Done:** Global Search navigation, All/one-workspace filter, submit/Enter/cancellation,
status/freshness, refresh/rebuild, grouped excerpts and existing conversation-open/message
focus, stale/deleted result notices and retained in-memory state across page navigation.
**Adapter/API done:** bounded Pi completion, exact permutation validation, local fallback,
query/runtime/API wiring, safe capability and requested/applied/reason metadata.
**Browser done:** default-on user-toggleable reranking, retained selection, safe applied/
local-fallback labels and focused browser-to-real-API/faux-Pi composition.

### 3. Validate and seek rollout approval

**Done:** existing typecheck/build/full unit and integration suites, full browser tests
and a synthetic browser-to-real API/faux-Pi composition check. Prior disposable
PostgreSQL validation retained; no SQL/indexer/backend changes in this increment.
README/runbook/config notes updated. Validate useful search, navigation and fallback end to end, not another
layer of primitives. No new infrastructure, evaluation framework, ABA, immediate
suppression, ticket lifecycle or membership-proof release gates.
Enable/restart the workstation only with explicit rollout approval after validation.

### 4. Simplify after approved rollout

Remove unused authority/cleanup/workspace-sync modules and obsolete tests; consolidate
abstractions that do not earn their maintenance cost. This is separate cleanup, not a
shipping prerequisite. Preserve working SQL and checksum-tracked migrations. Add
further complexity only for observed problems in actual use.

**Done means:** useful exact and semantic one/all-workspace search, correct conversation
and message navigation, refresh/rebuild, understandable freshness/fallback status,
no source mutation, and no chat/job disruption when search dependencies fail.
Staleness between passes is an explicit tradeoff, not an unfinished security feature.

## Existing validation (before this documentation reset)

Latest foundation checks from increment 5c:

- `npm run typecheck` and `npm run build:server` passed.
- Strict standalone TypeScript checking of new unit/integration suites passed;
  the normal test tsconfig does not cover all those files.
- Search units: **14 files / 430 tests passed**.
- Full units: **79 files / 1,192 tests passed**.
- Full integration: **16 files passed, 8 skipped / 78 tests passed, 62 skipped**.
- Isolated PostgreSQL composition: **51 tests passed** (7 workspace preparation,
  11 cleanup, 12 document, 18 repository, 3 schema).
- `git diff --check` passed.

PostgreSQL validation used a fresh loopback pgvector/PG17 container, random credentials,
tmpfs data and per-suite random schemas. Container/schemas removed; no credentials
persisted. Tests used temporary synthetic JSONL and fresh fake services, not real
transcripts, shared Ollama, paid providers or existing databases. No local `.env`
changes, service restart or startup wiring occurred.

Those tests validate the existing foundations, not an operational search feature.
This reset only updated documentation; runtime suites were not rerun for it.

## Working tree and handoff

No commit has been made. Preserve the existing uncommitted foundation changes;
do not discard or revert them wholesale when simplifying orchestration.
`docs/search-design.md` was already untracked when foundation work began.

Tracked changes include `.env.example`, `README.md`, `checkpoint.md`, `docs/design.md`,
`docs/pi-sdk-notes.md`, package files, server config/history and config/smoke tests.
New files include `src/server/search/`, `src/server/session-scope.ts`, search
migrations/provisioning/runbook, and `tests/{fixtures,unit,integration}/search-*`.
Consult `git status --short` for the exact current tree.

This handoff includes document simplification, the serialized worker, local hybrid retrieval,
optional runtime/API, browser Global Search/navigation/message focus and Pi reranking
query/runtime/API/browser wiring, retained rerank toggle and completed synthetic
end-to-end validation after the design reset. Earlier
foundation details/tests remain in source and the existing adapter runbook; its retired
authority/ticket sections describe old code, not production requirements. The simplified
search design is the plan to follow.
