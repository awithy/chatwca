# ChatWCA managed-network helper

This Linux-only helper owns the privileged setup transition for managed-egress
sandbox workers. The server executes `--outer` with an empty environment and a
length-prefixed launch descriptor on fixed FD 3. The outer process validates the
descriptor and inherited FDs, opens its own executable once, creates two
conversation-owned bridges, and directly launches Bubblewrap. Bubblewrap runs
the immutable artifact as `--inner`.

The inner process verifies all namespaces and fixed descriptors, raises only
loopback, performs authenticated one-time `SCM_RIGHTS` listener handoffs, drops
and locks all capabilities, enables `NoNewPrivs` and the architecture-checked
seccomp policy, and executes only `/usr/bin/node /app/worker.mjs` with a closed
proxy environment.

Build and test with:

```sh
npm run build:network-helper
npm run test:native
```

The build writes an architecture-specific executable and integrity manifest to
`dist/native/<arch>/`. The server validates both before managed egress can be
used. Release CI builds x64 and arm64 artifacts on native runners. Deployment,
hash verification, startup probes, incident cleanup, and rollback are covered
by [`../../docs/network-sandbox-operations.md`](../../docs/network-sandbox-operations.md).
