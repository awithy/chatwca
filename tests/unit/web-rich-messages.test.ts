import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NormalizedMessage } from "../../src/shared/protocol.js";
import { MessageTimeline } from "../../src/web/src/components/MessageTimeline.js";
import { ThinkingBlock } from "../../src/web/src/components/ThinkingBlock.js";
import { ToolCallCard } from "../../src/web/src/components/ToolCallCard.js";

function render(component: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(component);
}

describe("rich message rendering", () => {
  it("keeps thinking collapsed by default and renders it as untrusted text", () => {
    const html = render(createElement(ThinkingBlock, {
      text: '<script data-secret="yes">inspect()</script>',
    }));

    expect(html).toContain('<details class="thinking-block">');
    expect(html).not.toContain("<details open");
    expect(html).toContain("&lt;script data-secret=&quot;yes&quot;&gt;");
    expect(html).not.toContain("<script");
  });

  it.each([
    ["running", { isError: false }, "Running"],
    ["succeeded", { isError: false }, "Succeeded"],
    ["failed", { isError: true }, "Failed"],
  ] as const)("distinguishes a %s tool", (status, outcome, label) => {
    const result = outcome === undefined ? undefined : {
      type: "tool-result" as const,
      toolCallId: "call-1",
      toolName: "bash",
      content: "done",
      isError: outcome.isError,
      truncated: false,
    };
    const html = render(createElement(ToolCallCard, {
      call: {
        type: "tool-call",
        toolCallId: "call-1",
        toolName: "bash",
        arguments: { command: "pwd" },
        status,
      },
      result,
    }));

    expect(html).toContain(`tool-status-${status}`);
    expect(html).toContain(label);
  });

  it("shows bounded-output truncation metadata and escapes tool content", () => {
    const html = render(createElement(ToolCallCard, {
      call: undefined,
      result: {
        type: "tool-result",
        toolCallId: "call-1",
        toolName: "read",
        content: "<img onerror=alert(1)>",
        isError: false,
        truncated: true,
        originalBytes: 70_000,
      },
    }));

    expect(html).toContain('class="tool-output"');
    expect(html).toContain("&lt;img onerror=alert(1)&gt;");
    expect(html).not.toContain("<img");
    expect(html).toContain("Output truncated for browser display");
    expect(html).toContain("original size");
  });

  it("links a persisted tool result to its call and does not render a duplicate message", () => {
    const messages: NormalizedMessage[] = [
      {
        entryId: "assistant-1",
        role: "assistant",
        blocks: [
          { type: "thinking", text: "Check the workspace." },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            arguments: { command: "pwd" },
            status: "succeeded",
          },
        ],
      },
      {
        entryId: "result-1",
        role: "assistant",
        blocks: [{
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "bash",
          content: "/workspace",
          isError: false,
          truncated: false,
        }],
      },
    ];
    const html = render(createElement(MessageTimeline, {
      messages,
      streaming: false,
      cwd: "/workspace",
    }));

    expect(html.match(/tool-call-card/g)).toHaveLength(1);
    expect(html).toContain("/workspace");
    expect(html).not.toContain('data-entry-id="result-1"');
    expect(html).toContain('class="thinking-block"');
  });
});
