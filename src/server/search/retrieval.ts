import type { SearchCounts } from "../../shared/search.js";
import { SEARCH_EMBEDDING_DIMENSIONS } from "./config.js";
import { SearchRepositoryDatabase, type SearchRepositoryOptions } from "./database.js";
import { SearchQueryError, SearchRepositoryError } from "./errors.js";
import { isWellFormedText, MAX_SESSION_SNAPSHOT_BYTES } from "./extract.js";
import { MAX_CHUNK_CHARACTERS, MAX_CHUNK_UTF8_BYTES } from "./chunk.js";
import type { SearchDatabasePool } from "./migrations.js";
import { MAX_SEARCH_TITLE_BYTES, type SearchRepositoryScope } from "./repository.js";

export const MAX_SEARCH_QUERY_CHARACTERS = 2048;
export const MAX_SEARCH_QUERY_BYTES = 8192;
export const MAX_SEARCH_CANDIDATES = 100;
export const MAX_SEARCH_CONCURRENT_QUERIES = 2;

export function validateSearchQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || !isWellFormedText(value) ||
      value.length > MAX_SEARCH_QUERY_CHARACTERS * 2 || [...value].length > MAX_SEARCH_QUERY_CHARACTERS || Buffer.byteLength(value) > MAX_SEARCH_QUERY_BYTES) {
    throw new SearchQueryError("search_query_invalid");
  }
  return value;
}
export interface SearchCandidate extends SearchRepositoryScope {
  readonly chunkId: string;
  readonly sessionId: string;
  readonly workspaceName: string;
  readonly title: string;
  readonly modifiedAt: number;
  readonly indexedAt: number;
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly timestamp: number;
  readonly sourceByteStart: number;
  readonly sourceByteEnd: number;
  readonly text: string;
}
export interface SearchQueryVector { readonly spaceSignature: string; readonly embedding: readonly number[] }
export interface SearchRetrievalRequest {
  readonly query: string;
  readonly scopes: readonly SearchRepositoryScope[];
  readonly candidateLimit: number;
  readonly vector?: SearchQueryVector;
}
export interface SearchRetrievedCandidates { readonly lexical: readonly SearchCandidate[]; readonly vector: readonly SearchCandidate[] }
export interface SearchRetrievalRepository {
  retrieve(request: SearchRetrievalRequest, options?: SearchRepositoryOptions): Promise<SearchRetrievedCandidates>;
}

const COLUMNS = `c.id AS chunk_id, d.workspace_id, d.source_revision, d.session_id, w.display_name AS workspace_name,
  d.title, d.modified_at, d.indexed_at, c.entry_id, c.role, c.entry_timestamp, c.source_byte_start, c.source_byte_end, c.original_text`;
const JOINS = `FROM search_chunks c JOIN search_documents d ON d.id = c.document_id
  JOIN search_workspaces w ON w.workspace_id = d.workspace_id
  JOIN jsonb_to_recordset($1::jsonb) AS s(workspace_id text, source_revision text)
    ON s.workspace_id = d.workspace_id AND s.source_revision = d.source_revision AND s.source_revision = w.source_revision`;
function invalid(): never { throw new SearchQueryError("search_query_invalid"); }
function id(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}
function text(value: unknown, maxBytes: number): string {
  if (typeof value !== "string" || value.includes("\0") || !isWellFormedText(value) || Buffer.byteLength(value) > maxBytes) invalid();
  return value;
}
function time(value: unknown): number {
  if (!(value instanceof Date) || !Number.isSafeInteger(value.getTime()) || value.getTime() < 0) invalid();
  return value.getTime();
}
function offset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_SESSION_SNAPSHOT_BYTES) invalid();
  return value;
}
function decode(rows: Record<string, unknown>[], request: SearchRetrievalRequest): SearchCandidate[] {
  try {
    if (rows.length > request.candidateLimit) invalid();
    const ids = new Set<string>();
    return rows.map((row) => {
      if (typeof row.chunk_id !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(row.chunk_id) || ids.has(row.chunk_id)) invalid();
      ids.add(row.chunk_id);
      const workspaceId = id(row.workspace_id); const sourceRevision = hash(row.source_revision);
      if (!request.scopes.some((scope) => scope.workspaceId === workspaceId && scope.sourceRevision === sourceRevision)) invalid();
      const start = offset(row.source_byte_start); const end = offset(row.source_byte_end);
      const original = text(row.original_text, MAX_CHUNK_UTF8_BYTES);
      if (!original || [...original].length > MAX_CHUNK_CHARACTERS || end - start !== Buffer.byteLength(original) || (row.role !== "user" && row.role !== "assistant")) invalid();
      return { chunkId: row.chunk_id, workspaceId, sourceRevision, sessionId: id(row.session_id), workspaceName: text(row.workspace_name, 2048),
        title: text(row.title, MAX_SEARCH_TITLE_BYTES), modifiedAt: time(row.modified_at), indexedAt: time(row.indexed_at), entryId: id(row.entry_id),
        role: row.role, timestamp: time(row.entry_timestamp), sourceByteStart: start, sourceByteEnd: end, text: original };
    });
  } catch { throw new SearchRepositoryError("search_database_unavailable"); }
}

/** Read-only exact retrieval. Separate admission slots never contend with the maintenance repository. */
export class PostgresSearchRetrieval implements SearchRetrievalRepository {
  private readonly slots: { database: SearchRepositoryDatabase; busy: boolean }[];
  private closed = false;
  constructor(pool: SearchDatabasePool, timeoutMs?: number) {
    this.slots = Array.from({ length: MAX_SEARCH_CONCURRENT_QUERIES }, () => ({ database: new SearchRepositoryDatabase(pool, timeoutMs), busy: false }));
  }
  close(): void { this.closed = true; for (const slot of this.slots) slot.database.close(); }

  async readCounts(scopes: readonly SearchRepositoryScope[], options: SearchRepositoryOptions = {}): Promise<SearchCounts> {
    if (this.closed || options.signal?.aborted) throw new SearchRepositoryError("search_cancelled");
    const seen = new Set<string>();
    const filter = scopes.map((scope) => {
      const workspaceId = id(scope.workspaceId);
      if (seen.has(workspaceId)) invalid();
      seen.add(workspaceId);
      return { workspace_id: workspaceId, source_revision: hash(scope.sourceRevision) };
    });
    if (!filter.length) return { documents: 0, chunks: 0 };
    const slot = this.slots.find((slot) => !slot.busy);
    if (!slot) throw new SearchRepositoryError("search_busy");
    slot.busy = true;
    const parameter = JSON.stringify(filter);
    try {
      return await slot.database.transaction(async (tx) => {
        const result = await tx.query(`SELECT coalesce(sum(w.document_count), 0)::text AS documents, coalesce(sum(w.chunk_count), 0)::text AS chunks
          FROM search_workspaces w JOIN jsonb_to_recordset($1::jsonb) AS s(workspace_id text, source_revision text)
          ON s.workspace_id = w.workspace_id AND s.source_revision = w.source_revision`, [parameter]);
        const row = result.rows[0];
        const count = (value: unknown): number => {
          if (typeof value !== "string" || !/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new SearchRepositoryError("search_database_unavailable");
          return Number(value);
        };
        if (result.rows.length !== 1) throw new SearchRepositoryError("search_database_unavailable");
        return { documents: count(row?.documents), chunks: count(row?.chunks) };
      }, options.signal ? { signal: options.signal } : {}, true);
    } finally { slot.busy = false; }
  }

  async retrieve(request: SearchRetrievalRequest, options: SearchRepositoryOptions = {}): Promise<SearchRetrievedCandidates> {
    if (this.closed || options.signal?.aborted) throw new SearchRepositoryError("search_cancelled");
    if (!request || typeof request !== "object") invalid();
    const query = validateSearchQuery(request.query);
    if (!Number.isSafeInteger(request.candidateLimit) || request.candidateLimit < 1 || request.candidateLimit > MAX_SEARCH_CANDIDATES || !Array.isArray(request.scopes)) invalid();
    const seen = new Set<string>();
    const scopes = request.scopes.map((scope) => {
      if (!scope || seen.has(id(scope.workspaceId))) invalid();
      seen.add(scope.workspaceId);
      return { workspace_id: scope.workspaceId, source_revision: hash(scope.sourceRevision) };
    });
    let vector: string | undefined;
    if (request.vector !== undefined) {
      if (!request.vector || typeof request.vector !== "object") invalid();
      hash(request.vector.spaceSignature);
      const values = request.vector.embedding;
      if (!Array.isArray(values) || values.length !== SEARCH_EMBEDDING_DIMENSIONS || values.some((value) => typeof value !== "number" || !Number.isFinite(value)) ||
          Math.abs(values.reduce((sum, value) => sum + value * value, 0) - 1) > 0.0001) invalid();
      vector = `[${values.join(",")}]`;
    }
    if (!scopes.length) return { lexical: [], vector: [] };
    const slot = this.slots.find((slot) => !slot.busy);
    if (!slot) throw new SearchRepositoryError("search_busy");
    slot.busy = true;
    // Snapshot caller-owned arrays before awaits; no registration or source IO in the transaction.
    const snapshot = { ...request, scopes: scopes.map((scope) => ({ workspaceId: scope.workspace_id, sourceRevision: scope.source_revision })) };
    const parameters = [JSON.stringify(scopes), query, request.candidateLimit];
    const signature = request.vector?.spaceSignature;
    try {
      return await slot.database.transaction(async (tx) => {
        const lexical = await tx.query(`WITH q AS (SELECT plainto_tsquery('english', $2) AS english, plainto_tsquery('simple', $2) AS simple)
          SELECT ${COLUMNS} ${JOINS} CROSS JOIN q
          WHERE c.search_english @@ q.english OR c.search_simple @@ q.simple
          ORDER BY GREATEST(ts_rank_cd(c.search_english, q.english), ts_rank_cd(c.search_simple, q.simple)) DESC, c.id ASC LIMIT $3`, parameters);
        const semantic = vector === undefined ? [] : (await tx.query(`SELECT ${COLUMNS} ${JOINS}
          WHERE c.embedding_space_signature = $2 AND d.embedding_space_signature = $2
          ORDER BY c.embedding <=> $3::vector, c.id ASC LIMIT $4`, [parameters[0], signature, vector, snapshot.candidateLimit])).rows;
        return { lexical: decode(lexical.rows, snapshot), vector: decode(semantic, snapshot) };
      }, options.signal ? { signal: options.signal } : {}, true);
    } finally { slot.busy = false; }
  }
}
