import { useEffect, useMemo, useState, type FormEvent } from "react";

import type {
  ConversationSummary,
  LiveConversationStatus,
} from "../../../shared/protocol.js";
import {
  conversationTitle,
  groupConversations,
} from "./conversation-list.js";

type DisplayStatus = ConversationSummary["status"] | LiveConversationStatus;

export interface ConversationSidebarProps {
  readonly conversations: readonly ConversationSummary[];
  readonly liveStatuses: Readonly<Record<string, LiveConversationStatus>>;
  readonly selectedConversationId: string | null;
  readonly defaultCwd: string;
  readonly connected: boolean;
  readonly open: boolean;
  readonly onDismiss: () => void;
  readonly onCreate: (cwd: string) => Promise<void>;
  readonly onSelect: (conversation: ConversationSummary) => void;
}

function statusLabel(status: DisplayStatus): string {
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

function formatModified(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function ConversationSidebar({
  conversations,
  liveStatuses,
  selectedConversationId,
  defaultCwd,
  connected,
  open,
  onDismiss,
  onCreate,
  onSelect,
}: ConversationSidebarProps) {
  const [showCreate, setShowCreate] = useState(false);
  const [cwd, setCwd] = useState(defaultCwd);
  const [cwdEdited, setCwdEdited] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [cwdFilter, setCwdFilter] = useState("all");

  useEffect(() => {
    if (!cwdEdited) setCwd(defaultCwd);
  }, [cwdEdited, defaultCwd]);

  const workspaces = useMemo(
    () => [...new Set(conversations.map((item) => item.cwd))].sort(),
    [conversations],
  );
  const groups = useMemo(
    () => groupConversations(conversations, cwdFilter === "all" ? null : cwdFilter),
    [conversations, cwdFilter],
  );

  async function submitCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const requestedCwd = cwd.trim();
    if (requestedCwd.length === 0) {
      setCreateError("Enter a working directory.");
      return;
    }

    setCreating(true);
    setCreateError(null);
    try {
      await onCreate(requestedCwd);
      setShowCreate(false);
      setCwd(defaultCwd);
      setCwdEdited(false);
    } catch (error: unknown) {
      setCreateError(
        error instanceof Error ? error.message : "Unable to create the conversation.",
      );
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className={`conversation-sidebar${open ? " is-open" : ""}`} aria-label="Conversations">
      <div className="sidebar-brand">
        <div>
          <span className="brand-mark" aria-hidden="true">W</span>
          <div>
            <strong>ChatWCA</strong>
            <small>Pi coding agent</small>
          </div>
        </div>
        <button className="icon-button sidebar-dismiss" type="button" onClick={onDismiss} aria-label="Close conversations">
          <span aria-hidden="true">×</span>
        </button>
      </div>

      <div className="sidebar-actions">
        <button
          className="new-conversation-button"
          type="button"
          disabled={!connected}
          aria-expanded={showCreate}
          onClick={() => {
            setShowCreate((visible) => !visible);
            setCreateError(null);
          }}
        >
          <span aria-hidden="true">＋</span>
          New conversation
        </button>

        {showCreate && (
          <form className="new-conversation-form" onSubmit={(event) => void submitCreate(event)}>
            <label htmlFor="new-conversation-cwd">Working directory</label>
            <input
              id="new-conversation-cwd"
              value={cwd}
              disabled={creating}
              spellCheck={false}
              autoComplete="off"
              aria-describedby={createError === null ? undefined : "new-conversation-error"}
              aria-invalid={createError !== null}
              onChange={(event) => {
                setCwd(event.target.value);
                setCwdEdited(true);
                setCreateError(null);
              }}
            />
            {createError !== null && (
              <p className="form-error" id="new-conversation-error" role="alert">{createError}</p>
            )}
            <div className="form-actions">
              <button type="button" disabled={creating} onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="primary-button" type="submit" disabled={creating || !connected}>
                {creating ? "Creating…" : "Create"}
              </button>
            </div>
          </form>
        )}

        <label className="workspace-filter" htmlFor="workspace-filter">
          <span>Workspace</span>
          <select
            id="workspace-filter"
            value={cwdFilter}
            onChange={(event) => setCwdFilter(event.target.value)}
          >
            <option value="all">All workspaces</option>
            {workspaces.map((workspace) => (
              <option key={workspace} value={workspace}>{workspace}</option>
            ))}
          </select>
        </label>
      </div>

      <nav className="conversation-list" aria-label="Conversation history">
        {groups.length === 0 ? (
          <p className="sidebar-empty">
            {conversations.length === 0 ? "No conversations yet." : "No conversations in this workspace."}
          </p>
        ) : groups.map((group) => (
          <section className="conversation-group" key={group.cwd}>
            <h2 title={group.cwd}>{group.cwd}</h2>
            <ul>
              {group.conversations.map((conversation) => {
                const status = liveStatuses[conversation.id] ?? conversation.status;
                const selected = conversation.id === selectedConversationId;
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      className={`conversation-row${selected ? " is-selected" : ""}`}
                      aria-current={selected ? "page" : undefined}
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
                      {!conversation.runnable && <span className="unavailable-label">Workspace unavailable</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </nav>

      <div className="connection-summary" aria-live="polite">
        <span className={`connection-dot${connected ? " is-connected" : ""}`} />
        {connected ? "Connected" : "Connecting…"}
      </div>
    </aside>
  );
}
