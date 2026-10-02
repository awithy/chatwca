import { randomUUID } from "node:crypto";
import { chunkMessages } from "../../src/server/search/chunk.js";
import { extractSession, searchHash } from "../../src/server/search/extract.js";
import type { SearchDocumentPublication, SearchRepositoryWorkspace } from "../../src/server/search/repository.js";
import { createEmbeddingSpace, searchProcessingSignature } from "../../src/server/search/signatures.js";
import { FAKE_EMBEDDING_DIGEST, FAKE_EMBEDDING_MODEL, fakeSearchVector } from "./search-ollama.js";
import { searchSessionHeader, searchUserEntry } from "./search-session.js";

export const REPOSITORY_WORKSPACE: SearchRepositoryWorkspace = {
  workspaceId: "synthetic-workspace", sourceRevision: searchHash("synthetic-revision"),
  displayName: "Synthetic Workspace", canonicalPath: "/synthetic/workspace", sessionDirectory: "/synthetic/sessions",
};
export const REPOSITORY_SPACE = createEmbeddingSpace(FAKE_EMBEDDING_MODEL, FAKE_EMBEDDING_DIGEST);

export function searchPublication(texts = ["Synthetic searchable dialogue"], overrides: Partial<SearchDocumentPublication> = {}): SearchDocumentPublication {
  const session = extractSession([searchSessionHeader(), ...texts.map((text, index) => searchUserEntry(`entry-${index}`, index ? `entry-${index - 1}` : null, text))]);
  return {
    workspaceId: REPOSITORY_WORKSPACE.workspaceId, sourceRevision: REPOSITORY_WORKSPACE.sourceRevision,
    sessionId: session.header.id, expected: null, sourcePath: "/synthetic/sessions/conversation.jsonl",
    fingerprint: { device: "1", inode: "2", size: "1234", mtimeNs: "1700000000000000001", ctimeNs: "1700000000000000002" },
    title: session.title, createdAt: session.header.timestamp, modifiedAt: session.modifiedAt, savedLeafId: session.savedLeafId,
    snapshotHash: searchHash("synthetic-snapshot"), extractedContentHash: session.extractedContentHash,
    processingSignature: searchProcessingSignature(REPOSITORY_SPACE), embeddingSpaceSignature: REPOSITORY_SPACE.signature,
    scanId: randomUUID(), chunks: chunkMessages(session.messages).map((chunk) => ({ ...chunk, embedding: fakeSearchVector(0.6, 0.8) })),
    ...overrides,
  };
}
