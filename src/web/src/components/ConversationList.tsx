import * as React from "react";

import type {
  ConversationSummary,
  LiveConversationStatus,
  WorkspaceSummary,
} from "../../../shared/protocol.js";
import { conversationTitle, orderConversations } from "./conversation-list.js";

type DisplayStatus = ConversationSummary["status"] | LiveConversationStatus;

export interface ConversationListProps {
  readonly workspace: WorkspaceSummary | null;
  readonly conversations: readonly ConversationSummary[];
  readonly liveStatuses: Readonly<Record<string, LiveConversationStatus>>;
  readonly selectedConversationId: string | null;
  readonly connected: boolean;
  readonly historyPending: boolean;
  readonly historyError: string | null;
  readonly actionPending: boolean;
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
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function ConversationList({
  workspace,
  conversations,
  liveStatuses,
  selectedConversationId,
  connected,
  historyPending,
  historyError,
  actionPending,
  onCreate,
  onSelect,
}: ConversationListProps) {
  const canStartRuntime = workspace?.available === true &&
    workspace.usable && historyError === null;
  const scopedConversations = workspace === null
    ? []
    : orderConversations(conversations.filter((item) => item.workspaceId === workspace.id));

  return (
    <section className="conversation-list-panel" aria-labelledby="conversation-list-heading">
      <div className="conversation-list-header">
        <div>
          <h2 id="conversation-list-heading">Conversations</h2>
          {workspace !== null && <span>{workspace.name}</span>}
        </div>
        <button
          className="new-conversation-button"
          type="button"
          disabled={!connected || !canStartRuntime || actionPending}
          aria-label={workspace === null ? "New conversation (select a workspace first)" : `New conversation in ${workspace.name}`}
          onClick={() => void onCreate()}
        >
          <span aria-hidden="true">＋</span>
          New
        </button>
      </div>

      <div className="conversation-list-body">
        {workspace !== null && workspace.available && !workspace.usable && (
          <div className="sidebar-state sidebar-state-policy" role="status">
            <strong>Workspace blocked by policy</strong>
            <p>History and Workspace Info remain available. New, Open, Fork, and Rewind are disabled.</p>
          </div>
        )}

        {workspace === null ? (
          <p className="sidebar-empty">Select a workspace to load its conversations.</p>
        ) : !workspace.available || historyError !== null ? (
          <div className="sidebar-state sidebar-state-unavailable" role="status">
            <strong>{workspace.available ? "Unable to load conversations" : "Workspace unavailable"}</strong>
            <p>{historyError ?? "Restore the directory at the registered path to load conversations."}</p>
            <code>{workspace.path}</code>
          </div>
        ) : historyPending ? (
          <div className="sidebar-state" role="status">
            <span className="loading-spinner" aria-hidden="true" />
            <p>Loading conversations…</p>
          </div>
        ) : scopedConversations.length === 0 ? (
          <p className="sidebar-empty">No conversations in this workspace yet.</p>
        ) : (
          <nav className="conversation-list" aria-label={`Conversation history for ${workspace.name}`}>
            <ul>
              {scopedConversations.map((conversation) => {
                const status = liveStatuses[conversation.id] ?? conversation.status;
                const selected = conversation.id === selectedConversationId;
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={`conversation-row${selected ? " is-selected" : ""}`}
                      aria-current={selected ? "page" : undefined}
                      disabled={actionPending || !workspace.usable || !conversation.runnable}
                      title={!workspace.usable
                        ? "Server policy prevents opening conversations in this workspace"
                        : !conversation.runnable
                          ? "This conversation is unavailable"
                          : undefined}
                      onClick={() => onSelect(conversation)}
                    >
                      <span className="conversation-row-heading">
                        <strong>{conversationTitle(conversation)}</strong>
                        <span className={`conversation-status status-${status}`}>
                          <i aria-hidden="true" />{statusLabel(status)}
                        </span>
                      </span>
                      <span className="conversation-row-meta">
                        <span>{conversation.messageCount} {conversation.messageCount === 1 ? "message" : "messages"}</span>
                        <time dateTime={new Date(conversation.modifiedAt).toISOString()}>{formatModified(conversation.modifiedAt)}</time>
                      </span>
                      {!conversation.runnable && <span className="unavailable-label">Conversation unavailable</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
        )}
      </div>
    </section>
  );
}
