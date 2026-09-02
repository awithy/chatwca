# Managed-egress operations runbook

Managed egress is an optional extension of the Bubblewrap workspace sandbox. It is **disabled by default**. Enabling it is a disclosure decision: a tool can transmit any workspace content it can read to an allowed destination. The parent/model-provider path is separate and remains outside the worker namespace.

See [`bubblewrap-operations.md`](bubblewrap-operations.md) for the base sandbox host and workspace requirements. This runbook covers the native helper and conversation-owned policy proxies.

## Requirements and build

Supported production targets are Linux x86-64 (`x64`) and arm64 (`arm64`) with:

- the Bubblewrap requirements in the base runbook;
- a kernel with user/network namespaces, capabilities, `NoNewPrivs`, seccomp filter support, and `SCM_RIGHTS`;
- Rust stable for source builds (the installed service needs only the built ELF); and
- enough service descriptors for parent proxy sockets, outbound connections, helper pipes, and two bridges per managed worker. The provided unit uses `LimitNOFILE=8192`, `TasksMax=512`, and per-conversation proxy limits.

Build and verify from a clean checkout:

```sh
npm ci
npm run test:native
npm run test:native:architectures
npm run build
```

`npm run build:network-helper` compiles with `--release --locked`, writes `dist/native/<arch>/chatwca-network-helper` mode `0500`, and creates `network-helper-manifest.json` with protocol/build versions, architecture, and SHA-256. `npm run build` includes this step. Release CI builds and tests each artifact on its native architecture.

## Helper installation and integrity

The packaged path is the default. To install elsewhere, copy the ELF without modifying it and set an absolute canonical path:

```sh
sudo install -d -o root -g root -m 0755 /opt/chatwca/bin
sudo install -o root -g root -m 0555 \
  dist/native/$(node -p "process.arch")/chatwca-network-helper \
  /opt/chatwca/bin/chatwca-network-helper
sha256sum /opt/chatwca/bin/chatwca-network-helper
node -e 'const m=require("./dist/native/"+process.arch+"/network-helper-manifest.json"); console.log(m.sha256)'
/opt/chatwca/bin/chatwca-network-helper --version
```

Set `CHATWCA_NETWORK_HELPER_PATH=/opt/chatwca/bin/chatwca-network-helper`. The server still compares the override with the packaged manifest. Startup rejects a symlink/noncanonical path, wrong owner, group/other-writable file, wrong ELF architecture, version/protocol mismatch, hash mismatch, non-executable file, or overlap with a workspace/protected path. Never place the helper or its installation directory under an admitted workspace.

## Configuration and staged rollout

Start with:

```dotenv
CHATWCA_MANAGED_EGRESS_MODE=disabled
```

Disabled mode does not inspect, execute, or probe the helper. Configure the destination policy before switching modes:

```dotenv
CHATWCA_SANDBOX_MODE=optional
CHATWCA_MANAGED_EGRESS_MODE=optional
CHATWCA_NETWORK_ALLOWED_DOMAINS=["registry.npmjs.org","**.github.com"]
CHATWCA_NETWORK_DENIED_DOMAINS=["private.example.com"]
CHATWCA_NETWORK_ALLOWED_PORTS=[80,443]
CHATWCA_NETWORK_MAX_CONNECTIONS=32
CHATWCA_NETWORK_CONNECT_TIMEOUT_MS=10000
CHATWCA_NETWORK_IDLE_TIMEOUT_MS=300000
CHATWCA_NETWORK_MAX_CONNECTION_BYTES=1073741824
```

Patterns are exact, `*.` (subdomains only), or `**.` (apex and subdomains). Deny wins. IP literals require an exact allow entry; non-public addresses are denied regardless. Keep the allowlist narrow and prefer port 443. An allowed HTTPS destination receives opaque end-to-end TLS and can receive workspace data; ChatWCA adds no CA and cannot inspect method, path, headers, body, or TLS payload.

Rollout procedure:

1. Back up data and record the current disabled configuration.
2. Build/install and independently hash-check the helper.
3. Run all release gates, including `npm run test:sandbox-real`, directly as the service user.
4. Validate the unit with `systemd-analyze verify systemd/chatwca.service` and run the real suite under the exact service properties (command below).
5. Set mode to `optional` and restart. Startup must complete the isolated and managed functional probes before the HTTP listener binds.
6. Confirm `/api/config` reports managed mode `optional`, the normalized intended patterns/ports, and `functionalProbeSucceeded: true`; it must not expose helper/socket paths or resolved IPs.
7. Opt in one non-sensitive workspace, confirm its immutable **Sandboxed · Managed egress** badge and policy disclosure, then expand gradually.

A production-shaped v3 database should be restored to a staging copy and started once; verify every migrated workspace remains `isolated` before rollout.

## Direct and systemd verification

`CHATWCA_SANDBOX_CAPABLE=1` is a strict assertion: real tests run and any missing capability is a failure, never a skip.

```sh
npm run test:sandbox-real

sudo systemd-run --wait --pipe --collect \
  --unit=chatwca-managed-egress-check \
  --uid="$(id -u)" --gid="$(id -g)" \
  --working-directory="$PWD" \
  --property=NoNewPrivileges=true \
  --property=KillMode=control-group \
  --property=TasksMax=512 \
  --property=LimitNOFILE=8192 \
  --property=TimeoutStopSec=310s \
  --property=PrivateUsers=false \
  --property=RestrictNamespaces=false \
  --setenv=CHATWCA_SANDBOX_CAPABLE=1 \
  --setenv=CHATWCA_SANDBOX_RESOURCE_STRESS=1 \
  "$(command -v npm)" run test:sandbox-real
```

Do not add `PrivateNetwork`, `PrivateUsers`, or namespace restrictions without repeating the real probe; these can prevent Bubblewrap/helper setup. Preserve `NoNewPrivileges=true` and `KillMode=control-group`.

## Startup probes and runtime state

Optional mode refuses to listen if policy compilation, helper integrity, namespace creation, loopback setup, FD handoff, capability drop, seccomp installation, bridge connectivity, or the synthetic managed denial probe fails. The probe requires no Internet or public DNS.

Each conversation owns a private `0700` runtime directory and separate `0600` HTTP/SOCKS Unix sockets under the data directory. Guest endpoints exist only on that conversation's isolated loopback. Never publish or bind the parent sockets to TCP.

## Logs and monitoring

A policy decision is logged as a closed `network.policy` record with only:

- timestamp, workspace ID, and conversation ID;
- protocol (`http`, `https-connect`, or `socks5-tcp`);
- normalized host and port; and
- allow/deny decision and stable reason.

Expected reasons are `allowlist`, `explicit_deny`, `not_allowed`, `local_address`, `port_not_allowed`, `dns_failure`, `limit_exceeded`, and `proxy_unavailable`. Browser blocked notices are coalesced, but server decisions are logged individually.

Logs/events must not contain URL paths or queries, headers, bodies, credentials, TLS bytes, resolved browser-visible IPs, command output, helper/socket paths, or exception diagnostics. Alert on repeated `proxy_unavailable`, helper/bridge/proxy fatal errors, startup-probe failure, and unusual `limit_exceeded` volume. Store logs in the deployment's protected logging destination; initial releases do not provide tamper-resistant audit storage.

## Stale socket cleanup

Normal close, abort replacement, eviction, crash handling, and shutdown remove bridges, connections, socket files, and runtime directories. Startup removes only a narrowly verified, same-UID, dead-process directory shape; it never recursively follows unknown entries.

If stale entries remain:

1. Stop ChatWCA and verify no ChatWCA/helper/Bubblewrap processes remain in the unit cgroup.
2. Back up directory names/metadata only; do not publish private absolute paths.
3. Inspect direct entries under the configured managed network data directory with `lstat`/`find -xdev`—never follow links.
4. Remove only known `net-p-<dead-pid>-<token>/r-<token>/{h.sock,s.sock}` entries owned by the service UID with directory mode `0700` and socket mode `0600`.
5. Do not remove a symlink, regular file, unknown name/type, live-PID directory, wrong-owner entry, or unexpected content. Quarantine and investigate instead.
6. Restart and require the functional probe to pass.

## Incident shutdown and rollback

For a suspected bypass, helper compromise, proxy crash loop, or policy mistake:

```sh
sudo systemctl stop chatwca.service
# Verify the service cgroup is empty before handling state.
systemctl status chatwca.service
```

Preserve only redacted policy records and versions needed for the incident. Rotate credentials that may have been readable in affected workspaces and treat allowed destinations as potential recipients.

Rollback is fail-closed:

1. Set `CHATWCA_MANAGED_EGRESS_MODE=disabled`.
2. Restart the service and verify `/api/config` exposes only `isolated` as selectable.
3. Existing workspaces stored as `managed-egress` become unusable with `managed_egress_disabled`; they are **not** silently downgraded.
4. After closing live conversations, explicitly change affected workspaces to `isolated` if continued use is required.
5. Confirm no helper/bridge process, proxy socket, active connection, or runtime directory remains.

Never recover by selecting unrestricted tools or weakening a workspace profile. Diagnose stable codes: `network_policy_invalid`, `network_helper_unavailable`, `network_proxy_start_failed`, `network_bridge_start_failed`, and `network_proxy_failed`. A normal destination denial is `network_destination_blocked` and does not require a worker restart.
