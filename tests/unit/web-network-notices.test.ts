import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NetworkBlockedNotices } from "../../src/web/src/components/NetworkBlockedNotices.js";

describe("blocked network notices", () => {
  it("shows only browser-safe destination fields and no approval action", () => {
    const html = renderToStaticMarkup(createElement(NetworkBlockedNotices, {
      onDismiss: () => undefined,
      notices: [{
        type: "network.blocked" as const,
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        revision: 7,
        payload: {
          host: "blocked.example.com",
          port: 443,
          protocol: "https-connect" as const,
          reason: "explicit_deny" as const,
          occurrenceCount: 3,
        },
      }],
    }));

    expect(html).toContain("Network request blocked");
    expect(html).toContain("blocked.example.com");
    expect(html).toContain("port 443");
    expect(html).toContain("https-connect");
    expect(html).toContain("explicit_deny");
    expect(html).toContain("3 occurrences");
    expect(html).toContain('<button type="button" aria-label="Dismiss blocked network notices">Dismiss</button>');
    expect(html).not.toContain("Approve");
  });
});
