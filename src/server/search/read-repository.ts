import { MAX_CHUNK_CHARACTERS, MAX_CHUNK_UTF8_BYTES, MAX_CONVERSATION_CHUNKS } from "./chunk.js";
import { SearchRepositoryDatabase, type SearchRepositoryOptions, type SearchRepositoryTransaction } from "./database.js";
import { ConversationReadError, SearchQueryError, SearchRepositoryError } from "./errors.js";
import type { SearchDatabasePool } from "./migrations.js";
import {
  assembleConversationReadPage, assembleFocusedConversationReadPage, decodeConversationReadCursor,
  DEFAULT_CONVERSATION_READ_MESSAGES, MAX_CONVERSATION_READ_PAGE_BYTES, MAX_CONVERSATION_READ_PAYLOAD_BYTES, MAX_CONVERSATION_READ_ROWS,
  validateConversationReadDocument, validateConversationReadRequest,
  type ConversationReadChunk, type ConversationReadDocument, type ConversationReadPage,
  type ConversationReadPosition, type ConversationReadRequest, type ConversationReadWindow,
} from "./read-page.js";
import { MAX_SEARCH_TITLE_BYTES, type SearchRepositoryScope } from "./repository.js";

export const MAX_CONVERSATION_CONCURRENT_READS = 2;
// Bound transport before materialization, including worst-case JSON escaping.
// Three metadata rows select focused context; one prior chunk and one lookahead
// are included in this window. Smaller windows simply continue on the next page.
export const MAX_CONVERSATION_READ_WINDOW_ROWS = Math.min(MAX_CONVERSATION_READ_ROWS - 3,
  Math.floor((MAX_CONVERSATION_READ_PAYLOAD_BYTES - MAX_SEARCH_TITLE_BYTES * 6 - 2048 * 6 - 4096) /
    (MAX_CHUNK_CHARACTERS * 6 + 1024)));

export interface ConversationReadOptions extends SearchRepositoryOptions {
  /** Internal serialization budget only; never a model/browser parameter. */
  readonly maximumPageBytes?: number;
}
export function conversationReadPageBudget(options: ConversationReadOptions): number {
  const maximum = options.maximumPageBytes ?? MAX_CONVERSATION_READ_PAGE_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 1024 || maximum > MAX_CONVERSATION_READ_PAGE_BYTES) throw new SearchQueryError("search_query_invalid");
  return maximum;
}
export interface ConversationReadRepository {
  /** Caller supplies a current registration revision, never a source-usability check. */
  read(scope: SearchRepositoryScope, request: ConversationReadRequest, options?: ConversationReadOptions): Promise<ConversationReadPage>;
}
interface MessagePosition extends ConversationReadPosition {
  readonly lastOrdinal: number;
  readonly chunks: number;
}
function invalidCache(): never { throw new ConversationReadError("conversation_cache_invalid"); }
function number(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function timestamp(value: unknown): number { return value instanceof Date ? value.getTime() : NaN; }
function messagePosition(row: Record<string, unknown>): MessagePosition {
  if (typeof row.entry_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(row.entry_id) ||
      !number(row.ordinal) || !number(row.last_ordinal) || row.last_ordinal >= MAX_CONVERSATION_CHUNKS ||
      !number(row.chunk_count) || row.chunk_count !== row.last_ordinal - row.ordinal + 1 || row.first_byte !== 0) invalidCache();
  return { ordinal: row.ordinal, lastOrdinal: row.last_ordinal, entryId: row.entry_id, byteOffset: 0, chunks: row.chunk_count };
}
const POSITION_COLUMNS = `CASE WHEN octet_length(c.entry_id) <= 256 THEN c.entry_id END AS entry_id,
  min(c.ordinal) AS ordinal, max(c.ordinal) AS last_ordinal, count(*)::integer AS chunk_count, min(c.source_byte_start) AS first_byte`;

/** Cached dialogue only. No filesystem, Pi runtime, embedding or provider dependency. */
export class PostgresConversationReader implements ConversationReadRepository {
  private readonly slots: { database: SearchRepositoryDatabase; busy: boolean }[];
  private closed = false;
  constructor(pool: SearchDatabasePool, timeoutMs?: number) {
    this.slots = Array.from({ length: MAX_CONVERSATION_CONCURRENT_READS }, () => ({ database: new SearchRepositoryDatabase(pool, timeoutMs), busy: false }));
  }
  close(): void { this.closed = true; for (const slot of this.slots) slot.database.close(); }

  async read(scope: SearchRepositoryScope, input: ConversationReadRequest, options: ConversationReadOptions = {}): Promise<ConversationReadPage> {
    if (this.closed || options.signal?.aborted) throw new SearchRepositoryError("search_cancelled");
    const request = validateConversationReadRequest(input);
    const maximumPageBytes = conversationReadPageBudget(options);
    if (!scope || scope.workspaceId !== request.workspaceId || typeof scope.sourceRevision !== "string" || !/^[a-f0-9]{64}$/u.test(scope.sourceRevision)) {
      throw new SearchQueryError("search_query_invalid");
    }
    const revision = scope.sourceRevision;
    const cursor = request.cursor === undefined ? undefined : decodeConversationReadCursor(request.cursor, request);
    const slot = this.slots.find((candidate) => !candidate.busy);
    if (!slot) throw new SearchRepositoryError("search_busy");
    slot.busy = true;
    try {
      return await slot.database.transaction(async (tx) => {
        const metadata = await tx.query(`SELECT d.id AS document_id, d.generation::text AS generation, d.workspace_id, d.session_id,
          CASE WHEN octet_length(w.display_name) <= 2048 THEN w.display_name END AS workspace_name,
          CASE WHEN octet_length(d.title) <= $4 THEN d.title END AS title, d.modified_at, d.indexed_at,
          coverage.last_ordinal, coverage.chunk_count
          FROM search_documents d JOIN search_workspaces w ON w.workspace_id = d.workspace_id
          CROSS JOIN LATERAL (SELECT max(c.ordinal) AS last_ordinal, count(*)::integer AS chunk_count
            FROM search_chunks c WHERE c.document_id = d.id) coverage
          WHERE d.workspace_id = $1 AND d.session_id = $2 AND d.source_revision = $3 AND w.source_revision = $3`,
        [request.workspaceId, request.sessionId, revision, MAX_SEARCH_TITLE_BYTES]);
        if (metadata.rows.length === 0) throw new ConversationReadError("conversation_not_indexed");
        if (metadata.rows.length !== 1) invalidCache();
        const row = metadata.rows[0]!;
        const document: ConversationReadDocument = {
          documentId: row.document_id as string, generation: row.generation as string, workspaceId: row.workspace_id as string,
          sessionId: row.session_id as string, workspaceName: row.workspace_name as string, title: row.title as string,
          modifiedAt: timestamp(row.modified_at), indexedAt: timestamp(row.indexed_at),
        };
        validateConversationReadDocument(document);
        if (document.workspaceId !== request.workspaceId || document.sessionId !== request.sessionId) invalidCache();
        if (cursor && cursor.documentId !== document.documentId) throw new ConversationReadError("conversation_cursor_invalid");
        if (cursor && cursor.generation !== document.generation) throw new ConversationReadError("conversation_cursor_stale");
        const lastOrdinal = row.last_ordinal;
        if ((lastOrdinal !== null && (!number(lastOrdinal) || lastOrdinal >= MAX_CONVERSATION_CHUNKS)) ||
            !number(row.chunk_count) || row.chunk_count !== (lastOrdinal === null ? 0 : (lastOrdinal as number) + 1)) invalidCache();

        let positions: readonly ConversationReadPosition[] | undefined;
        let contextReduced = false;
        if (request.aroundEntryId !== undefined) {
          const selected = await this.focusPositions(tx, document.documentId, request.aroundEntryId, request.limit ?? DEFAULT_CONVERSATION_READ_MESSAGES);
          positions = selected.positions;
          contextReduced = selected.contextReduced;
        }
        const ordinal = cursor?.ordinal ?? positions?.[0]?.ordinal ?? 0;
        const fromOrdinal = Math.max(0, ordinal - 1);
        const result = await tx.query(`SELECT c.ordinal,
          CASE WHEN octet_length(c.entry_id) <= 256 THEN c.entry_id END AS entry_id,
          CASE WHEN c.role IN ('user', 'assistant') THEN c.role END AS role, c.entry_timestamp,
          c.source_byte_start, c.source_byte_end,
          CASE WHEN octet_length(c.original_text) <= $3 AND char_length(c.original_text) <= $4 THEN c.original_text END AS original_text
          FROM search_chunks c WHERE c.document_id = $1 AND c.ordinal >= $2 ORDER BY c.ordinal LIMIT $5`,
        [document.documentId, fromOrdinal, MAX_CHUNK_UTF8_BYTES, MAX_CHUNK_CHARACTERS, MAX_CONVERSATION_READ_WINDOW_ROWS]);
        if (result.rows.length > MAX_CONVERSATION_READ_WINDOW_ROWS) invalidCache();
        const chunks: ConversationReadChunk[] = result.rows.map((chunk) => ({
          ordinal: chunk.ordinal as number, entryId: chunk.entry_id as string, role: chunk.role as ConversationReadChunk["role"],
          timestamp: timestamp(chunk.entry_timestamp), sourceByteStart: chunk.source_byte_start as number,
          sourceByteEnd: chunk.source_byte_end as number, text: chunk.original_text as string,
        }));
        const hasMore = lastOrdinal !== null && chunks.length > 0 && chunks.at(-1)!.ordinal < lastOrdinal;
        if ((lastOrdinal === null && chunks.length !== 0) || (lastOrdinal !== null && chunks.length === 0 && !cursor) ||
            (hasMore && chunks.length !== MAX_CONVERSATION_READ_WINDOW_ROWS) ||
            (chunks.length > 0 && chunks.at(-1)!.ordinal !== lastOrdinal && !hasMore)) invalidCache();
        const window: ConversationReadWindow = { document, chunks, hasMore };
        return positions ? assembleFocusedConversationReadPage(window, request, positions, contextReduced, maximumPageBytes) : assembleConversationReadPage(window, request, undefined, maximumPageBytes);
      }, options, "snapshot");
    } finally { slot.busy = false; }
  }

  private async focusPositions(tx: SearchRepositoryTransaction, documentId: string, anchorId: string, limit: number): Promise<{
    readonly positions: readonly ConversationReadPosition[]; readonly contextReduced: boolean;
  }> {
    const anchorRows = await tx.query(`SELECT ${POSITION_COLUMNS} FROM search_chunks c
      WHERE c.document_id = $1 AND c.entry_id = $2 GROUP BY c.entry_id`, [documentId, anchorId]);
    if (anchorRows.rows.length === 0) throw new ConversationReadError("conversation_entry_not_indexed");
    if (anchorRows.rows.length !== 1) invalidCache();
    const anchor = messagePosition(anchorRows.rows[0]!);
    if (anchor.entryId !== anchorId) invalidCache();
    const precedingRows = await tx.query(`SELECT ${POSITION_COLUMNS} FROM search_chunks c
      WHERE c.document_id = $1 AND c.ordinal < $2 GROUP BY c.entry_id ORDER BY max(c.ordinal) DESC LIMIT 2`, [documentId, anchor.ordinal]);
    if (precedingRows.rows.length > 2) invalidCache();
    const preceding = precedingRows.rows.map(messagePosition).reverse();
    for (const [index, position] of preceding.entries()) {
      const next = preceding[index + 1] ?? anchor;
      if (position.lastOrdinal + 1 !== next.ordinal || position.entryId === anchorId || (index > 0 && position.entryId === preceding[index - 1]!.entryId)) invalidCache();
    }
    if (anchor.ordinal > 0 && preceding.length === 0) invalidCache();
    const originalCount = preceding.length;
    // Fit complete predecessors, the anchor's initial chunk, lookahead and the
    // preceding overlap witness in one bounded fetch. Never load huge context
    // then issue a second unbounded/redundant fetch to reach the anchor.
    while (preceding.length >= limit || preceding.reduce((sum, position) => sum + position.chunks, 0) > MAX_CONVERSATION_READ_WINDOW_ROWS - 3) preceding.shift();
    return { positions: [...preceding, anchor], contextReduced: preceding.length !== originalCount };
  }
}
