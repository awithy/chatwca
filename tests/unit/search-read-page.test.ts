import { describe, expect, it } from "vitest";

import { chunkMessages } from "../../src/server/search/chunk.js";
import { ConversationReadError } from "../../src/server/search/errors.js";
import { normalizeEntryText, type ExtractedMessage } from "../../src/server/search/extract.js";
import {
  assembleConversationReadPage, assembleFocusedConversationReadPage, decodeConversationReadCursor, encodeConversationReadCursor,
  MAX_CONVERSATION_CURSOR_BYTES, MAX_CONVERSATION_READ_PAGE_BYTES, MAX_CONVERSATION_READ_ROWS,
  validateConversationReadRequest,
  type ConversationReadChunk, type ConversationReadCursor, type ConversationReadDocument,
  type ConversationReadPage, type ConversationReadRequest, type ConversationReadWindow,
} from "../../src/server/search/read-page.js";

const document: ConversationReadDocument = {
  workspaceId: "workspace", workspaceName: "Workspace", sessionId: "session", title: "Cached conversation",
  documentId: "12345678-1234-1234-1234-123456789abc", generation: "9007199254740993", modifiedAt: 1000, indexedAt: 2000,
};
const identity = { workspaceId: document.workspaceId, sessionId: document.sessionId };
function message(text: string, entryId = "entry", role: ExtractedMessage["role"] = "user"): ExtractedMessage {
  return { text, entryId, role, ordinal: 0, timestamp: 1234, entryTimestamp: 1234 };
}
function windowFor(chunks: readonly ConversationReadChunk[], request: ConversationReadRequest, rows = MAX_CONVERSATION_READ_ROWS): ConversationReadWindow {
  const ordinal = request.cursor ? decodeConversationReadCursor(request.cursor, request).ordinal : 0;
  const from = Math.max(0, ordinal - 1);
  return { document, chunks: chunks.slice(from, from + rows), hasMore: chunks.length > from + rows };
}
function pagesFor(chunks: readonly ConversationReadChunk[], limit = 10, maximumBytes = MAX_CONVERSATION_READ_PAGE_BYTES, rows = MAX_CONVERSATION_READ_ROWS): ConversationReadPage[] {
  let request: ConversationReadRequest = { ...identity, limit };
  const pages: ConversationReadPage[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const page = assembleConversationReadPage(windowFor(chunks, request, rows), request, undefined, maximumBytes);
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(maximumBytes);
    expect(page.segments.length).toBeLessThanOrEqual(limit);
    pages.push(page);
    if (page.nextCursor === null) return pages;
    request = { ...identity, limit, cursor: page.nextCursor };
  }
  throw new Error("Continuation failed to make progress");
}
function assertExact(messages: readonly ExtractedMessage[], pages: readonly ConversationReadPage[]): void {
  const reconstructed = new Map<string, string>();
  const ended = new Set<string>();
  for (const page of pages) {
    for (const segment of page.segments) {
      const previous = reconstructed.get(segment.entryId) ?? "";
      expect(ended.has(segment.entryId)).toBe(false);
      expect(segment.sourceByteStart).toBe(Buffer.byteLength(previous));
      expect(segment.beginsMessage).toBe(previous.length === 0);
      expect(segment.sourceByteEnd - segment.sourceByteStart).toBe(Buffer.byteLength(segment.text));
      expect(segment.text).not.toContain("\ufffd");
      reconstructed.set(segment.entryId, previous + segment.text);
      if (segment.endsMessage) ended.add(segment.entryId);
    }
  }
  expect([...reconstructed.keys()]).toEqual(messages.map((item) => item.entryId));
  for (const item of messages) {
    expect(reconstructed.get(item.entryId)).toBe(normalizeEntryText(item.text));
    expect(ended.has(item.entryId)).toBe(true);
  }
}
function cursor(overrides: Partial<ConversationReadCursor> = {}): ConversationReadCursor {
  return { version: 1, ...identity, documentId: document.documentId, generation: document.generation, ordinal: 0, entryId: "entry", byteOffset: 0, ...overrides };
}
function rawCursor(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString("base64url"); }

describe("cached conversation read requests and cursors", () => {
  it("validates a closed request schema and captures inputs", () => {
    const input = { ...identity, limit: 20, aroundEntryId: "entry" };
    const parsed = validateConversationReadRequest(input);
    input.limit = 1;
    expect(parsed.limit).toBe(20);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(validateConversationReadRequest(identity)).toEqual(identity);
    for (const invalid of [null, [], {}, { ...identity, path: "/sessions" }, { ...identity, workspaceId: "../workspace" },
      { ...identity, sessionId: "" }, { ...identity, aroundEntryId: null }, { ...identity, cursor: null },
      { ...identity, limit: 0 }, { ...identity, limit: 21 }, { ...identity, limit: 1.5 },
      { ...identity, aroundEntryId: "entry", cursor: encodeConversationReadCursor(cursor()) }]) {
      expect(() => validateConversationReadRequest(invalid)).toThrow("search_query_invalid");
    }
  });

  it("round trips exact bigint generations and bounded versioned positions", () => {
    const original = cursor({ ordinal: 123, byteOffset: 456 });
    const encoded = encodeConversationReadCursor(original);
    expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(MAX_CONVERSATION_CURSOR_BYTES);
    expect(decodeConversationReadCursor(encoded, identity)).toEqual(original);
    expect(validateConversationReadRequest({ ...identity, cursor: encoded }).cursor).toBe(encoded);
  });

  it("rejects malformed, noncanonical, oversized, mismatched, and unknown-field cursors", () => {
    const encoded = encodeConversationReadCursor(cursor());
    for (const invalid of ["", "@@@", `${encoded}=`, "a".repeat(MAX_CONVERSATION_CURSOR_BYTES + 1),
      Buffer.from("not JSON").toString("base64url"), Buffer.from([0xff]).toString("base64url"),
      rawCursor({ ...cursor(), version: 2 }), rawCursor({ ...cursor(), generation: 9007199254740992 }),
      rawCursor({ ...cursor(), generation: "9223372036854775808" }), rawCursor({ ...cursor(), byteOffset: -1 }),
      rawCursor({ ...cursor(), ordinal: 20_000 }), rawCursor({ ...cursor(), extra: true }),
      rawCursor({ ...cursor(), workspaceId: "other" }), rawCursor({ ...cursor(), sessionId: "other" }),
      rawCursor({ ...cursor(), entryId: "../path" }), rawCursor({ ...cursor(), documentId: "invalid" })]) {
      expect(() => decodeConversationReadCursor(invalid, identity)).toThrow("conversation_cursor_invalid");
    }
    expect(() => encodeConversationReadCursor(cursor({ byteOffset: -1 }))).toThrow("conversation_cursor_invalid");
    for (const invalid of ["", "a".repeat(MAX_CONVERSATION_CURSOR_BYTES + 1)]) {
      expect(() => validateConversationReadRequest({ ...identity, cursor: invalid })).toThrow("conversation_cursor_invalid");
    }
  });
});

describe("bounded cached conversation pages", () => {
  it("returns metadata and separate ordered user/assistant segments", () => {
    const messages = [message("  Question\r\nwith whitespace\t", "user"), message("\nAnswer\n", "assistant", "assistant")];
    const pages = pagesFor(chunkMessages(messages));
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ ...identity, cached: true, generation: "9007199254740993", indexedAt: 2000, nextCursor: null });
    expect(pages[0]?.segments.map((segment) => segment.role)).toEqual(["user", "assistant"]);
    assertExact(messages, pages);
  });

  it.each([
    "a😀界e\u0301".repeat(12_000),
    "  paragraph\r\n\r\nline\r".repeat(5000),
    `\n\`\`\`typescript\n${"  const x = \\\"\\\\\\\";\n".repeat(5000)}\`\`\`\n`,
    `\`\`\`\n${"oversized_code_line".repeat(12_000)}\n\`\`\``,
  ])("removes overlaps exactly and resumes byte-limited messages (%#)", (text) => {
    const messages = [message(text), message("After huge message", "next", "assistant")];
    const pages = pagesFor(chunkMessages(messages), 1, 4096);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[0]?.segments[0]).toMatchObject({ beginsMessage: true, endsMessage: false });
    const next = decodeConversationReadCursor(pages[0]!.nextCursor!, identity);
    expect(next.byteOffset).toBe(pages[0]!.segments[0]!.sourceByteEnd);
    assertExact(messages, pages);
  });

  it("keeps UTF-8 boundaries exact across small varying page budgets", () => {
    const messages = [message('😀\\\"界\\\\e\u0301\\n'.repeat(180))];
    const chunks = chunkMessages(messages);
    for (let budget = 1024; budget <= 1152; budget += 7) {
      assertExact(messages, pagesFor(chunks, 1, budget));
    }
  });

  it("counts the complete escaped JSON, not just raw text", () => {
    const messages = [message('"\\\n\t'.repeat(5000))];
    const pages = pagesFor(chunkMessages(messages), 10, 2048);
    expect(pages.length).toBeGreaterThan(20);
    assertExact(messages, pages);
  });

  it("continues at the next message when the message count is reached", () => {
    const messages = Array.from({ length: 25 }, (_, index) => message(`Message ${index}`, `entry${index}`, index % 2 ? "assistant" : "user"));
    const pages = pagesFor(chunkMessages(messages), 10);
    expect(pages.map((page) => page.segments.length)).toEqual([10, 10, 5]);
    expect(decodeConversationReadCursor(pages[0]!.nextCursor!, identity)).toMatchObject({ ordinal: 10, entryId: "entry10", byteOffset: 0 });
    assertExact(messages, pages);
  });

  it("uses lookahead for correct message-end flags at bounded row windows", () => {
    const messages = [message("x".repeat(50_000)), message("answer", "answer", "assistant")];
    const pages = pagesFor(chunkMessages(messages), 10, MAX_CONVERSATION_READ_PAGE_BYTES, 4);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages[0]?.segments[0]?.endsMessage).toBe(false);
    assertExact(messages, pages);
  });

  it("resumes conversations exceeding the maximum row window", () => {
    const messages = [message("x".repeat(450_000))];
    expect(chunkMessages(messages).length).toBeGreaterThan(MAX_CONVERSATION_READ_ROWS);
    assertExact(messages, pagesFor(chunkMessages(messages)));
  });

  it("bounds escaped title metadata separately without shortening dialogue", () => {
    const chunks = chunkMessages([message("Full dialogue")]);
    const title = "\u0001".repeat(16 * 1024);
    const page = assembleConversationReadPage({ document: { ...document, title, workspaceName: "\u0002".repeat(2048) }, chunks, hasMore: false }, identity);
    expect(page.title).toBe(title.slice(0, 512));
    expect(page.titleTruncated).toBe(true);
    expect(page.segments[0]?.text).toBe("Full dialogue");
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MAX_CONVERSATION_READ_PAGE_BYTES);
  });

  it("returns an empty page only for an empty indexed document", () => {
    expect(assembleConversationReadPage({ document, chunks: [], hasMore: false }, identity)).toMatchObject({ segments: [], nextCursor: null });
    expect(() => assembleConversationReadPage({ document, chunks: [], hasMore: false }, { ...identity, cursor: encodeConversationReadCursor(cursor()) })).toThrow("conversation_cursor_invalid");
  });

  it("rejects stale generations and document identity mismatches", () => {
    const chunks = chunkMessages([message("text")]);
    const request = { ...identity, cursor: encodeConversationReadCursor(cursor()) };
    expect(() => assembleConversationReadPage({ ...windowFor(chunks, request), document: { ...document, generation: "9007199254740994" } }, request)).toThrow("conversation_cursor_stale");
    expect(() => assembleConversationReadPage(windowFor(chunks, request), { ...request, cursor: encodeConversationReadCursor(cursor({ documentId: "87654321-1234-1234-1234-123456789abc" })) })).toThrow("conversation_cursor_invalid");
  });

  it("rejects offsets outside a chunk, inside a code point, or inside previously covered overlaps", () => {
    const chunks = chunkMessages([message("😀".repeat(5000))]);
    for (const position of [{ ordinal: 0, byteOffset: 1 }, { ordinal: 0, byteOffset: chunks[0]!.sourceByteEnd },
      { ordinal: 1, byteOffset: chunks[1]!.sourceByteStart }, { ordinal: 19999, byteOffset: 0 }]) {
      const request = { ...identity, cursor: encodeConversationReadCursor(cursor(position)) };
      expect(() => assembleConversationReadPage(windowFor(chunks, request), request)).toThrow("conversation_cursor_invalid");
    }
  });

  it("does not quietly substitute a beginning read for a missing anchor", () => {
    const chunks = chunkMessages([message("text")]);
    expect(() => assembleConversationReadPage(windowFor(chunks, identity), { ...identity, aroundEntryId: "missing" })).toThrow("conversation_entry_not_indexed");
  });

  it("fails safely on corrupt spans, overlaps, ordinals, roles, and identities", () => {
    const original = chunkMessages([message("a".repeat(5000)), message("answer", "answer", "assistant")]);
    const corruptions: readonly ConversationReadChunk[][] = [
      [{ ...original[0]!, sourceByteStart: 1 }, ...original.slice(1)],
      [{ ...original[0]!, sourceByteEnd: 1 }, ...original.slice(1)],
      [original[0]!, { ...original[1]!, text: `b${original[1]!.text.slice(1)}` }, ...original.slice(2)],
      [original[0]!, { ...original[1]!, sourceByteStart: original[0]!.sourceByteEnd + 1, sourceByteEnd: original[0]!.sourceByteEnd + 1 + Buffer.byteLength(original[1]!.text) }, ...original.slice(2)],
      [original[0]!, { ...original[1]!, ordinal: 3 }, ...original.slice(2)],
      [original[0]!, { ...original[1]!, role: "assistant" }, ...original.slice(2)],
      [original[0]!, { ...original[1]!, timestamp: 999 }, ...original.slice(2)],
      [original[0]!, { ...original[1]!, entryId: "different" }, ...original.slice(2)],
      [{ ...original[0]!, text: "\ud800" }, ...original.slice(1)],
      [original[0]!, ...original.slice(1), { ...original[0]!, ordinal: original.length }],
    ];
    for (const chunks of corruptions) {
      expect(() => assembleConversationReadPage({ document, chunks, hasMore: false }, identity)).toThrow("conversation_cache_invalid");
    }
    expect(() => assembleConversationReadPage({ document, chunks: Array(MAX_CONVERSATION_READ_ROWS + 1).fill(original[0]), hasMore: false }, identity)).toThrow("conversation_cache_invalid");
    expect(() => assembleConversationReadPage({ document, chunks: [original[0]!], hasMore: true }, identity)).toThrow("conversation_cache_invalid");
  });

  it("rejects windows over the aggregate payload bound and non-dialogue roles", () => {
    const chunks = chunkMessages([message("😀".repeat(400_000))]).slice(0, MAX_CONVERSATION_READ_ROWS);
    expect(() => assembleConversationReadPage({ document, chunks, hasMore: true }, identity)).toThrow("conversation_cache_invalid");
    const toolChunk = { ...chunkMessages([message("tool payload")])[0]!, role: "tool" } as unknown as ConversationReadChunk;
    expect(() => assembleConversationReadPage({ document, chunks: [toolChunk], hasMore: false }, identity)).toThrow("conversation_cache_invalid");
  });

  it("checks overlaps on continuation, not just the first page", () => {
    const chunks = chunkMessages([message("a".repeat(10_000))]);
    const request = { ...identity, cursor: encodeConversationReadCursor(cursor({ ordinal: 1, byteOffset: chunks[0]!.sourceByteEnd })) };
    const window = windowFor(chunks, request);
    expect(() => assembleConversationReadPage({ ...window, chunks: [{ ...window.chunks[0]!, text: `${window.chunks[0]!.text.slice(0, -1)}b` }, ...window.chunks.slice(1)] }, request)).toThrow("conversation_cache_invalid");
  });

  it("drops byte-limited focused context and reserves room for focus metadata", () => {
    const anchor = "😀界\\\"\n".repeat(2000);
    const chunks = chunkMessages([message("small", "left"), message("big predecessor ".repeat(4000), "prior"), message(anchor, "anchor")]);
    const positions = chunks.filter((chunk) => chunk.sourceByteStart === 0).map((chunk) => ({ ordinal: chunk.ordinal, entryId: chunk.entryId, byteOffset: 0 }));
    const page = assembleFocusedConversationReadPage({ document, chunks, hasMore: false }, { ...identity, aroundEntryId: "anchor" }, positions, false, 4096);
    expect(page).toMatchObject({ aroundEntryId: "anchor", precedingContextReduced: true });
    expect(page.segments).toHaveLength(1);
    expect(page.segments[0]).toMatchObject({ entryId: "anchor", beginsMessage: true, endsMessage: false });
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(4096);
    const remainder = pagesFor(chunks); // Normal reads still preserve all preceding text.
    assertExact([message("small", "left"), message("big predecessor ".repeat(4000), "prior"), message(anchor, "anchor")], remainder);
    const request = { ...identity, cursor: page.nextCursor! };
    const continued = assembleConversationReadPage(windowFor(chunks, request), request);
    expect(page.segments[0]!.text + continued.segments[0]!.text).toBe(anchor);
    expect(continued.segments[0]?.sourceByteStart).toBe(page.segments[0]?.sourceByteEnd);
  });

  it("never exposes cache text in error messages", () => {
    try {
      assembleConversationReadPage({ document, chunks: [{ ...chunkMessages([message("SECRET")])[0]!, sourceByteEnd: 1 }], hasMore: false }, identity);
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ConversationReadError);
      expect((error as Error).message).toBe("conversation_cache_invalid");
    }
  });
});
