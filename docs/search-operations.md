# Conversation search: operations and provisioning

> **Architecture:** [search-design.md](search-design.md) describes the single-user
> implementation: one serialized indexer, cached local search and optional Pi reranking.
> Stale cached results are accepted; no membership recovery barrier is required.
> Retired authority/ticket/workspace-preparation modules and obsolete tests have been
> removed. This workstation's approved rollout is live and verified, including
> real-history search/navigation and Pi reranking. See `../checkpoint.md` for status.

**Implementation state:** configuration/schema/migrations, read-only source/chunk
and bounded Ollama/signature adapters, plus atomic document/checkpoint repository
operations, an injectable per-document reconciliation pipeline, and the serialized
sync/discovery/index/prune worker with coalescing, cancellation and in-memory status,
plus local lexical/vector retrieval, RRF/grouping, lexical fallback and bounded query
admission.
Optional mode now wires asynchronous startup/schema checks, the timer and mutation
refresh hooks, bounded search/status/refresh/rebuild routes and shutdown. Browser Global
Search and optional Pi query/API/browser reranking are implemented and synthetically validated.
Disabled mode constructs no pool, scans no
history and probes no dependencies. Enable optional mode only with explicit rollout
approval and provisioning. See [search-design.md](search-design.md).

## Runtime and local API

`search/service.ts` owns one optional service. After the server listener is ready it
constructs the lazy pool/adapters asynchronously, checks migration checksums and the
vector column in a bounded read-only transaction, then requests the worker's initial
pass. No DDL is applied. Search initialization/outage never gates chat/job readiness.
A timer (default 15 minutes) and manual requests coalesce into the same worker. Failed
initialization retries on the next timer or manual refresh; do not use a blind write
retry after ambiguous COMMIT acknowledgement.

Successful workspace create/update/delete, conversation deletion/rewind and rename
request eventual refresh through the existing WebSocket protocol. No mutation waits
on PostgreSQL or Ollama, and refresh errors never fail the completed source operation.
Shutdown seals search admission and cancels queries/indexing before SQLite teardown;
pool closure shares the existing server grace deadline.

`/api/config.search` contains only `mode`, `state`, `available` and `rerankAvailable`.
States are disabled/initializing/ready/unavailable/closed. Reranking availability reflects
only the configured native OpenAI/OpenAI-Codex model and local Pi auth snapshot; it is
not a remote health probe. Initialization/closed/disabled capability is false.
Search may retry cached queries after a previous worker/dependency failure; worker
success/freshness is not an admission barrier. Cache queries wait for schema
compatibility, not a successful reconciliation pass.

| Route | JSON request / response |
|---|---|
| `POST /api/search` | `{ "query": "past decision", "workspaceId": null, "limit": 10, "rerank": false }`; grouped excerpts plus cached/mode/warnings, compact freshness and requested/applied/reason rerank metadata |
| `GET /api/search/status` | availability, current registered/revision-filtered total document/chunk counts (null on dependency failure), compact freshness and bounded worker progress/errors |
| `POST /api/search/refresh` | `{ "workspaceId": null }`; `202 { "accepted": true }` |
| `POST /api/search/rebuild` | same scope; `202`; forces rereading and reuses exact vectors, without truncating the index first |

Null/omitted workspace selection means all registered stores. Rebuild confirmation
is implemented in the browser. API reranking defaults on; `rerank: false` explicitly
opts out (`not_requested`). The optional service reuses the existing Pi runtime and
global-only startup model pair, or the paired search override, without constructing
another model/auth runtime. Reranking uses one bounded in-process completion after
RRF collapse and before grouping. `applied` indicates a validated exact permutation;
`too_few_candidates`, `unsupported_model`, `unavailable`, `input_limit`,
`invalid_response` and `timeout` retain local ordering. Own rerank timeout is fallback;
aggregate query timeout/disconnect/shutdown is cancellation, not success. HTTP responses are private/
no-store, with no paths/vectors/credentials or diagnostic bodies. The 256 KiB result
cap includes freshness/feature metadata; request JSON is bounded to 32 KiB (including
escaped query encodings). Malformed/unknown fields return 400; unknown workspace 404;
busy 429; timeout 504; disabled/initializing/incompatible/unavailable/cancelled 503.

Routes reuse the app's same-authority Origin convention, reject cross-site fetches,
and accept direct clients without Origin. This is not new authentication: every
trusted accepted client retains full application authority. Disconnect cancellation
propagates to query IO. The browser cancels superseded searches, explicit cancellation
and navigation-away requests; late replies do not overwrite retained results.

Freshness is deliberately in memory: `lastSucceededAt: null` after restart is unknown,
not evidence that restored cached content is unusable. Compact freshness includes
last-success time, indexing state, stable first error and error count; full status
retains at most 100 worker errors without source paths. Counts describe derived cached
coverage; worker progress describes only the current/last pass.

Synthetic reranking checks use real HTTP/service/query/adapter and the pinned Pi runtime
with in-memory faux inference/auth (no PostgreSQL, real history or paid calls):

```sh
npx vitest run tests/unit/search-query.test.ts tests/unit/search-service.test.ts tests/unit/search-rerank.test.ts tests/integration/search-rerank.test.ts tests/integration/search-rerank-api.test.ts
```

## Browser Global Search

Optional configured mode exposes Global Search in desktop and mobile navigation, even
while initializing or unavailable. It polls status while the page is active (3 seconds
through initialization/indexing/outages, 15 seconds when ready/idle); polling is serialized,
bounded and cancelled on navigation. Worker failure does not disable cached query attempts.

Choose All or one registered workspace and submit/Enter. Results group up to three
plain-text excerpts per conversation, with role/time, workspace, indexing time and
local hybrid/lexical fallback labels. Pi reranking defaults on; the checkbox sends the
selected preference, with off (`rerank: false`) keeping the query/excerpts local.
The control stays usable when capability is unavailable, and never silently resets
selection. Its capability hint is advisory startup configuration, not a remote probe;
actual response metadata labels applied reranking, opt-out, too few matches or local
fallback (unavailable/unsupported model, input limits, invalid ordering or timeout).
Unknown reasons get a generic safe label, never raw diagnostics. Changing the toggle
does not relabel already submitted results. Search works without reranking.
Refresh and confirmed Rebuild affect the selected scope; both queue the existing worker.
Counts are total cache coverage across registrations, not scoped pass progress.

Query, workspace and reranking selection, last submitted query/results and status stay in App memory
across navigation, not local storage or reload. Opening uses the existing workspace/history
conversation flow and then focuses the exact `data-entry-id` in the message timeline.
Missing sessions retain the results with a stale-result notice; missing branch entries
open the conversation with an explicit notice and do not switch branches. Back to search
results retains the query/results. This does not change conversation policy or capacity.

Synthetic browser validation: `global-search.spec.ts` mocks search HTTP and uses real
fixture WebSocket opening. `search-rerank-api.spec.ts` loads the built browser against
an ephemeral same-origin server with real config/status/search HTTP, service/query/
adapter, pinned Pi ModelRuntime/faux providers and WebSocket message navigation.
Only storage/history/embeddings/inference boundaries are synthetic; no search HTTP
mocking, real credentials, source stores, PostgreSQL, shared Ollama or paid calls.
It verifies native OpenAI/Codex ordering, opt-out, scope, exact focus, local fallback
and browser cancellation/supersession/navigation reaching provider IO.

```sh
npx playwright test tests/browser/global-search.spec.ts tests/browser/search-rerank-api.spec.ts
```

No actual `.env` change or running-workstation restart is needed for these checks.

## Data ownership

SQLite remains authoritative for registered workspaces/jobs; Pi JSONL remains
authoritative for conversations. PostgreSQL is a separate disposable derived index.
Disabled startup does not read Pi history, load search reranking credentials or
contact search dependencies. Optional initialization checks PostgreSQL after listener
readiness, then the worker reads configured history and uses Ollama. Startup never
applies search DDL or copies/reads raw reranking credentials; authentication stays inside
the existing Pi runtime. Source adapters read scoped snapshots through the worker but
never write Pi files.

The schema stores plaintext conversation excerpts, source metadata, and 1,024-dimensional
vectors. Protect its storage/backups like Pi history. Keep database storage outside
workspaces and sandbox mounts. Do not give database credentials to tools/workers.

## Local embedding adapter

`src/server/search/embeddings.ts` is explicitly constructed and does no IO until
called. It uses only `/api/tags`, `/api/show`, and `/api/embed`; it never pulls a model,
changes the daemon, follows redirects, or sends remote embeddings. Missing models,
capabilities, and malformed responses fail with redacted stable codes, without raw causes.

Fixed bounds: at most 16 inputs per document batch, 16 KiB UTF-8 per profiled input,
256 KiB serialized request, and a count-derived response allowance capped at 1 MiB.
Metadata bodies are capped at 2 MiB for tags and 256 KiB for show. Responses require
exact vector counts and 1,024 finite values with nonzero norms; scaled L2 normalization
avoids overflow/underflow. `truncate=false` rejects context overflow instead of silently
embedding a prefix. Callers must stream larger conversations in bounded batches.

One background operation is admitted at a time (no queue); interactive embeddings have
one separate active slot and two FIFO waiters. Overflow returns `search_busy`. All
metadata, queue waiting, fetch, and body reads share the configured deadline; interactive
queries use at most 10 seconds. Caller abort/shutdown yields `search_cancelled`, deadline
expiry yields `search_timeout`. `close()` seals admission and aborts active/queued work.
There are no automatic retries; failed inputs are retried on the next refresh/timer pass.

Resolve the immutable SHA-256 digest/capability before a pass. Batches verify the digest
before/after embedding. The document pipeline rechecks with `assertSpaceCurrent()`
immediately before committing; these guards do not lock Ollama's mutable tag. Spaces
include canonical model tag, digest, dimensions and normalization version. Processing
signatures additionally include extractor/chunker/document-input versions; query profiles
have separate signatures and cannot force document re-embedding. Never use a vector with
a different space signature. The embedding adapter itself does not persist vectors
or advertise readiness.

## Atomic repository

`search/repository.ts` provides a narrow injectable maintenance boundary. Reads are
scoped by workspace/source revision, with exact bigint generation and nanosecond
fingerprint text. `readWorkspace()` returns derived metadata, never registration authority.
The worker snapshots SQLite registrations; the document pipeline checks source/model witnesses.

`readCheckpointPage()` returns at most 64 checkpoints (default 64), using session-ID
keyset ordering under PostgreSQL's `C` collation and a one-row lookahead. An optional
exact source-path filter supports cheap discovery before a session ID is known. Multiple
prior identities at the same path are returned, not silently reduced to one. Each page
intersects the requested workspace/revision with current derived workspace metadata;
none establishes SQLite registration authority or a consistent cross-page snapshot.
An empty/final page never authorizes pruning. Request filters are snapshotted before IO;
reads share maintenance admission, cancellation and deadlines. `readWorkspacePage()` also
returns at most 64 derived registrations with C-order keyset/lookahead, allowing restart-safe
orphan removal without relying on prior in-memory registration state.

Migration `002_checkpoint_lookup.sql` adds scoped keyset and hashed source-path indexes.
Path lookup also checks exact equality, so hash collisions cannot broaden results; hashing
avoids raw long paths exceeding PostgreSQL's btree key-size limit. Existing deployments
must explicitly rerun `npm run search:migrate`; `001_initial.sql` remains unchanged.

Workspace synchronization compares the expected revision under a row lock. Renames
update every copied lexical workspace name transactionally without changing vectors;
source-revision changes atomically delete obsolete documents and reset scan metadata/counts.
Publication checks the current derived workspace revision and expected document ID/generation,
upserts the entire chunk set (keeping IDs for matching stable keys), removes obsolete keys,
and commits metadata, counts, lexical vectors and the successful checkpoint together.
An absent document requires `expected=null`; a deleted committed document cannot be
resurrected with its old version. No process-owned invalidation seal is required by the
single-user worker; a later pass reconciles briefly stale content.

Reuse reads accept at most 128 exact input hashes and require the document generation,
current workspace/source revision and embedding space to match. Neither ordinal nor title
can authorize reuse. Supplied vectors must already be finite, 1,024-dimensional and unit
normalized (with tolerance for pgvector float32 rounding). No provider/source IO happens
inside these transactions. The indexer must revalidate source snapshots and model identity
before publication. The document pipeline uses the optional synchronous `assertCurrent`
callback for cancellation only; no registration/invalidation framework is required.

Fixed repository bounds: 20,000 chunks; 16 KiB UTF-8 title projection; 256 MiB total prepared
publication including copied lexical metadata; chunk upserts of at most 64 rows and 1 MiB
serialized data. Reject over-limit/invalid candidates without silently truncating evidence.
The document pipeline deliberately bounds display/lexical titles (the extractor's fallback
can be an entire first message); quoted body chunks must remain exact. Empty saved leaves
use an empty-string database sentinel, decoded back to null, with no fabricated chunks.

`search/database.ts` admits one maintenance transaction with no queue, leaving pool capacity
for independently admitted retrieval. A five-second aggregate deadline includes connection acquisition
(capped at three seconds), all statements, work and commit acknowledgement. PostgreSQL 17
`transaction_timeout` enforces a server-side aggregate bound; each statement/lock is also
limited to the remaining budget. Failures roll back; cancellation destroys active clients,
reclaims late connections and prevents subsequent queries/COMMIT. `close()` seals admission;
it does not own/end the pool. Idle pg-client errors project only a stable redacted status
code and cannot become an unhandled EventEmitter error when no subscriber is installed.

A lost/timed-out COMMIT acknowledgement is inherently ambiguous: the database may have
committed the **whole** generation. Never return an unacknowledged checkpoint or blindly
retry; destroy that connection and reconcile from fresh committed metadata. No partial
generation becomes visible. Normal pre-commit failures preserve the prior complete version.

Explicit scoped delete/seen primitives are used only by the serialized worker;
mutation hooks request refresh rather than writing the derived index themselves. Checkpoint pages are comparison data, not proof of
complete enumeration; the worker independently validates the directory witness before
absence pruning. Persistent run history is deferred; the timer/API now invoke the
same worker. Browser Global Search invokes these routes.

## Serialized indexing worker

`search/indexer.ts` supplies the one `SearchIndexer` for all maintenance writes.
Construction does no IO and does not create a pool, timer, runtime or session store.
`requestRefresh({ workspaceId?, rebuild? })` returns immediately; null/omitted scope
means all registered stores. While busy, requests union scopes into one pending pass,
and rebuild promotes that whole pending scope to forced rereading with exact-vector reuse.
`idle()` awaits active/coalesced passes; dependency errors are reported by `status()`.

Each pass snapshots SQLite registrations, directly reads/synchronizes derived workspace
metadata, discovers only configured stores and processes documents sequentially. Successful
publication removes old session IDs at the same canonical path using scoped checkpoint
pages and version-conditional deletion. Successful alias reads are deduplicated by canonical
target. Encountered malformed/unreadable paths and admitted canonical targets remain seen.
Only complete enumeration plus a final directory-witness check permits absence pruning.
Missing/incomplete/changed stores preserve cached rows. Fresh derived-workspace pages also
remove caches for registrations no longer present, including after restart.

Registration comparisons occur at workspace boundaries, not every await or COMMIT. A
change queues a fresh pass; brief stale publication/results are accepted. Provider failure
retains old excerpts; model-resolution failure skips embeddings for that pass but still
allows safe deletion reconciliation. PostgreSQL failure stops the pass without retries;
a later refresh reads metadata afresh, including after ambiguous COMMIT acknowledgement.

Status is in memory: current workspace, pending flag, start/completion/last-success times,
per-pass progress counts and up to 100 stable error records (no paths/provider diagnostics).
These are not total corpus coverage counts or persistent scan history. `close()` seals
admission, drops pending work, cancels even uncooperative injected IO and closes the owned
document pipeline. `SearchService` closes the embedder/repository/pool and wires
optional startup, the 15-minute timer, mutation refresh hooks and API routes.

## Per-document reconciliation

`search/document-indexer.ts` composes the read-only source, embedding and repository
boundaries. `SearchDocumentIndexer` construction performs no IO. Explicit `index()`
admits one document attempt with no queue; `close()` seals admission/cancels that attempt
without closing its injected dependencies. Cancellation races uncooperative adapters and
prevents late continuation; repository calls receive both abort signal and synchronous
pre-commit guards. Native dependency deadlines remain in force; there is no scheduler,
retry/backoff, aggregate pass admission, discovery, scan lifecycle or absence pruning here.

The caller supplies ordinary workspace/candidate inputs, a previously resolved immutable
embedding space and scan ID, plus optional force/recompute/cancellation settings. The
serialized worker synchronizes derived workspace metadata from SQLite and compares
registrations at workspace boundaries. There are no authority seals, suppression callbacks
or cleanup tickets in this pipeline. Invalid/unavailable sources retain cached old content;
a successfully published replacement session ID must have prior IDs at its canonical path
removed by the same worker. The local API vertical slice is validated with
synthetic server composition and the approved workstation rollout.

An exact canonical-target checkpoint lookup permits skipping only a single unambiguous
identity with matching fingerprint, processing profile and embedding space. Skip still
rechecks source/model and conditionally marks scan membership, never the
successful fingerprint/generation. Multiple prior path identities require reading the header.
Changed/forced snapshots extract the saved branch and deterministically chunk it; relocation
can find prior metadata by session ID. In-store symlink aliases converge on the canonical
source target. The worker accounts for aliases and discovered-unreadable paths
separately; this module neither establishes complete membership nor prunes old IDs.

Exact input hashes are deduplicated within a document. Reuse reads stream at most 128 hashes;
missing local embedding batches respect both 16-input and 256 KiB serialized-request limits,
including JSON escaping. Vector responses are copied/validated for shape, finiteness and unit
norm before publication. Prepared metadata/chunks/vectors are conservatively budgeted under
256 MiB, and repository publication retains its own lexical-metadata/batch bounds. Titles are
UTF-8/code-point-safe prefix projections capped at 16 KiB (metadata NUL becomes U+FFFD);
quoted body evidence and embedding inputs are never shortened to make a title fit.

Forced processing rereads even unchanged fingerprints but still reuses compatible inputs.
`recomputeEmbeddings` implies force and bypasses reuse. Changed processing profiles require
extraction; changed embedding spaces cannot reuse old vectors. Immediately before publication,
the pipeline checks the model digest and then the source witness. Repository cancellation
checks remain active through the short atomic transaction, with no authority seals. No
transaction is held during provider/source IO. Failed extraction, embedding or publication
preserves the prior successful checkpoint. Ambiguous commit acknowledgements are not blindly
retried: a later attempt must freshly read committed metadata. This is not an instant external
filesystem/model lock; changes after final witness checks remain subject to later reconciliation.

## Provision PostgreSQL 17 and pgvector

Use a dedicated `chatwca_search` database, application role, and migration history.
Do not reuse Network Brain's database or credentials. An existing PostgreSQL 17
server with pgvector installed can host this separate database. Extension provisioning
requires an administrator; application credentials must not be superuser credentials.

Alternatively, the optional [Compose recipe](../deploy/search/compose.yml) creates a
separate container and named volume. Run from the repository root. Choose an unused
host port; the default is **55432**, not the commonly occupied 5432. This recipe binds
only loopback and is provisioned separately from ChatWCA. Once provisioned, its
`unless-stopped` policy restarts PostgreSQL with Docker unless explicitly stopped.
This workstation's protected Compose environment is
`/home/adrian/.config/chatwca/search-postgres.env`; pass it with `--env-file` for
Compose operations. It contains secrets and must not be committed or printed.

```sh
read -rs -p 'New PostgreSQL admin password: ' CHATWCA_SEARCH_POSTGRES_ADMIN_PASSWORD
printf '\n'
export CHATWCA_SEARCH_POSTGRES_ADMIN_PASSWORD
# export CHATWCA_SEARCH_POSTGRES_PORT=55432
# Verify the chosen port is unused before starting.
docker compose -f deploy/search/compose.yml up -d
```

The Compose password initializes a **new** volume; changing the environment does not
change a password already stored in an existing volume. Use PostgreSQL role management
for rotations. Keep this administrator password separate from the application password.

Connect as administrator to the dedicated database:

```sh
docker compose -f deploy/search/compose.yml exec postgres psql -U postgres -d chatwca_search
```

Provision the extension and application role (interactive `\password` avoids putting
a password in SQL or shell history):

```sql
CREATE EXTENSION vector;
CREATE ROLE chatwca_search LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
\password chatwca_search
REVOKE ALL ON DATABASE chatwca_search FROM PUBLIC;
GRANT CONNECT ON DATABASE chatwca_search TO chatwca_search;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO chatwca_search;
```

Use administrator or dedicated DDL-role credentials to run migrations. If using a
DDL role, grant it CONNECT/USAGE/CREATE in this database; provision the extension
with the administrator first. Do not use these privileged credentials for ChatWCA.

## Explicit migrations

From the repository root, install dependencies and provide the **migration role's**
connection URL through `CHATWCA_SEARCH_DATABASE_URL`, then run:

```sh
npm ci
npm run search:migrate
```

The command loads the optional root `.env`; shell variables take precedence. You can
migrate while search is disabled. Avoid placing passwords in shell history: use a
protected environment file or a secret-injection mechanism. Percent-encode URL password
characters. Migration failure prints only a stable error, never raw pg diagnostics/URLs.

The command checks for pgvector, uses a bounded advisory transaction lock, applies
schema changes/checkpoints atomically, and verifies SHA-256 migration checksums.
Repeated invocation is a no-op. Unknown or changed applied migrations are rejected;
do not edit a migration after deploying it. Missing pgvector is reported as
`search_schema_incompatible`; other command failures use `search_migration_failed`.

After migration, grant only DML on derived-state tables and read-only schema metadata:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON
    search_workspaces, search_documents, search_chunks, search_index_runs
    TO chatwca_search;
GRANT SELECT ON search_schema_migrations TO chatwca_search;
```

Configure ChatWCA with the application-role URL, **not** the migration/admin URL.
Future migrations may require explicit grants on new tables. No approximate vector
index is created: retrieval will start with exact cosine queries. Both English and
simple full-text columns are generated with title/body weights; repository transactions
update copied title/workspace metadata along with document changes.

## Startup-only configuration

| Variable | Default | Validation |
|---|---|---|
| `CHATWCA_SEARCH_MODE` | `disabled` | `disabled` or `optional`; optional requires a database URL and initializes asynchronously after listening. |
| `CHATWCA_SEARCH_DATABASE_URL` | unset | PostgreSQL URL with host and database name, no fragment; server-only secret. |
| `CHATWCA_SEARCH_OLLAMA_URL` | `http://127.0.0.1:11434` | HTTP(S) base URL, no credentials/query/fragment. Probed by enabled indexing/query operations, not blocking listener readiness. |
| `CHATWCA_SEARCH_EMBEDDING_MODEL` | `qwen3-embedding:0.6b` | Non-empty trimmed tag; fixed schema dimension 1,024. Digest/capability checks run in indexing and independent query lanes. |
| `CHATWCA_SEARCH_INDEX_INTERVAL_MS` | `900000` | Positive safe integer, at most `86400000` (one day). |
| `CHATWCA_SEARCH_EMBEDDING_TIMEOUT_MS` | `30000` | Positive safe integer, at most `120000`. |
| `CHATWCA_SEARCH_RERANK_PROVIDER` | unset | Paired override; `openai` or `openai-codex`. Availability uses the existing Pi local catalog/auth snapshot. |
| `CHATWCA_SEARCH_RERANK_MODEL` | unset | Non-empty model paired with provider; otherwise uses the complete global Pi startup default pair; no automatic/project/session selection. |
| `CHATWCA_SEARCH_RERANK_TIMEOUT_MS` | `20000` | Positive safe integer, at most `35000` (full search deadline). |

Invalid local configuration fails startup even in disabled mode; syntax validation
performs no network, filesystem, or auth probing. Search settings are currently
server-only; `/api/config.search` advertises only the nonsecret capability projection.
No provider tokens/API keys are copied into search configuration.

The lazy PostgreSQL pool factory caps connections at four, connection establishment
at three seconds, and statements/client queries/idle transactions at five seconds.
The repository now bounds maintenance admission and aggregate transactions separately;
interactive retrieval now has two independently admitted read-only transaction slots
and the query service rejects excess concurrent searches without queueing. Optional
mode constructs the lazy pool asynchronously after listening; disabled mode never does.

## Local hybrid retrieval

`PostgresSearchRetrieval` uses parameterized English/simple full-text retrieval as one
channel and exact cosine retrieval as the other. Each filters current registered IDs
and source revisions; vectors also require matching document/chunk model-space
signatures. Results are cached and never probe source files. `SearchQueryService`
resolves/embeds in the independent Ollama query lane, falls back to lexical on provider
failure, applies RRF k=60 and overlap collapse, and groups by workspace/session.

Queries are bounded to 2,048 code points / 8 KiB and 35 seconds. Default/max groups:
10/20; per-channel candidates: `min(100, max(30, limit * 5))`; at most five retained
chunks per conversation / 100 overall. Public responses contain up to three plain-text
excerpts per group (1,200 code points each), capped to 256 KiB serialized. Paths,
vectors and internal scores are omitted. `cached: true`, lexical/hybrid mode and stable
embedding warnings do not claim source freshness; routes supply compact freshness
and the full status endpoint exposes worker progress/errors. Query cancellation/shutdown never becomes successful fallback.

Current-space vector absence reports lexical mode even when query embedding works.
Model replacement never compares old-space vectors; lexical cache remains usable while
the writer progressively replaces documents. No migration changes or background
startup behavior are introduced by these retrieval adapters.

## Read-only source adapters

- `src/server/session-scope.ts` shares canonical workspace/stored-CWD admission with
  `SessionHistory`. Search does not replace fresh scoped SDK authorization for open/delete.
- `search/session-source.ts` enumerates only regular JSONL candidates in the exact
  configured store. The Pi-default directory convention is pinned against SDK fixtures;
  Pi's internal helper creates missing directories, so search uses a pure path adapter
  instead. No global scan, runtime construction, or SDK listing is used by search.
- Enumeration reads directory/stat metadata, not transcript contents. Header ownership
  is checked when reading new/changed snapshots. Every encountered JSONL file remains
  seen, including malformed/unreadable ones. Escaping/broken file symlinks make the scan
  incomplete; a missing/unreadable/aliased store is unavailable, never an empty history.
  Directory symlinks are not traversed. Contained regular-file symlinks are allowed.
- Snapshot reads use regular-file descriptors, strict UTF-8/JSONL, source identity and
  fingerprint checks, and cancellation. Final parseable records need no newline;
  incomplete trailing records are deferred. Limits are 128 MiB per file, 48 MiB per
  record, and 100,000 discovered JSONL paths per workspace (an over-limit enumeration
  cannot authorize pruning). File/directory witnesses can be rechecked before later
  publication/pruning. The worker compares registrations at workspace boundaries;
  the document pipeline rechecks the model and source before publication.
- `search/extract.ts` keeps only the last persisted root-to-leaf branch's visible
  user/assistant text, including pre-compaction history. Multiple roots are valid after
  `resetLeaf()`. Duplicates, cyclic/forward/missing parent links, malformed required
  fields, and unsupported versions fail without changing sources. Unknown tree metadata
  and message roles are not searchable. `context_edit` does not redact historical text.
- Foreign or unavailable stored CWDs reject the new snapshot without suppressing cached
  results. Read failures preserve previously indexed content. Scoped deletion primitives
  are used by the serialized worker, not history/source adapters.
- `search/chunk.ts` emits independent message chunks with checked UTF-8 byte spans,
  3,200-code-point/12-KiB bounds, up to 400-code-point overlap, deterministic keys/input
  hashes, and a 20,000-chunk conversation cap. Only line endings are normalized.
  Role prefixes are separate from quoted text; titles/workspace names never enter the
  embedding input. Oversized code fences split without adding synthetic source text.

## Development checks

```sh
npm run typecheck
npx vitest run tests/unit/search-*.test.ts
npx vitest run tests/integration/search-session-source.test.ts tests/integration/search-embeddings.test.ts
```

The source integration suite uses only temporary synthetic files and the pinned SDK.
It covers scoped store/listing parity, branches/forks/compaction, nonpersisted live cursors,
source bytes/mtime, and a 40 MiB image-bearing record. No runtime/model/auth is needed.
Embedding tests use injectable transports and a new ephemeral loopback-only fake server,
with synthetic inputs/digests/vectors. They cover digest changes, input/body/vector limits,
aggregate deadlines, admission queues, cancellation, redirects and diagnostic redaction;
no shared Ollama, paid provider, real transcripts, or search database is used.

The PostgreSQL integration suites are explicitly opt-in. Point
`CHATWCA_SEARCH_TEST_DATABASE_URL` at a **disposable test database** with pgvector
already provisioned and schema-creation permission:

```sh
npx vitest run tests/integration/search-schema.test.ts tests/integration/search-repository.test.ts tests/integration/search-document-indexer.test.ts tests/integration/search-indexer.test.ts
```

Each run creates/drops its own random schema. Tests validate idempotence, schema
compatibility, fixed dimensions, exact nanosecond fingerprints, weighted lexical
columns, cascading deletion, rollback, exact-input reuse, atomic complete-generation
visibility, metadata renames, stale revision/generation rejection, cancellation, aggregate
deadlines and pre-commit cancellation guards. Checkpoint tests cover initial-schema
upgrades, stable keyset pagination, duplicate path identities, long paths, exact lookup,
stale scopes, and concurrent changes between pages. They never use Ollama/OpenAI or real
transcripts. The document composition suite additionally uses new temporary synthetic JSONL
files and its own ephemeral loopback embedder. It checks incremental reuse/title updates,
source bytes/metadata preservation, source/model races, malformed/wrong-owner cache
retention, pre-commit cancellation rollback, accepted post-witness staleness, provider
recovery and lost COMMIT acknowledgement.
The worker composition suite exercises real SQLite registrations, both configured store
kinds, sequential publication/skipping/reuse, forced rebuild, canonical aliases, incomplete
and missing stores, directory witness changes, identity replacement, rename/source revision
sync, unregister/restart, busy refresh coalescing and dependency failure/recovery. All source
files are temporary synthetic evidence and are verified unchanged by indexing.
Repository suites also cover exact version/path-conditional deletion, stale generation/move/
recreation no-ops, rollback of counters/evidence, cancellation and ambiguous deletion COMMIT
recovery. These checks remain under `search-repository.test.ts`; retired ticket/incarnation/
workspace-preparation suites have been removed. Without the environment variable PostgreSQL
cases are skipped; source/SQLite and fake-provider composition tests still run.

## Rollback and backup

Keep `CHATWCA_SEARCH_MODE=disabled` and restart. Search schema/data may remain for
later recovery; do not remove source files or SQLite metadata. PostgreSQL can be
reconstructed by the implemented indexer and is not a substitute for Pi/SQLite
backups. Do not destroy a Compose volume unless deliberately discarding this index.

## Approved rollout and acceptance

Local API, Global Search/message navigation and the default-on rerank toggle/fallback
labels are implemented and synthetically validated. Workstation rollout was explicitly
approved on 2026-10-01. Dedicated PostgreSQL, explicit migrations, optional-mode `.env`
and production build were prepared; the operator restarted the service at
19:42 PDT. Production indexing completed: **273 conversations / 3,210 chunks across
14 workspaces**, zero errors. Live HTTP all/scoped hybrid search, browser exact-message
opening/return retention, real Pi reranking/applied label and opt-out were verified.
Refresh completed with all documents unchanged; rebuild confirmation was cancelled.
All one-off workers are stopped. Assess operator relevance in everyday use.

For future activation/restarts, administrator authentication is required:

```sh
sudo systemctl restart chatwca.service
curl --fail http://10.35.0.34:8787/api/health
curl --fail http://10.35.0.34:8787/api/search/status
```

Check `/api/config.search` is optional/ready, reload the browser and validate useful
one/all-workspace search, exact excerpt navigation and actual applied/local-fallback
rerank labels. Let the production initial pass finish; it reuses existing cached work.
Do not run a second indexer alongside it. Current counts, protected secret/backup paths
and deployment/usage-assessment state are recorded in `../checkpoint.md`.

Retired modules and obsolete tests are removed. No cleanup tickets,
suppression recovery or membership barrier. Missing/incomplete stores still never
authorize pruning.
