import { SearchSourceError } from "./errors.js";
import { isWellFormedText, normalizeEntryText, searchHash, type ExtractedMessage } from "./extract.js";

export const SEARCH_CHUNKER_VERSION = "conversation-message-chunks-v1";
export const SEARCH_DOCUMENT_INPUT_VERSION = "conversation-document-input-v1";
export const SEARCH_QUERY_INPUT_VERSION = "conversation-query-input-v1";
export const MAX_CHUNK_CHARACTERS = 3_200;
export const MAX_CHUNK_UTF8_BYTES = 12 * 1024;
export const CHUNK_OVERLAP_CHARACTERS = 400;
export const MAX_CONVERSATION_CHUNKS = 20_000;

export interface SearchChunk {
  readonly stableKey: string;
  readonly ordinal: number;
  readonly splitOrdinal: number;
  readonly entryId: string;
  readonly role: ExtractedMessage["role"];
  readonly timestamp: number;
  readonly sourceByteStart: number;
  readonly sourceByteEnd: number;
  readonly text: string;
  readonly textHash: string;
  readonly embeddingInput: string;
  readonly embeddingInputHash: string;
}

/** Document context is role only; title/workspace renames never change vectors. */
export function documentEmbeddingInput(role: ExtractedMessage["role"], text: string): string {
  return `${role === "user" ? "User" : "Assistant"} message:\n${text}`;
}
export function queryEmbeddingInput(query: string): string {
  return `Instruct: Given a question or search phrase, retrieve relevant passages from past user and assistant conversations.\nQuery: ${query}`;
}

function utf8Width(codePoint: number): number {
  return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
}

/** Bound a slice without allocating a code-point array for the entire message. */
function maximumEnd(text: string, start: number): number {
  let end = start;
  let bytes = 0;
  for (let characters = 0; characters < MAX_CHUNK_CHARACTERS && end < text.length; characters += 1) {
    const codePoint = text.codePointAt(end)!;
    bytes += utf8Width(codePoint);
    if (bytes > MAX_CHUNK_UTF8_BYTES) break;
    end += codePoint > 0xffff ? 2 : 1;
  }
  return end;
}

function preferredEnd(text: string, start: number, maximum: number): number {
  if (maximum === text.length) return maximum;
  const slice = text.slice(start, maximum);
  // Keep at least half the available evidence, preferring paragraphs, then
  // sentences, then code/prose lines. Oversized fences are split, never padded
  // with synthetic delimiters that would invalidate source byte spans.
  const floor = slice.length / 2;
  for (const pattern of [/\n[ \t]*\n/gu, /[.!?][ \t\n]+/gu, /\n/gu]) {
    let boundary = 0;
    for (const match of slice.matchAll(pattern)) {
      const end = match.index + match[0].length;
      if (end >= floor) boundary = end;
    }
    if (boundary > 0) return start + boundary;
  }
  return maximum;
}

function overlapStart(text: string, start: number, end: number): number {
  let next = end;
  for (let characters = 0; characters < CHUNK_OVERLAP_CHARACTERS && next > start; characters += 1) {
    next -= 1;
    const unit = text.charCodeAt(next);
    if (unit >= 0xdc00 && unit <= 0xdfff) next -= 1;
  }
  // Guarantee forward progress even if a later profile changes these limits.
  return next > start ? next : end;
}

/** Independent deterministic message splits with UTF-8 source spans. */
export function chunkMessages(messages: readonly ExtractedMessage[]): readonly SearchChunk[] {
  const chunks: SearchChunk[] = [];
  for (const message of messages) {
    if (!isWellFormedText(message.text)) throw new SearchSourceError("search_session_invalid");
    const text = normalizeEntryText(message.text);
    if (!text.trim()) continue;
    let start = 0;
    let byteStart = 0;
    let splitOrdinal = 0;
    while (start < text.length) {
      if (chunks.length >= MAX_CONVERSATION_CHUNKS) throw new SearchSourceError("search_session_limit");
      const end = preferredEnd(text, start, maximumEnd(text, start));
      const quoted = text.slice(start, end);
      const byteEnd = byteStart + Buffer.byteLength(quoted, "utf8");
      const embeddingInput = documentEmbeddingInput(message.role, quoted);
      chunks.push({
        stableKey: `${SEARCH_CHUNKER_VERSION}:${message.entryId}:${String(splitOrdinal)}`,
        ordinal: chunks.length, splitOrdinal, entryId: message.entryId, role: message.role,
        timestamp: message.timestamp, sourceByteStart: byteStart, sourceByteEnd: byteEnd,
        text: quoted, textHash: searchHash(quoted), embeddingInput, embeddingInputHash: searchHash(embeddingInput),
      });
      splitOrdinal += 1;
      if (end === text.length) break;
      const next = overlapStart(text, start, end);
      byteStart += Buffer.byteLength(text.slice(start, next), "utf8");
      start = next;
    }
  }
  return chunks;
}
