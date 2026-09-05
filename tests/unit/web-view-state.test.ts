import { describe, expect, it } from "vitest";

import { createInitialChatClientState, reduceChatClientState } from "../../src/web/src/api/state.js";
import { createChatViewSnapshot } from "../../src/web/src/api/view-state.js";

describe("application view subscription", () => {
  it("keeps the same snapshot across draft edits and clears without losing stored drafts", () => {
    let state = createInitialChatClientState();
    const getSnapshot = createChatViewSnapshot(() => state);
    const initial = getSnapshot();
    expect(initial).not.toHaveProperty("drafts");
    expect(getSnapshot()).toBe(initial);

    for (const [conversationId, text] of [["first", "h"], ["first", "hello"], ["second", "other draft"]] as const) {
      state = reduceChatClientState(state, { type: "draft", conversationId, text });
      expect(getSnapshot()).toBe(initial);
    }
    expect(state.drafts).toEqual({ first: "hello", second: "other draft" });
    state = reduceChatClientState(state, { type: "draft.delete", conversationId: "first" });
    expect(getSnapshot()).toBe(initial);
    expect(state.drafts).toEqual({ second: "other draft" });
  });

  it("publishes non-draft changes before and after draft-only notifications", () => {
    let state = createInitialChatClientState();
    const getSnapshot = createChatViewSnapshot(() => state);
    const initial = getSnapshot();
    state = reduceChatClientState(state, { type: "ready", serverVersion: "test" });
    const connected = getSnapshot();
    expect(connected).not.toBe(initial);
    expect(connected.connection).toBe("connected");
    expect(connected.conversations).toBe(initial.conversations);

    state = reduceChatClientState(state, { type: "draft", conversationId: "first", text: "prefill" });
    expect(getSnapshot()).toBe(connected);
    state = reduceChatClientState(state, { type: "select", conversationId: "first" });
    const selected = getSnapshot();
    expect(selected).not.toBe(connected);
    expect(selected.selectedConversationId).toBe("first");
    expect(getSnapshot()).toBe(selected);

    // A single notification may both remove a draft and update visible state.
    state = reduceChatClientState(state, { type: "conversation.deleted", conversationId: "first" });
    expect(getSnapshot()).not.toBe(selected);
    expect(getSnapshot().selectedConversationId).toBeNull();
    expect(state.drafts).toEqual({});
  });

  it("observes every non-draft field and coalesced changes, not just selected fields", () => {
    let state = createInitialChatClientState();
    const getSnapshot = createChatViewSnapshot(() => state);
    for (const key of Object.keys(getSnapshot()) as (keyof ReturnType<typeof getSnapshot>)[]) {
      const before = getSnapshot();
      const value = state[key];
      const changed = Array.isArray(value) ? [...value] :
        value !== null && typeof value === "object" ? { ...value } :
        value === null ? "changed" : null;
      // Each field's identity matters, independent of its domain-specific value.
      state = { ...state, [key]: changed };
      state = reduceChatClientState(state, { type: "draft", conversationId: "first", text: key });
      expect(getSnapshot(), key).not.toBe(before);
      expect(getSnapshot()[key], key).toBe(changed);
    }
  });
});
