# Managed network sandbox acceptance mapping

This maps every item in [`network-sandbox-design.md`](network-sandbox-design.md) section 22 to automated evidence or a required deployment operation. `npm run test:sandbox-real` sets `CHATWCA_SANDBOX_CAPABLE=1`; under that exact value all capability-required tests run and failures cannot be converted to skips. Without that marker, only real-host suites follow the established skip convention.

## Section 22 criteria

| # | Acceptance criterion | Automated evidence | Operational verification |
|---:|---|---|---|
| 1 | Existing workspaces migrate to isolated networking. | `tests/unit/database.test.ts` covers v1/v2/v3→v4 migration, defaults, CHECK, rollback, and unsupported versions. | Restore a production-shaped v3 staging copy, start once, and query/inspect every workspace as isolated before rollout. |
| 2 | Managed egress is disabled by default and explicitly enabled. | `tests/unit/network-config.test.ts`, `config.test.ts`, `startup.test.ts`, `workspace-policy.test.ts`. | Start with no managed variables; verify `/api/config` mode is `disabled`, only isolated is selectable, and the helper is neither inspected nor run. |
| 3 | Browser commands cannot widen destination rules. | Closed schemas in `tests/unit/protocol.test.ts` and `server-protocol.test.ts`; administrator-only projection in `network-config.test.ts`; browser workspace tests. | Compare `/api/config` normalized policy with `.env`; verify no UI destination editor/approval action exists. |
| 4 | Managed worker has a distinct namespace with no external interface, route, or DNS. | Production handshake in `tests/integration/sandbox-probe.test.ts`, `sandbox-worker-client.test.ts`; real profile matrix in `sandbox-attack-concurrency.test.ts`. | Run the direct and systemd real suites from the operations runbook after host changes. |
| 5 | Unsetting proxy variables does not enable direct access. | Managed worker handshake's `directWithoutProxy` assertion in the real probe and every managed worker startup. | Covered by the same capability-required direct/systemd probe. |
| 6 | Only two designated guest-loopback endpoints are reachable. | Managed handshake checks HTTP/SOCKS success and arbitrary IPv4/IPv6 loopback failure; `sandbox-probe.test.ts`. | Require managed startup probe success before the service listener binds. |
| 7 | HTTP/SOCKS proxies are private and conversation-owned. | Socket mode/ownership, stale cleanup, cross-runtime paths, and idempotent close in `tests/unit/network-managed-runtime.test.ts`; distinct real runtimes in `sandbox-pi-runtime.test.ts` and the profile concurrency test. | Confirm no policy proxy TCP listener; inspect only same-UID `0700`/`0600` runtime shapes as documented. |
| 8 | Domain, port, DNS, and non-public policy precedes connection. | `network-policy.test.ts`, `network-addresses.test.ts`, `network-resolver.test.ts`, `network-proxies.test.ts`, `network-managed-proxies.test.ts`. | Review normalized allow/deny/port projection and redacted decision logs during staged rollout. |
| 9 | Outbound connection uses a validated pinned IP. | Resolver/dialer call assertions in `network-resolver.test.ts`; HTTP/CONNECT/SOCKS numeric dial assertions in proxy unit/integration tests. | No separate manual check; production connector construction is not injectable. |
| 10 | HTTPS is end-to-end with no ChatWCA CA. | Opaque CONNECT bytes in `network-proxies.test.ts` and `network-managed-proxies.test.ts`; public config schema asserts `tlsInterception: false`. | Verify no ChatWCA CA is installed/configured and Workspace Info says no TLS interception. |
| 11 | SOCKS UDP, Unix proxying, inbound, and direct local networking remain blocked. | SOCKS unsupported-command/malformed tests; managed seccomp/Unix-socket and direct-local handshake; policy address tests. | Run real probe and retain host firewall/service-listener review evidence. |
| 12 | Helper drops capabilities, sets `NoNewPrivs`, and installs seccomp before worker. | Rust capability/seccomp tests for x86-64/aarch64; strict managed worker handshake validates all capability sets, bounding set, `NoNewPrivs`, seccomp, Unix socket denial/socketpair allowance, and inherited FDs. | Build/hash-check the release helper and run direct/systemd probes on each production architecture. |
| 13 | Setup/policy/DNS/helper/bridge/proxy failures never choose unrestricted networking. | `startup.test.ts`, resolver/proxy denial tests, `sandbox-worker-client.test.ts`, `sandbox-worker-controller.test.ts`, `conversation-registry.test.ts`, crash test in `sandbox-attack-concurrency.test.ts`. | Treat optional-mode startup failure as a release stop; never bypass by changing profile to unrestricted. |
| 14 | Abort, close, eviction, crash, and shutdown remove all managed resources. | `sandbox-worker-controller.test.ts`, `conversation-registry.test.ts`, `shutdown.test.ts`, `sandbox-pi-runtime.test.ts`, native parent-death/FD closure tests, real managed crash test. | Stop unit, verify cgroup and managed runtime directory are empty; use only verified stale cleanup procedure. |
| 15 | Isolated, managed, and unrestricted conversations run concurrently without shared policy/routes. | Capability-required profile concurrency test in `sandbox-attack-concurrency.test.ts`; cross-runtime policy/socket tests in `network-managed-runtime.test.ts`; model remains parent-owned in `sandbox-pi-runtime.test.ts`. | Run the real suite under the production unit properties. |
| 16 | Browser shows immutable policy and disclosure. | `web-conversation-header.test.ts`, `web-workspace-ui.test.ts`, `web-network-notices.test.ts`, `web-state.test.ts`; Playwright workspace and reconnect/fork tests. | Verify staged managed conversation badge, Workspace Info policy, both disclosure warnings, and blocked notice. |
| 17 | Logs/events include decisions but no sensitive request/private data. | Closed audit validation/coalescing in `network-audit-connections.test.ts`; redaction assertions in proxy/runtime tests; protocol projection tests. | Review protected logs for the allowed field list in the operations runbook; do not retain raw diagnostics as release evidence. |

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

Host-specific release evidence is the direct/systemd pass result, kernel/Bubblewrap/Node/Rust/helper versions and manifest hash, `/api/config` probe success, v3 migration verification, and a redacted cgroup/socket cleanup check. Do not archive `.env`, host paths, raw journals, worker stderr, workspace content, credentials, URLs, headers, payloads, TLS bytes, resolved IPs, or command/model output.
