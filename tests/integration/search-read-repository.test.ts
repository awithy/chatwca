import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chunkMessages } from "../../src/server/search/chunk.js";
import { extractSession, normalizeEntryText, searchHash } from "../../src/server/search/extract.js";
import { loadSearchMigrations, migrateSearchDatabase, type SearchDatabasePool } from "../../src/server/search/migrations.js";
import { createSearchPool } from "../../src/server/search/postgres.js";
import { decodeConversationReadCursor, MAX_CONVERSATION_READ_PAGE_BYTES, MAX_CONVERSATION_READ_PAYLOAD_BYTES,
  MAX_CONVERSATION_READ_ROWS, type ConversationReadPage, type ConversationReadRequest } from "../../src/server/search/read-page.js";
import { PostgresConversationReader } from "../../src/server/search/read-repository.js";
import { PostgresSearchRepository, type SearchDocumentPublication, type SearchRepositoryWorkspace } from "../../src/server/search/repository.js";
import { fakeSearchVector } from "../fixtures/search-ollama.js";
import { REPOSITORY_WORKSPACE, searchPublication } from "../fixtures/search-repository.js";
import { searchAssistantEntry as assistant, searchEntry as entry, searchJsonl, searchSessionHeader as header, searchUserEntry as user } from "../fixtures/search-session.js";

const testUrl = process.env.CHATWCA_SEARCH_TEST_DATABASE_URL;
describe.skipIf(testUrl === undefined)("snapshot cached transcript reads on disposable pgvector PostgreSQL", () => {
  const schema = `chatwca_search_read_${randomUUID().replaceAll("-", "")}`;
  const other = { ...REPOSITORY_WORKSPACE, workspaceId: "other-workspace", sourceRevision: searchHash("other source") };
  const identity = { workspaceId: REPOSITORY_WORKSPACE.workspaceId, sessionId: "synthetic-session" };
  let admin: Pool; let pool: Pool; let writer: PostgresSearchRepository; let reader: PostgresConversationReader; let created = false;
  beforeAll(async () => {
    admin = createSearchPool(testUrl!); await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    const url = new URL(testUrl!); url.searchParams.set("options", `-c search_path=${schema},public`);
    pool = createSearchPool(url.toString()); await migrateSearchDatabase(pool, await loadSearchMigrations());
    writer = new PostgresSearchRepository(pool); reader = new PostgresConversationReader(pool);
  });
  beforeEach(async () => {
    await pool.query("TRUNCATE search_workspaces CASCADE");
    await writer.synchronizeWorkspace(REPOSITORY_WORKSPACE, null); await writer.synchronizeWorkspace(other, null);
  });
  afterAll(async () => { writer?.close(); reader?.close(); await pool?.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end(); });
  const publish = (texts: string[], workspace: SearchRepositoryWorkspace = REPOSITORY_WORKSPACE, overrides: Partial<SearchDocumentPublication> = {}) =>
    writer.publishDocument(searchPublication(texts, { workspaceId: workspace.workspaceId, sourceRevision: workspace.sourceRevision, title: "Synthetic conversation", ...overrides }));
  async function allPages(request: ConversationReadRequest, initial?: ConversationReadPage): Promise<ConversationReadPage[]> {
    const pages = initial ? [initial] : [await reader.read(REPOSITORY_WORKSPACE, request)];
    for (let index = 0; pages.at(-1)!.nextCursor !== null; index += 1) {
      if (index >= 100) throw new Error("Pagination did not finish");
      pages.push(await reader.read(REPOSITORY_WORKSPACE, { ...identity, limit: request.limit ?? 10, cursor: pages.at(-1)!.nextCursor! }));
    }
    for (const page of pages) expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(MAX_CONVERSATION_READ_PAGE_BYTES);
    return pages;
  }

  it("keeps duplicate session IDs workspace-scoped and filters both cached source revisions", async () => {
    await publish(["First workspace"]); await publish(["Other workspace"], other);
    expect((await reader.read(REPOSITORY_WORKSPACE, identity)).segments[0]?.text).toBe("First workspace");
    expect((await reader.read(other, { ...identity, workspaceId: other.workspaceId })).segments[0]?.text).toBe("Other workspace");
    await expect(reader.read({ ...REPOSITORY_WORKSPACE, sourceRevision: searchHash("new registration") }, identity)).rejects.toThrow("conversation_not_indexed");
    await pool.query("UPDATE search_workspaces SET source_revision = $1 WHERE workspace_id = $2", [searchHash("new cached revision"), REPOSITORY_WORKSPACE.workspaceId]);
    await expect(reader.read(REPOSITORY_WORKSPACE, identity)).rejects.toThrow("conversation_not_indexed");
    await pool.query("UPDATE search_documents SET source_revision = $1 WHERE workspace_id = $2", [searchHash("obsolete document"), other.workspaceId]);
    await expect(reader.read(other, { ...identity, workspaceId: other.workspaceId })).rejects.toThrow("conversation_not_indexed");
  });

  it("returns a complete empty page for an indexed conversation without dialogue", async () => {
    await publish([]);
    expect(await reader.read(REPOSITORY_WORKSPACE, identity)).toMatchObject({ cached: true, segments: [], nextCursor: null });
    await expect(reader.read(REPOSITORY_WORKSPACE, { ...identity, aroundEntryId: "missing" })).rejects.toThrow("conversation_entry_not_indexed");
  });

  it("reads restored cached text despite nonexistent source directories and follows metadata renames", async () => {
    await publish(["Retained cache"]);
    const restored = new PostgresConversationReader(pool);
    try {
      expect((await restored.read(REPOSITORY_WORKSPACE, identity)).segments[0]?.text).toBe("Retained cache");
      await writer.synchronizeWorkspace({ ...REPOSITORY_WORKSPACE, displayName: "Renamed workspace" }, REPOSITORY_WORKSPACE.sourceRevision);
      expect((await restored.read(REPOSITORY_WORKSPACE, identity)).workspaceName).toBe("Renamed workspace");
    } finally { restored.close(); }
    await expect(reader.read(REPOSITORY_WORKSPACE, { ...identity, sessionId: "absent" })).rejects.toThrow("conversation_not_indexed");
  });

  it("reconstructs normalized whitespace, multibyte text and split fences without duplicated overlaps", async () => {
    const texts = ['  😀界e\u0301\\\"\r\n'.repeat(8000), `\`\`\`typescript\n${"  fn();\n".repeat(10_000)}\`\`\`\n`, "after"];
    await publish(texts);
    const pages = await allPages({ ...identity, limit: 1 });
    const saved = new Map<string, string>(); const ended = new Set<string>();
    for (const segment of pages.flatMap((page) => page.segments)) {
      const preceding = saved.get(segment.entryId) ?? "";
      expect(segment.sourceByteStart).toBe(Buffer.byteLength(preceding));
      expect(segment.sourceByteEnd - segment.sourceByteStart).toBe(Buffer.byteLength(segment.text));
      expect(segment.beginsMessage).toBe(preceding.length === 0);
      expect(ended.has(segment.entryId)).toBe(false);
      saved.set(segment.entryId, preceding + segment.text);
      if (segment.endsMessage) ended.add(segment.entryId);
    }
    expect([...saved.values()]).toEqual(texts.map(normalizeEntryText));
    expect(ended.size).toBe(3);
  });

  it("reads saved-branch user/assistant text only, retains pre-compaction history and never reads live source content", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "chatwca-cached-read-"));
    try {
      const sourcePath = path.join(directory, "session.jsonl");
      const records = [header(), user("u", null, "Before compaction"), assistant("a", "u", [
        { type: "thinking", thinking: "PRIVATE_THINKING" }, { type: "toolCall", id: "tool", name: "bash", arguments: { command: "PRIVATE_ARGUMENTS" } },
        { type: "text", text: "Assistant evidence" },
      ]), user("abandoned", "a", "PRIVATE_ABANDONED"), entry("summary", "a", { type: "branch_summary", fromId: "abandoned", summary: "PRIVATE_SUMMARY" }),
      entry("compaction", "summary", { type: "compaction", summary: "PRIVATE_COMPACTION", firstKeptEntryId: "a", tokensBefore: 100 }),
      user("u2", "compaction", [{ type: "image", data: "PRIVATE_IMAGE", mimeType: "image/png" }, { type: "text", text: "Later question" }]),
      entry("tool", "u2", { type: "message", message: { role: "toolResult", content: "PRIVATE_TOOL_PAYLOAD", timestamp: 1000 } }), assistant("a2", "tool")];
      await writeFile(sourcePath, searchJsonl(records));
      const saved = extractSession(records);
      await writer.publishDocument(searchPublication([], { sourcePath, savedLeafId: saved.savedLeafId,
        chunks: chunkMessages(saved.messages).map((chunk) => ({ ...chunk, embedding: fakeSearchVector(1, 0) })) }));
      // A tool call must use the indexed branch, not this changed live file.
      await writeFile(sourcePath, "PRIVATE_LIVE_SOURCE\n");
      const before = await stat(sourcePath);
      const pages = await allPages(identity);
      expect(pages.flatMap((page) => page.segments.map(({ entryId, role, text }) => ({ entryId, role, text })))).toEqual(saved.messages.map(({ entryId, role, text }) => ({ entryId, role, text })));
      expect(JSON.stringify(pages)).not.toContain("PRIVATE_");
      expect(await readFile(sourcePath, "utf8")).toBe("PRIVATE_LIVE_SOURCE\n");
      expect((await stat(sourcePath)).mtimeMs).toBe(before.mtimeMs);
      await expect(reader.read(REPOSITORY_WORKSPACE, { ...identity, aroundEntryId: "abandoned" })).rejects.toThrow("conversation_entry_not_indexed");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("includes two preceding messages where possible and trims context to include a large anchor", async () => {
    await publish(["zero", "one", "two", "anchor", "after"]);
    const normal = await reader.read(REPOSITORY_WORKSPACE, { ...identity, aroundEntryId: "entry-3" });
    expect(normal.segments.map((segment) => segment.entryId)).toEqual(["entry-1", "entry-2", "entry-3", "entry-4"]);
    expect(normal.precedingContextReduced).toBe(false);
    const one = await reader.read(REPOSITORY_WORKSPACE, { ...identity, aroundEntryId: "entry-3", limit: 1 });
    expect(one.segments.map((segment) => segment.entryId)).toEqual(["entry-3"]); expect(one.precedingContextReduced).toBe(true);
    await expect(reader.read(REPOSITORY_WORKSPACE, { ...identity, aroundEntryId: "missing" })).rejects.toThrow("conversation_entry_not_indexed");
    const previous = await writer.readCheckpoint(REPOSITORY_WORKSPACE, identity.sessionId);
    const anchor = "😀".repeat(30_000);
    await publish(["small", "context".repeat(30_000), anchor, "after"], REPOSITORY_WORKSPACE, { expected: previous! });
    let returnedRows = 0; let returnedBytes = 0;
    const spyPool: SearchDatabasePool = { connect: async () => {
      const connection = await pool.connect();
      return { query: async (sql, values) => {
        const result = await connection.query(sql, values);
        returnedRows += result.rows.length; returnedBytes += Buffer.byteLength(JSON.stringify(result.rows));
        return result;
      }, release: (destroy) => connection.release(destroy) };
    } };
    const bounded = new PostgresConversationReader(spyPool);
    let first: ConversationReadPage;
    try { first = await bounded.read(REPOSITORY_WORKSPACE, { ...identity, aroundEntryId: "entry-2", limit: 1 }); }
    finally { bounded.close(); }
    expect(returnedRows).toBeLessThanOrEqual(MAX_CONVERSATION_READ_ROWS);
    expect(returnedBytes).toBeLessThanOrEqual(MAX_CONVERSATION_READ_PAYLOAD_BYTES);
    expect(first!).toMatchObject({ aroundEntryId: "entry-2", precedingContextReduced: true });
    expect(first!.segments[0]).toMatchObject({ entryId: "entry-2", beginsMessage: true, endsMessage: false });
    const pages = await allPages({ ...identity, limit: 1 }, first!);
    expect(pages.flatMap((page) => page.segments).filter((segment) => segment.entryId === "entry-2").map((segment) => segment.text).join("")).toBe(anchor);
  });

  it("returns exact generations and rejects continuation after atomic replacement", async () => {
    await publish(["first", "second"]);
    await pool.query("UPDATE search_documents SET generation = 9007199254740993");
    const first = await reader.read(REPOSITORY_WORKSPACE, { ...identity, limit: 1 });
    expect(first.generation).toBe("9007199254740993");
    expect(decodeConversationReadCursor(first.nextCursor!, identity).generation).toBe("9007199254740993");
    const previous = await writer.readCheckpoint(REPOSITORY_WORKSPACE, identity.sessionId);
    await publish(["replacement"], REPOSITORY_WORKSPACE, { expected: previous! });
    await expect(reader.read(REPOSITORY_WORKSPACE, { ...identity, cursor: first.nextCursor! })).rejects.toThrow("conversation_cursor_stale");
    expect((await reader.read(REPOSITORY_WORKSPACE, identity)).generation).toBe("9007199254740994");
  });

  it("does not mix metadata and text generations when publication happens between SELECTs", async () => {
    const previous = await publish(["old first", "old second"], REPOSITORY_WORKSPACE, { title: "Old title" });
    let markMetadata!: () => void; let releaseMetadata!: () => void;
    const metadataRead = new Promise<void>((resolve) => { markMetadata = resolve; });
    const resume = new Promise<void>((resolve) => { releaseMetadata = resolve; });
    const pausingPool: SearchDatabasePool = { connect: async () => {
      const connection = await pool.connect();
      return { query: async (sql, values) => {
        const result = await connection.query(sql, values);
        if (sql.includes("AS document_id")) { markMetadata(); await resume; }
        return result;
      }, release: (destroy) => connection.release(destroy) };
    } };
    const pausedReader = new PostgresConversationReader(pausingPool);
    try {
      const pending = pausedReader.read(REPOSITORY_WORKSPACE, { ...identity, limit: 1 });
      await metadataRead;
      try { await publish(["new first", "new second", "new third"], REPOSITORY_WORKSPACE, { title: "New title", expected: previous }); }
      finally { releaseMetadata(); }
      const page = await pending;
      expect(page).toMatchObject({ generation: "1", title: "Old title" });
      expect(page.segments[0]?.text).toBe("old first");
      await expect(reader.read(REPOSITORY_WORKSPACE, { ...identity, cursor: page.nextCursor! })).rejects.toThrow("conversation_cursor_stale");
      const current = await reader.read(REPOSITORY_WORKSPACE, identity);
      expect(current).toMatchObject({ generation: "2", title: "New title" });
      expect(current.segments.map((segment) => segment.text)).toEqual(["new first", "new second", "new third"]);
    } finally { releaseMetadata(); pausedReader.close(); }
  });

  it("fails safely for inconsistent overlaps and oversized stored chunks", async () => {
    await publish(["a".repeat(5000)]);
    await pool.query("UPDATE search_chunks SET original_text = 'b' || substring(original_text FROM 2) WHERE ordinal = 1");
    await expect(reader.read(REPOSITORY_WORKSPACE, identity)).rejects.toThrow("conversation_cache_invalid");
    await pool.query("UPDATE search_chunks SET ordinal = 3 WHERE ordinal = 1");
    await expect(reader.read(REPOSITORY_WORKSPACE, identity)).rejects.toThrow("conversation_cache_invalid");
    await pool.query("UPDATE search_chunks SET ordinal = 1 WHERE ordinal = 3");
    await pool.query("UPDATE search_chunks SET original_text = $1 WHERE ordinal = 0", ["oversized ".repeat(5000)]);
    await expect(reader.read(REPOSITORY_WORKSPACE, identity)).rejects.toThrow("conversation_cache_invalid");
  });
});
