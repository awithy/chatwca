import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NormalizedMessage } from "../../src/shared/protocol.js";
import {
  MarkdownContent,
  markdownUrl,
} from "../../src/web/src/components/MarkdownContent.js";
import { MessageTimeline } from "../../src/web/src/components/MessageTimeline.js";
import { ThinkingBlock } from "../../src/web/src/components/ThinkingBlock.js";
import { ToolCallCard } from "../../src/web/src/components/ToolCallCard.js";

function render(component: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(component);
}

describe("rich message rendering", () => {
  it("rewrites local Markdown image paths through the conversation image endpoint", () => {
    expect(markdownUrl("penguin.png", "conversation one")).toBe(
      "/api/conversations/conversation%20one/workspace-images?path=penguin.png",
    );
    expect(markdownUrl("file:///workspace/generated image.webp", "one")).toBe(
      "/api/conversations/one/workspace-images?path=%2Fworkspace%2Fgenerated%20image.webp",
    );
    expect(markdownUrl("https://example.test/image.png", "one")).toBe(
      "https://example.test/image.png",
    );

    const html = render(createElement(MarkdownContent, {
      text: "![Penguin](penguin.png)",
      conversationId: "one",
    }));
    expect(html).toContain(
      'src="/api/conversations/one/workspace-images?path=penguin.png"',
    );
  });

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
      notices: [],
      queue: { steering: [], followUp: [] },
      streaming: false,
      cwd: "/workspace",
    }));

    expect(html.match(/tool-call-card/g)).toHaveLength(1);
    expect(html).toContain("/workspace");
    expect(html).not.toContain('data-entry-id="result-1"');
    expect(html).toContain('class="thinking-block"');
  });

  it("renders referenced tool-result images inline and keeps the full image link", () => {
    const messages: NormalizedMessage[] = [
      {
        entryId: "assistant-image-call",
        role: "assistant",
        blocks: [{
          type: "tool-call",
          toolCallId: "call-image",
          toolName: "read",
          arguments: { path: "penguin.png" },
          status: "succeeded",
        }],
      },
      {
        entryId: "tool-image-entry",
        role: "assistant",
        blocks: [
          {
            type: "tool-result",
            toolCallId: "call-image",
            toolName: "read",
            content: "Read image file [image/png]",
            isError: false,
            truncated: false,
          },
          {
            type: "image",
            image: {
              mimeType: "image/png",
              url: "/api/conversations/one/messages/tool-image-entry/images/0",
            },
            alt: "Generated image",
          },
        ],
      },
    ];
    const html = render(createElement(MessageTimeline, {
      messages,
      notices: [],
      queue: { steering: [], followUp: [] },
      streaming: false,
      cwd: "/workspace",
    }));

    expect(html).toContain('class="message-image"');
    expect(html).toContain('src="/api/conversations/one/messages/tool-image-entry/images/0"');
    expect(html).toContain('alt="Generated image"');
    expect(html).toContain('aria-label="Open Generated image"');
  });

  it("renders final stop, reliable usage, and message failures as run metadata", () => {
    const messages: NormalizedMessage[] = [
      {
        entryId: "assistant-usage",
        role: "assistant",
        blocks: [],
        stopReason: "length",
        usage: {
          inputTokens: 1_234,
          outputTokens: 56,
          cacheReadTokens: 700,
          cacheWriteTokens: 12,
          totalCost: 0.012345,
        },
      },
      {
        entryId: "assistant-error",
        role: "assistant",
        blocks: [],
        stopReason: "error",
        error: {
          code: "model_failed",
          message: "Provider <failed>",
        },
      },
    ];
    const html = render(createElement(MessageTimeline, {
      messages,
      notices: [],
      queue: { steering: [], followUp: [] },
      streaming: false,
      cwd: "/workspace",
    }));

    expect(html).toContain('aria-label="Run metadata"');
    expect(html).toContain("Token limit reached");
    expect(html).toContain("1,234 input tokens");
    expect(html).toContain("56 output tokens");
    expect(html).toContain("700 cache-read tokens");
    expect(html).toContain("12 cache-write tokens");
    expect(html).toContain("$0.012345");
    expect(html).toContain("Run failed");
    expect(html).toContain("Provider &lt;failed&gt;");
    expect(html).not.toContain("Provider <failed>");
    expect(html).toContain('data-entry-id="assistant-usage"');
  });

  it("keeps retry, compaction, runtime, and queued-prompt notices outside assistant prose", () => {
    const html = render(createElement(MessageTimeline, {
      messages: [{
        entryId: "assistant-1",
        role: "assistant",
        blocks: [{ type: "text", text: "Model prose" }],
        stopReason: "stop",
      }],
      notices: [
        {
          kind: "retry",
          phase: "scheduled",
          message: "A model retry has been scheduled.",
          attempt: 2,
          maxAttempts: 3,
          delayMs: 1_500,
        },
        {
          kind: "compaction",
          phase: "completed",
          message: "Conversation compaction completed.",
        },
        {
          kind: "runtime",
          level: "warning",
          message: "Runtime needs attention.",
        },
      ],
      queue: {
        steering: [{ text: "Use the focused test", imageCount: 0 }],
        followUp: [{ text: "", imageCount: 2 }],
      },
      streaming: false,
      cwd: "/workspace",
    }));

    expect(html).toContain('<section class="run-activity" aria-label="Run notices"');
    expect(html).toContain("Retry scheduled");
    expect(html).toContain("Attempt 2 of 3 · retry delay 1.5 s");
    expect(html).toContain("Compaction completed");
    expect(html).toContain("Runtime warning");
    expect(html).toContain("Steering prompt queued");
    expect(html).toContain("Use the focused test");
    expect(html).toContain("Follow-up prompt queued");
    expect(html).toContain("2 images");
    expect(html.indexOf("run-activity")).toBeGreaterThan(html.indexOf("message-assistant"));
  });

  it("does not expose provisional run metadata while the last assistant is streaming", () => {
    const html = render(createElement(MessageTimeline, {
      messages: [{
        entryId: "stream:one:1",
        role: "assistant",
        blocks: [{ type: "text", text: "Working" }],
        stopReason: "unknown",
        usage: { inputTokens: 0, outputTokens: 0 },
      }],
      notices: [],
      queue: { steering: [], followUp: [] },
      streaming: true,
      cwd: "/workspace",
    }));

    expect(html).not.toContain('aria-label="Run metadata"');
    expect(html).not.toContain("0 input tokens");
  });
});
