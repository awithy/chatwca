import { describe, expect, it } from "vitest";

import type { ConversationSummary } from "../../src/shared/protocol.js";
import {
  conversationTitle,
  groupConversations,
} from "../../src/web/src/components/conversation-list.js";

function summary(
  id: string,
  cwd: string,
  modifiedAt: number,
  title = id,
): ConversationSummary {
  return {
    id,
    sessionFile: `/sessions/${id}.jsonl`,
    title,
    cwd,
    modifiedAt,
    messageCount: 0,
    status: "closed",
    runnable: true,
  };
}

describe("conversation list", () => {
  it("groups by sorted working directory and orders each group newest first", () => {
    const groups = groupConversations([
      summary("older", "/work/zeta", 10),
      summary("other", "/work/alpha", 15),
      summary("newer", "/work/zeta", 20),
    ], null);

    expect(groups.map((group) => group.cwd)).toEqual(["/work/alpha", "/work/zeta"]);
    expect(groups[1]?.conversations.map((item) => item.id)).toEqual(["newer", "older"]);
  });

  it("filters an exact working directory without mutating the source", () => {
    const conversations = [
      summary("one", "/work/one", 1),
      summary("two", "/work/two", 2),
    ] as const;

    expect(groupConversations(conversations, "/work/two")).toEqual([{
      cwd: "/work/two",
      conversations: [conversations[1]],
    }]);
    expect(conversations.map((item) => item.id)).toEqual(["one", "two"]);
  });

  it("provides a useful title for blank Pi session names", () => {
    expect(conversationTitle(summary("one", "/work", 1, "  "))).toBe("Untitled conversation");
  });
});
