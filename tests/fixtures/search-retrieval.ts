import { REPOSITORY_WORKSPACE } from "./search-repository.js";
import type { SearchCandidate } from "../../src/server/search/retrieval.js";

export function searchCandidate(index = 1, overrides: Partial<SearchCandidate> = {}): SearchCandidate {
  const text = "Synthetic searchable dialogue";
  return { workspaceId: REPOSITORY_WORKSPACE.workspaceId, sourceRevision: REPOSITORY_WORKSPACE.sourceRevision,
    chunkId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, sessionId: `session-${index}`,
    workspaceName: "Synthetic Workspace", title: "Synthetic title", modifiedAt: 1700000000000, indexedAt: 1700000000100,
    entryId: `entry-${index}`, role: "user", timestamp: 1700000000000, sourceByteStart: 0, sourceByteEnd: Buffer.byteLength(text), text, ...overrides };
}
export function searchCandidateRow(candidate = searchCandidate()): Record<string, unknown> {
  return { chunk_id: candidate.chunkId, workspace_id: candidate.workspaceId, source_revision: candidate.sourceRevision,
    session_id: candidate.sessionId, workspace_name: candidate.workspaceName, title: candidate.title, modified_at: new Date(candidate.modifiedAt),
    indexed_at: new Date(candidate.indexedAt), entry_id: candidate.entryId, role: candidate.role, entry_timestamp: new Date(candidate.timestamp),
    source_byte_start: candidate.sourceByteStart, source_byte_end: candidate.sourceByteEnd, original_text: candidate.text };
}
