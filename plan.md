# Managed Network Sandbox Implementation Plan

## Objective

Implement [`docs/network-sandbox-design.md`](docs/network-sandbox-design.md) as an optional capability for `workspace-sandboxed` conversations while preserving the existing Bubblewrap sandbox as the enforcement boundary.

The key invariant is:

> A managed-egress worker remains in an isolated network namespace. Its only usable network path is through two conversation-owned guest-loopback endpoints that bridge to parent-owned policy proxies.

There must be no fallback from managed egress to unrestricted tools, direct networking, or a different workspace policy.

## Implementation decisions

These decisions make the design fit the current codebase:

- Keep `WorkspaceSecurityProfile` and `SandboxNetworkPolicy` independent. `networkPolicy` is stored for every workspace, but `effectiveNetworkPolicy` is `null` unless the effective security profile is `workspace-sandboxed`.
- Reject `CHATWCA_MANAGED_EGRESS_MODE=optional` when `CHATWCA_SANDBOX_MODE=disabled`. Managed egress cannot be established without the Bubblewrap profile, and disabled sandbox mode must not claim the capability is usable.
- Compile and validate the administrator destination policy at startup. Each `ManagedNetworkRuntime` receives an immutable copy and owns separate listeners, counters, sockets, and audit context.
- Use `SessionManager.getSessionId()` before Pi session construction as the conversation ID for proxy ownership and audit events. This avoids creating the proxy after the worker while retaining the existing registry identity checks.
- Expose blocked-network and fatal-network notifications from `PiConversationRuntime` to `ConversationRegistry`, as is already done for worker failures. The registry remains the sole owner of revisioned conversation events.
- Keep the existing worker tool IPC unchanged. Network command bytes travel through the helper bridges, never through worker control frames.
- Preserve the isolated launch profile byte-for-byte where practical. Managed mode uses a separate launch path and never weakens isolated mode.
- Make DNS resolution and outbound dialing injectable only at internal constructor boundaries for deterministic tests. Production always uses the real resolver, classifier, and pinned numeric-address dialer.
- Build an architecture-specific Rust helper during source builds and place it with a generated SHA-256/version manifest under `dist/native/`. A configured helper override must match the packaged manifest; it is not an arbitrary executable escape hatch.

## Phase 0 — Native and kernel feasibility gate

Complete this phase before landing browser or persistence work.

1. Add a minimal `native/network-helper/` Rust crate and a temporary integration harness.
2. Prove on the supported Linux CI/service profile that the helper can:
   - be launched by the Node parent with an empty environment and no shell;
   - launch Bubblewrap with the existing user/PID/IPC/UTS/mount/network namespaces;
   - retain only `CAP_NET_ADMIN` long enough for the inner helper to bring up guest loopback;
   - bind two ephemeral listeners on guest `127.0.0.1`;
   - pass each listener to an outer bridge with `SCM_RIGHTS`;
   - drop every capability set and bounding capability before executing Node;
   - install `NoNewPrivs` and the proposed seccomp filter;
   - execute the immutable worker artifact; and
   - die, including bridges, when the parent or Bubblewrap process is killed.
3. Validate Bubblewrap 0.6.1 artifact handoff using `--perms 0500 --ro-bind-data <fd> /app/network-helper`; do not bind the mutable checkout into the guest.
4. Validate the same flow under the provided systemd constraints (`NoNewPrivileges=true`, `KillMode=control-group`, unrestricted namespace creation).
5. Keep the spike out of production paths until capability-drop, FD-handoff, seccomp, and teardown tests pass.

Exit criterion: the exact helper process tree and security transitions work on x86_64, and architecture-independent filter-generation tests cover aarch64.

## Phase 1 — Configuration, persistence, and wire contract

### 1.1 Shared protocol and errors

Update `src/shared/protocol.ts`:

- Add `SandboxNetworkPolicySchema`: `"isolated" | "managed-egress"`.
- Add `ManagedEgressModeSchema`: `"disabled" | "optional"`.
- Extend workspace projections with:
  - `networkPolicy`;
  - `effectiveNetworkPolicy`;
  - `networkPolicyIssue: "managed_egress_disabled" | null`.
- Add `networkPolicy: SandboxNetworkPolicy | null` to `ConversationState`.
- Make `workspace.create.networkPolicy` optional for wire compatibility; server default is `isolated`.
- Extend `workspace.update` with optional `networkPolicy` and `acknowledgeNetworkExposure: true`. Retain closed-object validation and enforce non-empty updates and acknowledgement semantics in the repository/dispatcher rather than creating an unmaintainable combinatorial schema union.
- Add a public managed-egress projection under `/api/config`, containing only mode, selectable policies, normalized allowed/denied patterns, allowed ports, supported protocols, non-public-address denial, TLS-interception status, disclosure text, and functional-probe status. Never expose helper paths, socket paths, resolved IPs, or private diagnostics.
- Add a revisioned `network.blocked` event with normalized `host`, `port`, `protocol`, stable `reason`, and an optional coalesced occurrence count. Do not include URLs, headers, bodies, resolved addresses, credentials, or filesystem paths.

Update `src/shared/errors.ts` with all stable network codes from the design and client-safe messages. Add a `network` error context for configuration, helper, bridge, proxy startup, active proxy failure, and safe destination denial.

### 1.2 Database migration

Update `src/server/database.ts`:

- Set `DATABASE_SCHEMA_VERSION` to 4.
- Add `network_policy TEXT NOT NULL DEFAULT 'isolated' CHECK (...)` to the initial schema.
- Add a transaction-scoped version-3-to-4 migration.
- Preserve the existing stepwise 1→2→3 migration behavior before applying 3→4.
- Do not create proxy/helper resources during migration.

Extend `tests/unit/database.test.ts` to cover fresh v4 creation, 1/2/3 migrations, default isolation of every existing row, CHECK enforcement, rollback, and unsupported versions.

### 1.3 Server configuration

Create `src/server/network/config.ts` and compose it into `ServerConfig` in `src/server/config.ts`.

Parse all variables in section 8 of the design with their exact defaults. Validation must include:

- mode and cross-check with sandbox mode;
- non-empty allowlist in optional mode;
- JSON array types;
- normalized duplicate rejection within each domain list and the port list;
- integer ports from 1 through 65535;
- positive safe-integer connection/time/byte limits;
- strict domain-pattern syntax; and
- no helper filesystem inspection while managed egress is disabled.

The server-only config should retain compiled-ready normalized values. The public projection should be constructed separately and should include the workspace-content disclosure warning.

Add focused tests in `tests/unit/network-config.test.ts` and extend `tests/unit/config.test.ts` and `tests/unit/startup.test.ts` for disabled, optional, malformed, and inconsistent sandbox/network combinations.

### 1.4 Workspace repository and commands

Update `src/server/workspace-repository.ts`:

- Read/write `network_policy` in every prepared statement and row validator.
- Add it to `CreateWorkspaceInput`, `UpdateWorkspaceInput`, and `RuntimeWorkspacePolicy`.
- Default trusted legacy create callers to `isolated`.
- Require `acknowledgeNetworkExposure: true` only for an `isolated`→`managed-egress` update; reject a smuggled acknowledgement for any other transition.
- Evaluate the network ceiling only when the effective security profile is `workspace-sandboxed`.
- Return `managed_egress_disabled` and `usable: false` without silently changing the stored value.
- Include the canonical helper file and installation directory in protected-path overlap/admission checks when managed egress can be used.
- Return the immutable effective network policy from `requireUsable()`.

Update `src/server/protocol.ts` so path, security-profile, or network-policy changes return `workspace_busy` while the workspace has a live runtime. Names remain editable. Fork and rewind must continue to call `requireUsable()` and never accept browser-supplied policy.

Extend workspace repository, policy, server protocol, and startup tests before proceeding.

## Phase 2 — Destination policy and pinned resolution

Create the policy modules under `src/server/network/`.

### 2.1 `addresses.ts`

Implement canonical IPv4/IPv6 parsing and classification without relying on string-prefix checks.

- Normalize IPv4, compressed IPv6, and IPv4-mapped IPv6.
- Reject all non-global/special ranges listed by the design, including loopback, private/ULA, link-local, metadata, CGNAT, multicast, unspecified, documentation, benchmark, broadcast, and reserved ranges.
- Keep range tables explicit and test boundary addresses immediately below, at, and above every range.
- Treat an IPv4-mapped IPv6 address according to the mapped IPv4 classification.

### 2.2 `policy.ts`

Implement:

- host normalization using `domainToASCII`, lowercase conversion, one optional trailing dot, label/length validation, and strict IP literal normalization;
- exact, `*.` subdomain-only, and `**.` apex-plus-subdomain matching;
- explicit deny precedence;
- exact-only matching for IP literals;
- port evaluation; and
- one shared decision API used by HTTP, CONNECT, and SOCKS.

Reject schemes, paths, credentials, embedded ports, global wildcards, mid-label globs, scoped IPv6, malformed IDNA, ambiguous numeric hosts, and empty labels.

### 2.3 `resolver.ts`

Implement a bounded resolver that:

1. skips DNS for a normalized IP literal;
2. resolves a DNS name once with all addresses returned;
3. rejects timeout, failure, empty results, or any non-public answer;
4. deduplicates canonical addresses;
5. deterministically chooses one validated address; and
6. returns a numeric host/family for the dialer, never a hostname.

Use a single aggregate setup deadline across resolution and connect. Do not cache results across connections and do not retry through a hostname-based API.

Add `tests/unit/network-addresses.test.ts`, `network-policy.test.ts`, and `network-resolver.test.ts`, including mixed public/private DNS answers, rebinding simulations, IDNA cases, mapped addresses, deny precedence, and proof that the dialer receives only the selected numeric address.

## Phase 3 — Parent-owned proxies and managed runtime

### 3.1 Common connection controls and audit

Create `src/server/network/audit.ts`:

- Define the complete server audit record from section 16.
- Log every allow/deny decision through an injected structured diagnostic sink.
- Validate/redact records before logging.
- Rate-limit/coalesce only browser notifications, keyed by conversation/protocol/host/port/reason; policy enforcement and server audit decisions still occur per request.

Create shared connection utilities for:

- per-conversation concurrent outbound count;
- setup and idle deadlines;
- aggregate bidirectional byte counting;
- half-close propagation;
- fixed high-water marks and pause/resume backpressure; and
- idempotent forced closure.

### 3.2 `http-proxy.ts`

Use a private Node HTTP server on a Unix socket and implement three explicit paths:

- absolute-form plain HTTP requests;
- HTTP WebSocket upgrades; and
- HTTPS/WSS `CONNECT` tunnels.

For every request/tunnel:

- require strict authority parsing and reject credentials, unsupported schemes, duplicate/conflicting host metadata, invalid ports, ambiguous framing, and oversized headers;
- evaluate policy and resolve before dialing;
- dial only the validated numeric address/family;
- reconstruct origin-form requests;
- preserve a validated destination `Host` value;
- remove `Proxy-Authorization`, `Proxy-Connection`, standard hop-by-hop fields, and every header named by `Connection`;
- handle upgrade headers only in the dedicated WebSocket path;
- disable automatic redirects and hostname re-resolution; and
- apply connection, timeout, idle, byte, and backpressure limits.

Send a single stable `x-chatwca-proxy-error` value on policy denials. Use generic responses for malformed/internal failures and never return IPs, configuration, paths, or exception text. Send `200 Connection Established` only after the pinned outbound socket connects. Never terminate TLS.

### 3.3 `socks5-proxy.ts`

Implement a bounded state machine for SOCKS5 no-auth TCP `CONNECT`:

- support domain, IPv4, and IPv6 targets;
- perform domain DNS only in the parent;
- reject unsupported authentication, BIND, UDP, malformed lengths, scoped IPv6, and trailing handshake bytes;
- apply the shared policy, resolver, dialer, limits, byte relay, and audit path; and
- return only standard SOCKS reply codes with no diagnostics.

### 3.4 `managed-runtime.ts`

`ManagedNetworkRuntime.start()` should:

1. create a short, random per-runtime directory beneath a process-private `0700` network directory under `dataDir`;
2. fail if any intended path already exists;
3. start HTTP and SOCKS proxies on separate `0600` Unix sockets;
4. attach immutable workspace/conversation/policy context;
5. expose only the two socket paths to trusted helper-launch code; and
6. report listener/internal failures through a terminal fatal subscription.

Shutdown should stop admission, close listeners, close all outbound/client sockets, unlink verified socket files, and remove the empty runtime directory. Implement safe startup cleanup that only removes direct stale entries owned by the server UID after `lstat` type/mode checks; never recursively follow or remove an unverified path. Validate Unix socket path-length limits before listening.

Add unit/integration tests for proxy parsing, request smuggling cases, headers, redirects, WebSockets, CONNECT, SOCKS handshakes, pinned dialing, limits, backpressure, socket ownership, stale cleanup, cross-runtime isolation, and idempotent shutdown. Test fixtures may inject a resolver/dialer mapping a synthetic public address to a local faux service; production construction must not expose that injection.

## Phase 4 — Production native helper

Implement the crate layout from the design:

- `main.rs`: strict `--outer`, `--inner`, and machine-readable `--version` dispatch;
- `protocol.rs`: versioned, size-bounded, closed launch/ready messages and fixed FD assignments;
- `namespace.rs`: namespace identity verification, loopback setup, listener creation, and socket validation;
- `bridge.rs`: authenticated one-time FD handoff and nonblocking bounded relay;
- `capabilities.rs`: securebits, capability-set/bounding/ambient removal, and `PR_SET_NO_NEW_PRIVS` verification;
- `seccomp.rs`: architecture-checked classic BPF for x86_64/aarch64.

### Outer helper requirements

- Validate the parent descriptor before forking.
- Open and verify its own executable once; provide that open artifact to Bubblewrap.
- Create private bootstrap socketpairs and one bridge process per proxy.
- Give each bridge only its bootstrap FD and immutable target Unix-socket data; close worker IPC, data-binding, and unrelated descriptors.
- Set parent-death behavior and process-group ownership so Node can forcibly tear down the complete tree.
- Launch Bubblewrap directly, with an empty environment and no shell.
- Forward a bounded helper-ready/error frame to the Node parent without exposing private details to the guest.

### Inner helper requirements

- Verify protocol, inherited FDs, and all expected namespace identities.
- Bring up only `lo`, bind two nonzero IPv4-loopback TCP listeners, and pass each listener exactly once.
- Wait for authenticated bridge acknowledgements.
- Build the complete proxy environment from constants, including lowercase and supported package-manager aliases; never merge `process.env` or parent-supplied variable values.
- Close every bootstrap and unrelated FD.
- Drop effective, permitted, inheritable, ambient, and bounding capabilities.
- Set/verify securebits and `NoNewPrivs`.
- Install seccomp that allows IPv4/IPv6 sockets and Unix `socketpair`, denies Unix/other socket families, and denies ptrace, process-vm, and io_uring calls with `EPERM`.
- Execute `/usr/bin/node /app/worker.mjs` only after all checks pass.

### Build and validation

Add:

- `native/network-helper/Cargo.toml` and committed `Cargo.lock`;
- `scripts/build-network-helper.mjs` to build the host release artifact, copy it to `dist/native/<arch>/`, and generate a version/protocol/SHA-256 manifest;
- npm scripts for helper build and native tests, with `build`, development prebuild, and real-sandbox tests depending on the helper where needed; and
- `src/server/network/helper.ts` to validate canonical path, regular-file type, owner, mode, executability, ELF architecture, helper-reported protocol/build version, manifest hash, and protected-path separation.

Rust tests must cover unknown protocol fields/versions, malformed and duplicate SCM handoffs, accepted listener properties, FD closure, relay half-close/backpressure, parent death, capability clearing, seccomp return values, and equivalent x86_64/aarch64 policy generation.

## Phase 5 — Bubblewrap worker and probe integration

Refactor `src/server/sandbox/bwrap.ts` and `worker-client.ts` around an explicit network launch profile.

- `isolated`: retain direct Bubblewrap launch, `--unshare-net`, `--cap-drop ALL`, no proxy variables, and the current final worker command.
- `managed-egress`: retain `--unshare-net`, bind the immutable helper at `/app/network-helper`, run it as the Bubblewrap command, and retain only the namespace capability required for inner loopback setup. The worker itself must never execute before the helper drops that capability.
- Keep worker request/response FDs unchanged and allocate non-overlapping helper/bootstrap/data FDs centrally.
- Add a helper-aware launch specification whose executable is the validated outer helper and whose descriptor contains only trusted bwrap path/argv, fixed proxy socket paths, immutable artifacts, and protocol metadata.
- Spawn with `shell: false`, `detached: true`, and an empty environment.

Update `src/server/sandbox/worker-entry.ts` and `probe.ts` with profile-specific assertions:

- isolated workers retain the current no-network expectations and exact isolated environment;
- managed workers report the exact controlled proxy environment and guest proxy ports;
- all namespaces differ from the parent;
- all capability sets and bounding capabilities are empty;
- `NoNewPrivs` and seccomp are active;
- direct IPv4/IPv6 and guest DNS fail;
- arbitrary loopback fails;
- both designated loopback endpoints answer;
- synthetic HTTP and SOCKS requests reach the parent and receive local-address denial;
- Unix socket creation is denied while Unix socketpair remains available; and
- no bootstrap or unexpected FD survives into the worker.

The managed startup probe must use temporary parent proxies and must not depend on public DNS or Internet access. Any helper, bridge, seccomp, proxy, or probe failure prevents server startup when managed egress is optional.

## Phase 6 — Pi runtime, registry, and lifecycle ownership

### 6.1 Runtime creation

Update `src/server/pi-runtime.ts`:

1. For managed policy, create `ManagedNetworkRuntime` before `SandboxController`.
2. Start each worker/replacement through the helper using the same healthy immutable proxy runtime.
3. Create the strict Pi session only after both helper and worker handshakes succeed.
4. Extend `PiConversationRuntime` with immutable `networkPolicy`, blocked-event subscription, and managed-network ownership.
5. On parent proxy fatal failure, terminally fail the sandbox controller, tear down the worker namespace, abort/settle Pi, and notify registry. Do not attempt worker replacement against a failed proxy.
6. On ordinary abort/timeout, replace only helper bridges and the worker; retain the conversation proxy runtime and policy.
7. Start Pi disposal, worker/bridge teardown, and network shutdown without allowing a stalled path to retain another resource beyond the global grace deadline. `teardownComplete` must cover all three.

Update `SandboxController` with an explicit terminal fail-closed transition so proxy failure cannot be mistaken for a planned restart.

### 6.2 Prompt and registry state

Update `src/server/sandbox/resources.ts` to select an isolated or managed-egress system prompt. The managed prompt must describe filtered destinations, denied local/LAN/metadata/UDP/inbound access, possible workspace disclosure, and the prohibition on tunnel workarounds. It is explanatory only.

Update `src/server/conversation-registry.ts`:

- store immutable `networkPolicy` in every record;
- verify runtime policy matches freshly resolved workspace ownership during register/open/fork/replacement;
- include it in state snapshots;
- subscribe/unsubscribe blocked events and emit revisioned `network.blocked` events;
- preserve distinct proxy ownership for temporary forks and transfer it through normal runtime promotion; and
- dispose managed resources on failed create/open/fork, close, eviction, fatal failure, and shutdown.

Extend lifecycle, fork/rewind, registry, Pi runtime, worker-controller, shutdown, and concurrency tests. Explicitly assert no retry or fallback through unrestricted/isolated tools after a managed operation is accepted.

## Phase 7 — Browser behavior

Update `WorkspaceForm.tsx`, `WorkspaceSidebar.tsx`, `ConversationHeader.tsx`, client state/reducer code, and related CSS/tests.

- Show **Sandbox network** only when the effective/chosen security profile can be workspace-sandboxed.
- Offer **Isolated** and **Managed egress** only when server configuration allows them.
- Default create to isolated.
- Require a browser confirmation whenever a form changes isolated to managed egress, including creation. Send `acknowledgeNetworkExposure: true` on updates.
- Lock network policy together with path/security controls while a workspace has a live runtime.
- Show stored/effective network policy and the separate network policy issue.
- Workspace Info must display normalized allowed domain patterns and ports, protocol support, local/private denial, UDP/inbound denial, no TLS interception, and both workspace/model disclosure warnings.
- Render conversation badges exactly as:
  - `Sandboxed · Network isolated`;
  - `Sandboxed · Managed egress`;
  - `Unrestricted`.
- Collect bounded `network.blocked` events in the client projection, preserve them across ordinary reconnect snapshots, and display a concise notice with host, port, protocol, stable reason, and coalesced count. Do not add an approval action.

Add/extend unit and Playwright coverage for defaults, disabled mode, confirmation, busy locking, immutable live badges, workspace information, blocked notices, fork/rewind policy refresh, and reconnect behavior.

## Phase 8 — Hardening, operations, and release

1. Add adversarial tests for malformed HTTP/SOCKS traffic, duplicate headers, conflicting authorities, slowloris behavior, request smuggling, DNS timeout/rebinding, mixed answers, byte overflow, connection exhaustion, bridge stalls, unsolicited FDs, and process crashes.
2. Add real Linux tests that run isolated, managed-egress, and unrestricted conversations concurrently and prove they share neither routes, proxies, nor policy state.
3. Extend `.github/workflows/ci.yml`:
   - install/build/test the Rust helper;
   - run native unit tests;
   - run managed real-sandbox tests directly and under the systemd constraints;
   - fail rather than skip when `CHATWCA_SANDBOX_CAPABLE=1`; and
   - compile/test both architecture filter definitions, with architecture-specific release artifacts produced by the release pipeline.
4. Update `systemd/chatwca.service` only where helper execution or descriptor limits require it; preserve `KillMode=control-group`, `NoNewPrivileges=true`, and namespace availability. Verify with `systemd-analyze` and the real managed probe.
5. Update `.env.example`, `README.md`, package scripts, requirements, configuration tables, security warnings, troubleshooting, and build instructions.
6. Add a managed-egress operations runbook covering helper installation/hash verification, rollout, startup probes, log fields, stale socket cleanup, incident shutdown, and rollback to `disabled`.
7. Add an acceptance-criteria mapping from every item in design section 22 to an automated test or documented operational verification.

## Test and quality gates

Run at each phase boundary:

```sh
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm run test:browser
npm run test:sdk-smoke
cargo test --manifest-path native/network-helper/Cargo.toml
npm run test:sandbox-real
```

Additional release gates:

- A version-3 production-shaped database migrates to v4 with every workspace isolated.
- Disabled managed-egress mode neither inspects nor executes the helper.
- Optional mode refuses to listen after any configuration/helper/probe failure.
- A managed worker cannot directly reach public IPv4, IPv6, DNS, arbitrary loopback, Unix sockets, host/LAN/private/link-local/metadata addresses, or another conversation's proxy.
- Removing every proxy environment variable still leaves direct networking unavailable.
- HTTP, HTTPS CONNECT, WebSocket, and SOCKS5 TCP work only for allowed host/port pairs and use the validated pinned address.
- HTTPS is opaque end-to-end; no CA or TLS interception is introduced.
- Proxy/bridge/helper failure transitions the conversation to error and never selects a weaker runtime.
- Abort replacement, fork promotion, rewind failure, close, LRU eviction, crash, and shutdown leave no helper process, bridge, proxy connection, Unix socket, or runtime directory.
- Logs and browser events contain destination decisions but no URL path/query, headers, bodies, TLS bytes, credentials, resolved browser-visible IPs, output, or host paths.

## Recommended commit sequence

1. Native feasibility harness and CI proof.
2. Schema v4, shared protocol, errors, config, and workspace policy.
3. Address/domain policy and resolver.
4. HTTP proxy, SOCKS5 proxy, audit, and managed runtime.
5. Production Rust helper, build manifest, and validator.
6. Managed Bubblewrap launch and profile-specific probes.
7. Pi/registry lifecycle integration and fatal handling.
8. Browser controls, badges, information, and blocked notices.
9. Adversarial tests, systemd/CI hardening, documentation, and acceptance mapping.

Each commit should keep managed egress disabled by default and leave the existing isolated and unrestricted paths passing their full test suites.
