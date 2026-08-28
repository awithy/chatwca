import * as React from "react";
import { useEffect, useRef, type UIEvent } from "react";

import type {
  NormalizedMessage,
  UserContentBlock,
  AssistantContentBlock,
  ToolResultBlock,
} from "../../../shared/protocol.js";
import { MarkdownContent } from "./MarkdownContent.js";
import { ThinkingBlock } from "./ThinkingBlock.js";
import { ToolCallCard } from "./ToolCallCard.js";

export interface MessageTimelineProps {
  readonly messages: readonly NormalizedMessage[];
  readonly streaming: boolean;
  readonly cwd: string;
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

function ImageAttachment({
  block,
}: {
  readonly block: Extract<UserContentBlock | AssistantContentBlock, { type: "image" }>;
}) {
  return (
    <span className="message-attachment">
      <span aria-hidden="true">▧</span>
      {block.image.name ?? "Image attachment"}
    </span>
  );
}

function MessageContent({
  blocks,
  markdown,
  toolCallIds,
  toolResults,
}: {
  readonly blocks: readonly (UserContentBlock | AssistantContentBlock)[];
  readonly markdown: boolean;
  readonly toolCallIds: ReadonlySet<string>;
  readonly toolResults: ReadonlyMap<string, ToolResultBlock>;
}) {
  return (
    <div className="message-blocks">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "text":
            return markdown ? (
              <MarkdownContent text={block.text} key={`text-${index}`} />
            ) : (
              <p className="message-text" key={`text-${index}`}>{block.text}</p>
            );
          case "image":
            return <ImageAttachment block={block} key={`image-${index}`} />;
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
  if (message.role === "user" || message.error !== undefined) return true;
  return message.blocks.some(
    (block) => block.type !== "tool-result" || !toolCallIds.has(block.toolCallId),
  );
}

export function MessageTimeline({ messages, streaming, cwd }: MessageTimelineProps) {
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
  }, [messages]);

  function trackScroll(event: UIEvent<HTMLDivElement>): void {
    const timeline = event.currentTarget;
    const distanceFromBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight;
    followOutputRef.current = distanceFromBottom < 96;
  }

  if (messages.length === 0) {
    return (
      <div className="timeline-empty">
        <div className="timeline-empty-mark" aria-hidden="true">›_</div>
        <h2>Ready for a new prompt</h2>
        <p>This session is open in <span>{cwd}</span>.</p>
      </div>
    );
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
      <div className="message-list">
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
              </header>
              <MessageContent
                blocks={message.blocks}
                markdown={message.role === "assistant"}
                toolCallIds={toolCallIds}
                toolResults={toolResults}
              />
              {message.role === "assistant" && message.error !== undefined && (
                <p className="message-error" role="alert">{message.error.message}</p>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
