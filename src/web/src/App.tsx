import { Value } from "@sinclair/typebox/value";
import { useEffect, useRef, useState } from "react";

import { PublicConfigSchema, type PublicConfig } from "../../shared/protocol.js";
import { useChatSocket } from "./api/index.js";
import { useGlobalSearch } from "./api/search.js";
import { GlobalSearchPage } from "./components/GlobalSearchPage.js";
import type { SearchMessageTarget } from "./components/MessageTimeline.js";
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
  // Configured mode, not transient readiness, controls navigation.
  const searchEnabled = server.config?.search?.mode === "optional";
  const search = useGlobalSearch(searchEnabled, section === "search");
  const [searchTarget, setSearchTarget] = useState<SearchMessageTarget | null>(null);
  const navigationRevision = useRef(0);
  function navigate(next: AppSection): void {
    navigationRevision.current += 1;
    setSearchTarget(null);
    setSection(next);
  }

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
    navigate("jobs");
    client.selectJob(jobId);
    client.selectJobRun(runId);
    await Promise.allSettled([client.loadJobRuns(jobId), client.loadJobRun(jobId, runId)]);
  }

  return (
    <div className="global-shell">
      <AppNavigation section={section} connected={state.connection === "connected"} searchEnabled={searchEnabled} onSelect={navigate} />
      <div className="section-shell">
        {section === "conversations" ? (
          <ConversationsPage
            client={client}
            chat={state}
            server={server}
            onOpenJobs={() => navigate("jobs")}
            onOpenJobRun={(jobId, runId) => void openRun(jobId, runId)}
            searchTarget={searchTarget}
            {...(searchEnabled ? { onOpenSearch: () => navigate("search") } : {})}
          />
        ) : section === "search" ? (
          <GlobalSearchPage search={search} rerankAvailable={server.config?.search?.rerankAvailable ?? false} workspaces={state.workspaces}
            onOpenConversations={() => navigate("conversations")}
            onOpenJobs={() => navigate("jobs")}
            onOpenResult={async (result, excerpt) => {
              const revision = navigationRevision.current;
              const opened = await client.openGeneratedConversation(result.workspaceId, result.sessionId);
              if (opened && revision === navigationRevision.current) {
                setSearchTarget({ conversationId: result.sessionId, entryId: excerpt.entryId });
                setSection("conversations");
              }
              return opened;
            }}
          />
        ) : (
          <JobsPage
            client={client}
            state={state}
            config={server.config}
            onOpenConversations={() => navigate("conversations")}
            {...(searchEnabled ? { onOpenSearch: () => navigate("search") } : {})}
            onOpenConversation={async (workspaceId, conversationId) => {
              const opened = await client.openGeneratedConversation(workspaceId, conversationId);
              if (opened) navigate("conversations");
              return opened;
            }}
          />
        )}
      </div>
    </div>
  );
}
