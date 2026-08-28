import { useEffect, useMemo, useState } from "react";

import type { ConversationSummary, UiImage } from "../../shared/protocol.js";
import { useChatSocket } from "./api/index.js";
import { Composer } from "./components/Composer.js";
import { ConversationHeader } from "./components/ConversationHeader.js";
import { ConversationSidebar } from "./components/ConversationSidebar.js";
import { MessageTimeline } from "./components/MessageTimeline.js";
import type { PromptAction } from "./components/chat-interactions.js";

interface HealthResponse {
  readonly ready: boolean;
  readonly version: string;
}

interface BrowserConfig {
  readonly maxImages: number;
  readonly maxImageBytes: number;
  readonly maxTotalImageBytes: number;
}

interface ServerStatus {
  readonly health?: HealthResponse;
  readonly config?: BrowserConfig;
  readonly error?: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function App() {
  const [server, setServer] = useState<ServerStatus>({});
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [lifecycleAction, setLifecycleAction] = useState<"close" | "delete" | null>(null);
  const [forkAction, setForkAction] = useState<{
    readonly conversationId: string;
    readonly entryId: string;
  } | null>(null);
  const { client, state: chat } = useChatSocket();

  useEffect(() => {
    const abortController = new AbortController();
    void Promise.all([
      fetch("/api/health", { signal: abortController.signal }),
      fetch("/api/config", { signal: abortController.signal }),
    ])
      .then(async ([healthResponse, configResponse]) => {
        if (!healthResponse.ok || !configResponse.ok) {
          throw new Error("The ChatWCA server returned an error.");
        }
        setServer({
          health: (await healthResponse.json()) as HealthResponse,
          config: (await configResponse.json()) as BrowserConfig,
        });
      })
      .catch((error: unknown) => {
        if (!abortController.signal.aborted) {
          setServer({ error: errorMessage(error, "Unable to reach the server.") });
        }
      });

    return () => abortController.abort();
  }, []);

  const connected = chat.connection === "connected";
  const liveStatuses = useMemo(
    () => Object.fromEntries(
      Object.entries(chat.conversations).map(([id, projection]) => [
        id,
        projection.conversation.status,
      ]),
    ),
    [chat.conversations],
  );
  const selectedProjection = chat.selectedConversationId === null
    ? undefined
    : chat.conversations[chat.selectedConversationId];
  const selectedConversation = selectedProjection?.conversation;
  const selectedSummary = chat.history.find(
    (conversation) => conversation.id === chat.selectedConversationId,
  ) ?? (selectedConversation === undefined ? undefined : {
    id: selectedConversation.id,
    workspaceId: selectedConversation.workspaceId,
    sessionFile: selectedConversation.sessionFile,
    title: selectedConversation.title,
    cwd: selectedConversation.cwd,
    createdAt: selectedConversation.createdAt,
    modifiedAt: selectedConversation.lastActiveAt,
    messageCount: selectedConversation.messages.length,
    status: selectedConversation.status === "aborting"
      ? "streaming" as const
      : selectedConversation.status,
    runnable: true,
  });

  async function createConversation(workspaceId: string): Promise<void> {
    setConversationError(null);
    const result = await client.send<"conversation.create">({
      type: "conversation.create",
      workspaceId,
    });
    client.selectConversation(result.conversation.id);
    setSidebarOpen(false);
  }

  function selectConversation(summary: ConversationSummary): void {
    client.selectConversation(summary.id);
    setSidebarOpen(false);
    setConversationError(null);

    if (!summary.runnable) {
      setConversationError("This conversation's working directory is unavailable.");
      return;
    }
    if (!connected) {
      setConversationError("Reconnect to the server before opening this conversation.");
      return;
    }
    if (summary.status !== "closed" && chat.conversations[summary.id] !== undefined) {
      return;
    }

    setLoadingConversationId(summary.id);
    const command = summary.status === "closed"
      ? client.send({
          type: "conversation.open",
          workspaceId: summary.workspaceId,
          conversationId: summary.id,
        })
      : client.send({ type: "conversation.state", conversationId: summary.id });
    void command
      .catch((error: unknown) => {
        if (client.getState().selectedConversationId === summary.id) {
          setConversationError(errorMessage(error, "Unable to open the conversation."));
        }
      })
      .finally(() => {
        setLoadingConversationId((current) => current === summary.id ? null : current);
      });
  }

  async function prompt(
    action: PromptAction,
    text: string,
    images: readonly UiImage[],
  ): Promise<void> {
    const conversationId = selectedConversation?.id;
    if (conversationId === undefined) throw new Error("The conversation is not open.");
    setConversationError(null);
    const input = { conversationId, text, images: [...images] };
    switch (action) {
      case "prompt.submit":
        await client.send({ type: action, ...input });
        break;
      case "prompt.steer":
        await client.send({ type: action, ...input });
        break;
      case "prompt.followUp":
        await client.send({ type: action, ...input });
        break;
    }
  }

  async function abortConversation(): Promise<void> {
    if (selectedConversation === undefined) return;
    setConversationError(null);
    await client.send({
      type: "conversation.abort",
      conversationId: selectedConversation.id,
    });
  }

  async function forkConversation(entryId: string): Promise<void> {
    if (
      selectedConversation === undefined ||
      selectedConversation.status !== "idle" ||
      forkAction !== null
    ) return;

    const conversationId = selectedConversation.id;
    setForkAction({ conversationId, entryId });
    setConversationError(null);
    try {
      await client.forkConversation(conversationId, entryId);
      setSidebarOpen(false);
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to fork the conversation."));
    } finally {
      setForkAction(null);
    }
  }

  async function closeConversation(): Promise<void> {
    if (selectedConversation === undefined || lifecycleAction !== null) return;
    setLifecycleAction("close");
    setConversationError(null);
    try {
      await client.send({
        type: "conversation.close",
        conversationId: selectedConversation.id,
      });
      client.selectConversation(null);
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to close the conversation."));
    } finally {
      setLifecycleAction(null);
    }
  }

  async function deleteConversation(): Promise<void> {
    if (selectedSummary === undefined || lifecycleAction !== null) return;
    const confirmed = window.confirm(
      `Delete “${selectedSummary.title.trim() || "Untitled conversation"}”? This cannot be undone.`,
    );
    if (!confirmed) return;

    setLifecycleAction("delete");
    setConversationError(null);
    try {
      if (selectedConversation !== undefined) {
        await client.send({
          type: "conversation.close",
          conversationId: selectedConversation.id,
        });
      }
      await client.send({
        type: "conversation.delete",
        workspaceId: selectedSummary.workspaceId,
        conversationId: selectedSummary.id,
      });
      client.setDraft(selectedSummary.id, "");
      client.selectConversation(null);
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to delete the conversation."));
    } finally {
      setLifecycleAction(null);
    }
  }

  const visibleError = conversationError ?? server.error ?? chat.lastError?.message;

  return (
    <div className="app-shell">
      <ConversationSidebar
        conversations={chat.history}
        liveStatuses={liveStatuses}
        selectedConversationId={chat.selectedConversationId}
        connected={connected}
        open={sidebarOpen}
        onDismiss={() => setSidebarOpen(false)}
        onCreate={createConversation}
        onSelect={selectConversation}
      />
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close conversations"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="conversation-page">
        <div className="mobile-app-bar">
          <button
            className="icon-button menu-button"
            type="button"
            aria-label="Open conversations"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <strong>ChatWCA</strong>
          <span className={`connection-dot${connected ? " is-connected" : ""}`} title={connected ? "Connected" : "Disconnected"} />
        </div>

        {selectedSummary === undefined ? (
          <section className="welcome-panel">
            <div className="welcome-mark" aria-hidden="true">W</div>
            <p className="eyebrow">Pi coding agent</p>
            <h1>Start a conversation</h1>
            <p>
              Create a session for a workspace, or choose a conversation from your history.
            </p>
            <button
              className="primary-button welcome-create"
              type="button"
              disabled={!connected}
              onClick={() => setSidebarOpen(true)}
            >
              Browse conversations
            </button>
            <small className="server-version">
              {connected ? "Server connected" : "Connecting to server…"}
              {chat.serverVersion !== null || server.health !== undefined
                ? ` · ChatWCA ${chat.serverVersion ?? server.health?.version ?? ""}`
                : ""}
            </small>
            {visibleError !== undefined && visibleError !== null && (
              <p className="page-error" role="alert">{visibleError}</p>
            )}
          </section>
        ) : (
          <>
            <ConversationHeader
              conversation={selectedConversation}
              summary={selectedSummary}
              loading={loadingConversationId === selectedSummary.id}
              connected={connected}
              actionPending={lifecycleAction}
              onClose={() => void closeConversation()}
              onDelete={() => void deleteConversation()}
            />
            <section className="conversation-content">
              {visibleError !== undefined && visibleError !== null && (
                <div className="page-error conversation-alert" role="alert">{visibleError}</div>
              )}
              {loadingConversationId === selectedSummary.id && selectedConversation === undefined ? (
                <div className="content-empty">
                  <span className="loading-spinner" aria-hidden="true" />
                  <p>Opening conversation…</p>
                </div>
              ) : selectedConversation === undefined ? (
                <div className="content-empty">
                  <h2>{selectedSummary.runnable ? "Conversation closed" : "Workspace unavailable"}</h2>
                  <p>
                    {selectedSummary.runnable
                      ? "Select it again to reopen the persisted session."
                      : `Restore ${selectedSummary.cwd} before reopening this session.`}
                  </p>
                </div>
              ) : (
                <div className="conversation-workspace">
                  <MessageTimeline
                    messages={selectedConversation.messages}
                    notices={selectedProjection?.notices ?? []}
                    queue={selectedConversation.queue}
                    streaming={selectedConversation.status === "streaming"}
                    cwd={selectedConversation.cwd}
                    canFork={connected && selectedConversation.status === "idle"}
                    forkingEntryId={forkAction?.conversationId === selectedConversation.id
                      ? forkAction.entryId
                      : null}
                    onFork={(entryId) => void forkConversation(entryId)}
                  />
                  <Composer
                    key={selectedConversation.id}
                    status={selectedConversation.status}
                    draft={chat.drafts[selectedConversation.id] ?? ""}
                    queue={selectedConversation.queue}
                    connected={connected}
                    {...(server.config === undefined ? {} : {
                      imageLimits: {
                        maxImages: server.config.maxImages,
                        maxImageBytes: server.config.maxImageBytes,
                        maxTotalImageBytes: server.config.maxTotalImageBytes,
                      },
                    })}
                    onDraftChange={(text) => client.setDraft(selectedConversation.id, text)}
                    onPrompt={prompt}
                    onAbort={abortConversation}
                    onError={(error) => setConversationError(errorMessage(error, "Unable to send the command."))}
                  />
                </div>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}
