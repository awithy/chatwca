# Gondolin Workspace Sandboxing Research

**Date:** 2026-08-31  
**Status:** Feasible; implementation spike recommended  
**Gondolin version reviewed:** `0.12.0`  
**Gondolin commit reviewed:** `29fa74d802112f29c720990aced26165e0d57d84`

## Summary

Gondolin is a viable and well-aligned way to add workspace-level sandboxing to ChatWCA. It runs untrusted code in a local Linux micro-VM, using QEMU by default, while host-side TypeScript mediates command execution, filesystem access, and networking.

The proposed ChatWCA workspace options are:

```ts
sandbox: boolean; // default false
sandboxNetworkPolicy: 'none' | 'allowlist' | 'public-web'; // default 'none'
sandboxNetworkAllowedHosts: string[]; // used by 'allowlist'
```

For a sandboxed workspace, ChatWCA should create one Gondolin VM per live conversation runtime, mount the workspace read/write at `/workspace`, and route Pi's built-in coding tools into that VM. Model requests, model credentials, ChatWCA metadata, and Pi session persistence should remain on the host. The network policy applies to every conversation in the workspace and controls guest HTTP/TLS egress; unsandboxed workspaces retain their existing unrestricted host networking.

This is not just theoretically possible: Gondolin includes a Pi extension example, and the pinned Pi SDK 0.84.3 also ships a more complete Gondolin extension example using the exact tool-operation interfaces ChatWCA can use.

However, the examples should not be copied verbatim. ChatWCA needs additional controls to prevent environment-secret leakage, protect workspace-local session files, constrain host-side extensions/custom tools, and define a deliberate network policy.

## Sources reviewed

### Gondolin

- Repository: <https://github.com/earendil-works/gondolin>
- Pi integration example: <https://github.com/earendil-works/gondolin/blob/main/host/examples/pi-gondolin.ts>
- Documentation: <https://earendil-works.github.io/gondolin/>
- SDK: <https://earendil-works.github.io/gondolin/sdk/>
- Security design: <https://earendil-works.github.io/gondolin/security/>
- Limitations: <https://earendil-works.github.io/gondolin/limitations/>
- VFS providers: <https://earendil-works.github.io/gondolin/vfs/>
- VM backends: <https://github.com/earendil-works/gondolin/blob/main/docs/backends.md>
- Local clone reviewed at `/tmp/gondolin-review`.

Relevant files reviewed from that clone:

- `README.md`
- `host/examples/pi-gondolin.ts`
- `host/package.json`
- `docs/architecture.md`
- `docs/backends.md`
- `docs/limitations.md`
- `docs/qemu.md`
- `docs/sdk.md`
- `docs/sdk-network.md`
- `docs/sdk-storage.md`
- `docs/sdk-vm.md`
- `docs/security.md`
- `docs/vfs.md`

### Pi SDK 0.84.3

The pinned Pi package contains a complete Gondolin extension example at:

```text
node_modules/@earendil-works/pi-coding-agent/examples/extensions/gondolin/
```

Its `package.json` pins:

```json
{
  "@earendil-works/gondolin": "0.12.0"
}
```

Pi documentation and examples reviewed:

- `docs/extensions.md`
- `docs/sdk.md`
- `examples/extensions/gondolin/index.ts`
- `examples/extensions/sandbox/index.ts`
- `examples/extensions/tool-override.ts`
- `examples/sdk/06-extensions.ts`
- `examples/sdk/12-full-control.ts`
- `examples/sdk/13-session-runtime.ts`

ChatWCA files reviewed:

- `README.md`
- `docs/design.md`
- `docs/pi-sdk-notes.md`
- `src/server/database.ts`
- `src/server/workspace-repository.ts`
- `src/server/conversation-registry.ts`
- `src/server/pi-runtime.ts`
- `package.json`

## Gondolin architecture and security model

Gondolin consists of:

- A trusted host-side Node.js/TypeScript control plane.
- A Linux guest VM running untrusted commands.
- QEMU as the default VM boundary, with experimental `libkrun` support.
- Virtio-serial channels for command and filesystem RPC.
- A mediated virtio network path rather than generic NAT.
- A programmable host-side virtual filesystem exposed to the guest through FUSE.

Its intended guarantee is that guest code cannot directly access the host kernel, memory, network, or filesystem except through explicitly configured host-side interfaces, assuming there is no QEMU escape.

Important non-goals include:

- Defending against a malicious host process or same-account local user.
- Defending against QEMU/hypervisor escapes.
- Side-channel resistance.
- Complete denial-of-service isolation.

## Evidence that Pi integration is supported

Pi supports replacing built-in tool execution while preserving the built-in tool schemas and rendering. The relevant factories and operation interfaces include:

- `createReadTool` / `ReadOperations`
- `createWriteTool` / `WriteOperations`
- `createEditTool` / `EditOperations`
- `createBashTool` / `BashOperations`
- `createGrepTool`
- `createFindTool` / `FindOperations`
- `createLsTool` / `LsOperations`

An extension can register a tool using the same name as a built-in tool to override its execution. Pi also supports inline extension factories through `DefaultResourceLoader` and, in ChatWCA's advanced runtime path, through:

```ts
createAgentSessionServices({
  cwd,
  resourceLoaderOptions: {
    extensionFactories: [/* sandbox extension */],
  },
});
```

The pinned SDK's Gondolin example routes `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` into a VM, routes user `!` commands into the VM, and changes the model-visible working directory from the host path to `/workspace`.

ChatWCA already creates CWD-bound services for each conversation runtime, so sandbox selection naturally belongs at that boundary.

## Recommended ChatWCA behavior

### Workspace metadata

Add SQLite-backed sandbox and network-policy properties:

```ts
type SandboxNetworkPolicy = 'none' | 'allowlist' | 'public-web';

interface Workspace {
  // existing fields
  sandbox: boolean;
  sandboxNetworkPolicy: SandboxNetworkPolicy;
  sandboxNetworkAllowedHosts: string[];
}
```

Recommended semantics:

- Default `sandbox` to `false` and `sandboxNetworkPolicy` to `none` for existing and newly created workspaces unless explicitly enabled.
- `none` denies guest network access.
- `allowlist` permits mediated HTTP/TLS only to explicitly configured public hosts.
- `public-web` permits mediated HTTP/TLS to public hosts, but remains subject to internal-range blocking and protocol restrictions.
- The allowlist is part of v1. Validate and canonicalize entries on write, reject malformed hosts, remove duplicates, and define exact-host versus wildcard matching unambiguously. Exact host matching is the safer initial behavior.
- The network policy applies to every conversation runtime belonging to the workspace. If per-conversation exceptions are needed later, the workspace policy can become the default copied into new conversations.
- The network setting is enforceable only for sandboxed workspaces. Unsandboxed tools execute on the host and retain host network access.
- Expose sandbox and network controls during creation and show the effective policies in Workspace Info.
- If either policy is editable after creation, reject changes while the workspace owns any live conversation runtime. Changing it requires disposing and reconstructing CWD-bound Pi services, tools, and network hooks.
- Alternatively, make the settings immutable like `sessionStorage`; this is simpler but less flexible.
- Display visible sandbox and network indicators in the conversation header.

A schema migration would add a boolean-like checked integer column and a checked network-policy column, plus storage for the normalized allowlist. For example:

```sql
ALTER TABLE workspaces
ADD COLUMN sandbox INTEGER NOT NULL DEFAULT 0
  CHECK (sandbox IN (0, 1));

ALTER TABLE workspaces
ADD COLUMN sandbox_network_policy TEXT NOT NULL DEFAULT 'none'
  CHECK (sandbox_network_policy IN ('none', 'allowlist', 'public-web'));
```

The allowlist can be stored as validated JSON or in a normalized child table. A child table gives cleaner uniqueness and update semantics; validated JSON is simpler if workspace settings are always replaced atomically.

### VM ownership

Use one Gondolin VM per live conversation runtime, while the policy enabling it remains workspace-level.

Benefits:

- Clear lifecycle ownership.
- Independent guest root filesystems between conversations.
- Closing or replacing one conversation cannot invalidate another conversation's VM.
- Pi's `session_shutdown` and ChatWCA runtime disposal map directly to `vm.close()`.
- This follows the ownership pattern in the Pi/Gondolin examples.

A shared VM per workspace would reduce memory usage but introduces command serialization, lifecycle reference counting, cross-conversation guest state, and failure coupling. It is not recommended for the initial implementation.

### Host/guest filesystem mapping

Mount the host workspace read/write at:

```text
/workspace
```

using a hardened provider stack based on:

```ts
new RealFSProvider(workspacePath)
```

`RealFSProvider` blocks symlink escapes for operations that follow symlinks. Reads and writes under the mount affect the actual host workspace, which is necessary for a coding agent.

The mount should be wrapped with `ShadowProvider` to hide ChatWCA-owned data. At minimum, hide:

```text
/.chatwca
```

This is essential when a workspace uses workspace-local session storage because its canonical Pi JSONL files live at:

```text
<workspace>/.chatwca/sessions
```

Without shadowing, the guest agent could inspect, alter, or delete its own canonical session history.

Additional optional shadow policies could hide:

- `/.env`
- `/.env.*`
- `/.npmrc`
- private-key files
- host-architecture `node_modules`

Hiding secrets changes expected coding behavior and therefore requires an explicit product decision. Hiding `/.chatwca` should be mandatory.

### Tool routing

For sandboxed workspaces, route all relevant built-in coding tools through Gondolin:

- `read`
- `write`
- `edit`
- `bash`
- `grep`
- `find`
- `ls`

Absolute paths inside the host workspace should map to `/workspace/...`. Absolute paths outside the host workspace should remain guest-absolute paths, which exposes only guest filesystem content rather than host content.

The system prompt should identify `/workspace` as the effective working directory. Host paths should not be presented as places where commands execute.

Sandbox startup and tool failures must fail closed. ChatWCA must never silently fall back to host filesystem or host shell execution if QEMU or Gondolin fails.

### Runtime construction

The runtime policy should be passed explicitly rather than inferred from `process.cwd()`.

The upstream examples capture:

```ts
const localCwd = process.cwd();
```

That is incorrect for ChatWCA because the server process CWD is the ChatWCA repository, while every conversation has its own workspace CWD.

Recommended adaptation:

```ts
createGondolinExtension({
  hostWorkspacePath: runtimeCwd,
  // explicit policy options
});
```

`ConversationRegistry` already resolves workspace ownership during create/open/fork operations. Its runtime factory calls should carry the resolved sandbox policy explicitly into `PiRuntimeFactory` and then into `createAgentSessionServices()`.

Fork and rewind temporary runtimes must inherit the source workspace sandbox policy. Runtime replacement must close the old VM through extension shutdown and create a new sandboxed runtime consistently.

## Critical security caveats

### 1. Do not forward Pi's shell environment into the guest

This is the most important deviation from the examples.

Pi's built-in bash tool constructs an environment from `process.env`. In ChatWCA, that environment may include model-provider credentials and other server secrets. The Gondolin examples sanitize values by type but then pass the resulting environment to `vm.exec()`. Type sanitization does not remove secrets.

Gondolin's own security documentation explicitly says not to put real secrets in `VM.env` or otherwise expose them to the guest.

ChatWCA should ignore the inherited Pi shell environment and create a small, explicit guest-safe environment. It should not expose:

- provider API keys;
- ChatWCA server secrets;
- `PI_CODING_AGENT_DIR`;
- host `PATH` values;
- `PI_SESSION_FILE` host paths;
- arbitrary variables loaded from `.env` or systemd.

If guest workloads later need credentials, they should use Gondolin's `createHttpHooks()` secret-placeholder mechanism, where real values remain on the host and are substituted only for approved destinations.

### 2. Tool sandboxing does not sandbox extension code

Pi extensions are JavaScript/TypeScript modules executed in the ChatWCA host process with full host permissions. Gondolin only isolates commands and file operations routed through its VM APIs.

Therefore a workspace cannot be described as strongly sandboxed if untrusted project-local extensions are still loaded on the host. Likewise, a custom tool can bypass Gondolin unless it is explicitly routed or blocked.

For a strong sandbox mode:

- Disable project-discovered extensions for sandboxed workspaces.
- Prefer disabling all discovered extensions and injecting only a trusted ChatWCA-owned inline sandbox extension.
- Alternatively, implement an explicit allowlist of trusted global/provider extensions.
- Block non-approved tools in a `tool_call` gate so an extension or future custom tool cannot silently execute host operations.

The tradeoff is that disabling all discovered extensions may disable model providers or other trusted features configured through global Pi extensions. A selective trusted-extension policy may eventually be required.

Skills, prompts, and context files are host-read data rather than executed code, but they can instruct the model to invoke tools. The tool boundary must remain authoritative.

### 3. Network policy must be explicit

Gondolin does not provide generic NAT, but its default HTTP policy is not necessarily deny-by-default. `createHttpHooks()` treats an omitted `allowedHosts` option as `['*']`, while still blocking internal address ranges by default.

V1 should expose a workspace-level `sandboxNetworkPolicy` with three modes:

- `none`: pass `allowedHosts: []` and deny outbound HTTP/TLS;
- `allowlist`: pass the workspace's validated `sandboxNetworkAllowedHosts`;
- `public-web`: pass `allowedHosts: ['*']`.

All modes must retain `blockInternalRanges: true`. The effective configuration is conceptually:

```ts
const allowedHosts =
  policy === 'none' ? [] :
  policy === 'public-web' ? ['*'] :
  validatedAllowedHosts;

const { httpHooks } = createHttpHooks({
  allowedHosts,
  blockInternalRanges: true,
});
```

The allowlist should initially support exact public hostnames. Scheme, path, userinfo, and ambiguous wildcard syntax should be rejected rather than guessed. If ports are supported by Gondolin's host syntax, permitted ports must be explicit; otherwise v1 should remain on standard HTTP/TLS ports. Redirects must be revalidated at every hop, and tests must confirm that DNS resolution or redirects cannot reach loopback, link-local, private, or other blocked ranges.

Any permitted host must be treated as able to receive all guest-readable workspace data. An allowlist limits destinations but is not a data-loss-prevention mechanism: package registries, source hosts, and other legitimate services can still be used for exfiltration. `public-web` should therefore require a prominent warning in the UI.

Mapped TCP and SSH are reduced-security exception paths and should remain disabled initially. WebSockets should also be disabled unless explicitly needed because traffic becomes opaque after the allowed HTTP upgrade handshake. Real credentials must not be added to the guest for any mode; future authenticated access should use Gondolin secret placeholders with per-secret destination restrictions.

### 4. The workspace itself is not protected from modification

A read/write `RealFSProvider` confines the guest to the workspace but does not protect workspace content. The agent can intentionally or accidentally modify or delete files in the workspace.

This feature provides compute, network, and outside-workspace host isolation. It does not provide file rollback or protection from destructive changes inside the selected workspace.

Git, filesystem snapshots, or a copy-on-write workspace provider would be separate features.

### 5. Abort does not necessarily kill guest processes immediately

Gondolin documents that aborting an `ExecProcess` rejects the host-side promise but does not currently guarantee that the guest process is terminated. A long-running process could remain active and block later exec requests until the VM is reset or closed.

The integration needs tests and policy for:

- prompt abort;
- tool timeout;
- closing a conversation after abort;
- server shutdown during an active guest command;
- whether an aborted VM should be discarded and lazily recreated.

### 6. VM and host limits remain necessary

Gondolin does not provide complete denial-of-service isolation. Guest code can consume its allocated CPU/memory and cause bounded but significant host work.

The default VM memory documented in the SDK is 1 GiB. With ChatWCA's default maximum of eight live conversations, one VM per runtime could imply up to eight retained VMs. The implementation should explicitly configure VM CPU/memory and consider a separate sandbox-VM capacity limit.

Lazy VM startup on the first prompt/tool avoids booting a VM merely because a conversation was opened. Eager startup detects configuration errors earlier but makes ChatWCA's automatic opening of a workspace's latest conversation expensive. Lazy startup is recommended initially, with a visible starting state on first use.

## Network and credential architecture

Model-provider requests should continue running in the trusted ChatWCA host process. Provider credentials remain in Pi's host-side `ModelRuntime` and should never enter the guest.

This creates the intended split:

```text
Browser
  -> ChatWCA host
       -> Pi ModelRuntime/provider APIs (host credentials stay here)
       -> Pi session JSONL store (host)
       -> Gondolin VM
            -> sandboxed coding tools
            -> /workspace via controlled VFS
            -> mediated/denied network
```

If guest commands need access to a remote service later, use Gondolin secret placeholders and per-secret host allowlists. Do not put real tokens in guest environment variables, files, command lines, or mounted credential directories.

## Lifecycle mapping

Recommended lifecycle:

```text
workspace selected
  -> history only; no VM required

conversation opened
  -> Pi runtime created
  -> trusted sandbox extension installed when workspace.sandbox = true
  -> VM remains lazy

first prompt/tool
  -> start Gondolin VM
  -> mount protected workspace at /workspace
  -> run tools in guest

conversation fork/runtime replacement
  -> old extension receives session_shutdown
  -> close old VM
  -> replacement services recreate sandbox extension from workspace policy

conversation close or LRU eviction
  -> Pi runtime dispose
  -> extension session_shutdown
  -> vm.close()

server shutdown
  -> abort active Pi runs
  -> dispose every runtime
  -> await bounded vm.close() operations
  -> force network/process shutdown at global deadline
```

VM cleanup must be idempotent. Startup failure must clear any partially created VM state so a later retry is well-defined.

## Database, protocol, and UI changes

Likely implementation areas:

### Database/repository

- Raise `DATABASE_SCHEMA_VERSION`.
- Add and migrate `workspaces.sandbox` with default `0`.
- Add `sandbox_network_policy` with default `none` and storage for a validated host allowlist.
- Add sandbox and network-policy fields to `WorkspaceRow`, `Workspace`, and `WorkspaceSummary`.
- Extend create/update statements and tests.
- If mutable, reject sandbox or network-policy changes when `ConversationRegistry.hasLiveWorkspace()` is true.

### Shared WebSocket protocol

- Add required or defaulted `sandbox`, `sandboxNetworkPolicy`, and `sandboxNetworkAllowedHosts` to `workspace.create`.
- Add the same fields optionally to `workspace.update` if mutable.
- Include the authoritative effective sandbox and network policy in workspace list responses.
- Validate strictly with TypeBox, including policy/allowlist consistency, host syntax, canonicalization, duplicate removal, and bounded entry count and length.

### Frontend

- Add a default-disabled **Sandbox this workspace** checkbox at creation.
- For sandboxed workspaces, add **No network**, **Allowed hosts**, and **Public web** choices, defaulting to **No network**.
- Provide an allowlist editor with per-entry validation.
- If mutable, expose the controls during editing with clear live-runtime constraints.
- Show sandbox and effective network state in Workspace Info.
- Show visible sandbox and network badges in `ConversationHeader`.
- Warn that allowed destinations can receive any guest-readable workspace content and that `public-web` is not an exfiltration boundary.
- Explain that the workspace remains writable and that startup may download guest assets.
- Surface stable errors for VM unavailable/start failure/tool-routing/network-policy failure.

### Runtime/registry

- Extend the runtime factory port so create/open operations receive workspace runtime policy explicitly.
- Preserve sandbox policy for temporary fork runtimes and runtime replacement.
- Inject a ChatWCA-owned inline extension through `resourceLoaderOptions.extensionFactories`.
- Prevent host fallback and unauthorized tools.
- Ensure VM closure is included in normal close, LRU eviction, replacement, and graceful shutdown.

## Host readiness findings

The current host is suitable for a QEMU/KVM spike.

Observed environment:

```text
OS: Linux x86_64
Kernel: 6.8.0-136-generic
QEMU: /usr/bin/qemu-system-x86_64
QEMU version: 6.2.0 (Ubuntu 22.04 package)
/dev/kvm: present
KVM accelerator: listed by qemu-system-x86_64 -accel help
ChatWCA service user: adrian
adrian kvm group: yes (gid 109)
running service supplementary groups include kvm: yes
production /usr/bin/node: v24.20.0
interactive development node: v22.22.1
```

The running systemd service is therefore positioned to use `/dev/kvm`.

QEMU 6.2.0 is relatively old, so compatibility should be proven with an actual Gondolin boot rather than assumed.

## Node.js compatibility issue

Gondolin 0.12.0 declares:

```json
{
  "engines": {
    "node": ">=23.6.0"
  }
}
```

ChatWCA currently declares and documents Node `>=22.19.0`. The production systemd service uses Node 24.20.0, which is compatible, but the current interactive development shell uses Node 22.22.1, which is not officially supported by Gondolin.

Before adding Gondolin as a production dependency:

- Move ChatWCA's documented and package minimum to Node 24.
- Ensure development, CI, `npm ci`, tests, and production all use Node 24.
- Keep `/usr/bin/node` in systemd or otherwise pin a known Node 24 binary.

## First-run assets

Gondolin automatically resolves and caches guest kernel/initramfs/rootfs assets. The repository documentation states that these assets are approximately 200 MB or more and are downloaded on first use.

Operational implications:

- First sandbox startup will be slower and requires network access from the host.
- Assets are cached under Gondolin's cache directory, normally below `~/.cache/gondolin`.
- The service user must have write access to that cache.
- Production deployment should consider prefetching assets before serving sandboxed workspaces.
- Backup of disposable Gondolin cache data is not required, but disk capacity and cache cleanup should be documented.

## Recommended proof-of-concept sequence

Do not begin with the full UI/schema implementation. First prove the runtime boundary on this host.

### Phase 1: standalone Gondolin smoke test

1. Standardize the shell on Node 24.
2. Install `@earendil-works/gondolin@0.12.0` in an isolated spike.
3. Download/resolve guest assets.
4. Boot a QEMU/KVM VM.
5. Verify that KVM, rather than TCG, is selected.
6. Mount a temporary host workspace at `/workspace`.
7. Verify guest writes appear in the host workspace.
8. Verify guest access to host paths outside the workspace fails.
9. Verify symlink escapes fail.
10. Verify `/.chatwca` is hidden by `ShadowProvider`.
11. Verify network deny-by-default.
12. Verify an exact-host allowlist permits only configured hosts, revalidates redirects, and still blocks internal ranges.
13. Verify public-web mode reaches public HTTP/TLS destinations but not internal ranges or disabled protocols.
14. Verify `vm.close()` leaves no QEMU process/session socket behind.

### Phase 2: Pi adapter smoke test

1. Adapt the pinned Pi 0.84.3 Gondolin example into a factory that receives an explicit workspace path.
2. Use Pi's deterministic faux provider.
3. Exercise every enabled built-in tool.
4. Verify no provider credential or unrelated environment variable appears in the guest.
5. Verify tool output streaming and truncation.
6. Verify prompt abort and tool timeout behavior.
7. Verify session shutdown closes the VM.
8. Verify fork/runtime replacement creates and disposes VMs correctly.

### Phase 3: ChatWCA integration

1. Add schema/protocol/repository changes.
2. Thread workspace policy through registry/runtime creation.
3. Add UI controls and status.
4. Add stable public error codes.
5. Add unit, integration, browser, and shutdown tests.
6. Document resource usage, first-run downloads, network behavior, and security boundaries.

## Testing requirements

At minimum, tests should cover:

- database migration defaults existing workspaces to `sandbox: false` and network policy `none`;
- create/list/update behavior for sandbox, network mode, and allowlist fields;
- malformed, duplicate, oversized, and mode-inconsistent allowlists are rejected or canonicalized as specified;
- sandbox or network-policy changes are rejected while a workspace has live conversations;
- unsandboxed workspaces retain current host-tool behavior;
- sandboxed create/open/fork all receive sandboxed tools;
- source-preserving fork does not leak or reuse the source VM incorrectly;
- all host paths outside the workspace remain inaccessible;
- workspace-local `.chatwca` is inaccessible from the guest;
- environment secrets are absent in the guest;
- network requests are denied under the default policy;
- allowlist mode permits exact configured hosts and denies unlisted hosts;
- allowlist redirects, DNS resolution, IP literals, and alternate ports cannot bypass internal-range restrictions;
- public-web mode permits public HTTP/TLS while internal ranges and unsupported protocols remain blocked;
- no network mode forwards provider credentials or unrelated host environment variables;
- custom or extension tools outside the approved set are blocked;
- VM boot failure does not fall back to host execution;
- close and idle LRU eviction stop QEMU;
- graceful shutdown closes every VM within the configured deadline;
- slow/aborted commands do not leave reusable contaminated runtimes;
- browser UI accurately shows sandbox policy and startup failures.

## Recommendation

Proceed with a small standalone and Pi-adapter spike before changing the persistent workspace model.

The feature is feasible and the existing Pi/Gondolin examples significantly reduce implementation risk. The key to making it a real security boundary is to treat Gondolin as more than a replacement bash backend: ChatWCA must also prevent environment leakage, protect `/.chatwca`, constrain host-side extensions/custom tools, define network behavior, and fail closed.
