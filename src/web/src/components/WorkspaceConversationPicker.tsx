import * as React from "react";

import type {
  ConversationSummary,
  LiveConversationStatus,
  WorkspaceSummary,
} from "../../../shared/protocol.js";
import { conversationTitle, orderConversations } from "./conversation-list.js";

type DisplayStatus = ConversationSummary["status"] | LiveConversationStatus;

export interface WorkspaceConversationPickerProps {
  readonly workspace: WorkspaceSummary;
  readonly conversations: readonly ConversationSummary[];
  readonly liveStatuses: Readonly<Record<string, LiveConversationStatus>>;
  readonly connected: boolean;
  readonly historyPending: boolean;
  readonly historyError: string | null;
  readonly actionPending: boolean;
  readonly error: string | null;
  readonly onCreate: () => Promise<void>;
  readonly onSelect: (conversation: ConversationSummary) => void;
}

function statusLabel(status: DisplayStatus): string {
  switch (status) {
    case "closed": return "Closed";
    case "idle": return "Idle";
    case "streaming": return "Running";
    case "aborting": return "Stopping";
    case "error": return "Error";
  }
}

function formatModified(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

export function WorkspaceConversationPicker({
  workspace,
  conversations,
  liveStatuses,
  connected,
  historyPending,
  historyError,
  actionPending,
  error,
  onCreate,
  onSelect,
}: WorkspaceConversationPickerProps) {
  const scopedConversations = orderConversations(
    conversations.filter((conversation) => conversation.workspaceId === workspace.id),
  );
  const unavailable = !workspace.available || historyError !== null;
  const canOpen = connected && workspace.available && workspace.usable && historyError === null;

  return (
    <section className="workspace-conversation-picker" aria-labelledby="workspace-picker-heading">
      <header className="workspace-picker-header">
        <div>
          <p className="eyebrow">Workspace</p>
          <h1 id="workspace-picker-heading">
            {!workspace.available
              ? "Workspace unavailable"
              : !workspace.usable
                ? "Workspace blocked by policy"
                : `Start in ${workspace.name}`}
          </h1>
          <p className="workspace-picker-path">{workspace.path}</p>
        </div>
        <button
          className="primary-button workspace-picker-create"
          type="button"
          disabled={!canOpen || actionPending}
          onClick={() => void onCreate()}
        >
          <span aria-hidden="true">＋</span>
          New conversation
        </button>
      </header>

      {error !== null && error !== historyError && (
        <p className="page-error workspace-picker-error" role="alert">{error}</p>
      )}

      {historyPending ? (
        <div className="workspace-picker-state" role="status">
          <span className="loading-spinner" aria-hidden="true" />
          <p>Loading conversations…</p>
        </div>
      ) : unavailable ? (
        <div className="workspace-picker-state workspace-picker-state-error" role="status">
          <h2>{workspace.available ? "Unable to load conversations" : "Conversations unavailable"}</h2>
          <p>{historyError ?? "Restore the workspace directory to load its conversations."}</p>
        </div>
      ) : scopedConversations.length === 0 ? (
        <div className="workspace-picker-state">
          <h2>No conversations yet</h2>
          <p>Create a conversation to start working in this workspace.</p>
        </div>
      ) : (
        <div className="workspace-picker-list-wrap">
          <div className="workspace-picker-list-heading">
            <h2>Conversations</h2>
            <span>{scopedConversations.length}</span>
          </div>
          <ul className="workspace-picker-list">
            {scopedConversations.map((conversation) => {
              const status = liveStatuses[conversation.id] ?? conversation.status;
              return (
                <li key={conversation.id}>
                  <button
                    className="workspace-picker-row"
                    type="button"
                    disabled={!canOpen || actionPending || !conversation.runnable}
                    title={!workspace.usable
                      ? "Server policy prevents opening conversations in this workspace"
                      : !conversation.runnable
                        ? "This conversation is unavailable"
                        : undefined}
                    onClick={() => onSelect(conversation)}
                  >
                    <span className="workspace-picker-row-heading">
                      <strong>{conversationTitle(conversation)}</strong>
                      <span className={`conversation-status status-${status}`}>
                        <i aria-hidden="true" />{statusLabel(status)}
                      </span>
                    </span>
                    <span className="workspace-picker-row-meta">
                      <span>{conversation.messageCount} {conversation.messageCount === 1 ? "message" : "messages"}</span>
                      <time dateTime={new Date(conversation.modifiedAt).toISOString()}>
                        Updated {formatModified(conversation.modifiedAt)}
                      </time>
                    </span>
                    {!conversation.runnable && (
                      <span className="unavailable-label">Conversation unavailable</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
