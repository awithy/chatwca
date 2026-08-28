import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export interface MarkdownContentProps {
  readonly text: string;
}

/**
 * Renders model-authored Markdown without interpreting embedded HTML.
 *
 * `skipHtml` is intentionally explicit: adding a raw-HTML rehype plugin later
 * must not silently turn model output into trusted DOM. React Markdown's
 * default URL transform also rejects unsafe link protocols such as javascript:.
 */
export function MarkdownContent({ text }: MarkdownContentProps) {
  return (
    <div className="message-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>{text}</ReactMarkdown>
    </div>
  );
}
