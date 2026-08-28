import { useEffect, useRef, type UIEvent } from "react";

import type {
  NormalizedMessage,
  UserContentBlock,
  AssistantContentBlock,
} from "../../../shared/protocol.js";

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

function TextContent({
  blocks,
}: {
  readonly blocks: readonly (UserContentBlock | AssistantContentBlock)[];
}) {
  const visible = blocks.filter(
    (block): block is Extract<typeof block, { type: "text" | "image" }> =>
      block.type === "text" || block.type === "image",
  );

  return (
    <div className="message-blocks">
      {visible.map((block, index) => block.type === "text" ? (
        <p className="message-text" key={`text-${index}`}>{block.text}</p>
      ) : (
        <span className="message-attachment" key={`image-${index}`}>
          <span aria-hidden="true">▧</span>
          {block.image.name ?? "Image attachment"}
        </span>
      ))}
    </div>
  );
}

export function MessageTimeline({ messages, streaming, cwd }: MessageTimelineProps) {
  const timelineRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const lastMessage = messages.at(-1);

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
        {messages.map((message) => {
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
              <TextContent blocks={message.blocks} />
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
