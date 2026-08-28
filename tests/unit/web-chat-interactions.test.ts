import { describe, expect, it } from "vitest";

import {
  canCloseConversation,
  canDeleteConversation,
  isComposerSubmitKey,
} from "../../src/web/src/components/chat-interactions.js";

describe("web chat interactions", () => {
  it("only uses unmodified Enter outside IME composition as the submit shortcut", () => {
    expect(isComposerSubmitKey({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(isComposerSubmitKey({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(isComposerSubmitKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isComposerSubmitKey({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });

  it("guards close and delete while a run is active", () => {
    expect(canCloseConversation("idle")).toBe(true);
    expect(canCloseConversation("error")).toBe(true);
    expect(canCloseConversation("idle", false)).toBe(false);
    expect(canCloseConversation("streaming")).toBe(false);
    expect(canCloseConversation("aborting")).toBe(false);

    expect(canDeleteConversation("closed")).toBe(true);
    expect(canDeleteConversation("idle")).toBe(true);
    expect(canDeleteConversation("error")).toBe(true);
    expect(canDeleteConversation("streaming")).toBe(false);
    expect(canDeleteConversation("aborting")).toBe(false);
  });
});
