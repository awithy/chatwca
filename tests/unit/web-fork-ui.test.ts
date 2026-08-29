import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NormalizedMessage } from "../../src/shared/protocol.js";
import { MessageTimeline } from "../../src/web/src/components/MessageTimeline.js";

const messages: NormalizedMessage[] = [
  {
    entryId: "eligible-user",
    role: "user",
    blocks: [{ type: "text", text: "Fork this prompt" }],
    forkEligible: true,
  },
  {
    entryId: "ineligible-user",
    role: "user",
    blocks: [{ type: "text", text: "Provisional prompt" }],
    forkEligible: false,
  },
  {
    entryId: "assistant-entry",
    role: "assistant",
    blocks: [{ type: "text", text: "Response" }],
  },
];

function renderTimeline(overrides: {
  readonly canFork?: boolean;
  readonly forkingEntryId?: string | null;
  readonly rewindingEntryId?: string | null;
} = {}): string {
  return renderToStaticMarkup(createElement(MessageTimeline, {
    messages,
    notices: [],
    queue: { steering: [], followUp: [] },
    streaming: false,
    cwd: "/workspace",
    onFork: () => undefined,
    onRewind: () => undefined,
    ...overrides,
  }));
}

describe("fork message UI", () => {
  it("shows a Fork action only for a server-eligible user message", () => {
    const html = renderTimeline({ canFork: true });

    expect(html.match(/class="message-fork-button"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Fork conversation from this message"');
    expect(html).toContain(">Fork</button>");
    expect(html.match(/class="message-rewind-button"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Rewind conversation to this message"');
    expect(html).toContain(">Rewind</button>");
    expect(html).not.toContain("Provisional prompt</p><button");
    expect(html).not.toContain("assistant-entry\" class=\"message-fork-button");
  });

  it("announces an in-flight fork and disables repeat actions", () => {
    const html = renderTimeline({
      canFork: true,
      forkingEntryId: "eligible-user",
    });

    expect(html).toContain('class="message-fork-button" type="button" disabled="" aria-busy="true"');
    expect(html).toContain("Forking…");
    expect(html).toContain('class="visually-hidden" role="status"');
    expect(html).toContain("Creating a new conversation from this message.");
  });

  it("announces an in-flight rewind and disables both branch actions", () => {
    const html = renderTimeline({
      canFork: true,
      rewindingEntryId: "eligible-user",
    });

    expect(html).toContain('class="message-rewind-button" type="button" disabled="" aria-busy="true"');
    expect(html).toContain("Rewinding…");
    expect(html).toContain("Rewinding the conversation to this message.");
    expect(html).toContain('class="message-fork-button" type="button" disabled=""');
  });

  it("keeps the eligible action visible but disabled when the source cannot fork", () => {
    const html = renderTimeline({ canFork: false });

    expect(html.match(/class="message-fork-button"/g)).toHaveLength(1);
    expect(html).toContain('disabled=""');
    expect(html).toContain("Forking is available while this conversation is idle and connected.");
  });
});
