import * as React from "react";
import { useEffect, useRef, type UIEvent } from "react";

import type {
  NormalizedMessage,
  UserContentBlock,
  AssistantContentBlock,
  ToolResultBlock,
  QueueState,
  StatusNotice,
  Usage,
} from "../../../shared/protocol.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { RunActivity } from "./RunActivity.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { ToolCallCard } from "./ToolCallCard.js";

export interface MessageTimelineProps {
  readonly conversationId?: string;
  readonly messages: readonly NormalizedMessage[];
  readonly notices: readonly StatusNotice[];
  readonly queue: QueueState;
  readonly streaming: boolean;
  readonly cwd: string;
  readonly canFork?: boolean;
  readonly forkingEntryId?: string | null;
  readonly rewindingEntryId?: string | null;
  readonly onFork?: (entryId: string) => void;
  readonly onRewind?: (entryId: string) => void;
}

function formatTime(timestamp: number | undefined): string | null {
  if (timestamp === undefined) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.valueOf())) return null;
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function stopReasonLabel(
  reason: Extract<NormalizedMessage, { role: "assistant" }>["stopReason"],
): string | null {
  switch (reason) {
    case "stop":
      return "Completed";
    case "length":
      return "Token limit reached";
    case "tool-use":
      return "Tool use";
    case "aborted":
      return "Aborted";
    case "error":
      return "Error";
    case "unknown":
      return "Unknown";
    case undefined:
      return null;
  }
}

function formatCost(cost: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(cost);
}

function UsageMetadata({ usage }: { readonly usage: Usage }) {
  return (
    <>
      <span>{usage.inputTokens.toLocaleString()} input tokens</span>
      <span>{usage.outputTokens.toLocaleString()} output tokens</span>
      {usage.cacheReadTokens !== undefined && (
        <span>{usage.cacheReadTokens.toLocaleString()} cache-read tokens</span>
      )}
      {usage.cacheWriteTokens !== undefined && (
        <span>{usage.cacheWriteTokens.toLocaleString()} cache-write tokens</span>
      )}
      {usage.totalCost !== undefined && (
        <span>{formatCost(usage.totalCost)} cost</span>
      )}
    </>
  );
}

function RunMetadata({
  message,
}: {
  readonly message: Extract<NormalizedMessage, { role: "assistant" }>;
}) {
  const reason = stopReasonLabel(message.stopReason);
  if (reason === null && message.usage === undefined) return null;

  return (
    <footer className="message-run-metadata" aria-label="Run metadata">
      {reason !== null && (
        <span className={`stop-reason stop-${message.stopReason ?? "unknown"}`}>
          Stop: {reason}
        </span>
      )}
      {message.usage !== undefined && <UsageMetadata usage={message.usage} />}
    </footer>
  );
}

function ImageAttachment({
  block,
  assistant,
}: {
  readonly block: Extract<UserContentBlock | AssistantContentBlock, { type: "image" }>;
  readonly assistant: boolean;
}) {
  const source = "url" in block.image
    ? block.image.url
    : `data:${block.image.mimeType};base64,${block.image.data}`;
  const label = block.alt ?? block.image.name ?? (
    assistant ? "Generated image" : "Attached image"
  );

  return (
    <figure className="message-image">
      <a href={source} target="_blank" rel="noreferrer" aria-label={`Open ${label}`}>
        <img src={source} alt={label} decoding="async" />
      </a>
      <figcaption className="message-attachment">
        <span aria-hidden="true">▧</span>
        {label}
      </figcaption>
    </figure>
  );
}

function MessageContent({
  blocks,
  markdown,
  toolCallIds,
  toolResults,
  conversationId,
}: {
  readonly blocks: readonly (UserContentBlock | AssistantContentBlock)[];
  readonly markdown: boolean;
  readonly toolCallIds: ReadonlySet<string>;
  readonly toolResults: ReadonlyMap<string, ToolResultBlock>;
  readonly conversationId?: string;
}) {
  return (
    <div className="message-blocks">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "text":
            return markdown ? (
              <MarkdownContent
                text={block.text}
                {...(conversationId === undefined ? {} : { conversationId })}
                key={`text-${index}`}
              />
            ) : (
              <p className="message-text" key={`text-${index}`}>{block.text}</p>
            );
          case "image":
            return (
              <ImageAttachment
                block={block}
                assistant={markdown}
                key={`image-${index}`}
              />
            );
          case "thinking":
            return <ThinkingBlock text={block.text} key={`thinking-${index}`} />;
          case "tool-call":
            return (
              <ToolCallCard
                call={block}
                result={toolResults.get(block.toolCallId)}
                key={`tool-${block.toolCallId}-${index}`}
              />
            );
          case "tool-result":
            // Persisted Pi tool results are separate messages. Render a linked
            // result with its call card instead of duplicating it in the timeline.
            if (toolCallIds.has(block.toolCallId)) return null;
            return (
              <ToolCallCard
                call={undefined}
                result={block}
                key={`orphan-tool-${block.toolCallId}-${index}`}
              />
            );
        }
      })}
    </div>
  );
}

function hasVisibleContent(
  message: NormalizedMessage,
  toolCallIds: ReadonlySet<string>,
): boolean {
  if (
    message.role === "user" ||
    message.error !== undefined ||
    message.stopReason !== undefined ||
    message.usage !== undefined
  ) return true;
  return message.blocks.some(
    (block) => block.type !== "tool-result" || !toolCallIds.has(block.toolCallId),
  );
}

export function MessageTimeline({
  conversationId,
  messages,
  notices,
  queue,
  streaming,
  cwd,
  canFork = false,
  forkingEntryId = null,
  rewindingEntryId = null,
  onFork,
  onRewind,
}: MessageTimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const toolCallIds = new Set<string>();
  const toolResults = new Map<string, ToolResultBlock>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const block of message.blocks) {
      if (block.type === "tool-call") toolCallIds.add(block.toolCallId);
      if (block.type === "tool-result") toolResults.set(block.toolCallId, block);
    }
  }

  const visibleMessages = messages.filter((message) =>
    hasVisibleContent(message, toolCallIds));
  const lastMessage = visibleMessages.at(-1);

  useEffect(() => {
    const timeline = timelineRef.current;
    if (timeline !== null && followOutputRef.current) {
      timeline.scrollTop = timeline.scrollHeight;
    }
  }, [messages, notices, queue]);

  function trackScroll(event: UIEvent<HTMLDivElement>): void {
    const timeline = event.currentTarget;
    const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    followOutputRef.current = distanceFromBottom < 96;
  }

  return (
    <div
      ref={timelineRef}
      className="message-timeline"
      role="log"
      aria-label="Conversation messages"
      aria-live="polite"
      onScroll={trackScroll}
    >
      <div className={`message-list${messages.length === 0 ? " has-no-messages" : ""}`}>
        {messages.length === 0 && (
          <div className="timeline-empty">
            <div className="timeline-empty-mark" aria-hidden="true">›_</div>
            <h2>Ready for a new prompt</h2>
            <p>This session is open in <span>{cwd}</span>.</p>
          </div>
        )}
        {visibleMessages.map((message) => {
          const activeAssistant = streaming && message === lastMessage && message.role === "assistant";
          const timestamp = message.timestamp;
          const time = formatTime(timestamp);
          return (
            <article
              className={`chat-message message-${message.role}${activeAssistant ? " is-streaming" : ""}`}
              key={message.entryId}
              data-entry-id={message.entryId}
            >
              <header className="message-heading">
                <strong>{message.role === "user" ? "You" : "Assistant"}</strong>
                {time !== null && timestamp !== undefined && (
                  <time dateTime={new Date(timestamp).toISOString()}>{time}</time>
                )}
                {message.role === "user" && message.forkEligible && (() => {
                  const isForking = forkingEntryId === message.entryId;
                  const isRewinding = rewindingEntryId === message.entryId;
                  const branchActionPending = forkingEntryId !== null || rewindingEntryId !== null;
                  return (
                    <span className="message-branch-actions">
                      <button
                        className="message-fork-button"
                        type="button"
                        disabled={!canFork || branchActionPending || onFork === undefined}
                        aria-busy={isForking || undefined}
                        aria-label="Fork conversation from this message"
                        title={!canFork ? "Forking is available while this conversation is idle and connected." : undefined}
                        onClick={() => onFork?.(message.entryId)}
                      >
                        <span aria-hidden="true">⑂</span>
                        {isForking ? "Forking…" : "Fork"}
                      </button>
                      <button
                        className="message-rewind-button"
                        type="button"
                        disabled={!canFork || branchActionPending || onRewind === undefined}
                        aria-busy={isRewinding || undefined}
                        aria-label="Rewind conversation to this message"
                        title={!canFork ? "Rewinding is available while this conversation is idle and connected." : "Replace this conversation with a fork from this message"}
                        onClick={() => onRewind?.(message.entryId)}
                      >
                        <span aria-hidden="true">↶</span>
                        {isRewinding ? "Rewinding…" : "Rewind"}
                      </button>
                    </span>
                  );
                })()}
              </header>
              {message.role === "user" && (
                forkingEntryId === message.entryId || rewindingEntryId === message.entryId
              ) && (
                <span className="visually-hidden" role="status">
                  {rewindingEntryId === message.entryId
                    ? "Rewinding the conversation to this message."
                    : "Creating a new conversation from this message."}
                </span>
              )}
              <MessageContent
                blocks={message.blocks}
                markdown={message.role === "assistant"}
                toolCallIds={toolCallIds}
                toolResults={toolResults}
                {...(conversationId === undefined ? {} : { conversationId })}
              />
              {message.role === "assistant" && message.error !== undefined && (
                <div className="message-error" role="alert">
                  <strong>Run failed</strong>
                  <span>{message.error.message}</span>
                </div>
              )}
              {message.role === "assistant" && !activeAssistant && (
                <RunMetadata message={message} />
              )}
            </article>
          );
        })}
        <RunActivity notices={notices} queue={queue} />
      </div>
    </div>
  );
}
