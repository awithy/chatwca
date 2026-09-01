# Bubblewrap operations and spike results

This is the operator runbook and deployment-validation record for the workspace sandbox. Bubblewrap reduces tool access; it is not client authentication and does not enforce per-conversation resource quotas.

## Phase 0 profile spike (T0.1)

Run the reproducible profile probe from the repository root:

```sh
npm run spike:sandbox-profile
```

Optional arguments are `--bwrap <absolute-path>`, `--data-dir <path>`, `--pi-agent-dir <path>`, and `--keep-temp`. The probe creates its workspace beneath the current directory so that an unrelated sibling tests mount isolation rather than merely testing the private `/tmp` mount.

The probe launches the proposed synthetic root with no shell-built Bubblewrap command. It fails unless all of the following hold:

- user, mount, PID, IPC, UTS, and network namespace IDs differ from the parent;
- `CapEff` is zero, `NoNewPrivs` is `1`, and the hostname is `chatwca-sandbox`;
- the root and `/dev` contain only the expected synthetic entries;
- Node 22+, Bash, and ripgrep execute from the read-only `/usr` mount;
- ordinary workspace writes reach the host;
- the host `.chatwca` content is hidden, while its guest tmpfs is writable and ephemeral;
- parent canaries, ChatWCA data, the Pi agent directory, an unrelated workspace, host home, host `/tmp`, host `/etc`, `/run`, and `/sys` are not visible;
- IPv4, IPv6, DNS, IPv4 loopback, and IPv6 loopback attempts all fail; and
- killing Bubblewrap removes its shell and forked descendant as observed from the parent PID namespace.

The command uses stdout only to report this disposable spike. Production workers will use dedicated protocol file descriptors and close stdout as specified by the design.

### Deployment-host result

Verified on 2026-04-01:

```text
Ubuntu kernel: 6.8.0-138-generic x86_64
Bubblewrap:    0.6.1 (/usr/bin/bwrap)
Guest Node:    v24.20.0 (/usr/bin/node)
Guest rg:      ripgrep 13.0.0 (/usr/bin/rg)
Result:        PASS (direct invocation)
Descendants:   Bubblewrap, namespace init, shell, and sleep all removed
```

The hardened `chatwca.service` uses `PrivateUsers=no`, `RestrictNamespaces=no`, `NoNewPrivileges=yes`, `KillMode=control-group`, process-wide `TasksMax=512`, and `TimeoutStopSec=310s`. The profile passed with `NoNewPrivileges` set both through `setpriv` and a systemd-managed transient service. These settings do not prevent the tested namespace creation on this host.

For a deployment check through the system manager under the same user and relevant unit properties, run:

```sh
sudo systemd-run --wait --pipe --collect \
  --unit=chatwca-sandbox-profile-spike \
  --uid=adrian \
  --working-directory=/home/adrian/projects/chatwca \
  --property=KillMode=control-group \
  --property=TimeoutStopSec=310s \
  --property=PrivateUsers=no \
  --property=NoNewPrivileges=yes \
  --property=RestrictNamespaces=no \
  --property=TasksMax=512 \
  /usr/bin/node scripts/spike-bubblewrap-profile.mjs
```

This command must print `"result": "pass"` before enabling optional or required sandbox mode. Re-run it after kernel, Bubblewrap, systemd hardening, `/usr` toolchain, or service-user changes.

### Bubblewrap 0.6.1 environment finding

Bubblewrap adds `PWD=/workspace` after `--clearenv`, including when `--unsetenv PWD` is supplied. The spike therefore requires that exact value in addition to the design allowlist. Production worker code must construct the command environment explicitly and must not forward `process.env`; `PWD` is established by the command working directory.

### Conclusion

The proposed profile works on the deployment kernel and toolchain, including from a systemd-managed service context. No blocker was found for proceeding to the inherited-data-FD spike. The system-manager command above remains a required deployment validation because changing unit namespace restrictions can invalidate this conclusion.

## Phase 2 production probes and workspace admission

In `optional` and `required` modes, startup now validates the canonical, root-owned Bubblewrap executable and the Node/Bash/ripgrep synthetic-root toolchain, then launches the bundled worker through the production argv/data-FD builder. The worker bundle and four minimal `/etc` files are inherited as immutable data pipes on FDs 3–7; request and response framing uses separate inherited FDs 8 and 9. Bubblewrap arguments are always an argv array and never a shell command. The functional probe is nonce- and artifact-hash-bound and verifies namespaces, capabilities, `NoNewPrivs`, the fixed environment, synthetic root, minimal `/dev` and `/etc`, workspace mount identity and write-through, `.chatwca` masking, protected-path visibility, read-only mount identity, and failed IPv4, IPv6, loopback, and DNS access. The listener is not constructed or bound until this succeeds. `disabled` mode does not load the worker artifact or inspect or execute Bubblewrap.

Every sandbox runtime admission re-canonicalizes the registered workspace, rechecks roots, read/write/search access and protected-path overlap, validates that `.chatwca` is absent or a real non-symlink directory, and performs a no-follow directory-handle walk for Unix-domain sockets. The walk rejects after either 100,000 entries or two seconds. This socket check is deliberately best effort: a host process can create or replace a pathname socket after admission, so operators must not place service, agent, Docker, SSH, or similar sockets in sandboxed workspaces.


## Operator requirements and installation

The enabled profile supports Linux x86-64 and arm64 and requires:

- a kernel that permits the service user to create unprivileged user, mount, PID, IPC, UTS, and network namespaces;
- Bubblewrap 0.6.1 or newer at an absolute canonical path, as a root-owned regular executable not writable by group/other;
- Node.js 22.19.0 or newer at `/usr/bin/node` inside the read-only `/usr` tree;
- `/usr/bin/bash` (exposed as `/bin/bash` by the synthetic root); and
- ripgrep on `CHATWCA_SANDBOX_PATH`.

For Debian/Ubuntu, install the host tools with:

```sh
sudo apt-get update
sudo apt-get install bubblewrap ripgrep
/usr/bin/bwrap --version
/usr/bin/node --version
/usr/bin/rg --version
```

Node installed only under nvm, `setup-node`, a home directory, or `/opt` is not visible through the default synthetic root. Install a supported distribution under `/usr`, or add a narrowly scoped administrator-approved read-only runtime mount and PATH entry. Do not mount an entire home, credential store, package cache containing tokens, Docker socket, or application checkout merely to make a tool available.

## Configuration reference

`.env` values are read before startup; an existing process environment wins. JSON settings are JSON **string arrays**, not comma-separated lists.

| Variable | Default | Rule |
|---|---:|---|
| `CHATWCA_SANDBOX_MODE` | `disabled` | `disabled`, `optional`, or `required`. |
| `CHATWCA_BWRAP_PATH` | `/usr/bin/bwrap` | Absolute canonical executable satisfying the ownership/version checks above. |
| `CHATWCA_WORKSPACE_ROOTS` | `[]` | Canonical approved roots. Required mode requires at least one. Non-empty roots apply in all modes. |
| `CHATWCA_SANDBOX_RO_MOUNTS` | `[]` | Canonical files/directories mounted read-only at the same absolute guest path. |
| `CHATWCA_SANDBOX_PATH` | `/usr/bin:/bin` | Absolute PATH entries, no empty segments; each must be supplied by `/usr` or an approved mount. |
| `CHATWCA_SANDBOX_START_TIMEOUT_MS` | `5000` | Positive startup and handshake deadline. |
| `CHATWCA_SANDBOX_COMMAND_TIMEOUT_MS` | `900000` | Positive hard shell-command deadline. |
| `CHATWCA_SANDBOX_MAX_COMMAND_OUTPUT_BYTES` | `67108864` | Positive total command-output bound; overflow kills the worker. |

Example optional rollout:

```dotenv
CHATWCA_HOST=127.0.0.1
CHATWCA_DATA_DIR=/var/lib/chatwca
PI_CODING_AGENT_DIR=/var/lib/chatwca/pi-agent
CHATWCA_SANDBOX_MODE=optional
CHATWCA_BWRAP_PATH=/usr/bin/bwrap
CHATWCA_WORKSPACE_ROOTS=["/srv/chatwca/workspaces","/srv/projects"]
CHATWCA_SANDBOX_RO_MOUNTS=["/opt/company-toolchain"]
CHATWCA_SANDBOX_PATH=/usr/bin:/bin:/opt/company-toolchain/bin
CHATWCA_SANDBOX_START_TIMEOUT_MS=5000
CHATWCA_SANDBOX_COMMAND_TIMEOUT_MS=900000
CHATWCA_SANDBOX_MAX_COMMAND_OUTPUT_BYTES=67108864
```

A source path in `CHATWCA_SANDBOX_RO_MOUNTS` appears at the same absolute path in the guest. Mounts are administrator trust decisions and their host paths are intentionally absent from `/api/config` and Workspace Info.

## Filesystem, network, and compatibility model

The synthetic root contains `/usr`, minimal `/dev` and `/proc`, immutable minimal `/etc` files, ephemeral home/temp directories, approved read-only mounts, and the selected workspace at `/workspace`. It does not bind the host root, home, `/run`, `/sys`, ChatWCA data, Pi agent state, or the application checkout. The host `<workspace>/.chatwca` is masked by ephemeral guest storage. The workspace—including `.git`, hooks, source, generated files, dependencies, and build scripts—remains writable.

Tools have no IPv4, IPv6, DNS, or loopback access. Package downloads and direct external services therefore do not work from sandboxed commands. Model-provider calls still run in the parent and may send workspace content to the configured remote provider. This is not confidentiality from the provider.

Sandboxed Pi sessions use exactly `read`, `write`, `edit`, `bash`, `ls`, `grep`, and `find`. Arbitrary extensions, dynamic tools, project/global skills, prompt packages, extension commands, and extension-only providers are disabled. Administrator-configured native remote providers remain usable through the parent. Keep unrestricted extensions globally disabled or run unrestricted and sandboxed workloads in separate ChatWCA processes when parent-process extension risk is unacceptable.

A Unix-domain socket mounted in a workspace can bypass IP-network isolation. Admission rejects sockets with a no-follow walk bounded at 100,000 entries and two seconds, and rejects rather than skipping when a bound is reached. This is a best-effort race check: a host process can create or replace a socket after admission. Never place Docker, SSH-agent, database, service, or other sockets in a sandboxed workspace.

## Protected paths and deployment layout

A sandbox workspace must not overlap in either direction with:

- `CHATWCA_DATA_DIR` (including SQLite, WAL, and SHM files);
- `PI_CODING_AGENT_DIR` (credentials, models, and global sessions); or
- an approved read-only mount.

The common trap is registering the ChatWCA checkout while using its default `./data`: the workspace contains protected ChatWCA state and is rejected. Move data and Pi state outside every approved workspace root, for example:

```text
/var/lib/chatwca/data       # CHATWCA_DATA_DIR
/var/lib/chatwca/pi-agent   # PI_CODING_AGENT_DIR
/srv/chatwca/workspaces/*   # approved workspaces
```

Workspace-local Pi sessions are intentionally stored by the parent under `.chatwca/sessions`; the guest sees only the ephemeral mask.

## Rollout, failure, and rollback

1. Start with `disabled`. Existing unrestricted behavior remains and Bubblewrap is not inspected.
2. Install the toolchain, separate protected directories, run the direct and systemd probes, then change to `optional`. Startup fails before listening if any configuration, executable, namespace, mount, environment, toolchain, or network check fails. New workspaces still default to Unrestricted; opt in representative workspaces.
3. Change to `required` only after all usable workspaces are beneath configured roots. Required mode derives Workspace sandbox for every runtime without rewriting stored rows.

Disabled mode never silently downgrades a stored sandbox request: that workspace is policy-blocked. Runtime mount, handshake, worker, protocol, timeout, and restart failures also fail closed and never select unrestricted tools. Rollback is an explicit mode change and restart; if an operator chooses to change a workspace to Unrestricted, the UI requires acknowledgement of reduced protection.

## systemd hardening and validation

The provided unit deliberately sets:

```ini
NoNewPrivileges=true
KillMode=control-group
TasksMax=512
PrivateUsers=false
RestrictNamespaces=false
TimeoutStopSec=310s
```

`NoNewPrivileges` is compatible with Bubblewrap only where the kernel allows unprivileged user namespaces; the functional probe is authoritative. `PrivateUsers` or `RestrictNamespaces` hardening can prevent Bubblewrap and must not be added without revalidation. `KillMode=control-group` gives crash/stop cleanup defense in depth. `TasksMax=512` limits the entire ChatWCA service—not a conversation—and does not provide CPU, memory, disk, or per-worker process quotas. `TimeoutStopSec` allows ChatWCA's maximum 300-second bounded shutdown plus a manager margin.

After installing the unit, run the profile as the exact service user and with its relevant properties (adjust user and path):

```sh
sudo systemd-run --wait --pipe --collect \
  --unit=chatwca-sandbox-deployment-check \
  --uid=adrian \
  --working-directory=/home/adrian/projects/chatwca \
  --property=NoNewPrivileges=true \
  --property=KillMode=control-group \
  --property=TasksMax=512 \
  --property=TimeoutStopSec=310s \
  --property=PrivateUsers=false \
  --property=RestrictNamespaces=false \
  /usr/bin/node scripts/spike-bubblewrap-profile.mjs
```

The command must report `"result": "pass"`. Repeat after kernel, Bubblewrap, Node, ripgrep, unit, mount, service-user, or filesystem changes.

## Listener and client authentication

Bubblewrap is not authentication. Prefer `CHATWCA_HOST=127.0.0.1` and an authenticated reverse proxy that requires valid mTLS client certificates for both HTTP and WebSocket upgrades. Preserve the external `Host` header and upgrade headers. If direct LAN binding is retained, restrict the port with host and network firewalls to a segmented trusted network. Every client accepted by the proxy or firewall has full ChatWCA authority; same-origin WebSocket validation does not create users, roles, or authorization.

## Diagnostics and troubleshooting

Browser responses, normal server logs, and CI output contain only stable error codes and generic messages. Worker stderr is bounded private process memory and is never returned through HTTP/WebSocket. It can contain paths, commands, output, or tool details, so do not publish raw debug captures. CI does not upload raw journals, stderr, `.env`, workspace trees, Pi state, or sandbox diagnostic buffers.

Troubleshoot by phase:

- `sandbox_configuration_error`: validate JSON syntax, canonical roots/mounts, executable ownership/mode, and PATH coverage.
- `sandbox_unavailable`: check kernel user namespaces, Bubblewrap/Node/ripgrep versions, and rerun the profile under the unit.
- `sandbox_workspace_rejected`: check roots, protected overlap, permissions, `.chatwca`, Unix sockets, and walk bounds.
- `sandbox_worker_start_failed`: check the per-worker namespace/mount handshake and timeout after reproducing the startup probe.
- `sandbox_worker_failed`: close the conversation, investigate host changes or worker termination privately, correct the cause, and reopen. There is no unrestricted fallback.
- `sandbox_operation_failed`: the worker remained healthy but rejected a bounded operation; requested paths and OS details are intentionally not public.

The interactive spike reports versions and a disposable temporary root only with `--keep-temp`; treat its terminal as private. For release evidence use the stable pass/fail result and the automated acceptance map in [`bubblewrap-acceptance.md`](bubblewrap-acceptance.md), not raw diagnostic artifacts.
