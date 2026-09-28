# Workspace HTTP Tools Design

**Status:** Implemented

**Runtime:** Node.js 22.19+, TypeScript, Pi SDK 0.84.3

**Audience:** Implementers and maintainers

## 1. Summary

ChatWCA supports a startup-loaded catalog of fixed JSON-over-HTTP tools. The catalog defines executable tools, while each registered workspace independently selects which catalog tools its conversations may use. No tool is enabled for a workspace by default.

Catalog definitions remain file-based and are not editable in the browser. Workspace selections are ordinary ChatWCA workspace metadata persisted in SQLite and editable from the existing Add/Edit Workspace dialog. This separates two concerns:

- the catalog defines what a tool is and where its parent-owned request goes;
- the workspace row defines whether that tool is available in that workspace.

Granted HTTP tools execute in the ChatWCA parent process as Pi custom tools. They therefore work for unrestricted, managed-egress, and network-isolated workspace runtimes. Enabling a tool does not open general sandbox networking. It grants only the fixed request represented by that tool definition.

The first catalog tool is `network_brain_search`, which sends a JSON `POST` request to `http://127.0.0.1:53147/v1/search`.

## 2. Goals

- Define HTTP tools in one startup-only JSON file.
- Persist per-workspace tool selections in SQLite.
- Default every workspace to no enabled HTTP tools.
- Let the user enable or disable catalog tools in the workspace UI.
- Make granted tools available in unrestricted and workspace-sandboxed conversations, including isolated networking.
- Keep a live conversation's tool set immutable for its lifetime.
- Apply current workspace selections to newly created, opened, forked, rewound, and scheduled conversations.
- Bound requests by fixed destination, method, timeout, response bytes, JSON parsing, and model-facing truncation.
- Preserve missing catalog selections without silently substituting another tool.
- Require no MCP client or server.

## 3. Non-goals

The initial implementation does not include:

- Editing tool definitions, URLs, schemas, or limits in the browser
- Discovering tools dynamically
- MCP transport, resources, prompts, or server lifecycle
- Arbitrary browser- or model-supplied URLs, methods, headers, or credentials
- Generic OAuth, API-key, or secret injection
- Streaming HTTP tool responses
- Non-JSON request or response bodies
- GET, PUT, PATCH, or DELETE tools
- Per-conversation enable/disable controls
- Interactive approval for individual tool calls
- Hot-reloading the catalog
- Routing parent-owned tools through the Bubblewrap managed-egress proxy

## 4. Terminology

- **Catalog tool:** A validated HTTP tool definition loaded from the configured catalog file.
- **Stored selection:** A tool name persisted for a workspace in SQLite.
- **Effective tool:** A stored selection whose name exists in the currently loaded catalog.
- **Unavailable selection:** A stored selection whose definition is absent from the current catalog.
- **Parent-owned tool:** A Pi tool whose `execute()` function and HTTP request run in the ChatWCA server process rather than the workspace worker.

## 5. Catalog configuration

### 5.1 Location and lifecycle

`CHATWCA_TOOL_CATALOG` optionally names the catalog file. Relative paths resolve against the server process's current working directory. When the variable is absent, the effective catalog is empty and all workspace HTTP tools are unavailable.

The catalog is read and validated once at startup. Changes require restarting ChatWCA. Startup fails for an explicitly configured missing, unreadable, oversized, malformed, or invalid catalog.

The repository-local `tool-catalog.json` is gitignored. `tool-catalog.example.json` documents the contract.

### 5.2 Final file shape

Workspace assignments do not belong in the final catalog format. The final v1 shape is:

```json
{
  "version": 1,
  "tools": [
    {
      "name": "network_brain_search",
      "label": "Network Brain Search",
      "description": "Search locally indexed networking and infrastructure documentation.",
      "method": "POST",
      "url": "http://127.0.0.1:53147/v1/search",
      "parameters": {
        "type": "object",
        "additionalProperties": false,
        "required": ["query"],
        "properties": {
          "query": { "type": "string", "minLength": 1, "maxLength": 1000 },
          "limit": { "type": "integer", "minimum": 1, "maximum": 10 }
        }
      },
      "timeoutMs": 30000,
      "maxResponseBytes": 1048576
    }
  ]
}
```

Top-level workspace grants are not accepted. There is one authority for workspace selections: SQLite.

### 5.3 Validation

At startup ChatWCA validates:

- catalog version and closed top-level structure;
- catalog file size and maximum tool count;
- unique lowercase tool names;
- collisions with built-in and ChatWCA-owned tool names;
- non-empty bounded labels and descriptions;
- fixed `POST` method;
- absolute HTTP or HTTPS URLs without embedded credentials or fragments;
- object-shaped JSON Schema parameters with `additionalProperties: false`;
- positive bounded timeout and response-byte limits.

Definitions are frozen after loading. Browser commands refer only to tool names and cannot supply or modify definition bytes.

## 6. SQLite persistence

### 6.1 Schema v8

Schema v8 adds an initially empty join table:

```sql
CREATE TABLE workspace_http_tools (
  workspace_id TEXT NOT NULL
    REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL
    CHECK (
      length(tool_name) BETWEEN 1 AND 64 AND
      tool_name NOT GLOB '*[^a-z0-9_]*' AND
      substr(tool_name, 1, 1) GLOB '[a-z]'
    ),
  PRIMARY KEY (workspace_id, tool_name)
);
```

There is deliberately no foreign key from `tool_name` to a catalog table because catalog definitions are external startup configuration, not SQLite rows.

The v7-to-v8 migration creates the empty table transactionally and advances `user_version` only after success. Every existing workspace therefore migrates with no selected HTTP tools.

### 6.2 Repository behavior

`WorkspaceRepository` loads stored tool names with every workspace. Create and update replace a workspace's selections transactionally with the rest of its mutable policy.

Rules:

- Creation defaults `enabledHttpTools` to `[]`.
- Submitted names must be unique and currently present in the loaded catalog.
- Unknown browser-submitted names are rejected.
- Deleting a workspace cascades its selections.
- Removing a tool from the catalog does not delete its stored rows.
- Reintroducing the same tool name makes the preserved selection effective again.
- An unavailable selection does not make the whole workspace unusable; it simply contributes no executable tool.
- No tool is silently substituted for a missing name.

Workspace summaries expose both stored and effective names:

```ts
interface WorkspaceSummary {
  enabledHttpTools: readonly string[];   // stored selections
  effectiveHttpTools: readonly string[]; // intersection with current catalog
}
```

The difference identifies unavailable selections without another issue code.

## 7. Public configuration and protocol

### 7.1 Safe catalog projection

`GET /api/config` and the initial WebSocket configuration expose the currently available definitions needed by the form:

```ts
interface PublicHttpTool {
  name: string;
  label: string;
  description: string;
  method: "POST";
  url: string;
}
```

Schemas and operational limits need not be editable, but the fixed destination is shown so the user understands the authority being granted. Catalog files cannot contain URL credentials.

### 7.2 Workspace commands

`workspace.create` accepts optional `enabledHttpTools`, defaulting to `[]`.

`workspace.update` accepts optional `enabledHttpTools`. Omission preserves current selections; an explicit empty array disables all tools.

Changing `enabledHttpTools` is a runtime-authority change. The protocol rejects it with `workspace_busy` while any conversation in that workspace is live, matching path, mount, security, and network-policy changes.

Authoritative workspace list responses and broadcasts include stored and effective tool names.

## 8. Runtime resolution

`WorkspaceRepository.requireUsable()` resolves effective catalog definitions from the stored names and places an immutable snapshot on `RuntimeWorkspacePolicy`.

A runtime captures that snapshot at creation. It does not re-read SQLite or the catalog during its lifetime. The same snapshot is used when Pi reconstructs services during fork or rewind.

`PiRuntimeFactory` converts each effective definition into a custom Pi `ToolDefinition`:

- unrestricted sessions receive the selected custom tools in the parent;
- strict sandbox sessions receive the same parent-owned custom tools alongside the seven worker-backed coding tools;
- the sandbox worker receives no endpoint URL, network route, credential, or generic parent transport;
- isolated networking remains isolated for all workspace processes.

Scheduled jobs call the existing `requireUsable()` path and therefore use the workspace's current effective selection at the beginning of each occurrence.

Conversation state should expose the captured effective tool names so a live header or info panel can describe immutable runtime authority accurately.

## 9. HTTP execution contract

For one tool call ChatWCA:

1. accepts parameters validated by Pi against the configured schema;
2. serializes the complete input object as the JSON request body;
3. sends a `POST` to the fixed configured URL;
4. sets `Accept: application/json` and `Content-Type: application/json`;
5. disables redirects;
6. combines Pi cancellation with the configured timeout;
7. rejects non-success HTTP status without exposing the response body;
8. accepts only `application/json` or `+json` response content types;
9. bounds response bytes while streaming;
10. parses JSON and formats it for the model;
11. truncates model-facing output using Pi's standard byte/line limits; and
12. returns bounded status/truncation details for transcript rendering.

Transport diagnostics, response bodies on error, and stacks are not exposed. Tool results and remote JSON are untrusted model context.

## 10. Sandbox and security semantics

A granted HTTP tool is an intentional parent-side capability. It bypasses isolated and managed-egress workspace networking in the same architectural sense as `web_search`, but it can contact only its fixed catalog URL.

Consequences shown in the UI and strict system prompt:

- the tool remains callable when workspace networking is isolated;
- tool arguments can include model-selected text derived from readable workspace files and mounts;
- the configured endpoint can receive that data;
- returned JSON is untrusted;
- enabling the tool does not let Bash, dependencies, or other workspace processes access the endpoint;
- disabling the tool removes it from future runtime tool sets but cannot mutate an already-live runtime.

The initial catalog has no secret/header mechanism. If credentials are added later, they must remain parent-only and be referenced indirectly rather than stored in workspace rows or sent to the browser/model.

## 11. Workspace UI

The existing Add/Edit Workspace form gains a **Parent-owned HTTP tools** fieldset.

For each public catalog tool it shows:

- an unchecked-by-default checkbox;
- label and model-facing description;
- fixed method and URL;
- a warning that calls run outside sandbox networking and may disclose readable workspace content.

Behavior:

- new workspaces start with every checkbox unchecked;
- edit mode initializes from stored selections;
- tool controls are locked while the workspace has a live conversation;
- saving a changed selection sends `enabledHttpTools`;
- unchanged selections are omitted from update commands;
- unavailable stored selections are shown as unavailable and can be removed once the workspace is idle;
- Workspace Info shows stored, effective, and unavailable selections;
- an empty catalog shows a concise “No HTTP tools configured” state.

No additional confirmation dialog is required: checking the clearly disclosed capability and saving is the explicit action.

## 12. Failure and compatibility behavior

- Missing `CHATWCA_TOOL_CATALOG`: server starts with an empty catalog.
- Explicitly configured invalid catalog: startup fails before listening.
- Endpoint unavailable: only that tool call fails; the conversation remains usable.
- Tool removed from catalog: its persisted selection remains stored but inactive.
- Tool definition changed and server restarted: new runtimes use the new definition; old runtimes ended at restart.
- Workspace update during a live runtime: rejected with `workspace_busy`.
- Network Brain not running: `network_brain_search` produces a redacted tool failure.
- Database backup/restore preserves selections; the catalog file and `.env` must be backed up separately.

## 13. Testing strategy

### Unit tests

- Catalog parsing, defaults, size bounds, names, URLs, schemas, and duplicate rejection
- Empty-catalog behavior
- HTTP request shape, cancellation, timeout, redirects, status handling, content type, byte limits, JSON parsing, and truncation
- Schema-v8 fresh initialization and v7 migration
- Workspace create/update/list/delete selection persistence
- Unknown, duplicate, absent, and unavailable tool-name behavior
- Stored/effective projection
- Protocol decoding and live-workspace busy checks
- Public configuration projection
- Workspace form validation and change detection

### Integration tests

- Unrestricted runtime receives only selected tools
- An unselected workspace cannot call or advertise the tool
- A selected isolated workspace advertises and executes the parent-owned tool while Bubblewrap networking remains isolated
- Open, fork, rewind, and scheduled runtimes preserve current selection semantics
- Catalog removal preserves stored selection but omits the runtime tool
- Runtime tool sets remain immutable until close/reopen

### Browser tests

- New workspace defaults all tools off
- Enable and disable a tool in Add/Edit Workspace
- Controls lock while a workspace runtime is live
- Workspace Info distinguishes effective and unavailable selections
- Isolated conversation header/info discloses the parent-owned capability

## 14. Implementation sequence

1. Amend the catalog contract to definitions-only and expose a public metadata projection.
2. Add schema v8 and repository persistence for `workspace_http_tools`.
3. Extend shared workspace schemas, commands, protocol dispatch, and runtime policy resolution.
4. Change `PiRuntimeFactory` to consume effective definitions from `RuntimeWorkspacePolicy` rather than config-file workspace paths.
5. Add workspace form controls, change detection, locking, and Workspace Info display.
6. Add conversation-state disclosure of captured effective tool names.
7. Update README, example catalog, backup notes, and acceptance criteria.
8. Run typecheck, build, unit, integration, browser, SDK smoke, and real sandbox tests.

## 15. Acceptance criteria

The feature is complete when:

- tool definitions exist only in the startup catalog;
- workspace grants exist only in SQLite;
- all existing and new workspaces default to no enabled tools;
- the UI can enable or disable available tools per workspace;
- changes are blocked while that workspace has a live conversation;
- selected tools work in unrestricted and isolated sandbox conversations;
- unselected tools are absent from the Pi tool set;
- removed catalog definitions never resolve to a different tool and do not break unrelated workspace use;
- live runtimes retain the exact tool set captured at creation;
- the fixed request and response bounds are enforced;
- Network Brain search works through `127.0.0.1:53147` from a selected isolated workspace; and
- the complete release checks pass.
