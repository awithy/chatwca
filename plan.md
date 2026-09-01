# Optional Slirp4netns Network Access Implementation Plan

**Status:** Proposed

**Design:** [`docs/slirp4netns-design.md`](docs/slirp4netns-design.md)

**Baseline:** Node.js 22.19+, Bubblewrap 0.6.1+, slirp4netns 1.0.1+, Pi SDK 0.84.3, Linux

## 1. Objective and release boundary

Add an independent network policy to `workspace-sandboxed` runtimes:

```ts
type SandboxNetworkPolicy = "isolated" | "unrestricted-egress";
```

`isolated` must preserve the current Bubblewrap behavior and remain the default. `unrestricted-egress` must keep the worker in its private network namespace and attach one per-runtime slirp4netns sidecar. It grants unfiltered outbound access to any destination reachable through the host; it is not an Internet-only policy.

The sidecar is part of the same fail-closed runtime as Bubblewrap. No API socket, inbound forwarding, host network namespace sharing, proxy inheritance, or credential inheritance is added. Pi model/provider traffic remains in the parent.

Destination filtering, traffic inspection, quotas, stable guest addresses, proxy configuration, inbound forwarding, and protocol-completeness guarantees remain out of scope.

## 2. Non-negotiable invariants

1. New and migrated workspaces store `isolated`; the administrator must explicitly permit `unrestricted-egress`.
2. A runtime receives policy only from `WorkspaceRepository.requireUsable()`, never from a conversation command or persisted Pi session.
3. `ConversationState.sandboxNetworkPolicy` is immutable runtime state: `null` for unrestricted runtimes and the effective policy for sandboxed runtimes.
4. Isolated launch remains sidecar-free and retains its current IPv4, IPv6, DNS, and loopback failure checks.
5. A network-enabled worker cannot execute or complete its nonce handshake until slirp4netns reports ready.
6. Every conversation worker, replacement worker, fork runtime, and rewind runtime gets a distinct sidecar and namespace.
7. Bubblewrap and slirp4netns are one failure domain. Startup or runtime failure never falls back to isolation, host networking, or unrestricted Pi tools.
8. slirp4netns receives only its namespace, ready, exit, and diagnostic descriptors; it receives no worker IPC, workspace mount, database handle, provider secret, or control socket.
9. The sidecar argv is shell-free and never contains `--api-socket` or a forwarding operation. `--disable-host-loopback` is defense in depth, not a destination boundary.
10. Abort, timeout, fatal exit, close, eviction, failed fork, failed startup, and shutdown dispose both processes and all inherited descriptors.
11. Public errors and `/api/config` expose no executable path, PID, namespace path, guest address, resolver detail, CA path, argv, or stderr.
12. UI and prompt text say **Unrestricted egress** and explicitly mention reachable private, LAN, VPN, link-local, and metadata services.

## 3. Current implementation impact

The Bubblewrap implementation already provides the core ownership model, but it currently assumes one child and one fixed no-network probe:

- `src/server/sandbox/config.ts` has no network-policy ceiling or slirp/CA settings.
- `src/server/sandbox/bwrap.ts` uses fixed data/protocol FDs and always builds an isolated `/etc` and environment.
- `src/server/sandbox/worker-client.ts` directly spawns and signals only Bubblewrap.
- `src/server/sandbox/worker-controller.ts` restarts one worker and maps failures only to worker errors.
- `src/server/sandbox/probe.ts` and `worker-entry.ts` require all networking to fail and currently probe third-party addresses/names.
- `src/server/database.ts` is schema version 3.
- `src/server/workspace-repository.ts` stores only the filesystem profile.
- `src/server/pi-runtime.ts` and `conversation-registry.ts` carry only `securityProfile` as immutable runtime policy.
- Shared/server protocol and browser forms have no requested/effective network fields.
- `SandboxResourceLoader` has one network-isolated system prompt.

Extend these ownership points rather than creating a parallel runtime stack.

## 4. Target types and ownership

Extend the trusted runtime descriptor:

```ts
interface RuntimeWorkspacePolicy {
  workspaceId: string;
  cwd: string;
  sessionDirectory: string | null;
  securityProfile: WorkspaceSecurityProfile;
  sandboxNetworkPolicy: SandboxNetworkPolicy | null;
}
```

The repository computes `sandboxNetworkPolicy` as follows:

- effective filesystem profile `unrestricted` => `null`;
- effective filesystem profile `workspace-sandboxed` and stored policy permitted => stored policy;
- effective filesystem profile `workspace-sandboxed` and stored policy not permitted => policy blocked with `sandbox_network_policy_disabled`.

Do not silently rewrite a stale stored policy. Required sandbox mode applies the same network ceiling after deriving the effective filesystem profile.

Use this runtime ownership shape:

```text
PiConversationRuntime
  -> SandboxController
       -> SandboxWorkerClient (framed IPC)
            -> SandboxNetworkController
                 -> Bubblewrap process
                 -> optional slirp4netns process
                 -> info/startup-gate/ready/exit/namespace descriptors
                 -> separate bounded diagnostics
```

`SandboxController` continues to be the stable tool-facing object. Every restart invokes the same factory with the runtime's immutable network policy.

## 5. Phase 0 — Prove the launch mechanics

Complete a focused Linux spike before changing persistence or UI. Add it to `scripts/` or an integration fixture and record the exact supported invocation in network operations documentation.

### T0.1 Bubblewrap startup gate and info pipe

Using Node `spawn()` and dedicated `stdio` entries, prove that Bubblewrap 0.6.1:

- emits one bounded JSON object through `--info-fd` containing `child-pid`;
- remains blocked at `--block-fd` before the worker command executes;
- releases only after the parent writes the documented gate byte;
- closes or otherwise delimits the info object without requiring Bubblewrap to exit; and
- fails cleanly if the parent closes the gate during startup.

The production parser must accept one UTF-8 JSON object within a small fixed limit, reject missing/duplicate/trailing data, and enforce the existing start timeout.

### T0.2 Race-safe namespace attachment

Use the minimum slirp4netns path-mode support rather than relying on a reusable PID:

1. Validate `child-pid` as a positive integer and a descendant of the launched Bubblewrap process using `/proc/<pid>/status` ancestry.
2. Record `/proc/<pid>/stat` start time and namespace inode identities.
3. Open and retain stable descriptors for `/proc/<pid>/ns/net` and `/proc/<pid>/ns/user`.
4. Verify the network namespace differs from the parent and still belongs to the validated process instance.
5. Pass only those descriptors to slirp4netns and use:

```text
--netns-type=path
--userns-path=/proc/self/fd/<userns-fd>
/proc/self/fd/<netns-fd>
```

Revalidate process start time and namespace inode identity around sidecar spawn/readiness. If descriptor-backed path attachment cannot be made reliable on the supported versions, stop the implementation; do not fall back to an unverified PID.

### T0.3 Sidecar readiness and teardown

Prove `--ready-fd`, `--exit-fd`, `--configure`, `--disable-host-loopback`, `--enable-sandbox`, and `--enable-seccomp` under the supplied systemd unit. Verify that:

- readiness occurs before releasing Bubblewrap;
- closing the parent exit-pipe end stops slirp4netns;
- `SIGTERM` then `SIGKILL` handles a stuck sidecar;
- killing either member leaves no worker, sidecar, TAP, namespace, or descriptor behind; and
- no API socket or forwarding rule is created.

### Phase 0 exit criterion

Do not proceed unless path-mode namespace pinning, startup ordering, sidecar sandbox/seccomp flags, and complete cleanup work both directly and under `systemd/chatwca.service`.

## 6. Phase 1 — Configuration and host validation

### T1.1 Parse network policy and settings

Extend `src/server/sandbox/config.ts` with:

- `CHATWCA_SANDBOX_NETWORK_POLICIES`, default `["isolated"]`;
- `CHATWCA_SLIRP4NETNS_PATH`, default `/usr/bin/slirp4netns`;
- `CHATWCA_SANDBOX_NETWORK_MTU`, default `1500`, inclusive range `1280..65521`;
- `CHATWCA_SANDBOX_ENABLE_IPV6`, default `false`, with strict boolean syntax; and
- `CHATWCA_SANDBOX_CA_BUNDLE`, default `/etc/ssl/certs/ca-certificates.crt`.

For the policy array, reject malformed JSON, empty arrays, non-strings, duplicates, unknown values, and omission of `isolated`. Parse the policy array in all modes. Keep slirp, MTU, IPv6, and CA values inert—without stat, version, or file reads—when `unrestricted-egress` is not permitted.

Represent unrestricted-egress settings as a nested immutable config object so call sites cannot accidentally inspect or use them when disabled.

### T1.2 Validate and snapshot slirp4netns

Create `src/server/sandbox/slirp.ts` containing:

- secure executable validation equivalent to Bubblewrap validation: canonical absolute regular file, root owner, executable by the service user, no group/other write bits;
- semantic version parsing requiring 1.0.1+;
- bounded `--help` validation for every required flag, including path namespace support;
- private parsing/log projection for slirp4netns and linked libslirp versions;
- a pure exact argv builder with no shell, API socket, or forwarding option; and
- sidecar spawn helpers using `env: {}`, a safe non-workspace CWD, ignored stdin/stdout, bounded private stderr, and an explicit FD map.

Version/help checks supplement, but do not replace, the functional launch probe.

### T1.3 Validate and snapshot the CA bundle

When unrestricted egress is active:

- canonicalize the configured CA path;
- require a root-owned regular file with no group/other writes;
- reject a snapshot larger than a named fixed limit (use 16 MiB initially);
- read it once during startup, hash it for private diagnostics, and retain the immutable `Buffer` for the process lifetime.

The validated host-network object should contain the canonical slirp path, private version metadata, and CA bytes/hash. It must not be returned by `/api/config`. Replacing the source file takes effect only after restart.

### T1.4 Public configuration

Extend `PublicSandboxConfig` in `src/shared/protocol.ts` and `publicSandboxConfig()` with only:

- selectable sandbox network policies;
- whether unrestricted-egress IPv6 is enabled; and
- fixed warning text describing unrestricted reachable destinations and exfiltration risk.

Retain the existing filesystem sandbox mode/profile/probe fields. Filter browser choices through both filesystem sandbox availability and the network ceiling without exposing host details.

## 7. Phase 2 — Persistence, protocol, and repository policy

### T2.1 Database schema version 4

In `src/server/database.ts`:

- advance `DATABASE_SCHEMA_VERSION` to `4`;
- include `sandbox_network_policy TEXT NOT NULL DEFAULT 'isolated'` with the exact CHECK constraint in fresh databases;
- add a transaction-safe 3-to-4 migration;
- retain chained 1-to-2-to-3-to-4 migration support; and
- update `user_version` only after each successful migration.

Add tests for fresh schema, every supported migration path, defaulting existing rows to isolated, rollback, and invalid stored values.

### T2.2 Shared wire contract

In `src/shared/protocol.ts` add:

- `SandboxNetworkPolicySchema` and type;
- `sandboxNetworkPolicy` and `effectiveSandboxNetworkPolicy` to workspace projections;
- `sandbox_network_policy_disabled` to `WorkspacePolicyIssue`;
- immutable `sandboxNetworkPolicy` to `ConversationState`, nullable only for unrestricted runtimes;
- required `sandboxNetworkPolicy` on `workspace.create`; and
- optional `sandboxNetworkPolicy` plus `acknowledgeNetworkExposure: true` on legal `workspace.update` variants.

Keep the TypeBox objects closed. Generate or explicitly enumerate update variants so security-profile acknowledgement and network-exposure acknowledgement can coexist only when each requested transition requires it. Reject acknowledgement fields on no-op or protection-increasing updates.

### T2.3 Repository evaluation and CRUD

Extend `WorkspaceRow`, SQL statements, workspace types, and `WorkspacePolicyInputs` in `src/server/workspace-repository.ts`.

Repository rules:

- validate stored network values when reading rows;
- create with the browser-supplied policy, with isolated as the trusted legacy-call fallback only;
- expose stored and effective values on every summary;
- apply the administrative ceiling when the effective filesystem profile is sandboxed;
- return `sandbox_network_policy_disabled` and throw `SANDBOX_NETWORK_POLICY_DISABLED` from `requireUsable()` rather than substituting another policy;
- require `acknowledgeNetworkExposure: true` for `isolated -> unrestricted-egress` updates;
- reject stray acknowledgement values;
- preserve the independent existing acknowledgement for `workspace-sandboxed -> unrestricted`; and
- return the effective nullable network policy in `RuntimeWorkspacePolicy`.

Add a policy-matrix test spanning disabled/optional/required sandbox modes, both security profiles, both network policies, and allowed/disallowed ceilings.

### T2.4 Server command handling and errors

In `src/server/protocol.ts`:

- pass both fields and acknowledgement flags to repository CRUD;
- treat path, filesystem profile, or network-policy changes as `workspace_busy` when a live runtime belongs to the workspace;
- continue allowing name-only updates; and
- keep fork/rewind free of browser policy input and resolve the destination workspace immediately before runtime construction.

Add the four public errors to `src/shared/errors.ts`:

- `sandbox_network_policy_disabled`;
- `sandbox_network_configuration_error`;
- `sandbox_network_start_failed`; and
- `sandbox_network_failed`.

Extend sandbox error context mapping while preserving generic client-safe messages. Network configuration errors are startup-fatal when the feature is active; ordinary tool connection failures remain command output.

## 8. Phase 3 — Bubblewrap guest profile and worker probe

### T3.1 Centralize FD allocation

Refactor `src/server/sandbox/bwrap.ts` to use one documented, collision-free FD layout. Keep worker request/response FDs stable unless the bundled worker is changed in the same commit. Allocate separate conditional FDs for:

- worker and minimal `/etc` data;
- generated `resolv.conf`;
- CA snapshot;
- Bubblewrap info output;
- Bubblewrap startup gate; and
- worker request/response IPC.

Make `BwrapLaunchSpecification` describe optional info/gate FDs and all inherited payloads. Tests must assert that no FD is reused and that the production `stdio` array exposes only intended descriptors.

### T3.2 Build policy-specific guest files and environment

Change `buildBwrapLaunchSpecification()` to accept the immutable effective network policy.

For `isolated`, preserve the current argv, `/etc`, and environment exactly.

For `unrestricted-egress`:

- retain `--unshare-net`;
- add `--info-fd` and `--block-fd`;
- bind generated `/etc/resolv.conf` containing only `nameserver 10.0.2.3` and `options timeout:2 attempts:2`;
- create `/etc/ssl/certs` and bind the CA snapshot through `--ro-bind-data` at `/etc/ssl/certs/ca-certificates.crt`;
- add only `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt` to the fixed environment; and
- do not mount host `/etc`, resolver files, trust directories, client certificates, or user stores.

Keep parent proxy, cloud, SSH, registry, Pi, ChatWCA, and Node debug/preload variables absent.

### T3.3 Version the worker handshake

Update `src/server/sandbox/protocol.ts`, `worker-protocol.ts`, fixtures, and bundled `worker-entry.ts` together. Bump the internal protocol/artifact version so an old worker cannot accidentally satisfy the new policy checks.

The hello frame should state the expected effective network policy and IPv6 mode. The ready probe should report, in a closed bounded schema:

- namespace identities and existing mount/security data;
- interface names, flags, and addresses;
- IPv4 default route and expected gateway;
- loopback self-connect success/failure using a temporary guest-local listener;
- a raw bounded DNS query/response check against `10.0.2.3` that does not require public resolution;
- IPv6 address/default-route presence when enabled and absence when disabled; and
- CA file regular-file/read-only identity for unrestricted egress.

Use Node built-ins and `/proc` data; do not add a dependency on third-party Internet, public DNS, or a host-mounted `/sys`. Remove the current `1.1.1.1` and `example.com` startup assumptions.

### T3.4 Policy-specific parent validation

Refactor `validateSandboxWorkerReady()` and its context:

- common namespace, capability, mount, artifact, hidden-path, and toolchain checks run for both policies;
- isolated requires IPv4, IPv6, DNS, and loopback failure as today;
- unrestricted egress requires `tap0`, `10.0.2.100/24`, gateway/default route `10.0.2.2`, synthetic DNS response, and working guest loopback;
- IPv6 disabled requires no usable IPv6 route; enabled requires a configured address and route but no external IPv6 connection; and
- environment, `/etc` entries, CA mount, and resolver contents must match the selected policy exactly.

Do not assert that public, private, metadata, VPN, or host non-loopback destinations are blocked.

## 9. Phase 4 — Composite startup and lifecycle

### T4.1 Add `network-controller.ts`

Create `src/server/sandbox/network-controller.ts` as the sole process owner for a launched sandbox.

For isolated policy it should use the existing direct Bubblewrap path with no sidecar.

For unrestricted egress it must:

1. create info and startup-gate pipes plus sidecar ready/exit pipes;
2. spawn Bubblewrap blocked at its worker command;
3. strictly read and validate the info JSON;
4. validate ancestry/start time and pin user/network namespace descriptors;
5. spawn slirp4netns with exact configured MTU, required hardening flags, optional IPv6, and descriptor-backed namespace paths;
6. wait for a valid readiness byte while also observing both process exits and the shared start timeout;
7. release the Bubblewrap gate;
8. allow `SandboxWorkerClient` to perform the normal nonce/policy handshake; and
9. publish the composite runtime only after all stages succeed.

Any failure closes the gate, ready, exit, info, and namespace descriptors; terminates both processes; waits boundedly; and throws `sandbox_network_start_failed` for network startup phases or the existing worker-start error for worker phases.

### T4.2 Refactor `worker-client.ts`

Move raw process spawning/signaling out of `SandboxWorkerClient`. It should own framed IPC and handshake only, against a process/stream port supplied by `SandboxNetworkController`.

The process port should expose:

- Bubblewrap protocol streams;
- separate bounded Bubblewrap and sidecar diagnostics;
- process exit subscriptions tagged by member and startup/runtime phase;
- graceful composite close; and
- immediate idempotent composite invalidation.

Preserve typed `AppError`s rather than remapping sidecar failures to worker failures. An unexpected active sidecar exit must reject outstanding tool calls, kill Bubblewrap immediately, and notify the runtime with `sandbox_network_failed`, even when no network command is active.

### T4.3 Controller restart and disposal

Update `worker-controller.ts` so:

- abort and command timeout invalidate the entire composite before aborting/settling Pi;
- replacement creates a fresh namespace and sidecar with the same policy before exposing idle;
- sidecar fatal failure is terminal and is not treated as a planned restart;
- replacement startup errors preserve network-vs-worker public error codes;
- close sends worker shutdown when possible, closes the sidecar exit FD, waits briefly, then escalates each remaining process through `SIGTERM` and `SIGKILL`; and
- close/invalidate remain idempotent under crossed process exits and shutdown.

### T4.4 Pi runtime and registry integration

In `src/server/pi-runtime.ts`:

- carry the nullable network policy through canonical policy validation;
- require non-null policy for sandboxed profiles and null for unrestricted profiles;
- pass the policy and validated slirp/CA host data into each worker factory call;
- retain the same policy through controller restarts and Pi session replacement; and
- select the policy-specific strict resource loader/system prompt.

In `src/server/conversation-registry.ts`:

- store network policy on `ConversationRecord`;
- verify runtime policy equality during create/open/fork registration and ownership checks;
- include it in snapshots; and
- ensure temporary fork promotion, LRU eviction, abort, close, failed fork cleanup, and shutdown retain existing ownership semantics for the composite runtime.

## 10. Phase 5 — Startup probes and server composition

Refactor `src/server/sandbox/probe.ts` and `src/server/index.ts` so startup performs:

- the existing isolated functional probe whenever Bubblewrap sandboxing is active; and
- an additional real Bubblewrap-plus-slirp4netns probe when unrestricted egress is administratively permitted and sandboxing can be used.

Load and validate the slirp host and CA snapshot before constructing the runtime factory. Pass the immutable validated object to the factory. Do not inspect those host resources when only isolated is allowed.

The unrestricted probe uses a temporary workspace and the production `bwrap`, slirp argv, FD allocator, network controller, worker handshake, and teardown. It verifies local TAP/route/DNS/CA state only; it must not contact a third-party service. Startup succeeds only if every administratively selectable policy succeeds.

Log privately, with bounded/redacted fields:

- stable startup phase;
- Bubblewrap/slirp/libslirp versions;
- network policy and IPv6 mode;
- worker and CA hashes;
- process exit status/signal; and
- conversation/workspace IDs for runtime failures.

Never log provider data, command output, raw sidecar stderr, namespace paths, or full argv in normal logs.

## 11. Phase 6 — Browser and prompt behavior

### T6.1 Workspace controls

Extend `WorkspaceForm`, `WorkspaceSidebar`, `App`, API state fixtures, and client tests:

- include `sandboxNetworkPolicy` on create and update values;
- default new workspaces to isolated;
- show **Tool network access** only in the sandbox-profile context;
- show unrestricted egress only when administratively selectable;
- preserve and display a stale stored value without silently rewriting it;
- provide an explicit route from a disabled stale value back to isolated;
- lock network changes with path/profile changes while any workspace runtime is live; and
- confirm the exact exfiltration/private-network/VPN/metadata warning before selecting or submitting unrestricted egress.

For an `isolated -> unrestricted-egress` update, send `acknowledgeNetworkExposure: true` only after confirmation. Keep it independent from `acknowledgeSecurityDowngrade` when a single update changes both dimensions.

### T6.2 Badges and Workspace Info

Update `ConversationHeader` to derive its combined label solely from immutable conversation state:

- `Sandboxed · Network isolated`;
- `Sandboxed · Unrestricted egress`; or
- `Unrestricted · Host network`.

Workspace Info must show stored/effective network policy, IPv6 state, no configured inbound forwarding, model-provider disclosure, and the unrestricted-egress warning. It must explicitly state that host-loopback disabling does not block host services on non-loopback addresses.

Add `sandbox_network_policy_disabled` copy to workspace policy issue rendering. Avoid “Internet only,” “public network,” “safe network,” or equivalent labels.

### T6.3 Policy-specific system prompts

Replace the single constant in `src/server/sandbox/resources.ts` with common sandbox text plus policy-specific network text.

Isolated retains current no-network wording. Unrestricted egress states that:

- tools have unrestricted outbound access to reachable public and private infrastructure;
- no proxy, cloud, SSH, registry, or provider credentials are supplied automatically;
- workspace-owned secrets remain readable and exfiltratable;
- downloads and scripts are untrusted and can modify the writable workspace; and
- guest listeners are not published on host interfaces.

The app-owned tool set remains unchanged.

## 12. Phase 7 — Tests and hardening

### T7.1 Unit tests

Update/add focused tests for:

- v3-to-v4 and chained database migration;
- network policy JSON parsing, defaults, duplicates, ceiling, MTU, IPv6, and inert config;
- slirp executable/help/version and CA ownership/mode/size/snapshot validation;
- exact sidecar argv and explicit absence of API socket/forwarding;
- policy matrix, stored/effective/null projections, both acknowledgements, and busy updates;
- bounded Bubblewrap info JSON parsing;
- descendant, PID start-time, namespace inode, and reused-PID rejection;
- FD allocation and descriptor allowlists for both child processes;
- startup gate ordering and failure cleanup;
- policy-specific bwrap argv, `/etc`, environment, worker protocol, and probes;
- composite close/invalidate/escalation/idempotency and crossed worker/sidecar exits;
- no fallback after startup, handshake, restart, or active-sidecar failure;
- runtime/registry policy immutability through create/open/fork/rewind; and
- browser controls, confirmations, stale policy rendering, badges, warning wording, and public config redaction.

Primary files include existing `database`, `sandbox-config`, `sandbox-bwrap`, `sandbox-probe`, `sandbox-worker-client`, `sandbox-worker-controller`, `workspace-policy`, `protocol`, `server-protocol`, and web test suites, plus new `sandbox-slirp` and `sandbox-network-controller` suites.

### T7.2 Linux integration tests

Add a dedicated sandbox-capable test file and include it in `test:sandbox-real`. Use controlled local fixtures only.

Verify unrestricted egress:

- parent and worker network namespace inodes differ;
- `tap0`, loopback, IPv4 address, gateway, route, and optional IPv6 state are correct;
- synthetic DNS responds;
- controlled TCP and UDP services are reachable through slirp;
- controlled HTTPS succeeds using the snapshotted test CA;
- a controlled private/non-loopback host service may be reachable;
- a host-loopback-only service is not reachable through the normal slirp host mapping;
- guest listeners are not reachable from the host without forwarding;
- no API socket or forwarding configuration exists;
- proxy/provider/cloud/SSH/registry variables remain absent;
- sidecar crash kills the worker and rejects outstanding operations;
- worker crash, abort, timeout, close, eviction, failed startup, failed fork, and shutdown remove the sidecar;
- repeated replacement leaks no processes, namespaces, TAP state, or FDs; and
- concurrent isolated/egress conversations have distinct sidecars and no shared namespace state.

Also rerun all existing filesystem, hidden-path, capability, environment, toolchain, and isolated-network assertions under the refactored launcher. The dedicated CI job must fail rather than skip when declared sandbox-capable.

### T7.3 Browser tests

Extend `tests/browser/workspace-sandbox.spec.ts` and fixtures to cover:

- existing/new default isolation;
- hidden unrestricted option under the default ceiling;
- confirmation and acknowledgement when enabled;
- live-runtime locking;
- policy-blocked stale rows;
- stored/effective/null values;
- immutable conversation badges;
- current-policy resolution on fork, rewind, reopen, and restart; and
- warnings that explicitly mention exfiltration, private networks, VPNs, and metadata.

## 13. Phase 8 — Deployment documentation and release

Update `.env.example`, `README.md`, systemd/deployment guidance, and add a slirp4netns operations runbook covering:

- package/version prerequisites and security updates;
- opt-in policy configuration;
- CA snapshot/restart behavior and enterprise CA use;
- unrestricted destination semantics and residual sidecar/libslirp risk;
- absence of inbound forwarding and limits of `--disable-host-loopback`;
- controlled startup/deployment probes;
- private diagnostics for each stable network error; and
- rollback by removing `unrestricted-egress` from the administrative ceiling, which policy-blocks affected sandboxed workspaces rather than silently changing their runtime.

Run before release:

```text
npm run build
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:sandbox-real
npm run test:browser
npm run test:sdk-smoke
```

## 14. Recommended commit sequence

1. Launch spike and operations findings.
2. Config types, slirp/CA validation, and public config.
3. Schema v4, shared protocol, repository policy, and errors.
4. Policy-specific Bubblewrap FD/files/environment builder.
5. Versioned worker network probes and parent validation.
6. Composite network controller and worker-client lifecycle refactor.
7. Pi runtime, registry, startup probe, and shutdown integration.
8. Browser controls, badges, Workspace Info, and prompts.
9. Linux/browser hardening tests and deployment documentation.

Keep each intermediate commit fail-closed. Do not expose `unrestricted-egress` in public configuration until the composite startup probe and lifecycle tests are complete.

## 15. Completion criteria

Implementation is complete only when:

- database, wire protocol, repository, runtime, and UI consistently expose requested/effective network policy;
- isolated remains the default and behaves exactly as before;
- an administrator must explicitly permit unrestricted egress;
- every network-enabled runtime owns a private network namespace and distinct sidecar;
- the worker cannot run before sidecar readiness and policy-specific handshake validation;
- DNS and common TLS clients work from the guest without inherited parent secrets or proxies;
- no sidecar API socket, inbound forwarding, or host-network sharing is configured;
- sidecar/worker startup and active failures preserve stable network error codes and never fall back;
- every lifecycle path removes both processes and descriptors;
- forks, rewinds, reopen, and replacement resolve or retain the correct immutable policy;
- controlled tests demonstrate both intentional unrestricted exfiltration and preserved filesystem isolation; and
- all public wording accurately describes private/LAN/VPN/metadata reachability and residual risk.
