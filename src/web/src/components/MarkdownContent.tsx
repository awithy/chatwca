import * as React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";

import { CodeBlock } from "./CodeBlock.js";

const markdownComponents = { pre: CodeBlock };

export interface MarkdownContentProps {
  readonly text: string;
  readonly conversationId?: string;
}

function localImagePath(url: string): string | undefined {
  let candidate = url;
  if (url.startsWith("file://")) {
    try {
      candidate = decodeURIComponent(new URL(url).pathname);
    } catch {
      return undefined;
    }
  } else if (url.startsWith("sandbox:")) {
    candidate = url.slice("sandbox:".length);
  } else if (/^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith("//")) {
    return undefined;
  }

  candidate = candidate.split(/[?#]/, 1)[0] ?? "";
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    return undefined;
  }
  return /\.(?:png|jpe?g|webp)$/i.test(candidate) ? candidate : undefined;
}

export function markdownUrl(
  url: string,
  conversationId: string | undefined,
): string | null | undefined {
  if (conversationId === undefined) return defaultUrlTransform(url);
  const filePath = localImagePath(url);
  if (filePath === undefined) return defaultUrlTransform(url);
  return `/api/conversations/${encodeURIComponent(conversationId)}/workspace-images?path=${encodeURIComponent(filePath)}`;
}

/**
 * Renders model-authored Markdown without interpreting embedded HTML.
 *
 * `skipHtml` is intentionally explicit: adding a raw-HTML rehype plugin later
 * must not silently turn model output into trusted DOM. React Markdown's
 * default URL transform also rejects unsafe link protocols such as javascript:.
 */
export const MarkdownContent = React.memo(function MarkdownContent({ text, conversationId }: MarkdownContentProps) {
  return (
    <div className="message-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
        skipHtml
        urlTransform={(url) => markdownUrl(url, conversationId)}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
