import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationReadError, SearchRepositoryError } from "../../src/server/search/errors.js";
import { encodeConversationReadCursor, MAX_CONVERSATION_READ_PAGE_BYTES, type ConversationReadRequest } from "../../src/server/search/read-page.js";
import { MAX_CONVERSATION_READ_WINDOW_ROWS, PostgresConversationReader } from "../../src/server/search/read-repository.js";
import { READ_DOCUMENT, READ_IDENTITY, readChunkRow, readChunks, readDocumentRow, readPositionRows } from "../fixtures/search-read.js";
import { REPOSITORY_WORKSPACE } from "../fixtures/search-repository.js";

type Result = { rows: Record<string, unknown>[] };
function fixture(texts = ["First", "Second", "Third"], override?: (sql: string, values?: unknown[]) => Promise<Result | undefined> | Result | undefined, timeoutMs = 1000) {
  const chunks = readChunks(texts);
  const client = { query: vi.fn(async (sql: string, values?: unknown[]): Promise<Result> => {
    const result = await override?.(sql, values);
    if (result) return result;
    if (sql.includes("AS document_id")) return { rows: [readDocumentRow(chunks)] };
    if (sql.includes("GROUP BY c.entry_id")) {
      if (typeof values?.[1] === "string") return { rows: readPositionRows(chunks.filter((chunk) => chunk.entryId === values[1])) };
      return { rows: readPositionRows(chunks.filter((chunk) => chunk.ordinal < (values?.[1] as number))).reverse().slice(0, 2) };
    }
    if (sql.includes("AS original_text")) return { rows: chunks.filter((chunk) => chunk.ordinal >= (values?.[1] as number)).slice(0, values?.[4] as number).map(readChunkRow) };
    return { rows: [] };
  }), release: vi.fn() };
  const pool = { connect: vi.fn(async () => client) };
  const reader = new PostgresConversationReader(pool, timeoutMs);
  return { chunks, client, pool, reader };
}
const cursor = (overrides = {}) => encodeConversationReadCursor({ version: 1, ...READ_IDENTITY, documentId: READ_DOCUMENT.documentId,
  generation: READ_DOCUMENT.generation, ordinal: 0, entryId: "entry-0", byteOffset: 0, ...overrides });
afterEach(() => vi.useRealTimers());

describe("scoped PostgreSQL cached transcript reader", () => {
  it("is lazy and reads document and chunks from a read-only repeatable snapshot", async () => {
    const f = fixture(); expect(f.pool.connect).not.toHaveBeenCalled();
    const page = await f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY);
    expect(page.generation).toBe("9007199254740993");
    expect(page.segments.map((segment) => segment.text)).toEqual(["First", "Second", "Third"]);
    expect(f.client.query.mock.calls[0]?.[0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(f.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    const [sql, values] = f.client.query.mock.calls.find(([query]) => query.includes("AS document_id"))!;
    expect(sql).toContain("d.workspace_id = $1 AND d.session_id = $2 AND d.source_revision = $3 AND w.source_revision = $3");
    expect(values?.slice(0, 3)).toEqual([READ_IDENTITY.workspaceId, READ_IDENTITY.sessionId, REPOSITORY_WORKSPACE.sourceRevision]);
    expect(sql).not.toContain("source_path"); expect(sql).not.toContain("canonical_path");
    const [chunkSql, chunkValues] = f.client.query.mock.calls.find(([query]) => query.includes("AS original_text"))!;
    expect(chunkSql).toContain("ORDER BY c.ordinal LIMIT $5");
    expect(chunkSql).toContain("octet_length(c.original_text) <= $3 AND char_length(c.original_text) <= $4");
    expect(chunkValues?.[4]).toBe(MAX_CONVERSATION_READ_WINDOW_ROWS);
    expect(MAX_CONVERSATION_READ_WINDOW_ROWS).toBeLessThan(128);
  });

  it("captures scope and request values before awaiting IO", async () => {
    const f = fixture(); const scope = { ...REPOSITORY_WORKSPACE }; const request = { ...READ_IDENTITY, limit: 1 };
    const pending = f.reader.read(scope, request);
    scope.sourceRevision = "f".repeat(64); request.sessionId = "other"; request.limit = 20;
    const page = await pending;
    expect(page.segments).toHaveLength(1);
    const values = f.client.query.mock.calls.find(([sql]) => sql.includes("AS document_id"))![1]!;
    expect(values.slice(0, 3)).toEqual([READ_IDENTITY.workspaceId, READ_IDENTITY.sessionId, REPOSITORY_WORKSPACE.sourceRevision]);
  });

  it("continues huge Unicode dialogue without duplication across byte and row bounds", async () => {
    const text = '  😀界e\u0301\\\"\n'.repeat(25_000);
    const f = fixture([text, "After"]); let request: ConversationReadRequest = { ...READ_IDENTITY, limit: 1 };
    const saved: string[] = []; const offsets = new Map<string, number>();
    for (let index = 0; index < 100; index += 1) {
      const page = await f.reader.read(REPOSITORY_WORKSPACE, request);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MAX_CONVERSATION_READ_PAGE_BYTES);
      for (const segment of page.segments) {
        expect(segment.sourceByteStart).toBe(offsets.get(segment.entryId) ?? 0);
        offsets.set(segment.entryId, segment.sourceByteEnd); saved.push(segment.text);
      }
      if (page.nextCursor === null) break;
      request = { ...READ_IDENTITY, limit: 1, cursor: page.nextCursor };
    }
    expect(saved.join("")).toBe(text + "After");
  });

  it("honors smaller internal serialization budgets with exact continuation and focused anchors", async () => {
    const text = '\\"😀\n'.repeat(10_000); const f = fixture([text, "Anchor"]);
    const first = await f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY, { maximumPageBytes: 22 * 1024 });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(22 * 1024);
    expect(first.nextCursor).not.toBeNull(); expect(first.segments[0]!.endsMessage).toBe(false);
    const next = await f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, cursor: first.nextCursor! }, { maximumPageBytes: 22 * 1024 });
    expect(next.segments[0]!.sourceByteStart).toBe(first.segments[0]!.sourceByteEnd);
    const focused = await f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, aroundEntryId: "entry-1" }, { maximumPageBytes: 22 * 1024 });
    expect(focused.segments.some((segment) => segment.entryId === "entry-1")).toBe(true);
    expect(focused.precedingContextReduced).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(focused))).toBeLessThanOrEqual(22 * 1024);
    const invalid = fixture();
    for (const maximumPageBytes of [0, 1023, 1.5, 48 * 1024, NaN]) await expect(invalid.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY, { maximumPageBytes })).rejects.toThrow("search_query_invalid");
    expect(invalid.pool.connect).not.toHaveBeenCalled();
  });

  it("returns explicit not-indexed and missing-anchor errors, with no fallback read", async () => {
    const absent = fixture(undefined, (sql) => sql.includes("AS document_id") ? { rows: [] } : undefined);
    await expect(absent.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)).rejects.toEqual(new ConversationReadError("conversation_not_indexed"));
    const f = fixture();
    await expect(f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, aroundEntryId: "missing" })).rejects.toThrow("conversation_entry_not_indexed");
    expect(f.client.query.mock.calls.some(([sql]) => sql.includes("AS original_text"))).toBe(false);
    expect(f.client.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("rejects stale and mismatched cursors before fetching dialogue", async () => {
    for (const token of [cursor({ generation: "1" }), cursor({ documentId: "87654321-1234-1234-1234-123456789abc" })]) {
      const f = fixture();
      await expect(f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, cursor: token })).rejects.toThrow(token === cursor({ generation: "1" }) ? "conversation_cursor_stale" : "conversation_cursor_invalid");
      expect(f.client.query.mock.calls.some(([sql]) => sql.includes("AS original_text"))).toBe(false);
    }
    const f = fixture();
    await expect(f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, cursor: cursor({ ordinal: 100 }) })).rejects.toThrow("conversation_cursor_invalid");
  });

  it("rejects bad requests/scopes/cursors without opening a connection", async () => {
    const f = fixture();
    await expect(f.reader.read({ ...REPOSITORY_WORKSPACE, workspaceId: "other" }, READ_IDENTITY)).rejects.toThrow("search_query_invalid");
    await expect(f.reader.read({ ...REPOSITORY_WORKSPACE, sourceRevision: "invalid" }, READ_IDENTITY)).rejects.toThrow("search_query_invalid");
    await expect(f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, cursor: "@@@" })).rejects.toThrow("conversation_cursor_invalid");
    await expect(f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, limit: 21 })).rejects.toThrow("search_query_invalid");
    expect(f.pool.connect).not.toHaveBeenCalled();
  });

  it("preserves safe cache failures and masks dependency diagnostics", async () => {
    const corrupt = fixture(undefined, (sql) => sql.includes("AS original_text") ? { rows: [{ ...readChunkRow(readChunks()[0]!), original_text: null }] } : undefined);
    await expect(corrupt.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)).rejects.toEqual(new ConversationReadError("conversation_cache_invalid"));
    const failed = fixture(undefined, (sql) => { if (sql.includes("AS document_id")) throw new Error("SELECT private paths and credentials"); });
    await expect(failed.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)).rejects.toEqual(new SearchRepositoryError("search_database_unavailable"));
  });

  it("rejects inconsistent document coverage before fetching dialogue", async () => {
    const f = fixture(undefined, (sql) => sql.includes("AS document_id") ? { rows: [{ ...readDocumentRow(readChunks()), chunk_count: 4 }] } : undefined);
    await expect(f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)).rejects.toThrow("conversation_cache_invalid");
    expect(f.client.query.mock.calls.some(([sql]) => sql.includes("AS original_text"))).toBe(false);
  });

  it("does not treat a missing chunk window as a complete empty conversation", async () => {
    const f = fixture(undefined, (sql) => sql.includes("AS original_text") ? { rows: [] } : undefined);
    await expect(f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)).rejects.toThrow("conversation_cache_invalid");
  });

  it("admits two reads with no queue and closes even stalled dependencies", async () => {
    const f = fixture(undefined, (sql) => sql.startsWith("BEGIN") ? new Promise(() => {}) : undefined);
    const pending = [f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY), f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)];
    const rejected = pending.map((promise) => expect(promise).rejects.toThrow("search_cancelled"));
    await expect(f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)).rejects.toThrow("search_busy");
    await vi.waitFor(() => expect(f.client.query.mock.calls.some(([sql]) => sql.startsWith("BEGIN"))).toBe(true));
    f.reader.close(); await Promise.all(rejected);
    await expect(f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)).rejects.toThrow("search_cancelled");
    expect(f.pool.connect).toHaveBeenCalledTimes(2);
    expect(f.client.release).toHaveBeenCalledWith(true);
  });

  it("bounds non-cooperative database IO and releases admission after timeout", async () => {
    vi.useFakeTimers(); let stalled = true;
    const f = fixture(undefined, (sql) => stalled && sql.includes("AS document_id") ? new Promise(() => {}) : undefined, 50);
    const pending = expect(f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)).rejects.toThrow("search_timeout");
    await vi.advanceTimersByTimeAsync(51); await pending;
    expect(f.client.release).toHaveBeenCalledWith(true);
    stalled = false;
    await expect(f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY)).resolves.toHaveProperty("cached", true);
  });

  it("propagates caller cancellation without converting it to an empty page", async () => {
    const f = fixture(undefined, (sql) => sql.includes("AS document_id") ? new Promise(() => {}) : undefined);
    await expect(f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY, { signal: AbortSignal.abort() })).rejects.toThrow("search_cancelled");
    expect(f.pool.connect).not.toHaveBeenCalled();
    const controller = new AbortController();
    const pending = expect(f.reader.read(REPOSITORY_WORKSPACE, READ_IDENTITY, { signal: controller.signal })).rejects.toThrow("search_cancelled");
    await vi.waitFor(() => expect(f.client.query.mock.calls.some(([sql]) => sql.includes("AS document_id"))).toBe(true));
    controller.abort(); await pending;
  });
});

describe("focused cached dialogue reads", () => {
  it("starts up to two messages before the anchor, then continues forward", async () => {
    const f = fixture(["zero", "one", "two", "anchor", "after"]);
    const page = await f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, aroundEntryId: "entry-3" });
    expect(page.segments.map((segment) => segment.entryId)).toEqual(["entry-1", "entry-2", "entry-3", "entry-4"]);
    expect(page).toMatchObject({ aroundEntryId: "entry-3", precedingContextReduced: false, nextCursor: null });
  });

  it("reduces preceding context for small message limits, without excluding the anchor", async () => {
    const f = fixture();
    const page = await f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, aroundEntryId: "entry-2", limit: 1 });
    expect(page.segments.map((segment) => segment.entryId)).toEqual(["entry-2"]);
    expect(page.precedingContextReduced).toBe(true);
  });

  it("drops oversized preceding context rather than returning an unfinished predecessor", async () => {
    const f = fixture(["small", "x".repeat(50_000), "anchor", "after"]);
    const page = await f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, aroundEntryId: "entry-2" });
    expect(page.segments.map((segment) => segment.entryId)).toEqual(["entry-2", "entry-3"]);
    expect(page.precedingContextReduced).toBe(true);
    expect(f.client.query.mock.calls.filter(([sql]) => sql.includes("AS original_text"))).toHaveLength(1);
  });

  it("omits enormous context before fetching, stays row-bounded and resumes a large anchor", async () => {
    const anchor = "😀".repeat(20_000);
    const f = fixture(["small", "huge context".repeat(20_000), anchor, "after"]);
    const first = await f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, aroundEntryId: "entry-2", limit: 1 });
    expect(first).toMatchObject({ aroundEntryId: "entry-2", precedingContextReduced: true });
    expect(first.segments[0]).toMatchObject({ entryId: "entry-2", beginsMessage: true, endsMessage: false });
    expect(first.nextCursor).not.toBeNull();
    const second = await f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, cursor: first.nextCursor!, limit: 1 });
    expect(second.segments[0]?.sourceByteStart).toBe(first.segments[0]?.sourceByteEnd);
    expect(first.segments[0]!.text + second.segments[0]!.text).toBe(anchor);
    const chunksQuery = f.client.query.mock.calls.find(([sql]) => sql.includes("AS original_text"))!;
    expect(chunksQuery[1]?.[1]).toBe(f.chunks.find((chunk) => chunk.entryId === "entry-2")!.ordinal - 1);
  });

  it("handles an anchor at the beginning and reports malformed message summaries safely", async () => {
    const f = fixture();
    const first = await f.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, aroundEntryId: "entry-0" });
    expect(first.precedingContextReduced).toBe(false);
    expect(first.segments[0]?.entryId).toBe("entry-0");
    for (const override of [{ first_byte: 1 }, { chunk_count: 0 }, { last_ordinal: 5 }, { entry_id: "other" }]) {
      const bad = fixture(undefined, (sql, values) => sql.includes("GROUP BY c.entry_id") && values?.[1] === "entry-0" ? {
        rows: [{ ...readPositionRows(readChunks())[0]!, ...override }],
      } : undefined);
      await expect(bad.reader.read(REPOSITORY_WORKSPACE, { ...READ_IDENTITY, aroundEntryId: "entry-0" })).rejects.toThrow("conversation_cache_invalid");
    }
  });
});
