import type { ConversationReadChunk, ConversationReadDocument } from "../../src/server/search/read-page.js";
import { searchPublication, REPOSITORY_WORKSPACE } from "./search-repository.js";

export const READ_DOCUMENT: ConversationReadDocument = {
  documentId: "12345678-1234-1234-1234-123456789abc", generation: "9007199254740993",
  workspaceId: REPOSITORY_WORKSPACE.workspaceId, workspaceName: REPOSITORY_WORKSPACE.displayName,
  sessionId: "synthetic-session", title: "Synthetic conversation", modifiedAt: 1000, indexedAt: 2000,
};
export const READ_IDENTITY = { workspaceId: READ_DOCUMENT.workspaceId, sessionId: READ_DOCUMENT.sessionId };
export function readChunks(texts = ["First", "Second", "Third"]): readonly ConversationReadChunk[] { return searchPublication(texts).chunks; }
export function readDocumentRow(chunks: readonly ConversationReadChunk[], document = READ_DOCUMENT): Record<string, unknown> {
  return { document_id: document.documentId, generation: document.generation, workspace_id: document.workspaceId,
    workspace_name: document.workspaceName, session_id: document.sessionId, title: document.title,
    modified_at: new Date(document.modifiedAt), indexed_at: new Date(document.indexedAt),
    last_ordinal: chunks.at(-1)?.ordinal ?? null, chunk_count: chunks.length };
}
export function readChunkRow(chunk: ConversationReadChunk): Record<string, unknown> {
  return { ordinal: chunk.ordinal, entry_id: chunk.entryId, role: chunk.role, entry_timestamp: new Date(chunk.timestamp),
    source_byte_start: chunk.sourceByteStart, source_byte_end: chunk.sourceByteEnd, original_text: chunk.text };
}
export function readPositionRows(chunks: readonly ConversationReadChunk[]): Record<string, unknown>[] {
  const groups = new Map<string, ConversationReadChunk[]>();
  for (const chunk of chunks) {
    const group = groups.get(chunk.entryId) ?? []; group.push(chunk); groups.set(chunk.entryId, group);
  }
  return [...groups.values()].map((group) => ({ entry_id: group[0]!.entryId, ordinal: group[0]!.ordinal,
    last_ordinal: group.at(-1)!.ordinal, chunk_count: group.length, first_byte: Math.min(...group.map((chunk) => chunk.sourceByteStart)) }));
}
