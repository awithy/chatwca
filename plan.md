# Gondolin Workspace Sandboxing Implementation Plan

**Status:** Proposed

**Source research:** [`research.md`](research.md)

**Target:** Gondolin `0.12.0`, Pi SDK `0.84.3`, Node.js 24, Linux with QEMU/KVM

## 1. Goal

Add an opt-in workspace execution policy that routes Pi's coding tools through a Gondolin micro-VM while keeping model requests, credentials, ChatWCA metadata, and Pi session persistence in the trusted host process.

Each workspace will have these authoritative settings:

```ts
type SandboxNetworkPolicy = "none" | "allowlist" | "public-web";

interface WorkspaceSandboxSettings {
  sandbox: boolean;
  sandboxNetworkPolicy: SandboxNetworkPolicy;
  sandboxNetworkAllowedHosts: string[];
}
```

Defaults for all existing and newly created workspaces are:

```ts
{
  sandbox: false,
  sandboxNetworkPolicy: "none",
  sandboxNetworkAllowedHosts: [],
}
```

For a sandboxed workspace, ChatWCA will:

- create at most one lazy Gondolin VM for each live conversation runtime;
- mount the host workspace read/write at `/workspace`;
- hide `/.chatwca` from the guest;
- route `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, and user-bash execution into the VM;
- disable untrusted/discovered Pi extensions and project resources in the sandboxed runtime;
- pass only a small fixed environment into guest commands;
- enforce the selected HTTP/TLS network policy;
- block private/internal network ranges and WebSockets in every mode;
- never fall back to host tools if VM startup or execution fails; and
- close or invalidate the VM on runtime disposal, abort, command timeout, replacement, eviction, and shutdown.

## 2. V1 policy decisions

### 2.1 Workspace-level policy

Sandbox and network settings apply to every conversation in a workspace. A closed conversation uses the workspace's current policy when reopened. A live conversation retains the policy with which its runtime was created.

Changing the workspace path, sandbox mode, network mode, or allowlist is rejected while the workspace owns any live runtime. Name-only updates remain allowed. Forks and rewinds inherit the source workspace policy.

Per-conversation overrides are out of scope for v1. If added later, the workspace policy should become the default copied into new conversations.

### 2.2 Network modes

- `none`: no guest HTTP/TLS egress; Gondolin receives `allowedHosts: []`.
- `allowlist`: guest HTTP/TLS egress only to the workspace's normalized exact-host allowlist.
- `public-web`: guest HTTP/TLS egress to public destinations; Gondolin receives `allowedHosts: ["*"]`.

All modes retain:

- `blockInternalRanges: true`;
- synthetic DNS;
- `allowWebSockets: false`;
- no SSH egress;
- no mapped TCP egress;
- no ingress; and
- no guest-visible host credentials.

V1 allowlist entries are exact DNS hostnames, not wildcard patterns. Permit only standard HTTP and HTTPS ports in v1. Gondolin must reapply host and IP policy after redirects and host-side DNS resolution.

An allowed host can receive any data readable in the workspace. The allowlist is destination control, not data-loss prevention.

### 2.3 Allowlist normalization

Create one server-owned normalization function and use it at every repository/protocol boundary. It will:

- trim whitespace;
- remove a terminal DNS root dot;
- convert Unicode names with `domainToASCII()`;
- lowercase the result;
- reject empty values, schemes, paths, queries, fragments, userinfo, ports, wildcard characters, IP literals, `localhost`, malformed labels, and names over 253 bytes;
- reject labels over 63 bytes or with invalid leading/trailing hyphens;
- deduplicate and sort the canonical result; and
- enforce at most 64 hosts per workspace.

`allowlist` requires at least one host. `none` and `public-web` require an empty host list. When `sandbox` is false, the network policy must be `none` with an empty host list.

### 2.4 Filesystem boundary

The workspace is writable. Sandbox mode protects the host outside the workspace; it does not protect workspace content from modification or deletion.

The VFS provider stack is:

```text
ShadowProvider
  └── RealFSProvider(<canonical workspace path>)
```

The mandatory shadow predicate hides `/.chatwca` and all descendants with `writeMode: "deny"` and symlink-bypass protection enabled. V1 will not claim to hide arbitrary workspace secrets such as `.env`; those files remain readable unless a separate product policy is introduced.

### 2.5 Trusted host resources

For sandboxed runtimes, disable all automatically discovered extensions, skills, prompt templates, themes, context files, project settings, project system prompts, and appended system prompts. Inject only the ChatWCA-owned inline Gondolin extension.

This intentionally trades feature compatibility for a defensible boundary. Provider/model resolution continues through the process-wide host `ModelRuntime`. A later trusted-resource allowlist can restore selected global resources after a separate security review.

### 2.6 VM lifecycle and abort policy

The VM starts before the first prompt is accepted, so startup failures are visible as a correlated ChatWCA error rather than a tool failure after model work has begun. VM startup remains lazy: merely listing history or opening a conversation does not boot a VM.

A prompt abort or guest command timeout invalidates and closes the VM. It must not be reused or restarted during the same agent run. A later prompt may lazily create a clean VM. Workspace writes already completed before invalidation remain on the host.

## 3. Architecture

```text
Browser
  -> WebSocket workspace policy commands
  -> ChatWCA host
       -> SQLite workspace policy
       -> process-wide Pi ModelRuntime and provider credentials
       -> host Pi JSONL session storage
       -> ConversationRegistry
            -> PiConversationRuntime
                 -> SandboxController (sandboxed workspaces only)
                      -> SandboxVmPool capacity lease
                      -> Gondolin VM
                           -> /workspace VFS mount
                           -> mediated HTTP/TLS policy
                 -> trusted inline Pi extension
                      -> approved tool overrides
```

Introduce a trusted runtime input rather than inferring policy from `process.cwd()`:

```ts
interface ConversationWorkspace {
  id: string;
  path: string;
  sessionDirectory: string | null;
  sandbox: boolean;
  sandboxNetworkPolicy: SandboxNetworkPolicy;
  sandboxNetworkAllowedHosts: readonly string[];
}
```

Change the runtime factory to receive this object for both create and open operations. The browser never supplies a CWD, session path, mount, or runtime policy directly; the repository-resolved workspace remains authoritative.

## 4. Phase 0 — Mandatory implementation spike

Do not land the persistent schema or UI until this phase passes on the production host.

### T0.1 Standardize Node and install Gondolin in an isolated spike

- Change the development shell to Node 24.
- Install `@earendil-works/gondolin@0.12.0` in an isolated branch or spike directory.
- Confirm `npm ci`, TypeScript, and the pinned Pi SDK work together under Node 24.
- Record the actual QEMU binary, accelerator, VM kernel/rootfs versions, and cache paths.

### T0.2 Prove the VM boundary

Using a temporary host workspace:

- boot with QEMU/KVM and verify KVM rather than TCG is active;
- mount the workspace at `/workspace` and verify write-through;
- verify host paths outside the workspace cannot be read or written;
- test relative paths, absolute host paths, `..`, symlinks, hard links, rename operations, and concurrent path replacement;
- hide `/.chatwca` with `ShadowProvider` and test reads, writes, listings, rename, and symlink aliases;
- verify `allowedHosts: []` denies egress;
- verify an exact-host allowlist permits only its destination;
- verify public-web reaches a public HTTP/TLS endpoint;
- verify redirects, DNS rebinding defenses, IP literals, private ranges, alternate ports, raw TCP, SSH, and WebSockets cannot bypass policy;
- verify `vm.close()` removes the QEMU process and session sockets; and
- test startup and close failure behavior.

### T0.3 Inventory realistic guest tooling

Run a representative ChatWCA repository workflow in the default guest image:

- inventory shell, Git, Node/npm, Python, compilers, certificates, and common utilities;
- run install/build/typecheck/test operations under the intended network modes;
- determine whether host `node_modules` is usable or must be shadowed/recreated;
- measure cold and warm boot times, resident memory, CPU use, and disk/cache use; and
- determine which guest-root changes survive VM recreation.

If the default image cannot support representative coding workflows, stop and decide on a custom rootfs, dependency cache, or narrower product promise before continuing.

### T0.4 Prove the Pi adapter

Adapt Pi's pinned Gondolin example with an explicit host workspace and a fake provider:

- exercise all seven approved built-in tools and user-bash routing;
- preserve built-in result shapes, streaming, truncation, and edit diff details;
- verify the final model-visible system prompt uses `/workspace` and contains no host workspace path;
- set `exposeSessionEnvironment: false` for bash;
- place canary provider credentials and unrelated secrets in `process.env` and prove they are absent in the guest;
- prove sandboxed resource loading does not execute a malicious project extension or read symlinked project context outside the workspace;
- verify prompt abort and command timeout invalidate the VM; and
- verify runtime replacement and `session_shutdown` close the old VM.

**Phase 0 exit criteria:** the host boundary, realistic toolchain, network policy, secret isolation, Pi tool shapes, and deterministic cleanup are demonstrated. Any failed criterion blocks the remaining phases.

## 5. Phase 1 — Runtime and dependency foundation

### T1.1 Raise the Node.js minimum

Update:

- `package.json` engines to Node `>=24`;
- `.github/workflows/ci.yml` to a pinned Node 24 release;
- `docs/design.md`, `README.md`, and deployment documentation;
- local version-manager files if added; and
- the Pi SDK smoke-test expectations.

Run the complete existing suite before adding sandbox behavior to establish that the Node upgrade is behavior-neutral.

### T1.2 Add the Gondolin dependency

- Add exact dependency `@earendil-works/gondolin@0.12.0` and update `package-lock.json`.
- Do not download guest assets during package installation or ordinary tests.
- Add an operator command such as `npm run sandbox:prefetch` that resolves assets or performs a controlled boot-and-close check.
- Document cache ownership, disk requirements, integrity verification provided by Gondolin, and offline deployment steps.

### T1.3 Add server resource configuration

Extend `src/server/config.ts` with bounded settings:

| Variable | Proposed default | Purpose |
|---|---:|---|
| `CHATWCA_MAX_LIVE_SANDBOX_VMS` | `4` | Maximum powered sandbox VMs |
| `CHATWCA_SANDBOX_MEMORY_MIB` | `1024` | Memory per VM |
| `CHATWCA_SANDBOX_CPUS` | `2` | vCPUs per VM |
| `CHATWCA_SANDBOX_START_TIMEOUT_MS` | `60000` | VM readiness deadline |

Validate safe integer ranges and translate memory to Gondolin's `memory` option. Keep these server-only; `/api/config` does not need host capacity details.

Add configuration unit tests and `.env.example` comments.

## 6. Phase 2 — Workspace policy persistence

### T2.1 Add shared policy schemas

In `src/shared/protocol.ts`:

- add `SandboxNetworkPolicySchema` and inferred type;
- add `sandbox`, `sandboxNetworkPolicy`, and `sandboxNetworkAllowedHosts` to `WorkspaceSchema` and `WorkspaceSummarySchema`;
- bound allowlist array and string sizes at the wire boundary;
- require all sandbox fields on `workspace.create`;
- allow them as a complete group on `workspace.update`;
- permit sandbox-only updates while still rejecting an update with no changes; and
- preserve `additionalProperties: false` on every command and response.

TypeBox provides structural bounds. Canonical host validation and cross-field consistency remain server-domain validation.

### T2.2 Migrate SQLite to schema version 3

Update `src/server/database.ts`:

```sql
ALTER TABLE workspaces
ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0
  CHECK (sandbox IN (0, 1));

ALTER TABLE workspaces
ADD COLUMN sandbox_network_policy TEXT NOT NULL DEFAULT 'none'
  CHECK (sandbox_network_policy IN ('none', 'allowlist', 'public-web'));

CREATE TABLE workspace_sandbox_network_hosts (
  workspace_id TEXT NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  host TEXT NOT NULL,
  PRIMARY KEY (workspace_id, host)
) WITHOUT ROWID;
```

Also enforce, either with a table-level check in a rebuilt table or repository validation, that an unsandboxed row cannot advertise network access.

Refactor migrations into an ordered chain:

- version 1 -> 2 adds `session_storage`;
- version 2 -> 3 adds sandbox policy and host table;
- a version 1 database runs both migrations transactionally in order;
- new databases are created directly at version 3; and
- unsupported future versions still fail startup.

Migration tests must prove all existing rows become unsandboxed with no network and no allowlist entries.

### T2.3 Add the policy normalization module

Add `src/server/sandbox/policy.ts` containing:

- allowlist normalization and validation;
- cross-field validation for sandbox/network combinations;
- conversion from persisted rows to an immutable runtime policy;
- conversion from policy to Gondolin `allowedHosts`; and
- constants for entry count and hostname length.

Return stable `AppError` values without exposing parser or local-system details.

### T2.4 Extend `WorkspaceRepository`

Update `src/server/workspace-repository.ts`:

- add the new columns to `WorkspaceRow` and all projections;
- load host rows and return a sorted canonical list;
- accept policy on create and update;
- validate before entering SQLite;
- insert a workspace and its allowlist in one transaction;
- replace the policy and host rows atomically on update;
- cascade host deletion when a workspace is removed;
- preserve policy on name/path-only updates; and
- ensure failed policy updates leave timestamps and host rows unchanged.

Add repository tests for defaults, every mode, canonicalization, duplicate removal, atomic replacement, invalid combinations, deletion cascade, reopening, and migration.

### T2.5 Add errors

Extend `src/shared/errors.ts` with at least:

- `invalid_sandbox_network_policy`;
- `sandbox_capacity`;
- `sandbox_unavailable`; and
- `sandbox_start_failed`.

Messages must be useful to the user but omit QEMU command lines, host paths, environment values, and raw Gondolin errors. Full causes remain server-side.

**Phase 2 exit criteria:** policy is safely migrated, validated, persisted, listed, and updated without constructing any VM.

## 7. Phase 3 — Gondolin adapter

Create a focused `src/server/sandbox/` module rather than embedding VM logic in `pi-runtime.ts`.

Suggested layout:

```text
src/server/sandbox/
├── policy.ts
├── vm-pool.ts
├── vm-controller.ts
├── path-mapping.ts
├── tool-operations.ts
└── extension.ts
```

### T3.1 Implement path mapping

Adapt the pinned Pi example's path mapping with these rules:

- relative paths resolve below `/workspace`;
- the canonical host workspace maps to `/workspace`;
- absolute host paths inside the workspace map to their guest equivalent;
- absolute host paths outside the workspace remain guest-absolute and never address the host;
- leading `@` normalization matches Pi built-ins; and
- host platform separators are converted to POSIX guest separators.

Unit-test normalization, boundaries with common prefixes, root paths, Unicode names, and Windows-like strings even though v1 deployment is Linux-only.

### T3.2 Implement the VM controller

`SandboxController` owns one lazy VM and a strict state machine:

```text
stopped -> starting -> ready -> stopping -> stopped
                    \-> error -> stopped on retry
```

Required behavior:

- coalesce concurrent startup calls;
- acquire VM-pool capacity before boot;
- create `createHttpHooks()` from the immutable workspace policy;
- create the protected workspace provider stack;
- set explicit CPU, memory, timeout, synthetic DNS, and WebSocket options;
- detect the guest shell without using host environment variables;
- expose status subscriptions for the registry/UI;
- make close and invalidate idempotent;
- clear partial state after failed startup;
- prevent stale startup promises from publishing a VM after disposal;
- hold a run lease for the full Pi prompt so the pool cannot evict a VM between tool calls;
- prevent VM recreation during a run invalidated by abort/timeout; and
- release capacity in every failure and close path.

Abstract VM construction behind a small injectable `GondolinVmFactory` so normal unit/integration tests do not require QEMU.

### T3.3 Implement VM capacity

`SandboxVmPool` tracks powered/starting VMs separately from live Pi runtimes.

- Enforce `CHATWCA_MAX_LIVE_SANDBOX_VMS` across all controllers.
- Count starting VMs so concurrent prompts cannot oversubscribe the host.
- Evict the least-recently-used powered VM only when its conversation has no active prompt/tool lease.
- Eviction closes only the VM, not the Pi runtime or session; the next prompt gets a clean guest.
- If every VM is active, reject startup with `sandbox_capacity`.
- Shutdown closes all registered controllers and waits within ChatWCA's existing global deadline.

Add deterministic tests for concurrent reservation, LRU ordering, active-run protection, release after startup failure, repeated close, and shutdown.

### T3.4 Implement protected VFS construction

Construct:

```ts
new ShadowProvider(new RealFSProvider(workspace.path), {
  shouldShadow: createShadowPathPredicate(["/.chatwca"]),
  writeMode: "deny",
  denySymlinkBypass: true,
});
```

Do not add optional `.env` hiding under the sandbox label in v1. Add focused tests against a fake provider and real gated VM tests for every supported VFS operation.

### T3.5 Implement network construction

Build hooks as follows:

```ts
const allowedHosts =
  policy === "none" ? [] :
  policy === "public-web" ? ["*"] :
  workspace.sandboxNetworkAllowedHosts;

const { httpHooks } = createHttpHooks({
  allowedHosts,
  blockInternalRanges: true,
  isRequestAllowed: standardHttpOrHttpsPortOnly,
});
```

Pass `httpHooks` and `allowWebSockets: false` to `VM.create()`. Do not configure `allowedInternalHosts`, SSH, mapped TCP, or ingress.

Test that an omitted allowlist can never accidentally become Gondolin's allow-all default.

### T3.6 Implement guest-safe tool operations

Adapt Pi's pinned example for:

- `ReadOperations`;
- `WriteOperations`;
- `EditOperations`;
- `BashOperations`;
- `FindOperations`;
- `LsOperations`; and
- grep traversal/results.

Requirements:

- preserve Pi's exact built-in schemas and result/detail shapes;
- preserve output streaming and 50KB/2000-line truncation behavior;
- pass abort signals through VFS and exec calls;
- invalidate the controller on bash timeout;
- never spread `process.env` or the `env` supplied to `BashOperations.exec`;
- use a fixed guest-safe environment determined by the spike;
- create bash with `exposeSessionEnvironment: false`; and
- never expose `PI_SESSION_FILE`, provider/model metadata, host `PATH`, proxy variables, or provider credentials.

### T3.7 Implement the trusted inline extension

`createGondolinExtension(controller, workspace)` will:

- register overrides for exactly `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`;
- route `user_bash` through the same safe bash operations;
- set the active tool list to the approved names;
- block any non-approved tool call as defense in depth;
- rewrite the model-visible working directory to `/workspace` without including the host path;
- avoid booting resources from the extension factory or `session_start`; and
- close the controller idempotently on `session_shutdown`.

The `PiConversationRuntime` owner will also close the controller directly during disposal; extension lifecycle events are not the sole cleanup mechanism.

**Phase 3 exit criteria:** the adapter is independently testable, contains no host fallback, and the only host filesystem provider points at the repository-resolved workspace.

## 8. Phase 4 — Pi runtime and registry integration

### T4.1 Harden sandboxed Pi resource loading

In `src/server/pi-runtime.ts`, construct sandboxed services with:

- `SettingsManager.create(cwd, agentDir, { projectTrusted: false })`;
- `noExtensions: true` plus the trusted inline `extensionFactories` entry;
- `noSkills: true`;
- `noPromptTemplates: true`;
- `noThemes: true`;
- `noContextFiles: true`;
- system-prompt override that ignores project prompt files;
- empty appended-system-prompt override; and
- an explicit approved tool list.

Apply security options after general injectable service/session options so tests or future callers cannot accidentally weaken them. Unsandboxed runtime construction remains unchanged.

Add a malicious-workspace integration fixture containing project extensions, settings, skills, prompts, `AGENTS.md` symlinks, and system-prompt files. Prove none are loaded or executed by a sandboxed runtime.

### T4.2 Change the runtime factory port

Replace positional CWD-only methods with policy-bearing inputs, for example:

```ts
createPersistent(workspace: ConversationWorkspace): Promise<PiConversationRuntimePort>;
openPersistent(
  workspace: ConversationWorkspace,
  sessionFile: string,
): Promise<PiConversationRuntimePort>;
```

The implementation still resolves/canonicalizes the CWD and session file independently and checks that the stored session CWD equals the workspace path.

Capture the workspace policy in the `createAgentSessionRuntime()` factory closure so every service reconstruction after fork/session replacement receives the same sandbox policy.

### T4.3 Thread policy through `ConversationRegistry`

Update `src/server/conversation-registry.ts`:

- extend `ConversationWorkspace` and `ConversationRecord` with immutable runtime policy;
- pass the full policy on create and open;
- pass the source policy when constructing temporary fork runtimes;
- compare policy as part of duplicate live-runtime ownership checks;
- preserve policy across replacement registration;
- dispose the controller on failed create/open/fork registration; and
- ensure close, LRU eviction, rewind, temporary-runtime failure, and shutdown all await sandbox cleanup.

Update all fake runtime factories and fixtures to use the new method signatures.

### T4.4 Expose runtime status

Add a revisioned sandbox-status projection:

```ts
type SandboxRuntimeStatus =
  | "disabled"
  | "stopped"
  | "starting"
  | "ready"
  | "stopping"
  | "error";
```

- Add `sandboxStatus` to `ConversationState`.
- Add a `conversation.sandbox-status` event to the shared protocol.
- Let `PiConversationRuntimePort` expose current status and a status subscription.
- Have the registry bridge controller changes into normal revision sequencing.
- Unsubscribe before disposal and ignore late status notifications.

### T4.5 Fail prompt startup closed

Before forwarding a sandboxed prompt to Pi:

- acquire the prompt/run lease;
- start the VM;
- reject with `sandbox_capacity`, `sandbox_unavailable`, or `sandbox_start_failed` if preparation fails;
- do not call `session.prompt()` on failure; and
- never construct or invoke host built-in tools as a fallback.

The existing preflight acknowledgement semantics remain unchanged after successful VM preparation.

### T4.6 Abort and timeout behavior

For sandboxed runtimes:

- call Pi abort;
- invalidate and close the current VM even if Pi abort resolves first;
- keep the current run generation invalid so subsequent tool calls in that run fail;
- return the conversation to a reusable state only after the run settles; and
- allow the next prompt to boot a clean VM.

Add races for abort-during-start, abort-during-exec, close-after-abort, shutdown-during-start, and replacement-during-cleanup.

### T4.7 Wire startup ownership

In `src/server/index.ts`:

- construct one process-wide `SandboxVmPool` from server configuration;
- inject it into `PiRuntimeFactory`;
- include it in startup failure unwinding and graceful shutdown;
- keep server startup independent of QEMU when no VM is requested; and
- ensure database/listener cleanup still runs if sandbox infrastructure construction fails.

**Phase 4 exit criteria:** create/open/fork/rewind consistently inherit policy, first prompt starts safely, every lifecycle path closes VMs, and unsandboxed behavior remains unchanged.

## 9. Phase 5 — Protocol dispatch and UI

### T5.1 Dispatch workspace policy commands

Update `src/server/protocol.ts`:

- pass all sandbox fields on create;
- pass the complete policy group on update;
- reject path or policy changes when `registry.hasLiveWorkspace()` is true;
- continue allowing name-only updates while live;
- return and broadcast authoritative normalized workspace values; and
- preserve safe error mapping.

Add protocol tests proving malformed or inconsistent settings never reach the repository.

### T5.2 Extend workspace creation/editing

Update `WorkspaceForm.tsx`, `WorkspaceSidebar.tsx`, and `App.tsx`:

- add a default-disabled **Sandbox this workspace** checkbox;
- when enabled, show radio/select choices for **No network**, **Allowed hosts**, and **Public web**;
- show a one-host-per-line allowlist editor for `allowlist`;
- validate obvious empty/duplicate/malformed entries client-side while treating server normalization as authoritative;
- reset network mode to `none` and clear hosts when sandbox is disabled;
- submit complete sandbox policy on create and edit;
- permit policy editing but show the server's live-runtime constraint;
- warn that the workspace remains writable; and
- warn that allowlisted/public destinations can receive all workspace-readable data.

Do not allow session-storage policy to become editable.

### T5.3 Show effective policy

In Workspace Info, display:

- sandbox enabled/disabled;
- network mode;
- canonical allowed hosts when applicable;
- `/workspace` as the guest mount; and
- a concise boundary statement.

In `ConversationHeader.tsx`, add accessible badges for:

- **Sandboxed**;
- **No network**, **N allowed hosts**, or **Public web**; and
- current VM status when starting/error is relevant.

The host workspace path may remain visible to the human in ChatWCA; it must not be inserted into the model-visible sandbox prompt.

### T5.4 Handle status and failures in the web client

Update client schemas/reducer/state tests to:

- consume `sandboxStatus` snapshots and revisioned events;
- show a starting state while the first prompt prepares the VM;
- preserve a user's draft if startup fails;
- show stable sandbox/capacity errors;
- avoid presenting a failed prompt as accepted; and
- reconcile status correctly after reconnect.

Update the browser fixture server with safe defaults and simulated start/failure/status transitions; browser CI must not require QEMU.

**Phase 5 exit criteria:** users can create and edit all three network modes, see authoritative normalized policy, and understand when the VM is starting or failed.

## 10. Phase 6 — Testing and hardening

### T6.1 Unit tests

Add or update tests for:

- Node/config bounds and defaults;
- database v1 -> v2 -> v3 and v2 -> v3 migration;
- workspace policy CRUD and atomic allowlist replacement;
- hostname normalization, IDNA, limits, malformed inputs, duplicates, and cross-field consistency;
- closed TypeBox command/response schemas;
- protocol live-runtime update rejection;
- path translation and host-path redaction;
- fixed guest environment construction;
- network hook construction for all modes;
- VM controller startup/close/invalidation races;
- VM-pool capacity and LRU behavior;
- registry policy ownership and fork inheritance;
- sandbox-status revisions;
- UI form accessibility, warnings, info, badges, and reducer behavior; and
- unchanged unsandboxed runtime behavior.

### T6.2 QEMU-free integration tests

Use a fake `GondolinVmFactory` and Pi's faux provider to verify:

- sandboxed create/open/fork/rewind receives approved tools;
- startup failure occurs before prompt acceptance;
- no host fallback occurs;
- all effective tools are from the approved set;
- malicious discovered resources do not load;
- process-environment canaries do not enter VM exec options;
- abort/timeout invalidates the VM;
- runtime replacement closes the prior VM generation;
- LRU conversation eviction releases VM capacity; and
- graceful shutdown closes every controller.

### T6.3 Gated real-Gondolin tests

Add an opt-in suite, such as `npm run test:gondolin`, guarded by an explicit environment variable and not run on ordinary browser/unit CI. It must cover:

- actual KVM boot and accelerator selection;
- workspace write-through;
- outside-workspace and symlink escape denial;
- `/.chatwca` shadowing for every relevant operation;
- environment-secret canaries;
- all seven Pi tools and user bash;
- no-network, exact allowlist, and public-web modes;
- redirects/internal ranges/WebSocket/raw protocol denial;
- abort and timeout process cleanup;
- concurrent VM capacity behavior; and
- no QEMU process or socket remaining after close and shutdown.

Run this suite in a dedicated deployment-host preflight job where `/dev/kvm` and network test fixtures are controlled.

### T6.4 Browser tests

Extend Playwright coverage for:

- safe defaults on workspace creation;
- allowlist editing and validation;
- public-web warning;
- policy persistence and Workspace Info;
- policy update rejection while a conversation is live;
- header badges and starting/ready/error states;
- draft preservation after sandbox startup failure; and
- unsandboxed workspace UI and behavior.

### T6.5 Security review checklist

Before release, manually verify:

- no code path passes `process.env` to Gondolin;
- no sandboxed path creates local Pi tools;
- no untrusted extension factory/module is loaded first and filtered later;
- project settings/context are not read through symlinks;
- `allowedHosts` is always explicit, including `[]` for `none`;
- redirects and every resolved IP are policy checked;
- WebSockets, SSH, mapped TCP, and ingress remain disabled;
- logs and public errors contain no secrets or raw provider errors;
- `.chatwca` cannot be reached by alias, rename, or symlink; and
- every VM owner has a bounded, idempotent cleanup path.

## 11. Phase 7 — Documentation and deployment

### T7.1 Update product documentation

Update `README.md` and `docs/design.md` to describe:

- Node 24 and Linux/QEMU/KVM requirements;
- the per-conversation VM ownership model;
- workspace/network settings and defaults;
- disabled project resources in sandbox mode;
- writable-workspace limitations and persistent code poisoning risk;
- allowlist/public-web exfiltration implications;
- first-run asset size and cache location;
- resource configuration and VM capacity;
- guest toolchain limitations; and
- the distinction between guest command egress and any future host-side web-search tool.

### T7.2 Add deployment readiness tooling

Provide an operator preflight command that checks:

- Node version;
- QEMU availability/version;
- `/dev/kvm` access and group membership;
- Gondolin asset availability/cache writability;
- one boot/exec/close cycle;
- effective accelerator;
- no leaked QEMU process; and
- configured memory/capacity totals.

Production deployment should prefetch verified assets before accepting sandboxed workspaces. Do not rely on a user's first prompt to download runtime assets.

### T7.3 Rollout

- Keep sandbox disabled by default for every migrated and new workspace.
- Deploy Node/QEMU/assets first.
- Run the gated host preflight and realistic repository workflow.
- Release workspace policy/UI second.
- Initially enable sandbox on a small number of workspaces and monitor boot latency, memory, cleanup failures, and capacity errors.
- Do not automatically convert existing workspaces to sandboxed execution.

## 12. Out of scope for v1

- Per-conversation policy overrides
- Raw unrestricted NAT
- WebSockets, UDP, SSH egress, mapped TCP, or guest ingress
- Guest access to host SSH agents or cloud credentials
- Authenticated guest services through secret placeholders
- A trusted global/project extension allowlist
- File rollback, snapshots, or copy-on-write workspaces
- Hiding arbitrary workspace secret patterns
- Multi-host scheduling or horizontal scaling
- Non-Linux production support

## 13. Acceptance criteria

The feature is complete when:

- existing databases migrate to `sandbox: false`, network `none`, and an empty allowlist;
- workspace create/list/update persist and return canonical sandbox policy;
- policy/path changes are rejected while the workspace has a live runtime;
- unsandboxed workspaces retain current host-tool behavior;
- sandboxed create/open/fork/rewind expose only approved VM-backed tools;
- the model sees `/workspace` and never the host workspace path;
- provider credentials, Pi session paths, proxy variables, and unrelated process environment values are absent in the guest;
- `/.chatwca` and every host path outside the workspace are inaccessible;
- `none`, exact-host `allowlist`, and `public-web` work as documented while internal ranges and disabled protocols remain blocked;
- VM startup, capacity, and readiness are visible and fail without host fallback;
- abort and timeout discard the current VM before the conversation can be reused;
- close, replacement, fork failure, LRU eviction, startup unwind, and graceful shutdown leave no QEMU process or socket behind;
- VM count, CPU, and memory are explicitly bounded;
- ordinary CI passes without QEMU, and the gated real-Gondolin suite passes on the deployment host;
- the UI clearly states that workspace files remain writable and network-enabled modes permit data exfiltration; and
- deployment documentation includes Node 24, KVM, asset prefetch, cache, and resource requirements.
