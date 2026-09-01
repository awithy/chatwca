# Bubblewrap operations and spike results

This document records deployment checks for the workspace sandbox. It will grow with the implementation.

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

The installed `chatwca.service` was inspected with `systemctl show`. It runs as `adrian` with `PrivateUsers=no`, `NoNewPrivileges=no`, `RestrictNamespaces=no`, and `KillMode=control-group`; none of these settings prevents the tested namespace creation. A systemd-managed transient user service with the repository working directory, `KillMode=control-group`, and the production stop timeout also passed the complete probe and reported `invocation: systemd`.

For a deployment check through the system manager under the same user and relevant unit properties, run:

```sh
sudo systemd-run --wait --pipe --collect \
  --unit=chatwca-sandbox-profile-spike \
  --uid=adrian \
  --working-directory=/home/adrian/projects/chatwca \
  --property=KillMode=control-group \
  --property=TimeoutStopSec=310s \
  --property=PrivateUsers=no \
  --property=NoNewPrivileges=no \
  --property=RestrictNamespaces=no \
  /usr/bin/node scripts/spike-bubblewrap-profile.mjs
```

This command must print `"result": "pass"` before enabling optional or required sandbox mode. Re-run it after kernel, Bubblewrap, systemd hardening, `/usr` toolchain, or service-user changes.

### Bubblewrap 0.6.1 environment finding

Bubblewrap adds `PWD=/workspace` after `--clearenv`, including when `--unsetenv PWD` is supplied. The spike therefore requires that exact value in addition to the design allowlist. Production worker code must construct the command environment explicitly and must not forward `process.env`; `PWD` is established by the command working directory.

### Conclusion

The proposed profile works on the deployment kernel and toolchain, including from a systemd-managed service context. No blocker was found for proceeding to the inherited-data-FD spike. The system-manager command above remains a required deployment validation because changing unit namespace restrictions can invalidate this conclusion.
