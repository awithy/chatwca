import { useEffect, useState } from "react";

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
  readonly socketReady: boolean;
  readonly error?: string;
}

export function App() {
  const [status, setStatus] = useState<ServerStatus>({ socketReady: false });

  useEffect(() => {
    const abortController = new AbortController();
    const socketProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${socketProtocol}//${window.location.host}/ws`,
    );

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
        setStatus((current) => ({ ...current, health, config }));
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          setStatus((current) => ({
            ...current,
            error: error instanceof Error ? error.message : "Unable to reach the server",
          }));
        }
      });

    socket.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: unknown };
        if (message.type === "ready") {
          setStatus((current) => ({ ...current, socketReady: true }));
        }
      } catch {
        setStatus((current) => ({
          ...current,
          error: "The server sent an invalid readiness message",
        }));
      }
    });
    socket.addEventListener("error", () => {
      setStatus((current) => ({
        ...current,
        error: "Unable to open the server connection",
      }));
    });

    return () => {
      abortController.abort();
      socket.close();
    };
  }, []);

  const connected = status.health?.ready === true && status.socketReady;

  return (
    <main>
      <p className="eyebrow">Pi coding agent</p>
      <h1>ChatWCA</h1>
      <p>Pi conversations from your browser.</p>
      <section aria-live="polite" className="server-status">
        <span className={connected ? "status-dot connected" : "status-dot"} />
        <div>
          <strong>{connected ? "Server connected" : "Connecting to server…"}</strong>
          {status.health !== undefined && (
            <small>ChatWCA {status.health.version}</small>
          )}
          {status.config !== undefined && (
            <small>Default workspace: {status.config.defaultCwd}</small>
          )}
          {status.error !== undefined && <small className="error">{status.error}</small>}
        </div>
      </section>
    </main>
  );
}
