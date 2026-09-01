# Network helper Phase 0 harness

This crate is the disposable native feasibility implementation from Phase 0 of
`docs/network-sandbox-design.md`. It is invoked only by
`scripts/phase0-network-helper.mjs` and is not part of the server build or any
production sandbox launch path.

The launch transition gives the inner process `CAP_NET_ADMIN` for loopback and
`CAP_SETPCAP` only so it can empty and lock the capability bounding set. Both
are removed before the immutable Node probe is executed. The harness fails
unless every capability set is empty, `NoNewPrivs` and seccomp are active, both
SCM listener handoffs work, and parent/Bubblewrap death removes the process
tree.

Run architecture-independent native tests with `npm run test:native`. Build the
host spike with `npm run build:network-helper-phase0`. The real Linux test is
conditional unless `CHATWCA_SANDBOX_CAPABLE=1`; CI runs
`npm run test:network-helper-real` directly and under the service-unit
constraints.
