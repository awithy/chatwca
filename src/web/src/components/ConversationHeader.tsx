import * as React from "react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import {
  MAX_CONVERSATION_TITLE_LENGTH,
  type ConversationState,
  type ConversationSummary,
  type WorkspaceSummary,
} from "../../../shared/protocol.js";
import {
  canCloseConversation,
  canDeleteConversation,
} from "./chat-interactions.js";
import { conversationTitle } from "./conversation-list.js";

export interface ConversationHeaderProps {
  readonly conversation: ConversationState | undefined;
  readonly summary: ConversationSummary;
  readonly workspace: WorkspaceSummary;
  readonly loading: boolean;
  readonly connected: boolean;
  readonly actionPending: "create" | "close" | "delete" | "rename" | "other" | null;
  readonly onRename: (title: string) => Promise<void>;
  readonly onCreate: () => void;
  readonly onClose: () => void;
  readonly onDelete: () => void;
  readonly onOpenJobRun: (jobId: string, runId: string) => void;
}

function formatTokens(count: number): string {
  if (count < 1_000) return count.toString();
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

function headerStatus(
  conversation: ConversationState | undefined,
  summary: ConversationSummary,
): string {
  const status = conversation?.status ?? summary.status;
  switch (status) {
    case "closed":
      return "Closed";
    case "idle":
      return "Idle";
    case "streaming":
      return "Running";
    case "aborting":
      return "Stopping";
    case "error":
      return "Error";
  }
}

export function ConversationHeader({
  conversation,
  summary,
  workspace,
  loading,
  connected,
  actionPending,
  onRename,
  onCreate,
  onClose,
  onDelete,
  onOpenJobRun,
}: ConversationHeaderProps) {
  const displayTitle = conversation?.title.trim() || conversationTitle(summary);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(displayTitle);
  const titleInput = useRef<HTMLInputElement>(null);
  const model = conversation?.model;
  const modelLabel = model === undefined
    ? "Loading model…"
    : model === null
      ? "No model available"
      : model.name ?? model.id;
  const contextUsage = conversation?.contextUsage;
  const contextLabel = contextUsage === undefined
    ? loading ? "Loading…" : "—"
    : contextUsage === null
      ? "—"
      : `${contextUsage.percent === null ? "?" : `${contextUsage.percent.toFixed(1)}%`}/${formatTokens(contextUsage.contextWindow)}`;
  const contextTitle = contextUsage === undefined || contextUsage === null
    ? undefined
    : contextUsage.tokens === null
      ? `Context usage unknown · ${contextUsage.contextWindow.toLocaleString()} token window`
      : `${contextUsage.tokens.toLocaleString()} of ${contextUsage.contextWindow.toLocaleString()} context tokens`;
  const status = loading ? "Opening" : headerStatus(conversation, summary);
  const statusClass = loading ? "opening" : (conversation?.status ?? summary.status);
  const actualStatus = conversation?.status ?? summary.status;
  const securityProfile = conversation?.securityProfile;
  const networkPolicy = conversation?.networkPolicy;
  const securityLabel = securityProfile === undefined
    ? "Loading security profile…"
    : securityProfile === "workspace-sandboxed"
      ? networkPolicy === "managed-egress"
        ? "Sandboxed · Managed egress"
        : "Sandboxed · Network isolated"
      : "Unrestricted";
  const owner = conversation?.owner ?? summary.owner;
  const mutationLocked = owner?.kind === "scheduled-job";
  const createEnabled = workspace.available && workspace.usable;
  const closeEnabled = !mutationLocked && conversation !== undefined && canCloseConversation(conversation.status);
  const deleteEnabled = !mutationLocked && canDeleteConversation(actualStatus);
  const renameEnabled = !mutationLocked && conversation !== undefined && connected && !loading && actionPending === null;
  const normalizedDraft = titleDraft.trim();
  const saveEnabled = renameEnabled && normalizedDraft.length > 0 && normalizedDraft !== displayTitle;

  useEffect(() => {
    setEditingTitle(false);
    setTitleDraft(displayTitle);
  }, [summary.id]);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(displayTitle);
  }, [displayTitle, editingTitle]);

  useEffect(() => {
    if (editingTitle) titleInput.current?.select();
  }, [editingTitle]);

  function cancelTitleEdit(): void {
    setTitleDraft(displayTitle);
    setEditingTitle(false);
  }

  async function submitTitle(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!saveEnabled) return;
    try {
      await onRename(normalizedDraft);
      setEditingTitle(false);
    } catch {
      titleInput.current?.focus();
    }
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelTitleEdit();
    }
  }

  return (
    <header className="conversation-header">
      <div className="conversation-heading">
        <p className="conversation-workspace-name">
          <span>{workspace.name}</span>
          {!workspace.available ? (
            <strong>Workspace unavailable</strong>
          ) : !workspace.usable ? (
            <strong>Workspace blocked by policy</strong>
          ) : null}
          {owner?.kind === "scheduled-job" && (
            <button
              type="button"
              className="job-owner-badge"
              onClick={() => onOpenJobRun(owner.jobId, owner.runId)}
            >
              Scheduled job · View run
            </button>
          )}
          <span
            className={`security-badge${securityProfile === undefined ? " security-loading" : securityProfile === "workspace-sandboxed" ? networkPolicy === "managed-egress" ? " security-managed" : " security-sandboxed" : " security-unrestricted"}`}
            aria-label={`Conversation security: ${securityLabel}`}
          >
            {securityLabel}
          </span>
        </p>
        {editingTitle ? (
          <form className="conversation-title-form" onSubmit={(event) => void submitTitle(event)}>
            <label className="visually-hidden" htmlFor="conversation-title-input">Conversation title</label>
            <input
              ref={titleInput}
              id="conversation-title-input"
              value={titleDraft}
              maxLength={MAX_CONVERSATION_TITLE_LENGTH}
              aria-invalid={normalizedDraft.length === 0}
              disabled={!connected || loading || actionPending !== null}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={handleTitleKeyDown}
            />
            <button className="title-save-button" type="submit" disabled={!saveEnabled}>
              {actionPending === "rename" ? "Saving…" : "Save"}
            </button>
            <button
              className="title-cancel-button"
              type="button"
              disabled={actionPending === "rename"}
              onClick={cancelTitleEdit}
            >
              Cancel
            </button>
          </form>
        ) : (
          <div className="conversation-title-row">
            <h1 title={displayTitle}>{displayTitle}</h1>
            <button
              className="edit-title-button"
              type="button"
              aria-label="Edit conversation title"
              disabled={!renameEnabled}
              onClick={() => setEditingTitle(true)}
            >
              <span aria-hidden="true">✎</span>
            </button>
          </div>
        )}
        <p className="conversation-workspace-path" title={workspace.path}>
          <span aria-hidden="true">⌁</span>
          {workspace.path}
        </p>
      </div>
      <div className="conversation-header-end">
        <dl className="conversation-facts">
          <div>
            <dt>Model</dt>
            <dd title={model === null || model === undefined ? undefined : `${model.provider}/${model.id}`}>
              {modelLabel}
            </dd>
          </div>
          <div>
            <dt>Context</dt>
            <dd title={contextTitle}>{contextLabel}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd className={`header-status status-${statusClass}`}>
              <i aria-hidden="true" />{status}
            </dd>
          </div>
        </dl>
        <div className="conversation-header-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={!connected || loading || actionPending !== null || !createEnabled}
            title={createEnabled ? `Start a new conversation in ${workspace.name}` : "This workspace cannot start conversations"}
            onClick={onCreate}
          >
            {actionPending === "create" ? "Creating…" : "New"}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!connected || loading || actionPending !== null || !closeEnabled}
            title={closeEnabled ? "Close this live session" : "Active runs must finish or be aborted before closing"}
            onClick={onClose}
          >
            {actionPending === "close" ? "Closing…" : "Close"}
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={!connected || loading || actionPending !== null || !deleteEnabled}
            title={deleteEnabled ? "Delete this conversation permanently" : "Active runs cannot be deleted"}
            onClick={onDelete}
          >
            {actionPending === "delete" ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </header>
  );
}
