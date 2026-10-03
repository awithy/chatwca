import { MAX_CHUNK_CHARACTERS, MAX_CHUNK_UTF8_BYTES, MAX_CONVERSATION_CHUNKS } from "./chunk.js";
import { ConversationReadError, SearchQueryError } from "./errors.js";
import { isWellFormedText, MAX_SESSION_SNAPSHOT_BYTES } from "./extract.js";
import { MAX_SEARCH_TITLE_BYTES, type SearchDocumentVersion } from "./repository.js";

export const MAX_CONVERSATION_TOOL_BYTES = 48 * 1024;
// Leave room for the service freshness envelope and tool serialization metadata.
export const MAX_CONVERSATION_READ_PAGE_BYTES = MAX_CONVERSATION_TOOL_BYTES - 4 * 1024;
export const MAX_CONVERSATION_CURSOR_BYTES = 2 * 1024;
export const MAX_CONVERSATION_READ_ROWS = 128;
export const MAX_CONVERSATION_READ_PAYLOAD_BYTES = 1024 * 1024;
export const DEFAULT_CONVERSATION_READ_MESSAGES = 10;
export const MAX_CONVERSATION_READ_MESSAGES = 20;

export interface ConversationReadRequest {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly aroundEntryId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}
export interface ConversationReadPosition {
  readonly ordinal: number;
  readonly entryId: string;
  /** Next undisclosed byte in the message, not an offset in the chunk. */
  readonly byteOffset: number;
}
export interface ConversationReadCursor extends SearchDocumentVersion, ConversationReadPosition {
  readonly version: 1;
  readonly workspaceId: string;
  readonly sessionId: string;
}
export interface ConversationReadDocument extends SearchDocumentVersion {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly sessionId: string;
  readonly title: string;
  readonly modifiedAt: number;
  readonly indexedAt: number;
}
export interface ConversationReadChunk {
  readonly ordinal: number;
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly timestamp: number;
  readonly sourceByteStart: number;
  readonly sourceByteEnd: number;
  readonly text: string;
}
export interface ConversationReadSegment {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly timestamp: number;
  readonly text: string;
  readonly sourceByteStart: number;
  readonly sourceByteEnd: number;
  readonly beginsMessage: boolean;
  readonly endsMessage: boolean;
}
export interface ConversationReadPage {
  readonly cached: true;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly sessionId: string;
  readonly title: string;
  readonly titleTruncated: boolean;
  readonly modifiedAt: number;
  readonly indexedAt: number;
  readonly generation: string;
  readonly segments: readonly ConversationReadSegment[];
  readonly nextCursor: string | null;
  readonly aroundEntryId?: string;
  readonly precedingContextReduced?: boolean;
}
/**
 * One snapshot, selected by a scoped repository. For ordinal > 0 include the
 * preceding row to verify overlap. If hasMore, the final row is lookahead only.
 * The repository must bound IO before materializing this window.
 */
export interface ConversationReadWindow {
  readonly document: ConversationReadDocument;
  readonly chunks: readonly ConversationReadChunk[];
  readonly hasMore: boolean;
}

function invalidRequest(): never { throw new SearchQueryError("search_query_invalid"); }
function invalidCursor(): never { throw new ConversationReadError("conversation_cursor_invalid"); }
function invalidCache(): never { throw new ConversationReadError("conversation_cache_invalid"); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value);
}
function integer(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && !value.includes("\0") && isWellFormedText(value) && Buffer.byteLength(value) <= maximum;
}
function generation(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,18}$/u.test(value) && BigInt(value) <= 9223372036854775807n;
}
function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value);
}
function jsonBytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value)); }

/** Closed schema validation at the service boundary, independent of Pi. */
export function validateConversationReadRequest(value: unknown): ConversationReadRequest {
  if (!record(value) || Object.keys(value).some((key) => !["workspaceId", "sessionId", "aroundEntryId", "cursor", "limit"].includes(key)) ||
      !identifier(value.workspaceId) || !identifier(value.sessionId) ||
      (value.aroundEntryId !== undefined && !identifier(value.aroundEntryId)) ||
      (value.cursor !== undefined && typeof value.cursor !== "string") ||
      (value.aroundEntryId !== undefined && value.cursor !== undefined) ||
      (value.limit !== undefined && (!integer(value.limit, MAX_CONVERSATION_READ_MESSAGES) || value.limit === 0))) invalidRequest();
  const request: ConversationReadRequest = {
    workspaceId: value.workspaceId, sessionId: value.sessionId,
    ...(value.aroundEntryId === undefined ? {} : { aroundEntryId: value.aroundEntryId as string }),
    ...(value.cursor === undefined ? {} : { cursor: value.cursor as string }),
    ...(value.limit === undefined ? {} : { limit: value.limit as number }),
  };
  if (request.cursor !== undefined) decodeConversationReadCursor(request.cursor, request);
  return Object.freeze(request);
}

function validCursor(value: unknown): value is ConversationReadCursor {
  return record(value) && Object.keys(value).length === 8 &&
    Object.keys(value).every((key) => ["version", "workspaceId", "sessionId", "documentId", "generation", "ordinal", "entryId", "byteOffset"].includes(key)) &&
    value.version === 1 && identifier(value.workspaceId) && identifier(value.sessionId) && uuid(value.documentId) && generation(value.generation) &&
    integer(value.ordinal, MAX_CONVERSATION_CHUNKS - 1) && identifier(value.entryId) && integer(value.byteOffset, MAX_SESSION_SNAPSHOT_BYTES);
}
export function encodeConversationReadCursor(cursor: ConversationReadCursor): string {
  if (!validCursor(cursor)) invalidCursor();
  const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  if (Buffer.byteLength(encoded) > MAX_CONVERSATION_CURSOR_BYTES) invalidCursor();
  return encoded;
}
export function decodeConversationReadCursor(encoded: string, identity: Pick<ConversationReadRequest, "workspaceId" | "sessionId">): ConversationReadCursor {
  if (typeof encoded !== "string" || encoded.length > MAX_CONVERSATION_CURSOR_BYTES || !/^[A-Za-z0-9_-]+$/u.test(encoded)) invalidCursor();
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) invalidCursor();
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!validCursor(value) || value.workspaceId !== identity.workspaceId || value.sessionId !== identity.sessionId) invalidCursor();
    return Object.freeze(value);
  } catch { return invalidCursor(); }
}

function boundary(bytes: Buffer, offset: number): boolean {
  return offset === bytes.length || (offset >= 0 && offset < bytes.length && (bytes[offset]! & 0xc0) !== 0x80);
}
export function validateConversationReadDocument(d: ConversationReadDocument): void {
  if (!d || !uuid(d.documentId) || !generation(d.generation) || !identifier(d.workspaceId) || !identifier(d.sessionId) ||
      !text(d.workspaceName, 2048) || !text(d.title, MAX_SEARCH_TITLE_BYTES) ||
      !integer(d.modifiedAt, 8_640_000_000_000_000) || !integer(d.indexedAt, 8_640_000_000_000_000)) invalidCache();
}
function validateWindow(window: ConversationReadWindow): readonly Buffer[] {
  if (!window || typeof window !== "object") invalidCache();
  const { document: d, chunks } = window;
  validateConversationReadDocument(d);
  if (!Array.isArray(chunks) || chunks.length > MAX_CONVERSATION_READ_ROWS || typeof window.hasMore !== "boolean" ||
      (window.hasMore && chunks.length < 2)) invalidCache();
  let payloadBytes = jsonBytes(d);
  const seen = new Set<string>();
  const buffers: Buffer[] = [];
  for (const [index, chunk] of chunks.entries()) {
    if (!chunk || !integer(chunk.ordinal, MAX_CONVERSATION_CHUNKS - 1) || !identifier(chunk.entryId) ||
        (chunk.role !== "user" && chunk.role !== "assistant") || !integer(chunk.timestamp, 8_640_000_000_000_000) ||
        !integer(chunk.sourceByteStart, MAX_SESSION_SNAPSHOT_BYTES) || !integer(chunk.sourceByteEnd, MAX_SESSION_SNAPSHOT_BYTES) ||
        !text(chunk.text, MAX_CHUNK_UTF8_BYTES) || !chunk.text || [...chunk.text].length > MAX_CHUNK_CHARACTERS) invalidCache();
    const bytes = Buffer.from(chunk.text);
    if (bytes.length !== chunk.sourceByteEnd - chunk.sourceByteStart || (chunk.ordinal === 0 && chunk.sourceByteStart !== 0)) invalidCache();
    // JSON size also bounds row metadata and escaped text, not just raw dialogue.
    payloadBytes += jsonBytes(chunk);
    if (payloadBytes > MAX_CONVERSATION_READ_PAYLOAD_BYTES) invalidCache();
    const previous = chunks[index - 1];
    if (previous) {
      if (chunk.ordinal !== previous.ordinal + 1) invalidCache();
      if (chunk.entryId === previous.entryId) {
        if (chunk.role !== previous.role || chunk.timestamp !== previous.timestamp ||
            chunk.sourceByteStart <= previous.sourceByteStart || chunk.sourceByteStart > previous.sourceByteEnd || chunk.sourceByteEnd <= previous.sourceByteEnd) invalidCache();
        const overlap = previous.sourceByteEnd - chunk.sourceByteStart;
        const previousBytes = buffers[index - 1]!;
        const previousOffset = chunk.sourceByteStart - previous.sourceByteStart;
        if (!boundary(previousBytes, previousOffset) || !boundary(bytes, overlap) ||
            !previousBytes.subarray(previousOffset).equals(bytes.subarray(0, overlap))) invalidCache();
      } else if (chunk.sourceByteStart !== 0 || seen.has(chunk.entryId)) invalidCache();
    }
    seen.add(chunk.entryId);
    buffers.push(bytes);
  }
  return buffers;
}

/**
 * Pure page assembly: no source IO, database, provider, or lifecycle dependencies.
 * A focused-read repository can supply an initial position; cursor continuations
 * always use their exact recorded position. Focused context selection is separate.
 */
export function assembleConversationReadPage(
  window: ConversationReadWindow,
  input: ConversationReadRequest,
  initialPosition?: ConversationReadPosition,
  maximumBytes = MAX_CONVERSATION_READ_PAGE_BYTES,
): ConversationReadPage {
  const request = validateConversationReadRequest(input);
  if (!integer(maximumBytes, MAX_CONVERSATION_READ_PAGE_BYTES) || maximumBytes < 1024) invalidRequest();
  const buffers = validateWindow(window);
  const { document: d, chunks } = window;
  if (d.workspaceId !== request.workspaceId || d.sessionId !== request.sessionId) invalidCache();
  const cursor = request.cursor === undefined ? undefined : decodeConversationReadCursor(request.cursor, request);
  if (cursor && cursor.documentId !== d.documentId) invalidCursor();
  if (cursor && cursor.generation !== d.generation) throw new ConversationReadError("conversation_cursor_stale");
  // Do not quietly substitute a beginning read for an unresolved focused request.
  if (request.aroundEntryId !== undefined && !initialPosition) throw new ConversationReadError("conversation_entry_not_indexed");
  const position = cursor ?? initialPosition ?? (chunks[0] && { ordinal: 0, entryId: chunks[0].entryId, byteOffset: 0 });
  const segments: ConversationReadSegment[] = [];
  // Match search's bounded display-title projection. Dialogue is never shortened
  // except through explicit segments; title truncation is separately reported.
  const title = [...d.title].slice(0, 512).join("");
  const base = {
    cached: true as const, workspaceId: d.workspaceId, workspaceName: d.workspaceName, sessionId: d.sessionId,
    title, titleTruncated: title !== d.title, modifiedAt: d.modifiedAt, indexedAt: d.indexedAt, generation: d.generation,
  };
  const page = (items: readonly ConversationReadSegment[], next: ConversationReadPosition | null): ConversationReadPage => ({
    ...base, segments: items,
    nextCursor: next === null ? null : encodeConversationReadCursor({
      version: 1, workspaceId: d.workspaceId, sessionId: d.sessionId, documentId: d.documentId, generation: d.generation, ...next,
    }),
  });
  if (!position) {
    if (cursor || initialPosition || window.hasMore) invalidCursor();
    const empty = page([], null);
    if (jsonBytes(empty) > maximumBytes) invalidCache();
    return empty;
  }
  if (!integer(position.ordinal, MAX_CONVERSATION_CHUNKS - 1) || !identifier(position.entryId) || !integer(position.byteOffset, MAX_SESSION_SNAPSHOT_BYTES)) invalidCursor();
  const startIndex = position.ordinal === 0 ? 0 : 1;
  const start = chunks[startIndex];
  if (!start || chunks[0]!.ordinal !== Math.max(0, position.ordinal - 1) || start.ordinal !== position.ordinal || start.entryId !== position.entryId ||
      position.byteOffset < start.sourceByteStart || position.byteOffset >= start.sourceByteEnd ||
      !boundary(buffers[startIndex]!, position.byteOffset - start.sourceByteStart)) {
    if (cursor) invalidCursor();
    invalidCache();
  }
  const previous = chunks[startIndex - 1];
  if (previous && position.byteOffset < (previous.entryId === start.entryId ? previous.sourceByteEnd : 0)) invalidCursor();
  const lastIndex = chunks.length - (window.hasMore ? 2 : 1);
  let next: ConversationReadPosition | null = position;
  for (let index = startIndex; index <= lastIndex; index += 1) {
    const chunk = chunks[index]!;
    const bytes = buffers[index]!;
    const prior = chunks[index - 1];
    const byteStart = index === startIndex ? position.byteOffset : prior?.entryId === chunk.entryId ? prior.sourceByteEnd : 0;
    const offset = byteStart - chunk.sourceByteStart;
    const following = chunks[index + 1];
    const endsMessage = !following || following.entryId !== chunk.entryId;
    const after: ConversationReadPosition | null = following ? {
      ordinal: following.ordinal, entryId: following.entryId, byteOffset: endsMessage ? 0 : chunk.sourceByteEnd,
    } : null;
    const last = segments.at(-1);
    const continuing = last?.entryId === chunk.entryId;
    if (!continuing && segments.length >= (request.limit ?? DEFAULT_CONVERSATION_READ_MESSAGES)) break;
    const candidate = (endOffset: number): ConversationReadPage => {
      const end = chunk.sourceByteStart + endOffset;
      const segment: ConversationReadSegment = {
        entryId: chunk.entryId, role: chunk.role, timestamp: chunk.timestamp,
        text: (continuing ? last.text : "") + bytes.subarray(offset, endOffset).toString("utf8"),
        sourceByteStart: continuing ? last.sourceByteStart : byteStart,
        sourceByteEnd: end, beginsMessage: continuing ? last.beginsMessage : byteStart === 0,
        endsMessage: endOffset === bytes.length && endsMessage,
      };
      return page([...(continuing ? segments.slice(0, -1) : segments), segment], endOffset === bytes.length ? after : {
        ordinal: chunk.ordinal, entryId: chunk.entryId, byteOffset: end,
      });
    };
    let result = candidate(bytes.length);
    if (jsonBytes(result) > maximumBytes) {
      // Binary search byte lengths, snapping each probe back to a code-point
      // boundary. Measure the complete JSON including escaping and the cursor.
      let low = offset;
      let high = bytes.length - 1;
      let best = offset;
      while (low <= high) {
        const midpoint = Math.floor((low + high) / 2);
        let end = midpoint;
        while (end > offset && !boundary(bytes, end)) end -= 1;
        if (jsonBytes(candidate(end)) <= maximumBytes) { best = end; low = midpoint + 1; }
        else high = end - 1;
      }
      if (best === offset) {
        if (!segments.length) invalidCache(); // No valid progress with this metadata/budget.
        break;
      }
      result = candidate(best);
      return result;
    }
    segments.splice(0, segments.length, ...result.segments);
    next = after;
  }
  const result = page(segments, next);
  if (!segments.length || jsonBytes(result) > maximumBytes) invalidCache();
  return result;
}

/** Initial focused pages contain their anchor, never an unfinished predecessor. */
export function assembleFocusedConversationReadPage(
  window: ConversationReadWindow,
  input: ConversationReadRequest,
  /** Earliest to latest: up to two predecessors, then the anchor's first chunk. */
  positions: readonly ConversationReadPosition[],
  precedingContextReduced = false,
  maximumBytes = MAX_CONVERSATION_READ_PAGE_BYTES,
): ConversationReadPage {
  const request = validateConversationReadRequest(input);
  if (request.aroundEntryId === undefined || request.cursor !== undefined) invalidRequest();
  validateWindow(window);
  if (!Array.isArray(positions) || positions.length < 1 || positions.length > 3 || !positions.at(-1) || positions.at(-1)!.entryId !== request.aroundEntryId ||
      positions.some((position, index) => !position || position.byteOffset !== 0 ||
        (index > 0 && position.ordinal <= positions[index - 1]!.ordinal))) invalidCache();
  // This is a conservative exact envelope reservation, including its extra comma.
  const envelopeBytes = jsonBytes({ aroundEntryId: request.aroundEntryId, precedingContextReduced: false });
  for (let index = 0; index < positions.length; index += 1) {
    const position = positions[index]!;
    const from = window.chunks.findIndex((chunk) => chunk.ordinal === Math.max(0, position.ordinal - 1));
    if (from === -1) invalidCache();
    const page = assembleConversationReadPage({ ...window, chunks: window.chunks.slice(from) }, request, position, maximumBytes - envelopeBytes);
    if (!page.segments.some((segment) => segment.entryId === request.aroundEntryId)) continue;
    const result: ConversationReadPage = {
      ...page, aroundEntryId: request.aroundEntryId, precedingContextReduced: precedingContextReduced || index > 0,
    };
    if (jsonBytes(result) > maximumBytes) invalidCache();
    return result;
  }
  return invalidCache();
}
