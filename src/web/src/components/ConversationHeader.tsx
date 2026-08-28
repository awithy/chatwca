import type {
  ConversationState,
  ConversationSummary,
  WorkspaceSummary,
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
  readonly actionPending: "close" | "delete" | "other" | null;
  readonly onClose: () => void;
  readonly onDelete: () => void;
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
  onClose,
  onDelete,
}: ConversationHeaderProps) {
  const model = conversation?.model;
  const modelLabel = model === undefined
    ? "Loading model…"
    : model === null
      ? "No model available"
      : model.name ?? model.id;
  const status = loading ? "Opening" : headerStatus(conversation, summary);
  const statusClass = loading ? "opening" : (conversation?.status ?? summary.status);
  const actualStatus = conversation?.status ?? summary.status;
  const closeEnabled = conversation !== undefined && canCloseConversation(conversation.status);
  const deleteEnabled = canDeleteConversation(actualStatus);

  return (
    <header className="conversation-header">
      <div className="conversation-heading">
        <p className="conversation-workspace-name">
          <span>{workspace.name}</span>
          {!workspace.available && <strong>Workspace unavailable</strong>}
        </p>
        <h1>{conversationTitle(summary)}</h1>
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
