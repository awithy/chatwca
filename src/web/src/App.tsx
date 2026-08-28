import { useEffect, useMemo, useRef, useState } from "react";

import type {
  ConversationSummary,
  UiImage,
  WorkspaceSummary,
} from "../../shared/protocol.js";
import { useChatSocket } from "./api/index.js";
import { Composer } from "./components/Composer.js";
import { ConversationHeader } from "./components/ConversationHeader.js";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar.js";
import type { WorkspaceFormValues } from "./components/WorkspaceForm.js";
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
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingActionRef = useRef<string | null>(null);
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
  const selectedWorkspace = chat.workspaces.find(
    (workspace) => workspace.id === chat.selectedWorkspaceId,
  );
  const selectedWorkspaceUnavailable = selectedWorkspace !== undefined && (
    !selectedWorkspace.available || chat.historyError?.code === "workspace_unavailable"
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

  async function runExclusive<T>(
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (pendingActionRef.current !== null) {
      throw new Error("Wait for the current action to finish.");
    }
    pendingActionRef.current = action;
    setPendingAction(action);
    try {
      return await operation();
    } finally {
      pendingActionRef.current = null;
      setPendingAction(null);
    }
  }

  async function createWorkspace(values: WorkspaceFormValues): Promise<void> {
    const knownIds = new Set(chat.workspaces.map((workspace) => workspace.id));
    const result = await runExclusive("workspace.create", () => client.send<"workspace.create">({
      type: "workspace.create",
      name: values.name,
      path: values.path,
    }));
    const created = result.workspaces.find((workspace) => !knownIds.has(workspace.id));
    if (created !== undefined) {
      void client.selectWorkspace(created.id).catch(() => undefined);
    }
  }

  async function updateWorkspace(
    workspaceId: string,
    values: { readonly name: string; readonly path?: string },
  ): Promise<void> {
    await runExclusive("workspace.update", () => client.send({
      type: "workspace.update",
      workspaceId,
      name: values.name,
      ...(values.path === undefined ? {} : { path: values.path }),
    }));
    if (values.path !== undefined && chat.selectedWorkspaceId === workspaceId) {
      await client.selectWorkspace(null);
      void client.selectWorkspace(workspaceId).catch(() => undefined);
    }
  }

  async function removeWorkspace(workspace: WorkspaceSummary): Promise<void> {
    await runExclusive("workspace.delete", () => client.send({
      type: "workspace.delete",
      workspaceId: workspace.id,
    }));
    if (client.getState().selectedWorkspaceId === workspace.id) {
      await client.selectWorkspace(null);
    }
  }

  async function createConversation(): Promise<void> {
    const workspace = selectedWorkspace;
    if (workspace === undefined || !workspace.available || selectedWorkspaceUnavailable) {
      setConversationError("Select an available workspace before creating a conversation.");
      return;
    }
    setConversationError(null);
    try {
      const result = await runExclusive("conversation.create", () => client.send<"conversation.create">({
        type: "conversation.create",
        workspaceId: workspace.id,
      }));
      client.selectConversation(result.conversation.id);
      setSidebarOpen(false);
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to create the conversation."));
    }
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
    void runExclusive("conversation.open", () => summary.status === "closed"
      ? client.send({
          type: "conversation.open",
          workspaceId: summary.workspaceId,
          conversationId: summary.id,
        })
      : client.send({ type: "conversation.state", conversationId: summary.id }))
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
    if (selectedWorkspaceUnavailable) throw new Error("The workspace directory is unavailable.");
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
    if (selectedConversation === undefined || pendingActionRef.current !== null) return;
    setConversationError(null);
    try {
      await runExclusive("conversation.abort", () => client.send({
        type: "conversation.abort",
        conversationId: selectedConversation.id,
      }));
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to abort the conversation."));
    }
  }

  async function forkConversation(entryId: string): Promise<void> {
    if (
      selectedConversation === undefined ||
      selectedConversation.status !== "idle" ||
      forkAction !== null ||
      pendingActionRef.current !== null ||
      selectedWorkspaceUnavailable
    ) return;

    const conversationId = selectedConversation.id;
    setForkAction({ conversationId, entryId });
    setConversationError(null);
    try {
      await runExclusive("conversation.fork", () => client.forkConversation(conversationId, entryId));
      setSidebarOpen(false);
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to fork the conversation."));
    } finally {
      setForkAction(null);
    }
  }

  async function closeConversation(): Promise<void> {
    if (selectedConversation === undefined || pendingActionRef.current !== null) return;
    setConversationError(null);
    try {
      await runExclusive("conversation.close", () => client.send({
        type: "conversation.close",
        conversationId: selectedConversation.id,
      }));
      client.selectConversation(null);
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to close the conversation."));
    }
  }

  async function deleteConversation(): Promise<void> {
    if (selectedSummary === undefined || pendingActionRef.current !== null) return;
    const confirmed = window.confirm(
      `Delete “${selectedSummary.title.trim() || "Untitled conversation"}”? This cannot be undone.`,
    );
    if (!confirmed) return;

    setConversationError(null);
    try {
      await runExclusive("conversation.delete", async () => {
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
      });
      client.clearDraft(selectedSummary.id);
      client.selectConversation(null);
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to delete the conversation."));
    }
  }

  const visibleError = conversationError ?? server.error ?? chat.lastError?.message;

  return (
    <div className="app-shell">
      <WorkspaceSidebar
        workspaces={chat.workspaces}
        selectedWorkspaceId={chat.selectedWorkspaceId}
        conversations={chat.historyWorkspaceId === chat.selectedWorkspaceId ? chat.history : []}
        liveStatuses={liveStatuses}
        selectedConversationId={chat.selectedConversationId}
        connected={connected}
        historyPending={chat.pendingHistoryWorkspaceId === chat.selectedWorkspaceId}
        historyError={chat.historyError?.workspaceId === chat.selectedWorkspaceId
          ? chat.historyError.message
          : null}
        actionPending={pendingAction !== null}
        open={sidebarOpen}
        onDismiss={() => setSidebarOpen(false)}
        onSelectWorkspace={(workspaceId) => {
          setConversationError(null);
          void client.selectWorkspace(workspaceId).catch(() => undefined);
          setSidebarOpen(false);
        }}
        onCreateWorkspace={createWorkspace}
        onUpdateWorkspace={updateWorkspace}
        onRemoveWorkspace={removeWorkspace}
        onCreateConversation={createConversation}
        onSelectConversation={selectConversation}
      />
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          type="button"
          aria-label="Close workspaces and conversations"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      <main className="conversation-page">
        <div className="mobile-app-bar">
          <button
            className="icon-button menu-button"
            type="button"
            aria-label="Open workspaces and conversations"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <strong>ChatWCA</strong>
          <span className={`connection-dot${connected ? " is-connected" : ""}`} title={connected ? "Connected" : "Disconnected"} />
        </div>

        {selectedSummary === undefined || selectedWorkspace === undefined ? (
          <section className="welcome-panel">
            <div className="welcome-mark" aria-hidden="true">W</div>
            <p className="eyebrow">Pi coding agent</p>
            <h1>
              {chat.workspaces.length === 0
                ? "Add your first workspace"
                : selectedWorkspace === undefined
                  ? "Select a workspace"
                  : selectedWorkspaceUnavailable
                    ? "Workspace unavailable"
                    : `Start in ${selectedWorkspace.name}`}
            </h1>
            <p>
              {chat.workspaces.length === 0
                ? "Register a named project directory to create and find its conversations."
                : selectedWorkspace === undefined
                  ? "Choose a workspace to load only its Pi conversation history."
                  : selectedWorkspaceUnavailable
                    ? `Restore the directory at ${selectedWorkspace.path} before loading or creating conversations.`
                    : "Create a new conversation, or choose one from this workspace's history."}
            </p>
            <button
              className="primary-button welcome-create"
              type="button"
              disabled={!connected}
              onClick={() => setSidebarOpen(true)}
            >
              Manage workspaces
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
              workspace={selectedWorkspace}
              loading={loadingConversationId === selectedSummary.id}
              connected={connected}
              actionPending={pendingAction === null
                ? null
                : pendingAction === "conversation.close"
                  ? "close"
                  : pendingAction === "conversation.delete"
                    ? "delete"
                    : "other"}
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
                    conversationId={selectedConversation.id}
                    messages={selectedConversation.messages}
                    notices={selectedProjection?.notices ?? []}
                    queue={selectedConversation.queue}
                    streaming={selectedConversation.status === "streaming"}
                    cwd={selectedConversation.cwd}
                    canFork={connected && !selectedWorkspaceUnavailable && pendingAction === null && selectedConversation.status === "idle"}
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
                    connected={connected && !selectedWorkspaceUnavailable && pendingAction === null}
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
