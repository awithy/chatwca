import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ConversationSummary, WorkspaceSummary } from "../../src/shared/protocol.js";
import { ConversationList } from "../../src/web/src/components/ConversationList.js";
import {
  conversationTitle,
  orderConversations,
} from "../../src/web/src/components/conversation-list.js";

function summary(
  id: string,
  workspaceId: string,
  modifiedAt: number,
  title = id,
): ConversationSummary {
  return {
    id,
    workspaceId,
    sessionFile: `/sessions/${id}.jsonl`,
    title,
    cwd: `/work/${workspaceId}`,
    modifiedAt,
    messageCount: 0,
    status: "closed",
    runnable: true,
  };
}

const workspace: WorkspaceSummary = {
  id: "workspace-one",
  name: "One",
  path: "/full/path/to/one",
  createdAt: 1,
  updatedAt: 1,
  available: true,
};

function renderList(overrides: Partial<Parameters<typeof ConversationList>[0]> = {}): string {
  return renderToStaticMarkup(createElement(ConversationList, {
    workspace,
    conversations: [],
    liveStatuses: {},
    selectedConversationId: null,
    connected: true,
    historyPending: false,
    historyError: null,
    actionPending: false,
    onCreate: async () => undefined,
    onSelect: () => undefined,
    ...overrides,
  }));
}

describe("conversation list", () => {
  it("orders selected-workspace conversations newest first without mutating source", () => {
    const conversations = [
      summary("older", workspace.id, 10),
      summary("newer", workspace.id, 20),
    ] as const;

    expect(orderConversations(conversations).map((item) => item.id)).toEqual(["newer", "older"]);
    expect(conversations.map((item) => item.id)).toEqual(["older", "newer"]);
  });

  it("renders only conversations owned by the selected workspace", () => {
    const html = renderList({
      conversations: [
        summary("selected-session", workspace.id, 10),
        summary("other-session", "workspace-other", 20),
      ],
    });

    expect(html).toContain("selected-session");
    expect(html).not.toContain("other-session");
    expect(html).toContain("Conversation history for One");
  });

  it("disables creation and explains unselected and unavailable states", () => {
    const unselected = renderList({ workspace: null });
    expect(unselected).toContain("Select a workspace to load its conversations.");
    expect(unselected).toContain("disabled");

    const unavailable = renderList({ workspace: { ...workspace, available: false } });
    expect(unavailable).toContain("Workspace unavailable");
    expect(unavailable).toContain("/full/path/to/one");
    expect(unavailable).toContain("disabled");
  });

  it("provides a useful title for blank Pi session names", () => {
    expect(conversationTitle(summary("one", workspace.id, 1, "  "))).toBe("Untitled conversation");
  });
});
