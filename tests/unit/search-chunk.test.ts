import { describe, expect, it } from "vitest";

import { chunkMessages, documentEmbeddingInput, MAX_CHUNK_CHARACTERS, MAX_CHUNK_UTF8_BYTES, MAX_CONVERSATION_CHUNKS, queryEmbeddingInput } from "../../src/server/search/chunk.js";
import { extractSession, normalizeEntryText, type ExtractedMessage } from "../../src/server/search/extract.js";
import { searchSessionHeader as header, searchUserEntry as user } from "../fixtures/search-session.js";

function message(text: string, entryId = "entry", role: ExtractedMessage["role"] = "user"): ExtractedMessage {
  return { text, entryId, role, ordinal: 0, timestamp: 0, entryTimestamp: 0 };
}

function assertValidSpans(text: string): void {
  const normalized = normalizeEntryText(text);
  const bytes = Buffer.from(normalized, "utf8");
  const chunks = chunkMessages([message(text)]);
  let coveredThrough = 0;
  let previousStart = -1;
  for (const chunk of chunks) {
    expect([...chunk.text].length).toBeLessThanOrEqual(MAX_CHUNK_CHARACTERS);
    expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(MAX_CHUNK_UTF8_BYTES);
    expect(chunk.sourceByteStart).toBeGreaterThan(previousStart);
    expect(chunk.sourceByteStart).toBeLessThanOrEqual(coveredThrough);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(chunk.sourceByteStart, chunk.sourceByteEnd))).toBe(chunk.text);
    coveredThrough = chunk.sourceByteEnd;
    previousStart = chunk.sourceByteStart;
  }
  expect(coveredThrough).toBe(bytes.length);
}

describe("deterministic conversation message chunks", () => {
  it("keeps readable source separate from the role-only embedding context", () => {
    const chunks = chunkMessages([message("  Code_Name.ts\r\n    preserveCase()", "user-id"), message("Reply", "assistant-id", "assistant")]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toMatchObject({
      ordinal: 0, splitOrdinal: 0, entryId: "user-id", role: "user", text: "  Code_Name.ts\n    preserveCase()",
      embeddingInput: "User message:\n  Code_Name.ts\n    preserveCase()",
    });
    expect(chunks[1]?.embeddingInput).toBe("Assistant message:\nReply");
    expect(chunks[0]?.textHash).not.toBe(chunks[0]?.embeddingInputHash);
    expect(documentEmbeddingInput("user", "text")).toBe("User message:\ntext");
    expect(queryEmbeddingInput("query")).toBe("Instruct: Given a question or search phrase, retrieve relevant passages from past user and assistant conversations.\nQuery: query");
  });

  it.each([
    "x".repeat(50_000), "😀".repeat(10_000), "界".repeat(10_000),
    "a😀界e\u0301".repeat(8_000),
    "Paragraph.\r\n\r\nCode line\r".repeat(1_000),
    `\`\`\`typescript\n${"  function_name();\n".repeat(1_000)}\`\`\``,
    `\`\`\`\n${"oversized_code_line".repeat(3_000)}\n\`\`\``,
  ])("bounds oversized messages/code/Unicode and covers every source byte (%#)", (text) => {
    assertValidSpans(text);
    expect(chunkMessages([message(text)])).toEqual(chunkMessages([message(text)]));
  });

  it("prefers paragraphs, sentences, and code-line boundaries before hard splits", () => {
    for (const boundary of ["\n\n", ". ", "\n"]) {
      const text = `${"x".repeat(2_000)}${boundary}${"y".repeat(3_000)}`;
      const chunks = chunkMessages([message(text)]);
      expect(chunks[0]?.text).toBe("x".repeat(2_000) + boundary);
      const overlap = Buffer.from(text).subarray(chunks[1]!.sourceByteStart, chunks[0]!.sourceByteEnd).toString();
      expect([...overlap].length).toBeLessThanOrEqual(400);
      assertValidSpans(text);
    }
  });

  it("never merges entry identities and retains reuse hashes when ordinals/title change", () => {
    const base = extractSession([header(), user("u", null, "Stable input")]);
    const named = extractSession([header(), user("u", null, "Stable input"), { type: "session_info", id: "name", parentId: "u", timestamp: "2025-01-01T00:00:00.000Z", name: "Renamed" }]);
    expect(chunkMessages(base.messages)).toEqual(chunkMessages(named.messages));
    const original = chunkMessages([message("Stable input", "u")])[0]!;
    const moved = chunkMessages([message("Earlier input", "earlier"), message("Stable input", "u")])[1]!;
    expect(moved.ordinal).toBe(1);
    expect(moved.stableKey).toBe(original.stableKey);
    expect(moved.embeddingInputHash).toBe(original.embeddingInputHash);
    expect(chunkMessages([message("Stable input", "u", "assistant")])[0]?.embeddingInputHash).not.toBe(original.embeddingInputHash);
  });

  it("does not create whitespace chunks or silently repair invalid Unicode", () => {
    expect(chunkMessages([message("  \r\n")])).toEqual([]);
    expect(() => chunkMessages([message("\ud800")])).toThrow("search_session_invalid");
  });

  it("caps complete conversation output rather than silently truncating it", () => {
    const messages = Array.from({ length: MAX_CONVERSATION_CHUNKS + 1 }, (_, index) => message("text", `entry${index}`));
    expect(() => chunkMessages(messages)).toThrow("search_session_limit");
  });
});
