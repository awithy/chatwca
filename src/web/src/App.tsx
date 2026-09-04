import { Value } from "@sinclair/typebox/value";
import { useEffect, useState } from "react";

import { PublicConfigSchema, type PublicConfig } from "../../shared/protocol.js";
import { useChatSocket } from "./api/index.js";
import { AppNavigation, type AppSection } from "./components/AppNavigation.js";
import { ConversationsPage, type ServerStatus } from "./components/ConversationsPage.js";
import { JobsPage } from "./components/jobs/JobsPage.js";

interface HealthResponse {
  readonly ready: boolean;
  readonly version: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function App() {
  const [section, setSection] = useState<AppSection>("conversations");
  const [server, setServer] = useState<ServerStatus>({});
  const { client, state } = useChatSocket();

  useEffect(() => {
    const abortController = new AbortController();
    void Promise.all([
      fetch("/api/health", { signal: abortController.signal }),
      fetch("/api/config", { signal: abortController.signal }),
    ]).then(async ([healthResponse, configResponse]) => {
      if (!healthResponse.ok || !configResponse.ok) throw new Error("The ChatWCA server returned an error.");
      const health = (await healthResponse.json()) as HealthResponse;
      const config: unknown = await configResponse.json();
      if (!Value.Check(PublicConfigSchema, config)) throw new Error("The ChatWCA server returned invalid public configuration.");
      setServer({ health, config: config as PublicConfig });
    }).catch((error: unknown) => {
      if (!abortController.signal.aborted) setServer({ error: errorMessage(error, "Unable to reach the server.") });
    });
    return () => abortController.abort();
  }, []);

  async function openRun(jobId: string, runId: string): Promise<void> {
    setSection("jobs");
    client.selectJob(jobId);
    client.selectJobRun(runId);
    await Promise.allSettled([client.loadJobRuns(jobId), client.loadJobRun(jobId, runId)]);
  }

  return (
    <div className="global-shell">
      <AppNavigation section={section} connected={state.connection === "connected"} onSelect={setSection} />
      <div className="section-shell">
        {section === "conversations" ? (
          <ConversationsPage
            client={client}
            chat={state}
            server={server}
            onOpenJobs={() => setSection("jobs")}
            onOpenJobRun={(jobId, runId) => void openRun(jobId, runId)}
          />
        ) : (
          <JobsPage
            client={client}
            state={state}
            config={server.config}
            onOpenConversations={() => setSection("conversations")}
            onOpenConversation={async (workspaceId, conversationId) => {
              const opened = await client.openGeneratedConversation(workspaceId, conversationId);
              if (opened) setSection("conversations");
              return opened;
            }}
          />
        )}
      </div>
    </div>
  );
}
