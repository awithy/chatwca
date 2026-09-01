# Bubblewrap Workspace Sandboxing Implementation Plan

**Status:** Proposed

**Design:** [`docs/bubblewrap-design.md`](docs/bubblewrap-design.md)

**Baseline:** Node.js 22.19+, Bubblewrap 0.6.1+, Pi SDK 0.84.3, Linux

## 1. Objective and release boundary

Implement the design's `workspace-sandboxed` profile without changing unrestricted behavior. A sandboxed live conversation owns one Bubblewrap worker. All model-selected filesystem and process operations cross that worker boundary; model/provider calls, credentials, SQLite, Pi JSONL persistence, HTTP, and WebSockets remain in the parent.

The first release supports exactly these sandboxed tools:

```text
read, write, edit, bash, ls, grep, find
```

It must not silently fall back to a parent implementation. Extensions, dynamically registered tools, skills, prompt templates, project settings that can alter tools, and provider registrations made by extensions are unavailable in sandboxed runtimes.

Resource quotas through cgroup v2, network allowlists, read-only source profiles, `.git` protection, and arbitrary extension support remain out of scope.

## 2. Non-negotiable implementation invariants

1. The browser supplies only a workspace ID and requested profile. Runtime policy always comes from a fresh repository lookup.
2. A sandboxed tool never resolves a model-provided path or spawns a model-provided command in the parent.
3. Worker responses cannot request host operations. The parent accepts only terminal responses, output, and diagnostics for parent-created request IDs.
4. Worker launch, handshake, protocol, and restart failures fail closed.
5. A live runtime's effective profile is immutable. Path/profile changes require all workspace runtimes to be closed.
6. Fork and rewind resolve the workspace policy again and create a distinct temporary worker.
7. Abort, timeout, fatal failure, close, eviction, and shutdown remove the namespace and descendants.
8. The sandbox system prompt and tool CWD are `/workspace`; canonical host workspace paths never enter the model-facing prompt.
9. `.chatwca` is masked with ephemeral storage. `.git` remains writable and is described accurately in the UI and documentation.
10. Sandboxing does not claim confidentiality from the model provider or protection from harmful workspace edits or denial of service.

## 3. Current-code impact

The main integration points are:

- `src/server/config.ts`: currently synchronous scalar environment parsing only.
- `src/server/database.ts`: schema version 2.
- `src/server/workspace-repository.ts`: synchronous availability checks and no policy evaluator.
- `src/shared/protocol.ts`: workspace create/update and projections have no security fields.
- `src/server/pi-runtime.ts`: CWD-only factory API, one shared `ModelRuntime`, and default Pi resources/tools.
- `src/server/conversation-registry.ts`: owns runtime/fork/abort/disposal lifecycle but records no effective profile.
- `src/server/protocol.ts`: uses `requireAvailable()` for all workspace operations and only treats path changes as busy-sensitive.
- `src/server/index.ts`: startup has no asynchronous host-capability probe; `/api/config` only reports image limits.
- `src/server/conversation-registry.ts#getWorkspaceImage()`: currently opens assistant-supplied Markdown image paths in the parent and must use the worker for sandboxed conversations.
- `WorkspaceForm`, `WorkspaceSidebar`, `ConversationHeader`, `App`, and client state: no profile controls, policy-blocked state, or runtime badge.

The existing registry already has useful ownership points: capacity reservation before construction, temporary fork runtime ownership, LRU eviction, coalesced aborts, and bounded shutdown. Extend these rather than creating a second conversation registry.

## 4. Target server types and ownership

Add shared types:

```ts
type WorkspaceSecurityProfile =
  | "unrestricted"
  | "workspace-sandboxed";

type SandboxMode = "disabled" | "optional" | "required";

type WorkspacePolicyIssue =
  | "sandbox_disabled"
  | "outside_workspace_roots"
  | "protected_path_overlap"
  | null;
```

Replace CWD-only runtime construction with:

```ts
interface RuntimeWorkspacePolicy {
  workspaceId: string;
  cwd: string;                    // canonical host path, parent-only
  sessionDirectory: string | null;
  securityProfile: WorkspaceSecurityProfile; // effective profile
}

interface PiRuntimeFactoryPort {
  createPersistent(policy: RuntimeWorkspacePolicy): Promise<PiConversationRuntimePort>;
  openPersistent(
    policy: RuntimeWorkspacePolicy,
    sessionFile: string,
  ): Promise<PiConversationRuntimePort>;
}
```

`ConversationRecord` stores the immutable effective `securityProfile`. `ConversationState.securityProfile` is projected from the record, not from the current workspace row.

Use these sandbox ownership layers:

```text
PiConversationRuntime
  -> SandboxController (optional)
       -> current SandboxWorkerClient
       -> restart/fatal state
       -> SandboxWorkerFactory
            -> bwrap child + data FDs + protocol pipes
```

Tools capture `SandboxController`, not a particular worker instance, so a successful abort restart updates all tool executions without rebuilding the Pi session.

## 5. Phase 0 — Boundary and packaging spike

Do this before landing schema/UI changes. The spike may live in tests or a disposable branch, but its conclusions must be recorded in `docs/bubblewrap-operations.md`.

### T0.1 Prove the exact Bubblewrap profile

**Status: Complete.** Reproducible probe and deployment results are recorded in [`docs/bubblewrap-operations.md`](docs/bubblewrap-operations.md).

On the deployment host and under `systemd/chatwca.service`, launch the proposed synthetic root and verify:

- user, mount, PID, IPC, UTS, and network namespaces differ from the parent;
- effective capabilities are empty and `NoNewPrivs` is `1`;
- `/usr/bin/node`, `/bin/bash`, and `rg` execute;
- the workspace is read/write at `/workspace`;
- `.chatwca` is ephemeral and masks host sessions;
- parent canary, ChatWCA data, Pi agent, unrelated workspace, host `/home`, `/etc`, `/run`, `/tmp`, `/sys`, and `/dev` devices beyond the minimal view are unavailable;
- IPv4, IPv6, DNS, and loopback connections fail; and
- killing Bubblewrap removes a forked command tree.

### T0.2 Prove inherited data FDs

Use Node `spawn()` with dedicated `stdio` entries to prove that Bubblewrap 0.6.1 accepts pipes for:

- `--ro-bind-data <worker-fd> /app/worker.mjs`;
- minimal `/etc/passwd`, `group`, `hosts`, and `nsswitch.conf`; and
- separate request and response protocol FDs inherited by the final worker.

The parent must write each immutable payload, close its end, and never place worker source in the workspace or bind the application checkout.

### T0.3 Prove development and production worker packaging

Add a worker bundle step using a direct `esbuild` development dependency:

```text
src/server/sandbox/worker-entry.ts
  -> dist/sandbox/worker.mjs
```

The bundle must contain only worker code and Node built-ins; it must not need `node_modules` in the namespace. Update `build`, `dev`, and clean scripts so both `tsx` development and compiled production load the same generated artifact. The server reads it into memory once, computes its SHA-256/version, and every worker launch uses that process-lifetime snapshot.

### Phase 0 exit criterion

Do not proceed if the current kernel/systemd policy cannot create the required namespaces, data FDs do not work, the synthetic root cannot run the required binaries, or killing the Bubblewrap child leaves descendants.

## 6. Phase 1 — Configuration, persistence, and policy projection

### T1.1 Extend configuration

Create `src/server/sandbox/config.ts` and keep `src/server/config.ts` as the top-level composition boundary.

Parse and validate:

- `CHATWCA_SANDBOX_MODE`;
- `CHATWCA_BWRAP_PATH`;
- `CHATWCA_WORKSPACE_ROOTS` as a JSON string array;
- `CHATWCA_SANDBOX_RO_MOUNTS` as a JSON string array;
- `CHATWCA_SANDBOX_PATH` as an absolute, empty-segment-free guest PATH;
- start timeout, command hard timeout, and full command output limit.

Rules:

- reject malformed JSON, non-string entries, empty values, relative paths, and canonical duplicates;
- require at least one workspace root in `required` mode;
- canonicalize configured roots and mount sources once at startup;
- require every PATH entry to be supplied by `/usr`, a compatibility symlink into `/usr`, or an approved read-only mount;
- validate extra mount sources as regular files or directories and reject protected/overlapping destinations;
- in `disabled` mode, do not stat, version-check, or execute Bubblewrap and do not require its runtime/toolchain settings to work;
- still enforce configured workspace roots in every mode.

Represent sandbox settings as an immutable nested object on `ServerConfig`. Keep executable paths, roots, mounts, limits, and diagnostics server-only.

### T1.2 Add schema version 3

In `src/server/database.ts`:

- change `DATABASE_SCHEMA_VERSION` to `3`;
- include `security_profile` in a fresh schema;
- add a transaction-safe 2-to-3 migration with default `unrestricted` and the CHECK constraint;
- preserve 1-to-2-to-3 migration support in one startup;
- set `user_version` only after each successful migration.

Add database tests for fresh version 3, version 2 migration, version 1 chained migration, invalid stored values, and rollback on failure.

### T1.3 Add policy evaluation to the workspace repository

Inject immutable policy inputs into `WorkspaceRepository`: mode, canonical roots, canonical data directory, canonical Pi agent directory, and canonical read-only mounts.

Extend stored/projection types with:

```ts
securityProfile: WorkspaceSecurityProfile; // stored
effectiveSecurityProfile: WorkspaceSecurityProfile | null;
usable: boolean;
policyIssue: WorkspacePolicyIssue;
```

Implement the mode table exactly:

- disabled + requested sandbox => `effectiveSecurityProfile: null`, `sandbox_disabled`, never downgrade silently;
- optional => stored value is effective;
- required => effective sandbox regardless of stored value.

Policy checks must use canonical containment/overlap helpers, never string prefixes. Apply roots whenever configured. Apply protected-path and extra-mount overlap checks when the effective profile is sandboxed.

Split repository admission:

- `requireAvailable(id)`: directory/session-history operations that do not start tools;
- `requireUsable(id)`: fresh canonical path/root/policy validation and a trusted `RuntimeWorkspacePolicy` for create/open/fork/rewind.

For sandboxed policy, `requireUsable()` also requires read/write/search access and delegates the bounded socket and `.chatwca` checks added in Phase 2. A policy-blocked workspace remains listable and may expose scoped history, but cannot create/open/fork/rewind a runtime.

### T1.4 Update workspace commands

In shared and server protocol code:

- require `securityProfile` on `workspace.create`;
- permit optional `securityProfile` on `workspace.update`;
- permit `acknowledgeSecurityDowngrade` only on an update containing a sandbox-to-unrestricted change;
- reject such a downgrade without `true`;
- reject any downgrade in required mode;
- treat path or profile changes as `workspace_busy` while a live runtime belongs to the workspace;
- continue allowing name-only changes while busy;
- include new projection fields in every authoritative workspace list.

Use closed TypeBox variants so acknowledgement fields cannot be smuggled into unrelated updates.

### T1.5 Add errors and public config

Add all seven sandbox errors from the design to `src/shared/errors.ts`, with generic client-safe messages. Extend error mapping with a sandbox context that distinguishes configuration, startup, workspace admission, worker startup, fatal worker failure, and healthy operation failure.

Extend `GET /api/config` with only:

- mode;
- selectable profiles;
- remote-provider disclosure warning;
- functional-probe success.

Do not expose bwrap path, roots, protected paths, mount source paths, or private causes. Workspace Info will describe `/usr` and the existence of administrator-controlled runtime mounts generically; host mount paths stay redacted as required by the design's API restriction.

### Phase 1 exit criterion

All existing tests pass in the default `disabled` mode. Version 3 rows and stored/effective projections are fully tested without launching Bubblewrap.

## 7. Phase 2 — Workspace admission, Bubblewrap builder, and probes

### T2.1 Implement sandbox workspace admission

Add an asynchronous admission component used by `requireUsable()` immediately before every sandbox runtime construction. Re-canonicalize the workspace and verify:

- approved-root membership;
- read/write/search access;
- `.chatwca` is absent or a real directory and never a symlink;
- no overlap in either direction with ChatWCA data, Pi agent, or extra mounts;
- the canonical path still matches the stored path; and
- no Unix-domain socket exists in a no-follow tree walk.

Use `lstat`/directory handles and never follow symlinks during the socket walk. Add named internal bounds (initially 100,000 entries and 2 seconds). Reaching either bound is rejection, not a skipped check. Record that this is a best-effort race check in documentation.

### T2.2 Validate Bubblewrap and required runtime binaries

In `src/server/sandbox/bwrap.ts`:

- require an absolute path whose realpath is identical to the configured path;
- require a root-owned regular executable not writable by group/other;
- invoke it without a shell and parse `bwrap --version` as at least 0.6.1;
- validate that the synthetic `/usr` provides `/usr/bin/node` at Node 22.19+, `/bin/bash` through the conditional symlink, and `rg` on the configured PATH;
- reject unsupported platform/architecture assumptions with `sandbox_configuration_error` or `sandbox_unavailable` as appropriate.

`rg` is the only required search executable: worker `grep` uses its JSON stream and worker `find` uses `rg --files` plus glob filtering. No parent `ensureTool()`, download, `fd`, or `rg` spawn is allowed.

### T2.3 Build Bubblewrap argv and immutable data bindings

Create one pure argument builder used by startup probes and conversation workers. It returns argv plus inherited FD payloads, never a shell command.

Cover:

- all namespaces, hostname, capabilities, session, parent death, and clearenv flags from the design;
- synthetic root with `/usr` only, conditional `/bin`, `/sbin`, `/lib`, `/lib64` symlinks, minimal `/proc` and `/dev`, ephemeral home/tmp/var-tmp;
- canonical extra mounts before the workspace bind;
- workspace bind and later `.chatwca` tmpfs mask;
- immutable worker and minimal `/etc` data FDs;
- exact fixed environment values;
- `/workspace` as chdir and `/usr/bin/node /app/worker.mjs` as the final command.

Unit tests inspect the argv array and prove there is no bind of `/`, data, agent, session paths, host home, host temp, `/run`, `/sys`, or application checkout.

### T2.4 Implement startup and per-worker probes

Add `src/server/sandbox/probe.ts`. The startup probe uses a temporary workspace, parent-only canary, and the same worker/argv builder. It checks namespace inode differences, capabilities, no-new-privileges, root entries, exact environment names, workspace write-through, hidden protected paths, mount identity, and network failures.

Every conversation handshake repeats nonce, protocol version, worker artifact hash/version, namespace checks, environment checks, and expected workspace mount identity. A successful process-wide probe never substitutes for a per-worker handshake.

Integrate startup in this order:

```text
parse config
open/canonicalize data and Pi paths
load immutable worker bundle
validate sandbox config and bwrap (optional/required only)
run functional probe (optional/required only)
create model/runtime services
construct HTTP/WS server
listen
```

Any failure before listening unwinds SQLite, temporary workers, FDs, and model/runtime construction just like current startup cleanup.

### Phase 2 exit criterion

Optional/required startup fails before binding when the executable, version, namespace, mount, environment, toolchain, or network probe is wrong. Disabled startup never inspects Bubblewrap.

## 8. Phase 3 — Framed IPC and parent worker lifecycle

### T3.1 Define protocol schemas and codecs

Create `src/server/sandbox/protocol.ts` with closed parent-side TypeBox schemas and an incremental four-byte big-endian frame decoder.

Enforce before allocation:

- 1 MiB frame limit;
- 16 MiB assembled request limit;
- eight active operations;
- 4 MiB pending worker output;
- strict UTF-8 and JSON;
- parent-generated request IDs only;
- ordered chunk sequence, declared byte count, and SHA-256;
- one terminal response/error per request.

Use raw chunks no larger than 768 KiB before base64 encoding so the encoded frame remains below 1 MiB. The dependency-free worker has mirrored strict structural validators; shared fixture tests feed every valid/invalid frame to both validators to prevent drift.

### T3.2 Implement `SandboxWorkerClient`

`src/server/sandbox/worker-client.ts` owns:

- detached Bubblewrap process and every inherited FD;
- hello/ready timeout and nonce verification;
- request correlation and operation-specific response validation;
- chunk assembly and hashes;
- streamed stdout/stderr callbacks;
- AbortSignal-to-cancel propagation;
- pipe backpressure and queue accounting;
- bounded private stderr diagnostics;
- graceful shutdown, then SIGTERM, then SIGKILL with bounded waits;
- rejection of all pending calls on exit/protocol violation; and
- exactly-once fatal notification.

Worker stdout is closed, stdin is `/dev/null`, and stderr is diagnostic-only. Never parse protocol from stdout/stderr.

Unknown IDs, unsolicited request-like frames, duplicate terminals, malformed JSON/UTF-8, hash mismatch, sequence gaps, oversized payloads, queue overflow, or unexpected exit are fatal. Healthy operation errors carry stable worker codes only.

### T3.3 Define worker operations

Version 1 operation schemas cover:

- `readFile` with MIME signature detection and bounded binary response;
- `writeFile` with recursive parent creation;
- atomic `editFile`;
- `listDirectory`/metadata;
- `grep`;
- `find`;
- `exec` with stream frames;
- health/namespace probes.

The parent API exposes typed methods, not a generic `call(operation, unknown)` outside the sandbox package.

### T3.4 Test hostile transport behavior

Use fake child streams and a deliberately hostile worker fixture to test partial prefixes, coalesced frames, invalid lengths, slow readers, worker stderr floods, spoofed IDs, request races, cancellation, shutdown races, and exit during every handshake phase. Assert FD closure and one fatal callback in every path.

### Phase 3 exit criterion

The parent can treat the worker as compromised without accepting new authority or leaking unbounded memory/FDs.

## 9. Phase 4 — Dependency-free worker filesystem operations

### T4.1 Implement guest path handling

Create `worker-entry.ts` and `worker-fs.ts` using Node built-ins only.

Path rules:

- strip one leading `@`;
- resolve relative paths from `/workspace`;
- treat absolute paths as synthetic guest-root paths;
- reject NUL and malformed path inputs;
- use `realpath` for existing mutation targets;
- for new targets, canonicalize the nearest existing ancestor and append the unresolved suffix;
- rely on the mount namespace as the final boundary rather than translating guest paths to host paths.

Do not add a host-path broker or return host paths in operation errors.

### T4.2 Serialize mutations by canonical guest target

Maintain per-target promise queues in the worker. Queue the complete read/validate/write mutation window for `writeFile` and `editFile`, and collapse symlink aliases onto the same canonical key. Remove idle queue entries to bound state.

### T4.3 Preserve edit semantics

Port the pinned Pi 0.84.3 behavior needed for exact edits into the worker:

- legacy argument preparation remains parent-side;
- one or more unique, non-overlapping matches against original content;
- BOM preservation;
- LF normalization and original line-ending restoration;
- no partial write when any edit is invalid;
- diff, unified patch, and first changed line in the result.

Write through a same-directory temporary file plus rename where filesystem semantics permit, while preserving existing permissions. Contract-test success and every ambiguity/overlap/error case against Pi 0.84.3 fixtures.

### T4.4 Implement read/write/list/image behavior

Return binary bytes and MIME-signature results from the worker. Parent tool code may resize/format returned image bytes, but must not receive or open a host path. Enforce IPC/read limits before buffering.

For sandboxed Markdown workspace images, replace the current parent `realpath/readFile` path with a worker read/signature operation. Keep the current host implementation only for unrestricted records. This closes the existing assistant-supplied path bypass outside tool execution.

### Phase 4 exit criterion

Read/write/edit/ls work in the workspace, cannot escape through absolute paths, `..`, symlinks, or `.chatwca`, and no model-directed path is opened in the parent.

## 10. Phase 5 — Search, shell, output, and cleanup

### T5.1 Implement grep and find inside the worker

Run the mounted `rg` from the worker, not the parent:

- `grep`: JSON output, regex/literal/case/glob/context/limit behavior, `.gitignore`, hidden-file behavior, long-line and byte truncation metadata;
- `find`: `rg --files`, glob filtering, relative POSIX paths, result limit and truncation metadata.

Spawn without a shell for search. Validate all options before construction and pass argv arrays. Contract-test result text/details against Pi 0.84.3.

### T5.2 Implement shell execution

Run `/bin/bash -lc <command>` with:

- cwd `/workspace`;
- exact fixed environment;
- stdin ignored;
- separate stdout/stderr pipes;
- one exec at a time;
- a new process group;
- the lower of the tool timeout and configured hard maximum.

The worker streams ordered output frames while writing full output to ephemeral worker storage. The parent keeps only Pi-compatible truncation snapshots. If output is truncated, `fullOutputPath` is a guest path readable through the sandbox worker, never a parent temp file.

Terminate the worker when total command output exceeds `CHATWCA_SANDBOX_MAX_COMMAND_OUTPUT_BYTES`; do not continue while dropping bytes.

### T5.3 Clean command descendants

After normal command exit, inspect private `/proc`, terminate remaining descendants, and report success only when only Bubblewrap init and the worker remain. Failure to prove a clean namespace is fatal.

On tool timeout or conversation abort, do not trust process-group cleanup: terminate the entire Bubblewrap namespace. Pipe backpressure must pause child output and resume on drain without allowing more than 4 MiB queued frames.

### T5.4 Add worker restart/failure state

`SandboxController` distinguishes:

- healthy operation failure: return a normal failed tool result; worker remains usable;
- planned invalidation (abort/command timeout): kill namespace, allow Pi to settle, start and probe a fresh worker before another prompt;
- fatal exit/protocol failure: reject all tools, abort the active Pi run, mark the runtime failed after Pi settles, and do not auto-fallback or auto-retry unrestricted;
- restart failure: transition the conversation to `error`.

A timeout may abort the current run and return the conversation to idle only after a replacement worker handshakes. A fatal protocol/worker failure leaves it in `error` until close/reopen.

### Phase 5 exit criterion

Shell/search behavior is useful and bounded; command descendants cannot survive completion, abort, close, or worker teardown.

## 11. Phase 6 — App-owned Pi tools and strict resources

### T6.1 Build complete app-owned tool definitions

Add `src/server/sandbox/tools.ts`. Use Pi's exported definition factories only as pinned metadata/schema sources; do not call their built-in `execute` functions. Replace execution for all seven tools with typed worker operations.

Preserve:

- names, labels, descriptions, parameter schemas, prompt snippets/guidelines;
- edit `prepareArguments` compatibility;
- 50 KiB/2,000-line truncation direction and notices;
- tool update streaming;
- read image content shape;
- grep/find/ls details;
- bash details and guest `fullOutputPath`;
- edit diff/patch/firstChangedLine.

Do not retain built-in edit preview renderers that can probe a host path. Browser rendering uses normalized results and does not need Pi TUI renderers.

Every thrown tool error must use a generic stable message. Requested paths, command output, OS messages, worker stderr, stacks, and Bubblewrap arguments remain in bounded private diagnostics.

### T6.2 Add a strict ResourceLoader

Implement an app-owned `ResourceLoader` for sandboxed sessions:

- empty extension runtime (`createExtensionRuntime()`), no discovered or inline extensions;
- empty skills, prompts, and themes;
- no package discovery/installation;
- no appended/system prompt files from project/global locations;
- context files loaded only by an app-owned scanner that stops at workspace root, requires canonical regular files within the workspace, and returns guest display paths such as `/workspace/AGENTS.md`;
- explicit sandbox system prompt with `/workspace` and the design's network, host-path, `.chatwca`, package-download, and ephemeral-state constraints.

Use a strict in-memory settings snapshot derived from administrator-controlled global settings. Exclude project settings and resource/tool/shell/package fields that can alter tool execution. Preserve safe model choice, thinking, retry, and compaction settings needed for normal agent behavior.

### T6.3 Separate model runtimes

Create two process-lifetime `ModelRuntime` instances using the same administrator-controlled credential/model paths:

- unrestricted: current extension-compatible behavior;
- strict: never passed to an extension-capable resource loader and therefore never mutated by extension provider registration.

`PiRuntimeFactory` chooses by effective profile. `listAvailableModels()` should report the appropriate administrator-visible catalog without causing the strict runtime to inherit unrestricted extension mutations. Add tests proving an extension-only provider/tool is absent from strict sessions while a normal faux remote provider still works through the parent.

### T6.4 Construct sandboxed sessions with an explicit allowlist

Pass only the seven app-owned `customTools` and an explicit seven-name active allowlist to `createAgentSessionFromServices()`. Set bash session-environment exposure to false. Contract-test the final `session.agent.state.tools`: exact names, exact app-owned execute functions, and no built-in/dynamic/extension extras.

Inspect the final model-facing system prompt in tests and fail if it contains the canonical host workspace, data directory, Pi agent directory, or session file.

### Phase 6 exit criterion

A fake model can exercise every approved tool, but cannot call an unbrokered built-in, extension tool, extension command, dynamic tool, or parent `pi.exec` path.

## 12. Phase 7 — Runtime, registry, fork, abort, and shutdown integration

### T7.1 Refactor the runtime factory API

Update every production/test factory implementation to take `RuntimeWorkspacePolicy`. For open, verify the session file as today, but use the supplied trusted policy rather than deriving security from the session header/CWD. Continue verifying that the stored canonical CWD equals `policy.cwd`.

For sandboxed creation:

1. run fresh workspace admission;
2. start and handshake the worker;
3. construct strict Pi services/session;
4. dispose the worker if any later construction step fails.

For unrestricted creation, preserve the current path exactly.

### T7.2 Extend `PiConversationRuntime`

Own an optional controller and expose:

- immutable `securityProfile`;
- a fatal runtime failure subscription for the registry;
- coordinated `abort()` that tears down the worker, aborts Pi, waits for idle, and handshakes a replacement;
- `dispose()` that always kills the worker even if Pi disposal fails;
- prompt rejection while worker replacement is pending or failed.

Pi session replacement inside a runtime retains the controller because profile/path changes are prohibited while live.

### T7.3 Extend conversation registry state

Store and project the effective profile. Subscribe to runtime fatal failures and transition to `error` after Pi settles without allowing a later normalizer `idle` event to overwrite the terminal state.

Keep worker ownership inside the runtime so existing close, LRU eviction, temporary fork ownership, failed-fork rollback, and process shutdown automatically cover it. Add explicit assertions that runtime disposal has completed worker teardown.

### T7.4 Re-resolve policy for fork and rewind

Before fork/rewind, `src/server/protocol.ts` must:

- read source state only to obtain workspace ID;
- call `requireUsable(workspaceId)` again;
- pass the resulting policy to `registry.fork()`;
- verify it still matches the immutable source workspace ownership;
- create the temporary runtime with `openPersistent(policy, sourceFile)`.

Promotion transfers the temporary Pi runtime and its worker together. Rewind deletes the source only after the fork snapshot succeeds, preserving current semantics.

### T7.5 Verify all cleanup paths

Add lifecycle tests for:

- normal close;
- LRU eviction;
- failed registration;
- failed fork before/after replacement;
- prompt abort and repeated abort;
- command timeout;
- worker self-kill;
- protocol violation;
- graceful shutdown and forced deadline;
- startup failure after a worker exists.

Each test checks process exit, FD closure, pending request rejection, and no fallback factory call.

### Phase 7 exit criterion

Concurrent unrestricted and sandboxed conversations do not share workers, strict tools, resource loaders, or extension-mutated model runtimes. Every registry ownership exit disposes its worker.

## 13. Phase 8 — Browser behavior

### T8.1 Load client-safe sandbox configuration

Add a shared public config schema/type and store it in `App`. Handle config fetch failure conservatively: do not show/select sandbox options until authoritative config is available.

### T8.2 Add profile create/edit controls

Update `WorkspaceForm` and sidebar props:

- optional mode defaults new workspaces to unrestricted;
- disabled mode hides/fixes the control to unrestricted;
- required mode fixes it to Workspace sandbox;
- edit displays stored and effective values;
- reducing protection uses an explicit `window.confirm()` warning and sends `acknowledgeSecurityDowngrade: true` only after confirmation;
- security/path controls are disabled when the client knows a workspace has a live runtime, while the server remains authoritative.

Use **Workspace sandbox**, never “Safe” or “Secure.”

### T8.3 Show availability versus policy usability

Workspace rows and selected-workspace behavior distinguish:

- unavailable directory;
- policy-blocked workspace and its reason;
- usable workspace.

A blocked workspace remains visible and can show Workspace Info/history, but New/Open/Fork/Rewind are disabled and server-rejected if attempted.

### T8.4 Expand Workspace Info

Show:

- stored and effective profile;
- whether server mode requires sandboxing;
- workspace and session paths;
- no-network policy;
- writable `.git` warning;
- `/usr` plus generically described administrator-approved read-only runtime mounts, without exposing host mount paths;
- remote-model disclosure warning;
- lack of CPU/memory/disk denial-of-service isolation.

### T8.5 Add conversation badge

Add an always-visible **Sandboxed** or **Unrestricted** badge to `ConversationHeader`, sourced only from `ConversationState.securityProfile`. Add accessible text, high-contrast styles, and browser/unit coverage.

### Phase 8 exit criterion

All three server modes, stored/effective differences, busy updates, downgrade confirmation, blocked reasons, badges, and warnings are covered by reducer/component and Playwright tests.

## 14. Phase 9 — Documentation, deployment, CI, and hardening

### T9.1 Update operator documentation

Update `README.md`, `.env.example`, and add `docs/bubblewrap-operations.md` with:

- Bubblewrap/Node/kernel requirements and installation;
- all environment variables and JSON examples;
- required-mode roots requirement;
- synthetic-root/toolchain compatibility;
- no package network access;
- remote model disclosure;
- writable workspace/`.git` and hook/build-script risk;
- socket prohibition and race limitation;
- extension/provider compatibility;
- data/Pi overlap deployment trap;
- disabled/optional/required rollout and failure behavior;
- private diagnostic fields and troubleshooting probe failures;
- explicit statement that Bubblewrap is not authentication or resource quota enforcement.

Reconcile the older LAN deployment text with the current mTLS/reverse-proxy deployment: recommend loopback binding or firewall isolation and state that all accepted clients retain full ChatWCA authority.

### T9.2 Harden the systemd unit

Test and document a unit with:

- `NoNewPrivileges=true` if compatible with unprivileged user namespaces;
- `KillMode=control-group`;
- a process-wide `TasksMax` defense-in-depth value;
- a stop timeout consistent with ChatWCA's bounded shutdown;
- no `PrivateUsers`/namespace restriction that prevents Bubblewrap.

Do not claim these are per-conversation cgroup limits.

### T9.3 Add dedicated Linux sandbox CI

Keep the existing default-mode suite. Add a sandbox-capable Linux job that installs Bubblewrap and ripgrep and must fail, not skip, if namespace/probe tests cannot run. Jobs not declared sandbox-capable may skip only the marked real-Bubblewrap suite.

Run the sandbox integration suite both directly and under the provided systemd unit in deployment validation. Capture only redacted diagnostics in CI artifacts.

### T9.4 Run attack and concurrency tests

Cover the full design matrix:

- relative, absolute, `..`, symlink, rename, and mutation-alias escapes;
- SQLite/WAL/SHM, Pi credentials, global/local sessions, parent environment, `/proc`, and canary reads;
- IPv4/IPv6/DNS/loopback and Unix socket admission;
- workspace/source modification and `.git` functionality;
- read-only toolchain use and write rejection;
- malformed IPC and compromised worker behavior;
- output floods and slow parent reads;
- fork bombs/large allocation tests only in isolated CI, verifying cleanup but not claiming quota protection;
- concurrent profiles and multiple sandboxed workers;
- remote faux provider success through the parent.

### Phase 9 exit criterion

The acceptance criteria in `docs/bubblewrap-design.md` are each mapped to at least one automated test or a documented manual deployment check.

## 15. Planned file changes

```text
scripts/
└── build-sandbox-worker.mjs       # bundle dependency-free worker artifact

src/server/
├── sandbox/
│   ├── config.ts                  # mode, roots, mounts, limits, public projection
│   ├── admission.ts               # protected paths, .chatwca, bounded socket walk
│   ├── bwrap.ts                   # executable validation, argv/data-FD builder
│   ├── probe.ts                   # startup and handshake assertions
│   ├── protocol.ts                # parent schemas, frame codec, operation types
│   ├── worker-client.ts           # process/IPC lifecycle and flow control
│   ├── worker-controller.ts       # restart/fatal state for one runtime
│   ├── worker-entry.ts            # dependency-free child main
│   ├── worker-fs.ts               # guest paths, queues, fs/search/edit operations
│   ├── tools.ts                   # seven Pi-compatible app-owned tools
│   └── resources.ts               # strict loader/settings/context/system prompt
├── config.ts
├── database.ts
├── workspace-repository.ts
├── pi-runtime.ts
├── conversation-registry.ts
├── protocol.ts
└── index.ts

src/shared/
├── protocol.ts
└── errors.ts

src/web/src/
├── App.tsx
├── api/state.ts
├── components/WorkspaceForm.tsx
├── components/WorkspaceSidebar.tsx
├── components/ConversationHeader.tsx
└── app.css

tests/
├── unit/sandbox-*.test.ts
├── integration/sandbox-*.test.ts
├── browser/workspace-sandbox.spec.ts
└── fixtures/sandbox/hostile-worker.mjs
```

Existing test fakes for `PiRuntimeFactoryPort`, `ProtocolWorkspaceRepository`, workspace wire objects, and `ServerConfig` must be updated centrally to avoid unsafe `as` casts that omit policy.

## 16. Test gates by phase

After every phase run:

```sh
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
```

After UI phases also run:

```sh
npm run test:browser
```

On a sandbox-capable Linux host run the dedicated real-Bubblewrap suite and Pi SDK smoke test. Before release, run the complete suite under both:

```text
CHATWCA_SANDBOX_MODE=disabled
CHATWCA_SANDBOX_MODE=optional
CHATWCA_SANDBOX_MODE=required
```

Required mode must use approved temporary roots and must not rewrite stored workspace rows.

## 17. Release and rollback strategy

1. Ship with the existing default `CHATWCA_SANDBOX_MODE=disabled`.
2. Validate optional-mode startup probe and representative repositories on the production host.
3. Opt in selected workspaces and monitor only redacted phase/error codes, worker exits, restart outcomes, and command timeouts.
4. Move to required mode only after every production workspace is under approved roots and data/Pi directories do not overlap.
5. Operational rollback is an explicit server-mode change and restart. Stored sandbox requests remain stored; disabled mode shows them as policy-blocked rather than silently running unrestricted.

No rollback path may reinterpret a requested sandboxed workspace as unrestricted without an administrator changing policy and, where applicable, a browser-confirmed workspace downgrade.

## 18. Definition of done

Implementation is complete only when:

- schema version 3 persists requested profiles and mode-derived effective profiles;
- root, protected path, and live-runtime checks are server-enforced;
- optional/required startup executes the real functional probe before listening;
- every enabled sandboxed tool and assistant-supplied workspace image path uses the worker;
- the strict Pi runtime contains exactly seven app-owned tools and no arbitrary resources/extensions;
- parent credentials/environment/session stores are absent from the namespace;
- synthetic root, `.chatwca` mask, no-network policy, and read-only mounts pass integration probes;
- abort, timeout, failure, close, eviction, fork rollback, and shutdown leave no worker descendants or FDs;
- no sandbox failure path selects unrestricted tools;
- concurrent effective profiles remain isolated; and
- UI/operator text accurately communicates remote-provider disclosure, writable workspace/`.git`, compatibility limits, socket caveat, and missing resource quotas.
