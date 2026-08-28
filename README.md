# ChatWCA

ChatWCA is a single-user, dark-only web interface for the [Pi coding agent](https://pi.dev/). A Node.js server runs the pinned `@earendil-works/pi-coding-agent` SDK in-process and serves a React client over HTTP and WebSocket.

> [!CAUTION]
> **ChatWCA has no authentication or authorization.** It listens on `0.0.0.0` by default, and every client that can reach the port can operate Pi, access configured conversations, and request tools that read, write, or execute with the server process's permissions. Run it only on a trusted, segmented LAN behind host/network firewall rules. Do not expose it to the public internet or an untrusted network.

## Requirements

- Node.js **22.19.0 or newer** and npm.
- A host supported by Pi, with at least one model/provider configured and available to the server process.
- Read/search access to each conversation working directory and read/write access to Pi's agent/session directory.
- Network access to any remote model provider. `PI_OFFLINE` intentionally disables Pi model network access.

`npm ci` installs the Pi SDK and its local `pi` executable; a separate global Pi installation is not required. ChatWCA uses Pi's existing settings, credentials, context files, skills, and extensions. Configure those through Pi rather than ChatWCA—the web UI has no model or credential settings. You can inspect the models visible to the same installation with:

```sh
npx pi --list-models
```

The application is pinned to `@earendil-works/pi-coding-agent` **0.84.3**. See [docs/pi-sdk-notes.md](docs/pi-sdk-notes.md) for the validated SDK behavior.

## Install and run

Run commands from the repository root so the production server can find `dist/web`.

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

Operational endpoints are:

```text
GET /api/health
GET /api/config
WS  /ws
```

## Configuration

These are all environment variables interpreted by ChatWCA or explicitly passed through to its Pi runtime:

| Variable | Default | Validation and behavior |
|---|---:|---|
| `CHATWCA_HOST` | `0.0.0.0` | Non-empty HTTP/WebSocket bind address. |
| `CHATWCA_PORT` | `8787` | Integer from `1` through `65535`. |
| `CHATWCA_DEFAULT_CWD` | server process CWD | Initial new-conversation path. Relative values are resolved against the process CWD. The path is validated when a conversation is created. |
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
CHATWCA_DEFAULT_CWD=/work/project \
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
| Tool-result output exposed in a browser snapshot/event | 65536 UTF-8 bytes (64 KiB), fixed |
| WebSocket outbound high-water mark per client | 524288 bytes (512 KiB), fixed |
| Additional outbound application queue per client | 4194304 bytes (4 MiB), fixed |
| Persistent slow-client timeout | 5000 ms, fixed |

Image count and byte defaults are controlled by the corresponding environment variables and are returned to the browser by `/api/config`. The browser performs preliminary checks and resizing; the server remains authoritative, validates canonical padded base64 and file signatures, and counts actual decoded bytes. Image data on the wire is raw base64 without a `data:` URL prefix. Raising image limits does **not** raise the fixed 40 MiB WebSocket command limit.

Tool output is bounded only in the browser projection; Pi's native session remains canonical. Under backpressure, cumulative tool/history updates may be coalesced. A client that remains slow is closed and can reconnect to obtain an authoritative snapshot; its disconnect does not stop server-side runs.

## Network and security behavior

The browser client uses `/api/*` and `/ws` on the same authority that served the page. ChatWCA does not enable broad CORS. Browser WebSocket upgrades are accepted only when the `Origin` authority matches the request `Host`; direct clients that omit `Origin` are accepted. This check reduces cross-site WebSocket abuse but **is not authentication**.

Use a single ChatWCA process. The process-wide registry prevents duplicate live writers inside that process, but it does not coordinate session writes with another ChatWCA or Pi CLI process.

## Session storage and Pi compatibility

- Pi's native append-only JSONL store is the only message store; ChatWCA does not create an application database or a separate image store.
- By default sessions are under `~/.pi/agent/sessions`; `PI_CODING_AGENT_DIR` changes that root.
- History is discovered through Pi's session-listing APIs across working directories. ChatWCA does not parse JSONL to build history.
- Sessions are created by the pinned Pi 0.84.3 SDK and remain usable by a matching Pi CLI. Avoid writing the same session concurrently from ChatWCA and another Pi process. Back up sessions before changing Pi/SDK versions.
- Closing a conversation or idle LRU eviction disposes only its live runtime; persisted history remains and can be reopened. Deletion removes the listed JSONL file and is allowed only after the live conversation is closed.
- A new persistent session has an ID and prospective path but no file yet. It becomes durable when its first assistant message finishes (including a terminal error/abort response). Empty and user-only conversations are therefore absent from history and do not survive a process restart.
- A stored conversation retains its original working directory. If that directory disappears, history remains visible but is marked unavailable and cannot be opened until the same path is restored.

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

### Working directory is missing or inaccessible

New conversations require an existing directory that the server process can read and search. Use an absolute path, verify ownership/permissions as the server user, and remember that `CHATWCA_DEFAULT_CWD` is resolved relative to the directory where ChatWCA starts.

For stored sessions, ChatWCA intentionally does not override the CWD recorded in Pi's header. Restore that directory at the displayed path, then refresh/reopen the conversation. There is no v1 UI for relocating a stored session.

### WebSocket origin mismatch or repeated reconnects

A rejected browser upgrade usually appears as HTTP `403` for `/ws` in browser developer tools. Load the UI and WebSocket from the same scheme/host/port. When using a reverse proxy, preserve the browser-facing `Host` header (including a non-default port) on the WebSocket upgrade and proxy `/ws` with upgrade support. Do not serve the UI from one hostname while directing its WebSocket to another. HTTP health can be checked independently at `/api/health`.

### Session or runtime errors

- `session_file_missing` / `session_not_listed`: the JSONL file was removed or is no longer in the active Pi agent directory. Refresh history; restore it from backup if it was removed externally.
- `session_unavailable`: verify read/write permissions for the session file and its Pi directories.
- `pi_runtime_create_failed`: verify the stored/new CWD, Pi settings, credentials, extensions, and filesystem permissions by running Pi in the same CWD and environment.
- `pi_runtime_replace_failed`: a fork/runtime replacement failed. The source-preserving fork path leaves the original conversation unchanged; close/reopen an idle errored conversation and reproduce the operation in Pi's own interface before retrying.
- `live_runtime_limit`: all configured runtime slots are active, so no idle conversation can be evicted. Wait for or abort a run, close an idle conversation, or raise `CHATWCA_MAX_LIVE_CONVERSATIONS` and restart.

Public WebSocket errors deliberately omit SDK details, local paths, and stacks. Startup and unexpected listener/protocol failures are reported in the server terminal; expected command failures may expose only their stable public code. Reproduce those failures with Pi in the same CWD and environment to obtain Pi-side diagnostics. If a session was edited or deleted by another process while live, stop concurrent writers, restart ChatWCA, and recover from the canonical Pi JSONL/backup rather than editing it through ChatWCA.

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

A license has not yet been selected.
