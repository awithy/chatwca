import { describe, expect, it } from "vitest";

import { extractSession, SessionExtractor } from "../../src/server/search/extract.js";
import { searchAssistantEntry as assistant, searchEntry as entry, searchSessionHeader as header, searchUserEntry as user, SEARCH_TEST_TIMESTAMP } from "../fixtures/search-session.js";

describe("read-only saved-branch extraction", () => {
  it("selects the last persisted tree entry and preserves the full pre-compaction branch", () => {
    const records = [
      header(), user("u1", null, "Before compaction"), assistant("a1", "u1"),
      user("abandoned", "a1", "Abandoned evidence"), assistant("old-leaf", "abandoned"),
      entry("summary", "a1", { type: "branch_summary", fromId: "old-leaf", summary: "Synthesized abandoned summary" }),
      entry("compaction", "summary", { type: "compaction", summary: "Compaction synthesis", firstKeptEntryId: "a1", tokensBefore: 100 }),
      user("u2", "compaction", "Saved fork"),
      entry("edit", "u2", { type: "context_edit", targetId: "u1", replacement: null }),
      assistant("a2", "edit", [{ type: "text", text: "Visible history" }]),
    ];
    const result = extractSession(records);
    expect(result.savedLeafId).toBe("a2");
    expect(result.messages.map(({ entryId, text }) => [entryId, text])).toEqual([
      ["u1", "Before compaction"], ["a1", "Assistant dialogue"], ["u2", "Saved fork"], ["a2", "Visible history"],
    ]);
    expect(result.messages[0]).toMatchObject({ role: "user", ordinal: 0, timestamp: SEARCH_TEST_TIMESTAMP, entryTimestamp: SEARCH_TEST_TIMESTAMP });
    expect(result.title).toBe("Before compaction");
    expect(JSON.stringify(result)).not.toContain("Synthesized");
  });

  it("excludes images, thinking, tool arguments/results, system/Bash/custom/unknown roles and provider metadata", () => {
    const records = [
      header(), user("u", null, [{ type: "text", text: "Line 1\r\n  Code" }, { type: "image", data: "private-image", mimeType: "image/png" }, { type: "text", text: "Line 2\rEnd" }]),
      assistant("a", "u", [
        { type: "thinking", thinking: "private-thinking", thinkingSignature: "private-signature" },
        { type: "toolCall", id: "tool", name: "bash", arguments: { command: "private-arguments" } },
        { type: "text", text: "Visible", textSignature: "private-signature" },
      ]),
      ...["toolResult", "system", "bashExecution", "custom", "unknown-role"].map((role, index) => entry(`excluded${index}`, index === 0 ? "a" : `excluded${index - 1}`, { type: "message", message: { role, content: "private-excluded", timestamp: SEARCH_TEST_TIMESTAMP } })),
    ];
    const result = extractSession(records);
    expect(result.messages.map(({ text }) => text)).toEqual(["Line 1\n  Code\nLine 2\nEnd", "Visible"]);
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("keeps visible persisted abort/error text but never synthesizes provider errors", () => {
    const error = assistant("a", "u", [{ type: "text", text: "Visible aborted response" }]);
    error.message.stopReason = "aborted";
    const result = extractSession([header(), user("u", null), error]);
    expect(result.messages[1]?.text).toBe("Visible aborted response");
  });

  it("uses session-wide latest title metadata (including clears) without hashing titles", () => {
    const base = [header(), user("u", null), assistant("a", "u")];
    const original = extractSession(base);
    const named = extractSession([...base, entry("name", "a", { type: "session_info", name: "  New title  " })]);
    expect(named.title).toBe("New title");
    expect(named.extractedContentHash).toBe(original.extractedContentHash);
    const cleared = extractSession([...base, entry("name", "a", { type: "session_info", name: " " })]);
    expect(cleared.title).toBe("User dialogue");
  });

  it("supports multiple roots from resetLeaf and header-only files", () => {
    const result = extractSession([header(), user("old-root", null, "Old root"), user("new-root", null, "New root")]);
    expect(result.messages.map(({ text }) => text)).toEqual(["New root"]);
    expect(extractSession([header()])).toMatchObject({ savedLeafId: null, title: "Untitled conversation", messages: [] });
  });

  it("can project incrementally and skips empty/image-only dialogue", () => {
    const extractor = new SessionExtractor("synthetic-session");
    for (const record of [header(), user("u", null, [{ type: "image", data: "large-image" }]), assistant("a", "u", []), user("u2", "a", "   ")]) extractor.append(record);
    expect(extractor.finish().messages).toEqual([]);
  });

  it.each([undefined, 1, 2, 4, "3"])("rejects unsupported versions untouched (%s)", (version) => {
    expect(() => extractSession([header(undefined, { version })])).toThrow("search_session_version_unsupported");
  });

  it.each([
    [], [null], [{ type: "message" }], [header(), header()],
    [header(), user("same", null), user("same", "same")],
    [header(), user("self", "self")], [header(), user("child", "missing")],
    [header(), user("a", "b"), user("b", "a")],
    [header(), entry("missing-parent", null, { parentId: undefined })],
    [header(), entry("bad-time", null, { timestamp: "not-a-date" })],
    [header(), entry("bad-id", null, { id: "bad/id" })],
    [header(undefined, { cwd: "" })],
    [header(), user("u", null, [{ type: "text" }])],
    [header(), assistant("a", null, "assistant strings are not valid")],
    [header(), user("u", null, "\ud800")],
    [header(), entry("bad-message", null, { type: "message", message: {} })],
    [header(), entry("bad-message", null, { type: "message", message: { role: "user", content: "text", timestamp: null } })],
  ])("rejects malformed identities/required fields instead of manufacturing history (%j)", (...records) => {
    expect(() => extractSession(records)).toThrow("search_session_invalid");
  });

  it("rejects a mismatched expected session identity", () => {
    expect(() => extractSession([header()], "different-session")).toThrow("search_session_invalid");
  });
});
