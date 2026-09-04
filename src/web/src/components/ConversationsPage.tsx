import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  MAX_CONVERSATION_TITLE_LENGTH,
  type ConversationSummary,
  type PublicConfig,
  type UiImage,
  type WorkspaceSummary,
} from "../../../shared/protocol.js";
import type { ChatSocketClient } from "../api/client.js";
import type { ChatClientState } from "../api/state.js";
import { Composer } from "./Composer.js";
import { ConversationHeader } from "./ConversationHeader.js";
import { WorkspaceConversationPicker } from "./WorkspaceConversationPicker.js";
import { WorkspaceSidebar } from "./WorkspaceSidebar.js";
import type { WorkspaceFormValues } from "./WorkspaceForm.js";
import { MessageTimeline } from "./MessageTimeline.js";
import { NetworkBlockedNotices } from "./NetworkBlockedNotices.js";
import {
  canCloseConversation,
  canDeleteConversation,
  type PromptAction,
} from "./chat-interactions.js";
import { conversationTitle } from "./conversation-list.js";

export interface ConversationsPageProps {
  readonly client: ChatSocketClient;
  readonly chat: ChatClientState;
  readonly server: ServerStatus;
  readonly onOpenJobs: () => void;
  readonly onOpenJobRun: (jobId: string, runId: string) => void;
}

export interface ServerStatus {
  readonly health?: { readonly ready: boolean; readonly version: string };
  readonly config?: PublicConfig;
  readonly error?: string;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function mobileStatusLabel(status: ConversationSummary["status"] | "aborting"): string {
  switch (status) {
    case "closed": return "Closed";
    case "idle": return "Idle";
    case "streaming": return "Running";
    case "aborting": return "Stopping";
    case "error": return "Error";
  }
}

function mobileSecurityLabel(conversation: ChatClientState["conversations"][string]["conversation"] | undefined): string {
  if (conversation === undefined) return "Loading security profile…";
  if (conversation.securityProfile !== "workspace-sandboxed") return "Unrestricted";
  return conversation.networkPolicy === "managed-egress"
    ? "Sandboxed · Managed egress"
    : "Sandboxed · Network isolated";
}

function mobileContextLabel(conversation: ChatClientState["conversations"][string]["conversation"] | undefined): string {
  const usage = conversation?.contextUsage;
  if (usage === undefined || usage === null) return "—";
  const window = usage.contextWindow < 1_000
    ? String(usage.contextWindow)
    : `${Math.round(usage.contextWindow / 1_000)}k`;
  return `${usage.percent === null ? "?" : `${usage.percent.toFixed(1)}%`}/${window}`;
}

export function ConversationsPage({ client, chat, server, onOpenJobs, onOpenJobRun }: ConversationsPageProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [mobileRenaming, setMobileRenaming] = useState(false);
  const [mobileTitleDraft, setMobileTitleDraft] = useState("");
  const mobileActionTrigger = useRef<HTMLButtonElement>(null);
  const mobileTitleInput = useRef<HTMLInputElement>(null);
  const [loadingConversationId, setLoadingConversationId] = useState<string | null>(null);
  const [conversationError, setConversationError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const pendingActionRef = useRef<string | null>(null);
  const [branchAction, setBranchAction] = useState<{
    readonly kind: "fork" | "rewind";
    readonly conversationId: string;
    readonly entryId: string;
  } | null>(null);
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
  const liveWorkspaceIds = useMemo(
    () => new Set(
      Object.values(chat.conversations).map(
        (projection) => projection.conversation.workspaceId,
      ),
    ),
    [chat.conversations],
  );
  const selectedWorkspace = chat.workspaces.find(
    (workspace) => workspace.id === chat.selectedWorkspaceId,
  );
  const selectedWorkspaceUnavailable = selectedWorkspace !== undefined && (
    !selectedWorkspace.available || chat.historyError?.code === "workspace_unavailable"
  );
  const selectedWorkspaceBlocked = selectedWorkspace !== undefined &&
    selectedWorkspace.available && !selectedWorkspace.usable;
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
    ...(selectedConversation.owner === undefined ? {} : { owner: selectedConversation.owner }),
  });
  const mobileTitle = selectedSummary === undefined
    ? selectedWorkspace?.name ?? "ChatWCA"
    : selectedConversation?.title.trim() || conversationTitle(selectedSummary);
  const mobileStatus = selectedConversation?.status ?? selectedSummary?.status;
  const mobileOwner = selectedConversation?.owner ?? selectedSummary?.owner;
  const mobileMutationLocked = mobileOwner?.kind === "scheduled-job";
  const mobileCloseEnabled = !mobileMutationLocked && selectedConversation !== undefined &&
    canCloseConversation(selectedConversation.status);
  const mobileDeleteEnabled = !mobileMutationLocked && mobileStatus !== undefined &&
    canDeleteConversation(mobileStatus);
  const mobileRenameEnabled = !mobileMutationLocked && selectedConversation !== undefined &&
    connected && loadingConversationId !== selectedSummary?.id && pendingAction === null;
  const mobileCreateEnabled = selectedWorkspace?.available === true && selectedWorkspace.usable;

  useEffect(() => {
    setMobileActionsOpen(false);
    setMobileRenaming(false);
    setMobileTitleDraft(mobileTitle);
  }, [selectedSummary?.id]);

  useEffect(() => {
    if (mobileRenaming) mobileTitleInput.current?.select();
  }, [mobileRenaming]);

  useEffect(() => {
    if (!mobileActionsOpen) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setMobileActionsOpen(false);
      setMobileRenaming(false);
      window.requestAnimationFrame(() => mobileActionTrigger.current?.focus());
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mobileActionsOpen]);

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

  async function createWorkspace(
    values: WorkspaceFormValues & { readonly acknowledgeWritableMounts?: true },
  ): Promise<void> {
    const knownIds = new Set(chat.workspaces.map((workspace) => workspace.id));
    const result = await runExclusive("workspace.create", () => client.send<"workspace.create">({
      type: "workspace.create",
      name: values.name,
      path: values.path,
      sessionStorage: values.sessionStorage,
      securityProfile: values.securityProfile,
      mounts: [...values.mounts],
      networkPolicy: values.networkPolicy,
      networkPolicySetId: values.networkPolicySetId,
      ...(values.acknowledgeWritableMounts === true
        ? { acknowledgeWritableMounts: true as const }
        : {}),
    }));
    const created = result.workspaces.find((workspace) => !knownIds.has(workspace.id));
    if (created !== undefined) {
      void changeWorkspace(created.id).catch(() => undefined);
    }
  }

  async function updateWorkspace(
    workspaceId: string,
    values: {
      readonly name: string;
      readonly path?: string;
      readonly securityProfile?: WorkspaceFormValues["securityProfile"];
      readonly mounts?: WorkspaceFormValues["mounts"];
      readonly networkPolicy?: WorkspaceFormValues["networkPolicy"];
      readonly networkPolicySetId?: string;
      readonly acknowledgeSecurityDowngrade?: true;
      readonly acknowledgeNetworkExposure?: true;
      readonly acknowledgeWritableMounts?: true;
    },
  ): Promise<void> {
    await runExclusive("workspace.update", () => client.send({
      type: "workspace.update",
      workspaceId,
      name: values.name,
      ...(values.path === undefined ? {} : { path: values.path }),
      ...(values.securityProfile === undefined
        ? {}
        : { securityProfile: values.securityProfile }),
      ...(values.mounts === undefined ? {} : { mounts: [...values.mounts] }),
      ...(values.networkPolicy === undefined
        ? {}
        : { networkPolicy: values.networkPolicy }),
      ...(values.networkPolicySetId === undefined
        ? {}
        : { networkPolicySetId: values.networkPolicySetId }),
      ...(values.acknowledgeSecurityDowngrade === true
        ? { acknowledgeSecurityDowngrade: true as const }
        : {}),
      ...(values.acknowledgeNetworkExposure === true
        ? { acknowledgeNetworkExposure: true as const }
        : {}),
      ...(values.acknowledgeWritableMounts === true
        ? { acknowledgeWritableMounts: true as const }
        : {}),
    }));
    if (values.path !== undefined && chat.selectedWorkspaceId === workspaceId) {
      await client.selectWorkspace(null);
      void changeWorkspace(workspaceId).catch(() => undefined);
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
    if (
      workspace === undefined ||
      !workspace.available ||
      !workspace.usable ||
      selectedWorkspaceUnavailable
    ) {
      setConversationError("Select a usable workspace before creating a conversation.");
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

  async function changeWorkspace(workspaceId: string): Promise<void> {
    setConversationError(null);
    setLoadingConversationId(null);
    if (client.getState().selectedWorkspaceId === workspaceId) {
      client.selectConversation(null);
      return;
    }
    await client.selectWorkspace(workspaceId);
  }

  function selectConversation(summary: ConversationSummary): void {
    const authoritativeWorkspace = client.getState().workspaces.find(
      (workspace) => workspace.id === summary.workspaceId,
    );
    if (authoritativeWorkspace?.usable !== true) {
      setConversationError("This workspace is blocked by server policy.");
      return;
    }
    client.selectConversation(summary.id);
    setSidebarOpen(false);
    setConversationError(null);

    if (!summary.runnable) {
      setConversationError("This conversation's working directory is unavailable.");
      return;
    }
    const state = client.getState();
    if (state.connection !== "connected") {
      setConversationError("Reconnect to the server before opening this conversation.");
      return;
    }
    if (summary.status !== "closed" && state.conversations[summary.id] !== undefined) {
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
      branchAction !== null ||
      pendingActionRef.current !== null ||
      selectedWorkspaceUnavailable ||
      selectedWorkspaceBlocked
    ) return;

    const conversationId = selectedConversation.id;
    setBranchAction({ kind: "fork", conversationId, entryId });
    setConversationError(null);
    try {
      await runExclusive("conversation.fork", () => client.forkConversation(conversationId, entryId));
      setSidebarOpen(false);
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to fork the conversation."));
    } finally {
      setBranchAction(null);
    }
  }

  async function rewindConversation(entryId: string): Promise<void> {
    if (
      selectedConversation === undefined ||
      selectedConversation.status !== "idle" ||
      branchAction !== null ||
      pendingActionRef.current !== null ||
      selectedWorkspaceUnavailable ||
      selectedWorkspaceBlocked
    ) return;

    const title = selectedConversation.title.trim() || "Untitled conversation";
    const confirmed = window.confirm(
      `Rewind “${title}” to this message? The current conversation will be permanently deleted, and this message will be copied into the new conversation’s composer. This cannot be undone.`,
    );
    if (!confirmed) return;

    const conversationId = selectedConversation.id;
    setBranchAction({ kind: "rewind", conversationId, entryId });
    setConversationError(null);
    try {
      await runExclusive("conversation.rewind", () => client.rewindConversation(conversationId, entryId));
      setSidebarOpen(false);
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to rewind the conversation."));
    } finally {
      setBranchAction(null);
    }
  }

  async function renameConversation(title: string): Promise<void> {
    if (selectedConversation === undefined || pendingActionRef.current !== null) return;
    setConversationError(null);
    try {
      await runExclusive("conversation.rename", () => client.send({
        type: "conversation.rename",
        conversationId: selectedConversation.id,
        title,
      }));
    } catch (error) {
      setConversationError(errorMessage(error, "Unable to rename the conversation."));
      throw error;
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

  async function submitMobileTitle(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const title = mobileTitleDraft.trim();
    if (!mobileRenameEnabled || title.length === 0 || title === mobileTitle) return;
    try {
      await renameConversation(title);
      setMobileActionsOpen(false);
      setMobileRenaming(false);
    } catch {
      mobileTitleInput.current?.focus();
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
        liveWorkspaceIds={liveWorkspaceIds}
        selectedConversationId={chat.selectedConversationId}
        connected={connected}
        historyPending={chat.pendingHistoryWorkspaceId === chat.selectedWorkspaceId}
        historyError={chat.historyError?.workspaceId === chat.selectedWorkspaceId
          ? chat.historyError.message
          : null}
        actionPending={pendingAction !== null}
        publicSandboxConfig={server.config?.sandbox}
        publicManagedEgressConfig={server.config?.managedEgress}
        open={sidebarOpen}
        onDismiss={() => setSidebarOpen(false)}
        onOpenJobs={() => {
          setSidebarOpen(false);
          onOpenJobs();
        }}
        onSelectWorkspace={(workspaceId) => {
          void changeWorkspace(workspaceId).catch(() => undefined);
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
            onClick={() => {
              setMobileActionsOpen(false);
              setMobileRenaming(false);
              setSidebarOpen(true);
            }}
          >
            <span aria-hidden="true">☰</span>
          </button>
          <div className="mobile-app-title">
            <strong title={mobileTitle}>{mobileTitle}</strong>
            {mobileStatus !== undefined && (
              <small>
                <span className={`mobile-conversation-status status-${mobileStatus}`}>
                  <i aria-hidden="true" />{mobileStatusLabel(mobileStatus)}
                </span>
                <span aria-label={`Conversation security: ${mobileSecurityLabel(selectedConversation)}`}>
                  {mobileSecurityLabel(selectedConversation)}
                </span>
              </small>
            )}
          </div>
          <div className="mobile-app-bar-end">
            <span className={`connection-dot${connected ? " is-connected" : ""}`} title={connected ? "Connected" : "Disconnected"} />
            {selectedSummary !== undefined && (
              <button
                ref={mobileActionTrigger}
                className="icon-button mobile-actions-trigger"
                type="button"
                aria-label="Open conversation actions"
                aria-expanded={mobileActionsOpen}
                onClick={() => {
                  setMobileTitleDraft(mobileTitle);
                  setMobileRenaming(false);
                  setMobileActionsOpen((open) => !open);
                }}
              >
                <span aria-hidden="true">⋮</span>
              </button>
            )}
          </div>
          {mobileActionsOpen && (
            <>
              <button
                className="mobile-actions-backdrop"
                type="button"
                aria-label="Close conversation actions"
                onClick={() => {
                  setMobileActionsOpen(false);
                  setMobileRenaming(false);
                  mobileActionTrigger.current?.focus();
                }}
              />
              <section className="mobile-conversation-menu" aria-label="Conversation actions">
                {mobileRenaming ? (
                  <form className="mobile-title-form" onSubmit={(event) => void submitMobileTitle(event)}>
                    <label htmlFor="mobile-conversation-title">Conversation title</label>
                    <input
                      ref={mobileTitleInput}
                      id="mobile-conversation-title"
                      value={mobileTitleDraft}
                      maxLength={MAX_CONVERSATION_TITLE_LENGTH}
                      disabled={!mobileRenameEnabled}
                      onChange={(event) => setMobileTitleDraft(event.target.value)}
                    />
                    <div>
                      <button
                        type="button"
                        onClick={() => {
                          setMobileRenaming(false);
                          window.requestAnimationFrame(() => mobileActionTrigger.current?.focus());
                        }}
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={!mobileRenameEnabled || mobileTitleDraft.trim().length === 0 || mobileTitleDraft.trim() === mobileTitle}
                      >
                        {pendingAction === "conversation.rename" ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <>
                    <dl className="mobile-conversation-facts">
                      <div><dt>Workspace</dt><dd>{selectedWorkspace?.name ?? "—"}</dd></div>
                      <div><dt>Model</dt><dd>{selectedConversation?.model?.name ?? selectedConversation?.model?.id ?? "—"}</dd></div>
                      <div><dt>Context</dt><dd>{mobileContextLabel(selectedConversation)}</dd></div>
                      <div><dt>Security</dt><dd>{mobileSecurityLabel(selectedConversation)}</dd></div>
                    </dl>
                    <div className="mobile-conversation-actions">
                      {mobileOwner?.kind === "scheduled-job" && (
                        <button
                          type="button"
                          onClick={() => {
                            setMobileActionsOpen(false);
                            onOpenJobRun(mobileOwner.jobId, mobileOwner.runId);
                          }}
                        >
                          View scheduled run
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={!connected || pendingAction !== null || !mobileCreateEnabled}
                        onClick={() => {
                          setMobileActionsOpen(false);
                          void createConversation();
                        }}
                      >
                        {pendingAction === "conversation.create" ? "Creating…" : "New conversation"}
                      </button>
                      <button
                        type="button"
                        disabled={!mobileRenameEnabled}
                        onClick={() => setMobileRenaming(true)}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        disabled={!connected || pendingAction !== null || !mobileCloseEnabled}
                        onClick={() => {
                          setMobileActionsOpen(false);
                          void closeConversation();
                        }}
                      >
                        {pendingAction === "conversation.close" ? "Closing…" : "Close"}
                      </button>
                      <button
                        className="mobile-delete-action"
                        type="button"
                        disabled={!connected || pendingAction !== null || !mobileDeleteEnabled}
                        onClick={() => {
                          setMobileActionsOpen(false);
                          void deleteConversation();
                        }}
                      >
                        {pendingAction === "conversation.delete" ? "Deleting…" : "Delete"}
                      </button>
                    </div>
                  </>
                )}
              </section>
            </>
          )}
        </div>

        {selectedWorkspace === undefined ? (
          <section className="welcome-panel">
            <p className="eyebrow">Local agent platform</p>
            <h1>{chat.workspaces.length === 0 ? "Add your first workspace" : "Select a workspace"}</h1>
            <p>
              {chat.workspaces.length === 0
                ? "Register a named project directory to create and find its conversations."
                : "Choose a workspace"}
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
        ) : selectedSummary === undefined ? (
          <WorkspaceConversationPicker
            workspace={selectedWorkspace}
            conversations={chat.historyWorkspaceId === selectedWorkspace.id ? chat.history : []}
            liveStatuses={liveStatuses}
            connected={connected}
            historyPending={chat.pendingHistoryWorkspaceId === selectedWorkspace.id}
            historyError={chat.historyError?.workspaceId === selectedWorkspace.id
              ? chat.historyError.message
              : null}
            actionPending={pendingAction !== null}
            error={visibleError ?? null}
            onCreate={createConversation}
            onSelect={selectConversation}
          />
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
                : pendingAction === "conversation.create"
                  ? "create"
                  : pendingAction === "conversation.close"
                    ? "close"
                    : pendingAction === "conversation.delete"
                      ? "delete"
                      : pendingAction === "conversation.rename"
                        ? "rename"
                        : "other"}
              onRename={renameConversation}
              onCreate={() => void createConversation()}
              onClose={() => void closeConversation()}
              onDelete={() => void deleteConversation()}
              onOpenJobRun={onOpenJobRun}
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
                <div className={`conversation-workspace${(selectedProjection?.networkBlocked.length ?? 0) > 0 ? " has-network-notices" : ""}`}>
                  {(selectedProjection?.networkBlocked.length ?? 0) > 0 && (
                    <NetworkBlockedNotices notices={selectedProjection?.networkBlocked ?? []} />
                  )}
                  <MessageTimeline
                    conversationId={selectedConversation.id}
                    messages={selectedConversation.messages}
                    notices={selectedProjection?.notices ?? []}
                    queue={selectedConversation.queue}
                    streaming={selectedConversation.status === "streaming"}
                    cwd={selectedConversation.cwd}
                    canFork={connected && selectedConversation.owner === undefined && !selectedWorkspaceUnavailable && !selectedWorkspaceBlocked && pendingAction === null && selectedConversation.status === "idle"}
                    forkingEntryId={branchAction?.kind === "fork" && branchAction.conversationId === selectedConversation.id
                      ? branchAction.entryId
                      : null}
                    rewindingEntryId={branchAction?.kind === "rewind" && branchAction.conversationId === selectedConversation.id
                      ? branchAction.entryId
                      : null}
                    onFork={(entryId) => void forkConversation(entryId)}
                    onRewind={(entryId) => void rewindConversation(entryId)}
                  />
                  <Composer
                    key={selectedConversation.id}
                    status={selectedConversation.status}
                    draft={chat.drafts[selectedConversation.id] ?? ""}
                    queue={selectedConversation.queue}
                    connected={connected && !selectedWorkspaceUnavailable && pendingAction === null}
                    mutationLocked={selectedConversation.owner?.kind === "scheduled-job"}
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
