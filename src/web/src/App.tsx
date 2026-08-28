import { useEffect, useState } from "react";

import { useChatSocket } from "./api/index.js";

interface HealthResponse {
  readonly ready: boolean;
  readonly version: string;
}

interface BrowserConfig {
  readonly defaultCwd: string;
}

interface ServerStatus {
  readonly health?: HealthResponse;
  readonly config?: BrowserConfig;
  readonly error?: string;
}

export function App() {
  const [status, setStatus] = useState<ServerStatus>({});
  const { state: chat } = useChatSocket();

  useEffect(() => {
    const abortController = new AbortController();
    void Promise.all([
      fetch("/api/health", { signal: abortController.signal }),
      fetch("/api/config", { signal: abortController.signal }),
    ])
      .then(async ([healthResponse, configResponse]) => {
        if (!healthResponse.ok || !configResponse.ok) {
          throw new Error("The ChatWCA server returned an error");
        }

        const health = (await healthResponse.json()) as HealthResponse;
        const config = (await configResponse.json()) as BrowserConfig;
        setStatus({ health, config });
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          setStatus({
            error: error instanceof Error ? error.message : "Unable to reach the server",
          });
        }
      });

    return () => abortController.abort();
  }, []);

  const connected = status.health?.ready === true && chat.connection === "connected";
  const connectionLabel = chat.connection === "reconnecting"
    ? "Reconnecting to server…"
    : "Connecting to server…";
  const error = status.error ?? chat.lastError?.message;

  return (
    <main>
      <p className="eyebrow">Pi coding agent</p>
      <h1>ChatWCA</h1>
      <p>Pi conversations from your browser.</p>
      <section aria-live="polite" className="server-status">
        <span className={connected ? "status-dot connected" : "status-dot"} />
        <div>
          <strong>{connected ? "Server connected" : connectionLabel}</strong>
          {status.health !== undefined && (
            <small>ChatWCA {chat.serverVersion ?? status.health.version}</small>
          )}
          {status.config !== undefined && (
            <small>Default workspace: {status.config.defaultCwd}</small>
          )}
          {error !== undefined && <small className="error">{error}</small>}
        </div>
      </section>
    </main>
  );
}
