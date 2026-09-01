# Bubblewrap acceptance-criteria mapping

This document maps every criterion in [`bubblewrap-design.md`](bubblewrap-design.md) section 22 and the release Definition of Done in [`plan.md`](../plan.md) to automated evidence or an explicit deployment check. `npm run test:sandbox-real` sets `CHATWCA_SANDBOX_CAPABLE=1`; therefore namespace/probe tests fail rather than skip. The ordinary integration job leaves that marker unset and skips only real-host suites.

## Design acceptance criteria

| # | Criterion | Evidence |
|---:|---|---|
| 1 | Requested and effective profiles persist/project. | `tests/unit/database.test.ts`, `workspace-repository.test.ts`, `workspace-policy.test.ts`; `tests/browser/workspace-sandbox.spec.ts`. |
| 2 | Browser commands cannot exceed mode or approved roots. | `tests/unit/protocol.test.ts`, `server-protocol.test.ts`, `workspace-policy.test.ts`, `sandbox-config.test.ts`; browser mode tests. |
| 3 | Required mode sandboxes every usable conversation. | `tests/unit/workspace-policy.test.ts`, `workspace-repository.test.ts`; required-mode browser test. |
| 4 | Every enabled sandbox tool uses the per-conversation worker. | `tests/integration/sandbox-pi-contract.test.ts` checks exact seven app-owned execute functions; `sandbox-pi-runtime.test.ts` performs a real tool call through Bubblewrap. |
| 5 | No model-directed path/process runs in the parent. | `tests/unit/sandbox-tools.test.ts`, `sandbox-worker-fs.test.ts`, `conversation-registry.test.ts` (sandbox Markdown images); real escape matrix in `sandbox-attack-concurrency.test.ts`. Code review boundary: only typed `SandboxController` operations are captured by sandbox tools. |
| 6 | No arbitrary extension or unapproved tool in strict sessions. | `tests/integration/sandbox-pi-contract.test.ts`, `tests/unit/sandbox-resources.test.ts`, `tests/integration/pi-runtime.test.ts`. |
| 7 | Tool processes receive no parent credentials/Pi variables. | Startup and per-worker probe validation in `sandbox-probe.test.ts`; parent sentinel and `/proc/*/environ` attack in `sandbox-attack-concurrency.test.ts`. |
| 8 | Synthetic root mounts only workspace, `/usr`, and approved read-only paths. | `tests/unit/sandbox-bwrap.test.ts`; real startup probe and read-only mount write rejection in the attack suite; deployment profile spike. |
| 9 | ChatWCA data, Pi state, and session stores remain absent. | Real SQLite/WAL/SHM, Pi credential/global-session, workspace-session, unrelated directory, and canary attacks in `sandbox-attack-concurrency.test.ts`; startup hidden-path probe. |
| 10 | `.chatwca` hidden; writable `.git` documented. | Real worker-client mask test and real Git init/commit in attack suite; README, operations runbook, and Workspace Info browser/unit tests. |
| 11 | IPv4, IPv6, DNS, and loopback fail. | `tests/integration/sandbox-probe.test.ts` and every production worker handshake validate all five probes; `npm run spike:sandbox-profile` repeats them under service constraints. |
| 12 | Setup/protocol/runtime failures never choose unrestricted tools. | `tests/unit/startup.test.ts`, `sandbox-worker-client.test.ts`, `sandbox-worker-controller.test.ts`, `conversation-registry.test.ts`; `tests/integration/shutdown.test.ts`. |
| 13 | Abort/close/eviction/crash/shutdown remove workers and descendants. | `tests/unit/sandbox-worker-controller.test.ts`, `conversation-registry.test.ts`, `shutdown.test.ts`; real descendant cleanup in worker-client and profile spike; systemd `KillMode=control-group` deployment check. |
| 14 | Fork/rewind freshly resolve destination policy. | `tests/integration/fork.test.ts`, `server-protocol.test.ts`; lifecycle assertions in `tests/unit/conversation-registry.test.ts`. |
| 15 | Concurrent profiles do not share workers/tools/model runtimes. | `tests/integration/sandbox-pi-contract.test.ts` (model separation), `sandbox-attack-concurrency.test.ts` (three real workers plus parent work), `tests/unit/conversation-registry.test.ts`. |
| 16 | UI/docs state residual workspace, extension, provider, and DoS risks. | `tests/browser/workspace-sandbox.spec.ts`, `tests/unit/web-workspace-ui.test.ts`, `web-conversation-header.test.ts`; README and `bubblewrap-operations.md`. |

## Phase 9 attack/concurrency matrix

| Attack or behavior | Evidence |
|---|---|
| Relative, absolute, `..`, symlink, and host rename escapes | Real `sandbox-attack-concurrency.test.ts`; lexical/canonical unit coverage in `sandbox-worker-fs.test.ts`. |
| Mutation aliases | Unit and real concurrent symlink-alias edits. |
| SQLite/WAL/SHM, Pi credentials, global/local sessions, parent environment, `/proc`, canary | Real attack suite and startup hidden-path probe. |
| IPv4/IPv6/DNS/loopback | Real startup/per-worker probe. |
| Unix socket admission and bounded race caveat | `tests/unit/sandbox-admission.test.ts`; documented manual prohibition because post-admission replacement is inherently racy. |
| Workspace/source writes and `.git` functionality | Real write-through plus Git init/add/commit. |
| Read-only toolchain use/write rejection | Real Node/ripgrep execution, approved mount read, and EROFS rejection. |
| Malformed IPC/compromised worker | `tests/unit/sandbox-protocol.test.ts`, `sandbox-worker-client.test.ts`, hostile worker fixture. |
| Output flood and slow parent | Unit 4 MiB slow-consumer/backpressure test and real command-output cap termination. |
| Process burst/large allocation cleanup | Guarded test in `sandbox-attack-concurrency.test.ts`, enabled only by `CHATWCA_SANDBOX_RESOURCE_STRESS=1` in the isolated `sandbox-linux` CI VM. It uses a finite 64-descendant burst and 128 MiB allocation; it verifies cleanup and deliberately makes no quota claim. |
| Multiple workers/concurrent unrestricted parent work | Three real workers plus concurrent parent file operation in attack suite. |
| Remote faux provider through parent | `tests/integration/sandbox-pi-runtime.test.ts`. |

## Definition of Done cross-check

- Schema/profile policy: criteria 1–3.
- Real pre-listen probe: criteria 7–9 and 11; startup ordering is asserted in `tests/unit/startup.test.ts`.
- Worker-only tools and workspace images: criteria 4–5.
- Exactly seven strict tools/resources: criterion 6.
- Namespace contents, `.chatwca`, network, and read-only mounts: criteria 7–11.
- Cleanup for abort, timeout, failure, close, eviction, fork rollback, and shutdown: criteria 12–14.
- No fallback and concurrent isolation: criteria 12 and 15.
- Accurate operator/UI disclosures: criterion 16.

## Required deployment checks

Automated CI cannot prove a different production kernel, unit, service user, filesystem, or toolchain. Before enabling optional/required mode and after any relevant host change:

1. run `npm run spike:sandbox-profile` directly as the service user;
2. run the same probe through `systemd-run` with every hardening property from `systemd/chatwca.service` (command in `bubblewrap-operations.md`);
3. require `"result": "pass"`, verify `/api/config` reports `functionalProbeSucceeded: true`, and confirm the listener did not bind on a deliberately failed probe; and
4. verify the reverse proxy requires valid mTLS for HTTP and WebSocket, preserves `Host`, and the backend is loopback-bound or firewall-isolated.

Store only pass/fail, stable versions, and redacted error codes as release evidence. Do not archive raw worker stderr, journals containing private paths, `.env`, Pi state, workspace contents, commands, or provider output.
