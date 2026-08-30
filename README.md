# ChatWCA

ChatWCA is a single-user, dark-only web interface for the [Pi coding agent](https://pi.dev/). A Node.js server runs the pinned `@earendil-works/pi-coding-agent` SDK in-process and serves a React client over HTTP and WebSocket.

> [!CAUTION]
> **ChatWCA has no authentication or authorization.** It listens on `0.0.0.0` by default, and every client that can reach the port can operate Pi, access configured conversations, and request tools that read, write, or execute with the server process's permissions. Run it only on a trusted, segmented LAN behind host/network firewall rules. Do not expose it to the public internet or an untrusted network.

## Requirements

- Node.js **22.19.0 or newer** and npm.
- A host supported by Pi, with at least one model/provider configured and available to the server process.
- Read/search access to every directory registered as a workspace, read/write access to Pi's agent/session directory, and read/write access to ChatWCA's data directory. A workspace configured for workspace-local session storage must also be writable.
- Network access to any remote model provider. `PI_OFFLINE` intentionally disables Pi model network access.

`npm ci` installs the Pi SDK and its local `pi` executable; a separate global Pi installation is not required. ChatWCA uses Pi's existing settings, credentials, context files, skills, and extensions. Configure those through Pi rather than ChatWCA—the web UI has no model or credential settings. You can inspect the models visible to the same installation with:

```sh
npx pi --list-models
```

The application is pinned to `@earendil-works/pi-coding-agent` **0.84.3**. See [docs/pi-sdk-notes.md](docs/pi-sdk-notes.md) for the validated SDK behavior.

## Install and run

Run commands from the repository root so the production server can find `dist/web`. The default SQLite location, `./data`, is also resolved from the server process's current working directory.

```sh
npm ci
```

### Development

```sh
npm run dev
```

This starts the backend on `http://0.0.0.0:8787` and Vite on `http://0.0.0.0:5173`. Open `http://127.0.0.1:5173` locally or use the host's LAN address with port `5173`. The Vite proxy is fixed to `http://127.0.0.1:8787`, so keep the backend reachable there when using the combined development command.

The processes can also be run separately:

```sh
npm run dev:server
npm run dev:web
```

### Production build and start

```sh
npm run build
npm start
```

`npm start` runs the already-built `dist/server/server/index.js`; it does not build first. With default settings, open `http://127.0.0.1:8787` on the server or `http://<server-lan-address>:8787` from the trusted LAN. `0.0.0.0` is a bind address, not a browser destination.

### systemd

A system service for this checkout and the `adrian` user is provided at [`systemd/chatwca.service`](systemd/chatwca.service). It uses `/usr/bin/node`, loads the optional repository `.env`, and runs the existing production build. Build before installing or restarting it:

```sh
npm ci
npm run build
sudo install -m 0644 systemd/chatwca.service /etc/systemd/system/chatwca.service
sudo systemctl daemon-reload
sudo systemctl enable --now chatwca.service
```

Inspect its state and logs with:

```sh
systemctl status chatwca.service
journalctl -u chatwca.service -f
```

After application updates, run `npm ci`, rebuild, and use `sudo systemctl restart chatwca.service`. If the checkout or user changes, update `User`, `WorkingDirectory`, `EnvironmentFile`, `ExecStart`, and `Documentation` in the service file.

Operational endpoints are:

```text
GET /api/health
GET /api/config
GET /api/conversations/:conversationId/messages/:entryId/images/:imageIndex
GET /api/conversations/:conversationId/workspace-images?path=<image-path>
WS  /ws
```

## Workspace onboarding

ChatWCA starts with no selected workspace. Before creating or opening a conversation:

1. Open **Manage workspaces** and choose **Add**.
2. Enter a name and a directory path on the **server** machine. An absolute path is recommended. The directory must already exist and be readable/searchable by the server process.
3. Optionally enable **Store sessions in this workspace**. It is disabled by default and cannot be changed after creation. Enabled workspaces use `<workspace>/.chatwca/sessions`; otherwise they use Pi's default session store.
4. Select the workspace. Only then does ChatWCA ask Pi for sessions whose exact working directory is that workspace path, and it opens that workspace's most recently modified conversation when one exists.
5. Create a new conversation or open one from the selected workspace's history. An open conversation's title can be edited from its header; the custom title is stored in Pi's native session metadata. From an eligible user message, **Fork** keeps the source conversation while **Rewind** replaces it with the fork and permanently deletes the source after fork creation succeeds.

Workspace definitions persist across browser and server restarts, but browser selection is intentionally in memory only and resets after a full page load. During a browser session, the workspace list is ordered by most recently selected; that usage order resets with the browser selection after a full page load. Starting ChatWCA or connecting a browser loads the small SQLite workspace list; it does **not** scan Pi session history. ChatWCA performs no automatic discovery or import of directories from existing global Pi history.

You can use **Workspace Info** to inspect a workspace's path, availability, session-storage policy, and workspace-local session directory. You can rename a workspace at any time. Changing its path or removing it requires closing all live conversations in that workspace first. The session-storage policy cannot be edited. Removing a workspace unregisters only its ChatWCA metadata: the directory, its contents, and all Pi JSONL sessions are retained.

## Configuration

When started through the server entry point, ChatWCA loads an optional `.env` file from the repository/current working directory before reading its configuration. Copy the included template and edit it:

```sh
cp .env.example .env
```

For example, set `CHATWCA_HOST` to an IP address assigned to the server. Variables already present in the shell environment take precedence over values in `.env`. The `.env` file is gitignored so credentials and machine-specific settings are not committed.

These are all environment variables interpreted by ChatWCA or explicitly passed through to its Pi runtime:

| Variable | Default | Validation and behavior |
|---|---:|---|
| `CHATWCA_HOST` | `0.0.0.0` | Non-empty HTTP/WebSocket bind address. |
| `CHATWCA_PORT` | `8787` | Integer from `1` through `65535`. |
| `CHATWCA_DATA_DIR` | `./data` | Directory containing `chatwca.sqlite`. Relative values are resolved against the server process's current working directory. The directory is created at startup; an explicitly empty value is rejected. |
| `CHATWCA_MAX_LIVE_CONVERSATIONS` | `8` | Positive integer. At capacity, the least-recently-used idle runtime is closed; active runtimes are never evicted. |
| `CHATWCA_MAX_IMAGES` | `8` | Positive integer; maximum images in one prompt. |
| `CHATWCA_MAX_IMAGE_BYTES` | `8388608` (8 MiB) | Positive integer; maximum decoded bytes for one image. |
| `CHATWCA_MAX_TOTAL_IMAGE_BYTES` | `25165824` (24 MiB) | Positive integer; maximum aggregate decoded image bytes in one prompt. |
| `CHATWCA_SHUTDOWN_GRACE_MS` | `10000` | Positive integer in milliseconds, capped at `300000` (5 minutes). |
| `PI_CODING_AGENT_DIR` | Pi default (`~/.pi/agent`) | Non-empty Pi configuration, credential, resource, and session root. Prefer an absolute path. Changing it selects a different Pi history/configuration universe. |
| `PI_OFFLINE` | unset | Pi offline mode is enabled by the variable's **presence**, regardless of value; even `PI_OFFLINE=0` enables it. Remove/unset the variable to disable offline mode. |

All numeric limits above accept positive safe integers; startup fails with a specific configuration message for invalid values. Provider-specific credential environment variables are consumed by Pi, not parsed or returned by ChatWCA. Their names depend on the configured Pi provider; use Pi's provider documentation or credential store. Credentials and `PI_CODING_AGENT_DIR` are never included in `/api/config`.

Example:

```sh
CHATWCA_HOST=127.0.0.1 \
CHATWCA_PORT=8787 \
CHATWCA_DATA_DIR=/var/lib/chatwca \
npm start
```

### Payload and flow-control defaults

| Boundary | Default |
|---|---:|
| Accepted image types | PNG, JPEG, WebP |
| Browser resize maximum | 2048 px on the longest edge |
| Images per prompt | 8 |
| Decoded bytes per image | 8 MiB |
| Aggregate decoded image bytes per prompt | 24 MiB |
| Complete inbound WebSocket command | 41943040 bytes (40 MiB), fixed |
| Tool-result text exposed in a browser snapshot/event | 65536 UTF-8 bytes (64 KiB), fixed |
| WebSocket outbound high-water mark per client | 524288 bytes (512 KiB), fixed |
| Additional outbound application queue per client | 4194304 bytes (4 MiB), fixed |
| Persistent slow-client timeout | 5000 ms, fixed |

Image count and byte defaults are controlled by the corresponding environment variables and are returned to the browser by `/api/config`. The browser performs preliminary checks and resizing; the server remains authoritative, validates canonical padded base64 and file signatures, and counts actual decoded bytes. Image data on the wire is raw base64 without a `data:` URL prefix. Raising image limits does **not** raise the fixed 40 MiB WebSocket command limit.

Tool-result text is bounded only in the browser projection; Pi's native session remains canonical. Supported images attached to tool results are displayed inline through a same-origin, no-store HTTP URL backed by the open conversation's canonical Pi entry, so their base64 data is not repeated in WebSocket snapshots. Markdown image and image-link destinations ending in PNG, JPEG, or WebP are resolved against the open conversation's workspace and rewritten to a same-origin endpoint. Absolute, `file:`, and `sandbox:` image paths are accepted only when their canonical target remains inside that workspace; symlink escapes, unsupported formats, oversized files, and non-image signatures are rejected. This allows a generated workspace image to appear from ordinary Markdown without exposing a general workspace file server. Under backpressure, cumulative tool/history updates may be coalesced. A client that remains slow is closed and can reconnect to obtain an authoritative snapshot; its disconnect does not stop server-side runs.

## Network and security behavior

The browser client uses `/api/*` and `/ws` on the same authority that served the page. ChatWCA does not enable broad CORS. Browser WebSocket upgrades are accepted only when the `Origin` authority matches the request `Host`; direct clients that omit `Origin` are accepted. This check reduces cross-site WebSocket abuse but **is not authentication**.

Use a single ChatWCA process. The process-wide registry prevents duplicate live writers inside that process, but it does not coordinate session writes with another ChatWCA or Pi CLI process.

## Storage, backup, and Pi compatibility

ChatWCA uses two independent stores:

- `./data/chatwca.sqlite` contains only registered workspace IDs, names, canonical directory paths, immutable session-storage policies, and timestamps. `CHATWCA_DATA_DIR` changes its parent directory. The repository's `/data/` rule ignores the database and its `-wal`, `-shm`, and journal sidecars.
- Pi's native append-only JSONL store remains canonical for messages, images, editable conversation titles, and conversation metadata. A workspace uses either Pi's default session store under `~/.pi/agent/sessions` (affected by `PI_CODING_AGENT_DIR`) or its own `<workspace>/.chatwca/sessions` directory. ChatWCA does not copy Pi sessions into SQLite or maintain a separate image store.

At startup and browser connection ChatWCA reads workspace rows only. Selecting a workspace invokes `SessionManager.list()` for that exact working directory and its configured session location. Open and delete operations are authorized by another fresh listing in the same workspace; normal application operation never performs a global `SessionManager.listAll()` scan and never parses JSONL to build history.

Sessions are created by the pinned Pi 0.84.3 SDK and remain usable by a matching Pi CLI. For workspace-local history, run Pi from that workspace with `npx pi --session-dir .chatwca/sessions -r`, or open a JSONL file directly with `--session`. Avoid writing the same session concurrently from ChatWCA and another Pi process. Closing a conversation or idle LRU eviction disposes only its live runtime; persisted history remains and can be reopened. Conversation deletion removes the freshly listed Pi JSONL file and is allowed only after its live runtime is closed.

A new persistent session has an ID and prospective path but no file yet. It becomes durable when its first assistant message finishes (including a terminal error/abort response). Empty and user-only conversations are therefore absent from history and do not survive a process restart.

### Backups

Back up the ChatWCA data directory, Pi's agent/session directory, and the `.chatwca/sessions` directory of every workspace using local storage. SQLite runs in WAL mode, so copying only `chatwca.sqlite` while the server is running can omit committed workspace changes or produce an inconsistent backup. The safest file-copy procedure is:

1. shut down ChatWCA cleanly and wait for the process to exit;
2. copy the entire configured `CHATWCA_DATA_DIR`;
3. copy the Pi directory selected by `PI_CODING_AGENT_DIR` (or Pi's default agent directory); and
4. copy each workspace that uses workspace-local session storage, including its `.chatwca/sessions` directory.

A SQLite-aware online backup tool may be used while running, but a plain file copy must account for the database, `-wal`, and `-shm` files as one consistent set. Restore backups while ChatWCA is stopped.

## Graceful shutdown

Send `SIGINT` (for example, Ctrl-C) or `SIGTERM`. Shutdown is idempotent and:

1. rejects new create/open/fork/prompt work;
2. stops accepting HTTP/WebSocket connections and sends connected clients a shutdown notice;
3. requests aborts for active Pi runs;
4. disposes subscriptions and live runtimes; and
5. closes network transports.

The whole graceful phase is bounded by `CHATWCA_SHUTDOWN_GRACE_MS`. At the deadline ChatWCA terminates remaining sockets/connections and invokes runtime disposal without waiting for a stalled SDK promise. Completed Pi entries remain durable. An in-progress response may be persisted as aborted depending on how far Pi progressed. A browser disconnect by itself does not trigger shutdown or stop a run.

## Troubleshooting

### No model is configured or available

A prompt rejected with `model_unavailable` means Pi rejected the model prompt preflight; a missing model or credential is the common cause.

1. Run `npx pi --list-models` as the same OS user, from the same shell, and with the same `PI_CODING_AGENT_DIR`/provider environment as ChatWCA.
2. Configure a model and credential in Pi; ChatWCA cannot do this in the web UI.
3. If network catalog access is needed, make sure `PI_OFFLINE` is completely unset—not set to `0` or an empty string—and verify provider/network access.
4. Restart ChatWCA after changing Pi configuration or credentials.

A failure after a prompt was accepted appears in the streamed assistant/error state as `model_failed`; inspect the server terminal and Pi diagnostics for the provider-side cause.

### Workspace is unavailable

A registered workspace is retained in SQLite when its directory disappears or becomes inaccessible, but it is marked **Unavailable** and cannot list, create, or open conversations. Restore a readable/searchable directory at the exact registered path, then reselect or refresh the workspace. If the project permanently moved, use **Edit workspace** to register its new canonical path; path changes require all live conversations in that workspace to be closed.

ChatWCA intentionally does not override the working directory recorded in a Pi session header. Sessions discovered for a different directory are not admitted to the selected workspace. There is no UI for rewriting or relocating a stored Pi session.

### WebSocket origin mismatch or repeated reconnects

A rejected browser upgrade usually appears as HTTP `403` for `/ws` in browser developer tools. Load the UI and WebSocket from the same scheme/host/port. When using a reverse proxy, preserve the browser-facing `Host` header (including a non-default port) on the WebSocket upgrade and proxy `/ws` with upgrade support. Do not serve the UI from one hostname while directing its WebSocket to another. HTTP health can be checked independently at `/api/health`.

### Database, session, or runtime errors

- `database_error`: verify that `CHATWCA_DATA_DIR` and `chatwca.sqlite` are writable by the server user, that the filesystem has free space, and that another ChatWCA process is not using the deployment. Inspect the server terminal for the private SQLite diagnostic.
- `workspace_unavailable`: restore access at the registered path or close the workspace's live conversations and update the path.
- `session_file_missing` / `session_not_listed`: the JSONL file was removed, is no longer returned from the selected workspace's configured session directory, or is outside that directory. Refresh scoped history; restore it from backup if it was removed externally.
- `session_unavailable`: verify read/write permissions for the session file and its Pi directories.
- `pi_runtime_create_failed`: verify the stored or new working directory, Pi settings, credentials, extensions, and filesystem permissions by running Pi in the same working directory and environment.
- `pi_runtime_replace_failed`: a fork/runtime replacement failed. The source-preserving fork path leaves the original conversation unchanged; close/reopen an idle errored conversation and reproduce the operation in Pi's own interface before retrying.
- `live_runtime_limit`: all configured runtime slots are active, so no idle conversation can be evicted. Wait for or abort a run, close an idle conversation, or raise `CHATWCA_MAX_LIVE_CONVERSATIONS` and restart.

Public WebSocket errors deliberately omit SDK details, local paths, and stacks. Startup and unexpected listener/protocol failures are reported in the server terminal; expected command failures may expose only their stable public code. Reproduce those failures with Pi in the same working directory and environment to obtain Pi-side diagnostics. If a session was edited or deleted by another process while live, stop concurrent writers, restart ChatWCA, and recover from the canonical Pi JSONL/backup rather than editing it through ChatWCA.

## Development checks

```sh
npm run typecheck
npm run build
npm run test:unit
npm run test:integration
npm run test:browser
npm run test:sdk-smoke
```

The SDK smoke test uses temporary Pi state and a faux provider; it does not require paid credentials or network access. Browser tests use a deterministic fixture server.

## Documentation

- [Technical design](docs/design.md)
- [Validated Pi SDK integration notes](docs/pi-sdk-notes.md)
- [Implementation plan](plan.md)

## License

ChatWCA is licensed under the [MIT License](LICENSE).
