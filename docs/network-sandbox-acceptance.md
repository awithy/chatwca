# Managed network sandbox acceptance mapping

This maps every item in [`network-sandbox-design.md`](network-sandbox-design.md) section 22 to automated evidence or a required deployment operation. `npm run test:sandbox-real` sets `CHATWCA_SANDBOX_CAPABLE=1`; under that exact value all capability-required tests run and failures cannot be converted to skips. Without that marker, only real-host suites follow the established skip convention.

## Section 22 criteria

| # | Acceptance criterion | Automated evidence | Operational verification |
|---:|---|---|---|
| 1 | Pre-network rows migrate isolated; every v1–v4 row selects `default`. | `tests/unit/database.test.ts` covers fresh v5, every prior version, row/timestamp preservation, v3 isolation, v4 managed preservation, `default`, CHECKs, rollback, and unsupported versions. | Restore production-shaped v3 and v4 staging copies; verify counts/identity/timestamps, v3 isolation, and `default` on every row before rollout. |
| 2 | Managed egress is disabled by default and explicitly enabled. | `network-config.test.ts`, `config.test.ts`, `startup.test.ts`, `workspace-policy.test.ts`. | With no managed variables, verify `/api/config` is disabled/isolated-only and helper inspection/execution does not occur. |
| 3 | No set variable preserves the legacy policy through synthesized `default`. | Decision-matrix equivalence and immutable synthesis in `tests/unit/network-config.test.ts`; repository default tests in `workspace-repository.test.ts`. | Leave the variable absent, restart staging, and compare the `default` public grants with the prior global lists. |
| 4 | Browser commands cannot create or widen destination rules. | Create/update closed-schema attacks for domains, ports, denials, and raw set objects in `tests/unit/protocol.test.ts`; exact dispatcher/browser payload tests in `server-protocol.test.ts` and `workspace-modal.spec.ts`. | Confirm the modal has only a named-set selector/read-only details and no rule editor or approval action. |
| 5 | Managed worker has a distinct namespace with no external interface, route, or DNS. | Production handshake in `sandbox-probe.test.ts`, `sandbox-worker-client.test.ts`; real profile matrix in `sandbox-attack-concurrency.test.ts`. | Run direct and systemd real suites after host changes. |
| 6 | Unsetting proxy variables does not enable direct access. | Managed handshake `directWithoutProxy` assertion in the capability-required real probe. | Covered by the same direct/systemd probe. |
| 7 | Only two designated guest-loopback endpoints are reachable. | Managed handshake checks HTTP/SOCKS success and arbitrary IPv4/IPv6 loopback failure; `sandbox-probe.test.ts`. | Require managed startup-probe success before listener bind. |
| 8 | HTTP/SOCKS proxies are private and conversation-owned. | Socket ownership/mode, stale cleanup, distinct paths, pressure recovery, and idempotent close in `network-managed-runtime.test.ts`; real runtime tests. | Confirm no policy-proxy TCP listener and inspect only verified same-UID `0700`/`0600` shapes. |
| 9 | Named sets are exact ceiling subsets and global deny/domain/port/DNS/non-public checks precede connection. | Exact-membership rejection and selected-set deny/local decision tests in `network-config.test.ts`; both-proxy mandatory-denial tests in `network-managed-runtime.test.ts`; address/policy/resolver/proxy suites. | Review global and per-set normalized `/api/config` projections and redacted decisions during rollout. |
| 10 | Outbound connection uses a validated pinned IP. | Numeric resolver/dialer assertions in `network-resolver.test.ts` and HTTP/CONNECT/SOCKS proxy tests. | Production connector is non-injectable; no separate manual check. |
| 11 | HTTPS is end-to-end with no ChatWCA CA. | Opaque CONNECT tests and public schema assertion `tlsInterception: false`. | Verify no ChatWCA CA and Workspace Info says no TLS interception. |
| 12 | SOCKS UDP, Unix proxying, inbound, and direct local networking remain blocked. | SOCKS unsupported-command tests, managed seccomp/Unix/direct-local handshake, and address-policy tests. | Run the real probe and retain firewall/listener review evidence. |
| 13 | Helper drops capabilities, sets `NoNewPrivs`, and installs seccomp before worker. | Rust x86-64/aarch64 capability/seccomp tests and strict managed handshake. | Hash-check helper and run direct/systemd probes on every production architecture. |
| 14 | Setup/policy/DNS/helper/bridge/proxy failures never choose weaker networking. | Startup, resolver/proxy, worker-controller, registry, and real crash tests. | Treat optional-mode startup failure as a release stop; never recover via unrestricted tools. |
| 15 | Abort, close, eviction, crash, and shutdown remove all managed resources. | Worker-controller, registry, shutdown, Pi runtime, native parent-death/FD, and real crash tests. | Stop the unit; verify empty cgroup/runtime area using the documented safe procedure. |
| 16 | Isolated, managed, and unrestricted profiles run concurrently without shared routes/policy. | Capability-required profile matrix plus cross-runtime socket tests and parent-owned model assertions. | Run under exact production unit properties. |
| 17 | Concurrent managed workspaces enforce distinct sets and proxies. | Bidirectional HTTP/SOCKS cross-set denial with separate sockets/resolution traces in `network-managed-runtime.test.ts`; registry/fork concurrency tests. | During staged rollout, test each workspace's own and the other set's additional destination. |
| 18 | Removed sets remain stored and fail closed. | Repository unavailable-set persistence/recovery tests in `workspace-repository.test.ts`; projection/UI tests. | Follow staged removal; if removed early, confirm stored ID/issue before re-adding or explicitly replacing it. |
| 19 | Live runtimes retain immutable set identity and policy bytes. | Frozen-object and identity checks in `network-config.test.ts`, `network-managed-runtime.test.ts`, `conversation-registry.test.ts`, Pi replacement/fork tests. | Close conversations before set changes; confirm existing badge/audit ID never changes in place. |
| 20 | Browser shows immutable network/set state and disclosures. | Header, Workspace Info, notice, state, reconnect/fork unit and Playwright tests. | Verify staged badge, effective set, both disclosure warnings, and blocked notice. |
| 21 | Workspace modal is keyboard-accessible at supported narrow widths. | Focus trap, Escape/pending behavior, exact focus restoration, error association, locking, confirmation retention, and narrow viewport checks in `workspace-modal.spec.ts`; UI/style unit tests. | Complete add/edit without a pointer at desktop and minimum supported deployment viewport. |
| 22 | Logs/events include decisions/set ID but no sensitive request/private data. | Closed audit validation/coalescing in `network-audit-connections.test.ts`; redaction assertions in proxy/runtime/protocol tests. | Review protected logs using the runbook allowlist; retain no raw diagnostics. |

## Adversarial and resource-pressure matrix

| Threat | Evidence |
|---|---|
| Malformed HTTP targets, credentials, authorities, duplicate critical headers, oversized headers, conflicting framing, request smuggling | `tests/unit/network-proxies.test.ts` adversarial HTTP cases. |
| Malformed SOCKS versions/auth/commands/address lengths/trailing bytes and slow greeting | `tests/unit/network-proxies.test.ts`; bounded state-machine tests. |
| HTTP/SOCKS slowloris, idle/stalled peers | Raw client deadline tests in `network-proxies.test.ts`; native delayed-reader bridge test in `native/network-helper/src/bridge.rs`. |
| DNS timeout, empty/failure, rebinding, mixed public/private, family confusion | `tests/unit/network-resolver.test.ts`. |
| Byte overflow, aggregate idle limit, connection exhaustion, half-close, backpressure | `network-audit-connections.test.ts`, `network-managed-proxies.test.ts`, native bridge tests. |
| Malformed/duplicate/unsolicited FD handoff and inherited FD closure | Rust bridge/namespace tests; strict worker descriptor probe. |
| Descriptor pressure and malformed-client recovery | `tests/unit/network-managed-runtime.test.ts`. |
| Worker/helper/bridge/proxy crash and no weaker retry | Real managed crash test plus worker-controller/registry/startup unit tests and Rust parent-death tests. |

## Final release gates

Before release, require:

```sh
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm run test:browser
npm run test:sdk-smoke
npm run test:native
npm run test:native:architectures
npm run test:sandbox-real
```

CI additionally cross-compiles the aarch64 helper policy, builds the host release helper and manifest, and runs the real suite both directly and under the preserved systemd controls. The release workflow builds architecture-specific x64 and arm64 archives on native runners.

Host-specific release evidence is the direct/systemd pass result, kernel/Bubblewrap/Node/Rust/helper versions and manifest hash, `/api/config` probe/set projection success, production-shaped v3/v4→v5 migration verification, per-set allow/cross-set-deny checks, keyboard-only desktop/narrow modal checks, and a redacted cgroup/socket cleanup check. Do not archive `.env`, host paths, raw journals, worker stderr, workspace content, credentials, URLs, headers, payloads, TLS bytes, resolved IPs, or command/model output.
