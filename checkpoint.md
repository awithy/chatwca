# ChatWCA HTTP Tools Checkpoint

**Updated:** 2026-09-27T17:35:07-07:00

## Current objective

Finish fixed parent-owned HTTP tools with per-workspace SQLite enablement and browser controls. Tool definitions live only in the startup JSON catalog. Workspace selections live only in SQLite and default to disabled.

The intended end state remains documented in [`docs/http-tools-design.md`](docs/http-tools-design.md).

## User decisions to preserve

1. Do not introduce MCP for the initial HTTP tools.
2. Keep endpoint definitions in a startup-only config file; there is no definition-authoring UI.
3. Store per-workspace selected tool names in SQLite, disabled by default.
4. Edit selections in the existing Add/Edit Workspace UI.
5. Parent-owned tools must work in unrestricted and isolated/sandboxed conversations.
6. Tool selection is immutable for a live runtime and cannot be changed while the workspace has a live conversation.
7. The first tool is Network Brain search from `/home/adrian/projects/network-brain`.

## Network Brain contract

The first tool remains:

```text
network_brain_search -> POST http://127.0.0.1:53147/v1/search
```

Example request body:

```json
{
  "query": "where is nginx running?",
  "limit": 5
}
```

`/v1/answers` is intentionally not onboarded because ChatWCA can synthesize an answer from `/v1/search` chunks without launching a redundant model request.

## Implementation progress

The previous parent HTTP executor and strict-sandbox integration remain in the working tree. This session added the persistence, protocol, runtime-policy, public-config, and UI work needed to replace transitional path grants.

### 1. Definitions-only catalog

`src/server/http-tool-catalog.ts` now:

- accepts only top-level `version` and `tools`;
- rejects the transitional top-level `workspaces` property;
- keeps validated definitions startup-frozen;
- exports a safe `publicHttpTools()` projection containing only:
  - `name`
  - `label`
  - `description`
  - fixed `method`
  - fixed `url`
- no longer exports or uses path-based grant resolution.

`tool-catalog.example.json` was changed to the final definitions-only shape. The ignored local `tool-catalog.json` was also changed to definitions-only so a later local restart will not fail catalog validation.

### 2. Public and WebSocket protocol

`src/shared/protocol.ts` now defines:

- `HttpToolNameSchema` and related limits/pattern;
- `PublicHttpToolSchema`;
- `PublicConfig.httpTools`;
- `Workspace.enabledHttpTools`;
- `WorkspaceSummary.enabledHttpTools` and `effectiveHttpTools`;
- optional `enabledHttpTools` on workspace create/update commands;
- `ConversationState.effectiveHttpTools` for the live captured runtime authority.

`src/server/index.ts` now returns safe HTTP tool metadata from `/api/config` and passes the startup catalog into `WorkspaceRepository`.

### 3. SQLite schema v8

`src/server/database.ts` now uses schema version 8 and creates:

```sql
workspace_http_tools(workspace_id, tool_name)
```

The table:

- cascades on workspace deletion;
- validates lowercase tool-name structure;
- has a `(workspace_id, tool_name)` primary key;
- deliberately has no catalog foreign key.

The v7-to-v8 migration creates an empty table, so all existing workspaces remain disabled by default.

### 4. Workspace repository persistence and resolution

`src/server/workspace-repository.ts` now:

- accepts the startup catalog as a repository option;
- defaults new workspaces to `enabledHttpTools: []`;
- persists create/update selections transactionally;
- rejects duplicate, malformed, and currently unknown submitted names;
- reads stored names in deterministic order;
- preserves stored names when definitions disappear;
- projects stored and effective name lists independently;
- leaves workspaces usable when a stored definition is unavailable;
- resolves frozen effective definitions in `requireUsable()`;
- relies on SQLite cascade when deleting a workspace.

### 5. Authority locking and runtime snapshots

`src/server/protocol.ts` now:

- forwards create/update selections to the repository;
- treats `enabledHttpTools` changes as authority changes;
- returns `workspace_busy` when a live workspace runtime exists.

`src/server/pi-runtime.ts` now:

- consumes `RuntimeWorkspacePolicy.effectiveHttpTools` instead of catalog path grants;
- creates parent-owned HTTP tools from the captured definitions;
- exposes captured effective names on the runtime;
- keeps strict sandbox networking isolated while the parent performs the fixed request.

`src/server/conversation-registry.ts` now:

- records and verifies captured effective tool names;
- keeps them stable across create/open/fork/replacement paths;
- exposes them through `ConversationState.effectiveHttpTools`.

`src/server/job-runner.ts` freezes the effective tool-definition array when capturing a scheduled-run policy.

### 6. Workspace UI

The Add/Edit Workspace flow now includes a **Parent-owned HTTP tools** fieldset.

Implemented behavior:

- available tools render as unchecked-by-default checkboxes;
- each option shows label, description, fixed method, and fixed URL;
- the form warns that calls run in the ChatWCA parent outside sandbox networking and may transmit readable workspace/mount content;
- edit mode initializes from stored selections;
- unavailable stored names render as selected unavailable options that can be unchecked;
- an empty catalog renders “No HTTP tools configured.”;
- controls are disabled while that workspace has a live conversation;
- update change detection omits an unchanged selection and sends an explicit empty array when disabling all tools;
- create commands always send the selected list, which defaults to empty;
- Workspace Info displays stored, effective, and unavailable names plus the parent-owned-tool security disclosure.

Changed UI files:

- `src/web/src/components/WorkspaceForm.tsx`
- `src/web/src/components/WorkspaceDialog.tsx`
- `src/web/src/components/WorkspaceSidebar.tsx`
- `src/web/src/components/ConversationsPage.tsx`
- `src/web/src/app.css`

### 7. Live conversation disclosure

`src/web/src/components/ConversationHeader.tsx` now shows an HTTP-tool badge when the live conversation captured one or more effective tools. Its accessible label/title lists the names and warns that calls run outside sandbox networking and can transmit readable workspace content.

The mobile conversation facts also show captured effective HTTP tool names.

## Tests changed or added

### Unit

- Catalog tests now cover definitions-only parsing and safe public projection.
- Database tests include the v7-to-v8 empty-selection migration.
- Repository tests cover:
  - default-off behavior;
  - selection persistence;
  - stored/effective projection;
  - missing-catalog preservation;
  - immutable runtime definition resolution;
  - duplicate/unknown rejection;
  - delete cascade.
- Protocol tests cover the public projection and new workspace/conversation fields.
- Server protocol tests cover forwarding selections and `workspace_busy` locking.
- Workspace UI tests cover:
  - fixed endpoint disclosure;
  - default-off rendering;
  - changed/unchanged update planning;
  - unavailable selections;
  - live-workspace locking.
- Existing web-client, workspace-policy, repository, sandbox-resource, and config fixtures were updated for the new projections.

### Integration

- Unrestricted Pi runtime tests were adapted to pass captured definitions on runtime policy instead of catalog path grants.
- Real sandbox Pi runtime setup was adapted the same way.
- Server smoke expectations include `httpTools` in public config.

### Browser

- The browser fixture now starts with a one-tool definitions-only catalog.
- Workspace create/update fixture behavior persists selected/effective names.
- A browser test was added to enable a tool during workspace creation, inspect it in Workspace Info, edit the workspace, and disable it.

## Validation status

The release checks pass:

- typecheck;
- 65 unit files / 762 tests;
- 12 integration files passed, 4 skipped / 56 tests passed, 14 skipped;
- production build;
- 48 browser tests;
- Pi SDK smoke;
- 12 native tests plus the architecture-policy test; and
- 5 real-sandbox files / 19 tests passed, 1 skipped.

The local Network Brain `/v1/search` endpoint also returned bounded JSON for the documented sample query. No system service restart has been performed.

## Documentation

`README.md` and `.env.example` now describe the definitions-only catalog, SQLite/UI selections, default-off and unavailable-selection behavior, live locking, backup requirements, and parent-owned sandbox/network semantics.

## Working tree

No commit has been made. The tree contains the original HTTP-tool prototype plus this session’s persistence/runtime/UI work.

Tracked modifications currently include server, shared protocol, web UI/CSS, and test files. Untracked implementation/design files remain:

```text
checkpoint.md
docs/http-tools-design.md
src/server/http-tool-catalog.ts
src/server/http-tool.ts
tests/unit/http-tool-catalog.test.ts
tests/unit/http-tool.test.ts
tool-catalog.example.json
```

The ignored `.env` and `tool-catalog.json` remain outside Git status.

## Recommended next step

Review and commit the working tree. Do not restart the system service until the catalog path and intended workspace selections are ready; restart is required to load catalog definition changes.
