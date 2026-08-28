import * as React from "react";

export interface ThinkingBlockProps {
  readonly text: string;
}

/** Model reasoning is visible on demand, but never expanded unexpectedly. */
export function ThinkingBlock({ text }: ThinkingBlockProps) {
  return (
    <details className="thinking-block">
      <summary>
        <span aria-hidden="true" className="thinking-mark">◇</span>
        Thinking
      </summary>
      <div className="thinking-content">{text || "No thinking content yet."}</div>
    </details>
  );
}
