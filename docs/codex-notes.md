# Codex CLI Security Notes for ChatWCA

ChatWCA's Bubblewrap and slirp4netns designs already cover Codex's main hard boundary: filesystem, process, environment, and network containment. The most valuable Codex-inspired additions are policy and authorization layers above that boundary.

## Highest-priority additions

### 1. Deterministic command execution policy

Codex can classify commands independently of the model as:

- **allow**;
- **prompt**; or
- **forbid**.

ChatWCA currently permits arbitrary `/bin/bash -lc` commands inside the sandbox. This limits host impact, but injected instructions can still damage the workspace.

Add administrator-defined rules for commands such as:

```text
forbid:
  sudo, mount, nsenter
  destructive disk/filesystem utilities
  credential or tunnel utilities

prompt:
  rm
  git reset --hard
  git clean
  git push
  package-manager install scripts
  chmod on executable files

allow:
  grep, find, git status, test runners
```

The policy should evaluate the parsed command—including pipelines, command chains, substitutions, and shell wrappers—rather than relying on simple string matching. Ambiguous commands should require approval or be rejected.

### 2. Per-action approvals, separate from sandbox policy

Codex distinguishes:

- whether authorization is required; and
- whether the OS sandbox permits the operation.

ChatWCA's acknowledgements currently apply when changing an entire workspace profile. Consider approvals for individual risky actions:

- enabling network access for one command;
- writing a protected file;
- modifying `.git`, hooks, CI, authentication, or deployment configuration;
- running a destructive command;
- publishing or pushing changes; and
- contacting a new external destination.

Approvals should be narrowly scoped:

```text
Allow once
Allow for this conversation
Allow this exact command pattern
Deny
```

The UI should show the exact command, affected paths, requested capability, destination if known, and why the action needs elevation. Approval must never silently replace sandbox enforcement.

### 3. Independent Guardian-style risk review

Codex includes a Guardian layer that reviews proposed actions separately from the reasoning process that produced them. It considers:

- whether the user explicitly authorized the exact action;
- whether the action is relevant to the task;
- whether it may have resulted from repository instructions or other untrusted content; and
- whether the operation expands privilege or causes irreversible effects.

ChatWCA could run such a reviewer before high-risk operations. Useful triggers include:

- bulk deletion or rewriting;
- authentication or security changes;
- dependency or lockfile modification;
- test removal or weakening;
- build, release, CI, or deployment changes;
- access to secrets;
- network transmission of workspace content; and
- Git pushes or external publication.

This is defense in depth, not a hard boundary: a reviewer is still model-based and can make mistakes.

### 4. Trusted/untrusted context provenance

Codex explicitly represents some additional context as untrusted. ChatWCA should preserve provenance when constructing model context:

- user instructions — trusted authorization;
- repository files — untrusted data;
- command output — untrusted data;
- downloaded content — untrusted external data;
- tool-generated summaries — derived/untrusted; and
- administrator policy — trusted and non-overridable.

This provenance should also be supplied to the approval or Guardian layer. Text inside a repository should never count as user authorization merely because the model read it.

A strong invariant would be:

> Only direct user or administrator input can authorize a risky capability; repository content, web content, and tool output cannot.

## Filesystem improvements

### 5. Protected paths inside the workspace

The current profile intentionally permits modification of all workspace content, including `.git`. Codex reapplies read-only protection to sensitive carve-outs inside otherwise writable roots.

Consider configurable protection for:

```text
.git/
.github/workflows/
.gitlab-ci.yml
CODEOWNERS
package manager lockfiles
deployment manifests
authentication/authorization modules
.env*
*.pem
*.key
```

Possible policies include:

- unreadable;
- read-only;
- writable only with approval; or
- writable normally but always reported as security-sensitive.

A dedicated `.git` capability would materially reduce persistence through hooks, configuration, and repository metadata while allowing ordinary source editing.

### 6. Fine-grained read-deny rules

The synthetic root already gives stronger host confidentiality than a typical read-only host-root sandbox. However, workspace-local secrets remain readable.

Add per-workspace deny or mask rules for files such as:

```text
.env
.env.*
secrets/
credentials.json
private keys
production configuration
workspace-owned registry tokens
```

This becomes particularly important when `unrestricted-egress` is enabled.

## Network improvements

### 7. Managed, destination-filtered egress

The proposed network choices are deliberately binary:

- no network; or
- unrestricted egress.

Codex also supports a managed proxy path. ChatWCA should consider an intermediate policy:

```ts
type SandboxNetworkPolicy =
  | "isolated"
  | "managed-egress"
  | "unrestricted-egress";
```

Managed egress could enforce:

- allowed domains and ports;
- denial of loopback, RFC-1918, link-local, and metadata addresses;
- DNS resolution followed by IP validation;
- redirect revalidation;
- connection and bandwidth limits;
- request logging; and
- optional package-registry-only profiles.

This would support package downloads and Git access without granting arbitrary exfiltration and internal-network scanning. Domain filtering must address DNS rebinding, CNAMEs, redirects, IPv6, and direct-IP connections.

## Trust and operational controls

### 8. Project trust mode

Codex treats untrusted projects more conservatively. ChatWCA could add a trust state distinct from the sandbox profile:

```ts
type WorkspaceTrust = "untrusted" | "trusted";
```

For an untrusted workspace:

- default all nontrivial shell commands to prompt;
- deny network unless explicitly approved;
- protect `.git`, CI, and dependency files;
- disable executable project context/configuration; and
- apply stricter Guardian review.

Trust should require an explicit user action and should not be inferred from repository content.

### 9. Security audit trail

Record security decisions separately from normal chat history:

- proposed command and normalized policy classification;
- approval request and user response;
- effective filesystem/network profile;
- protected paths touched;
- Guardian decision;
- capability elevation and duration;
- policy rule responsible for allow/deny; and
- sidecar and worker lifecycle failures.

Logs should be tamper-resistant from inside the workspace and redact secrets.

### 10. Stronger syscall restrictions

Codex's Linux containment includes seccomp alongside namespace and filesystem controls. The Bubblewrap design mentions seccomp mainly as future hardening.

A dedicated worker/command profile should consider denying unnecessary operations such as:

- namespace creation and mounting;
- `ptrace`;
- `bpf`, `perf_event_open`, and kernel keyrings;
- unusual device access;
- raw or packet sockets; and
- pathname Unix-socket connections, if workspace sockets must be a hard prohibition.

This would strengthen the current best-effort Unix-domain socket preflight and reduce kernel attack surface.

## Suggested implementation order

1. Deterministic exec policy.
2. Exact-action approval workflow.
3. Protected workspace paths, especially `.git` and secrets.
4. Trusted/untrusted context provenance.
5. Managed destination-filtered egress.
6. Guardian review for high-risk operations.
7. Project trust modes and security audit history.
8. Dedicated seccomp profiles.

ChatWCA's current architecture is already stricter than Codex in some areas: synthetic root construction, fixed environment, parent-free model-directed I/O, disabled extensions, and an app-owned tool set. The biggest remaining gap is therefore not another sandbox; it is controlling malicious actions that are valid **inside** the existing sandbox.
