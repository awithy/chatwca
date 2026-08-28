import type {
  ConversationState,
  ConversationSummary,
} from "../../../shared/protocol.js";
import { conversationTitle } from "./conversation-list.js";

export interface ConversationHeaderProps {
  readonly conversation: ConversationState | undefined;
  readonly summary: ConversationSummary;
  readonly loading: boolean;
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
  loading,
}: ConversationHeaderProps) {
  const model = conversation?.model;
  const modelLabel = model === undefined
    ? "Loading model…"
    : model === null
      ? "No model available"
      : model.name ?? model.id;
  const status = loading ? "Opening" : headerStatus(conversation, summary);
  const statusClass = loading ? "opening" : (conversation?.status ?? summary.status);

  return (
    <header className="conversation-header">
      <div className="conversation-heading">
        <h1>{conversation?.title.trim() || conversationTitle(summary)}</h1>
        <p className="conversation-cwd" title={conversation?.cwd ?? summary.cwd}>
          <span aria-hidden="true">⌁</span>
          {conversation?.cwd ?? summary.cwd}
        </p>
      </div>
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
    </header>
  );
}
