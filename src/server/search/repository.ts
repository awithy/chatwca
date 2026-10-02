import { randomUUID } from "node:crypto";
import path from "node:path";
import { documentEmbeddingInput, MAX_CHUNK_CHARACTERS, MAX_CHUNK_UTF8_BYTES, MAX_CONVERSATION_CHUNKS, type SearchChunk } from "./chunk.js";
import { SEARCH_EMBEDDING_DIMENSIONS } from "./config.js";
import { SearchRepositoryDatabase, type SearchRepositoryOptions, type SearchRepositoryTransaction } from "./database.js";
import { SearchRepositoryError } from "./errors.js";
import { isWellFormedText, MAX_SESSION_SNAPSHOT_BYTES, searchHash } from "./extract.js";
import type { SearchDatabasePool } from "./migrations.js";
import type { SourceFingerprint } from "./session-source.js";

export const MAX_SEARCH_TITLE_BYTES = 16 * 1024;
export const MAX_SEARCH_PUBLICATION_BYTES = 256 * 1024 * 1024;
export const MAX_SEARCH_CHUNK_WRITE_BYTES = 1024 * 1024;
export const MAX_SEARCH_CHUNK_WRITE_BATCH = 64;
export const MAX_SEARCH_REUSE_HASHES = 128;
export const MAX_SEARCH_CHECKPOINT_PAGE = 64;

export interface SearchRepositoryScope {
  readonly workspaceId: string;
  readonly sourceRevision: string;
}
export interface SearchRepositoryWorkspace extends SearchRepositoryScope {
  readonly displayName: string;
  readonly canonicalPath: string;
  readonly sessionDirectory: string;
}
export interface SearchWorkspacePageRequest {
  readonly limit?: number;
  readonly afterWorkspaceId?: string | null;
}
export interface SearchWorkspacePage {
  readonly workspaces: readonly SearchRepositoryWorkspace[];
  readonly nextAfterWorkspaceId: string | null;
}
export interface SearchDocumentVersion {
  readonly documentId: string;
  /** Exact PostgreSQL bigint text, never a lossy JS number. */
  readonly generation: string;
}
export interface SearchDocumentCheckpoint extends SearchDocumentVersion, SearchRepositoryScope {
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly fingerprint: SourceFingerprint;
  readonly title: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly savedLeafId: string | null;
  readonly snapshotHash: string;
  readonly extractedContentHash: string;
  readonly processingSignature: string;
  readonly embeddingSpaceSignature: string;
  readonly lastSeenScanId: string;
}
export interface SearchCheckpointPageRequest {
  readonly limit?: number;
  readonly afterSessionId?: string | null;
  /** Exact server-only path filter. A path can have multiple prior session identities. */
  readonly sourcePath?: string;
}
export interface SearchCheckpointPage {
  readonly checkpoints: readonly SearchDocumentCheckpoint[];
  readonly nextAfterSessionId: string | null;
}
export interface SearchDocumentPublication extends SearchRepositoryScope {
  readonly sessionId: string;
  readonly expected: SearchDocumentVersion | null;
  readonly sourcePath: string;
  readonly fingerprint: SourceFingerprint;
  readonly title: string;
  readonly createdAt: number;
  readonly modifiedAt: number;
  readonly savedLeafId: string | null;
  readonly snapshotHash: string;
  readonly extractedContentHash: string;
  readonly processingSignature: string;
  readonly embeddingSpaceSignature: string;
  readonly scanId: string;
  readonly chunks: readonly (SearchChunk & { readonly embedding: readonly number[] })[];
}

/** Exact observed generation/path, not authority to delete by session ID alone. */
export type SearchDocumentDeletion = Pick<SearchDocumentCheckpoint, "workspaceId" | "sourceRevision" | "sessionId" | "sourcePath" | "documentId" | "generation">;

/** Derived-index boundary for the future indexer. No source IO or embedding calls. */
export interface SearchIndexRepository {
  /** Derived metadata only, never registration authority. */
  readWorkspace(workspaceId: string, options?: SearchRepositoryOptions): Promise<SearchRepositoryWorkspace | null>;
  /** Derived registrations for restart-safe removal of unregistered workspace caches. */
  readWorkspacePage(request?: SearchWorkspacePageRequest, options?: SearchRepositoryOptions): Promise<SearchWorkspacePage>;
  synchronizeWorkspace(workspace: SearchRepositoryWorkspace, expectedRevision: string | null, options?: SearchRepositoryOptions): Promise<void>;
  readCheckpoint(scope: SearchRepositoryScope, sessionId: string, options?: SearchRepositoryOptions): Promise<SearchDocumentCheckpoint | null>;
  /** Fresh scoped keyset page, not a cross-page snapshot or authority for absence pruning. */
  readCheckpointPage(scope: SearchRepositoryScope, request?: SearchCheckpointPageRequest, options?: SearchRepositoryOptions): Promise<SearchCheckpointPage>;
  readReusableEmbeddings(checkpoint: SearchDocumentCheckpoint, spaceSignature: string, inputHashes: readonly string[], options?: SearchRepositoryOptions): Promise<ReadonlyMap<string, readonly number[]>>;
  publishDocument(publication: SearchDocumentPublication, options?: SearchRepositoryOptions): Promise<SearchDocumentVersion>;
  markDocumentSeen(checkpoint: SearchDocumentCheckpoint, scanId: string, options?: SearchRepositoryOptions): Promise<void>;
  /** Explicit current-session removal; delayed cleanup must use deleteDocumentVersion instead. */
  deleteDocument(scope: SearchRepositoryScope, sessionId: string, options?: SearchRepositoryOptions): Promise<boolean>;
  deleteDocumentVersion(expected: SearchDocumentDeletion, options?: SearchRepositoryOptions): Promise<boolean>;
  deleteWorkspace(scope: SearchRepositoryScope, options?: SearchRepositoryOptions): Promise<boolean>;
}

function invalid(): never { throw new SearchRepositoryError("search_index_invalid"); }
function changed(): never { throw new SearchRepositoryError("search_source_changed"); }
function text(value: unknown, maximum: number, empty = false): string {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.includes("\0") || !isWellFormedText(value)) invalid();
  if (value.length > maximum || Buffer.byteLength(value) > maximum) throw new SearchRepositoryError("search_session_limit");
  return value;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) invalid();
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) invalid();
  return value;
}
function uuid(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(value)) invalid();
  return value;
}
function integer(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid();
  return value;
}
function timestamp(value: unknown): number {
  return integer(value, 8_640_000_000_000_000);
}
function sourcePath(value: unknown): string {
  const result = text(value, 4096);
  if (!path.isAbsolute(result) || path.normalize(result) !== result) invalid();
  return result;
}
function scope(value: SearchRepositoryScope): SearchRepositoryScope {
  if (!value || typeof value !== "object") invalid();
  return { workspaceId: identifier(value.workspaceId), sourceRevision: hash(value.sourceRevision) };
}
function version(value: SearchDocumentVersion): SearchDocumentVersion {
  if (!value || typeof value !== "object") invalid();
  if (typeof value.generation !== "string" || !/^[1-9]\d{0,18}$/u.test(value.generation) || BigInt(value.generation) > 9223372036854775807n) invalid();
  return { documentId: uuid(value.documentId), generation: value.generation };
}
function fingerprint(value: SourceFingerprint): SourceFingerprint {
  if (!value || typeof value !== "object") invalid();
  const numeric = (part: unknown, signed: boolean): string => {
    if (typeof part !== "string" || !(signed ? /^-?\d{1,30}$/u : /^\d{1,30}$/u).test(part)) invalid();
    return part;
  };
  const size = numeric(value.size, false);
  if (BigInt(size) > BigInt(MAX_SESSION_SNAPSHOT_BYTES)) throw new SearchRepositoryError("search_session_limit");
  return { device: numeric(value.device, false), inode: numeric(value.inode, false), size, mtimeNs: numeric(value.mtimeNs, true), ctimeNs: numeric(value.ctimeNs, true) };
}
function embedding(value: unknown): readonly number[] {
  if (!Array.isArray(value) || value.length !== SEARCH_EMBEDDING_DIMENSIONS) invalid();
  let norm = 0;
  for (const element of value) {
    if (typeof element !== "number" || !Number.isFinite(element)) invalid();
    norm += element * element;
  }
  // pgvector stores float32; allow its rounding, not unnormalized/zero vectors.
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.0001) invalid();
  return value as number[];
}
function count(row: Record<string, unknown> | undefined): number {
  if (typeof row?.count !== "string" || !/^\d+$/u.test(row.count)) invalid();
  return integer(Number(row.count), MAX_CONVERSATION_CHUNKS);
}
const CHECKPOINT_COLUMNS = `d.id AS document_id, d.generation::text AS generation, d.workspace_id, d.source_revision,
  d.session_id, d.source_path, d.source_device, d.source_inode, d.source_size::text AS source_size,
  d.source_mtime_ns::text AS source_mtime_ns, d.source_ctime_ns::text AS source_ctime_ns,
  d.title, d.created_at, d.modified_at, d.saved_leaf_id, d.snapshot_hash, d.extracted_content_hash,
  d.processing_signature, d.embedding_space_signature, d.last_seen_scan_id`;

function workspaceRow(row: Record<string, unknown>): SearchRepositoryWorkspace {
  return { ...scope({ workspaceId: row.workspace_id as string, sourceRevision: row.source_revision as string }),
    displayName: text(row.display_name, 2048), canonicalPath: sourcePath(row.canonical_path), sessionDirectory: sourcePath(row.session_directory) };
}

function checkpoint(row: Record<string, unknown>): SearchDocumentCheckpoint {
  const time = (value: unknown): number => {
    if (!(value instanceof Date)) invalid();
    return timestamp(value.getTime());
  };
  return {
    ...version({ documentId: row.document_id as string, generation: row.generation as string }),
    ...scope({ workspaceId: row.workspace_id as string, sourceRevision: row.source_revision as string }),
    sessionId: identifier(row.session_id), sourcePath: sourcePath(row.source_path),
    fingerprint: fingerprint({ device: row.source_device as string, inode: row.source_inode as string, size: row.source_size as string, mtimeNs: row.source_mtime_ns as string, ctimeNs: row.source_ctime_ns as string }),
    title: text(row.title, MAX_SEARCH_TITLE_BYTES, true), createdAt: time(row.created_at), modifiedAt: time(row.modified_at),
    savedLeafId: row.saved_leaf_id === "" ? null : identifier(row.saved_leaf_id),
    snapshotHash: hash(row.snapshot_hash), extractedContentHash: hash(row.extracted_content_hash),
    processingSignature: hash(row.processing_signature), embeddingSpaceSignature: hash(row.embedding_space_signature),
    lastSeenScanId: uuid(row.last_seen_scan_id),
  };
}

interface PreparedPublication {
  readonly metadata: Omit<SearchDocumentPublication, "chunks">;
  readonly batches: readonly string[];
  readonly keys: readonly string[];
}
function prepare(publication: SearchDocumentPublication): PreparedPublication {
  if (!publication || typeof publication !== "object") invalid();
  const metadata: Omit<SearchDocumentPublication, "chunks"> = {
    ...scope(publication), sessionId: identifier(publication.sessionId),
    expected: publication.expected === null ? null : version(publication.expected),
    sourcePath: sourcePath(publication.sourcePath), fingerprint: fingerprint(publication.fingerprint),
    title: text(publication.title, MAX_SEARCH_TITLE_BYTES, true), createdAt: timestamp(publication.createdAt), modifiedAt: timestamp(publication.modifiedAt),
    savedLeafId: publication.savedLeafId === null ? null : identifier(publication.savedLeafId),
    snapshotHash: hash(publication.snapshotHash), extractedContentHash: hash(publication.extractedContentHash),
    processingSignature: hash(publication.processingSignature), embeddingSpaceSignature: hash(publication.embeddingSpaceSignature), scanId: uuid(publication.scanId),
  };
  if (!Array.isArray(publication.chunks) || publication.chunks.length > MAX_CONVERSATION_CHUNKS) throw new SearchRepositoryError("search_session_limit");
  if (metadata.savedLeafId === null && publication.chunks.length !== 0) invalid();
  const keys: string[] = [];
  const unique = new Set<string>();
  const batches: string[] = [];
  let batch: string[] = [];
  let batchBytes = 2;
  let totalBytes = Buffer.byteLength(metadata.title) * (publication.chunks.length + 1);
  for (const [ordinal, chunk] of publication.chunks.entries()) {
    if (!chunk || typeof chunk !== "object") invalid();
    const key = text(chunk.stableKey, 512);
    if (unique.has(key) || chunk.ordinal !== ordinal) invalid();
    unique.add(key); keys.push(key);
    integer(chunk.splitOrdinal, MAX_CONVERSATION_CHUNKS);
    if (chunk.role !== "user" && chunk.role !== "assistant") invalid();
    const quoted = text(chunk.text, MAX_CHUNK_UTF8_BYTES);
    if ([...quoted].length > MAX_CHUNK_CHARACTERS) invalid();
    const start = integer(chunk.sourceByteStart, MAX_SESSION_SNAPSHOT_BYTES);
    const end = integer(chunk.sourceByteEnd, MAX_SESSION_SNAPSHOT_BYTES);
    if (end - start !== Buffer.byteLength(quoted)) invalid();
    const input = text(chunk.embeddingInput, 16 * 1024);
    if (input !== documentEmbeddingInput(chunk.role, quoted) || hash(chunk.textHash) !== searchHash(quoted) || hash(chunk.embeddingInputHash) !== searchHash(input)) invalid();
    const row = JSON.stringify({
      stable_key: key, ordinal, entry_id: identifier(chunk.entryId), role: chunk.role,
      entry_timestamp: new Date(timestamp(chunk.timestamp)).toISOString(), source_byte_start: start, source_byte_end: end,
      original_text: quoted, text_hash: chunk.textHash, embedding_input_hash: chunk.embeddingInputHash,
      embedding: `[${embedding(chunk.embedding).join(",")}]`,
    });
    const bytes = Buffer.byteLength(row) + 1;
    totalBytes += bytes;
    if (totalBytes > MAX_SEARCH_PUBLICATION_BYTES) throw new SearchRepositoryError("search_session_limit");
    if (bytes + 2 > MAX_SEARCH_CHUNK_WRITE_BYTES) throw new SearchRepositoryError("search_session_limit");
    if (batch.length && (batch.length >= MAX_SEARCH_CHUNK_WRITE_BATCH || batchBytes + bytes > MAX_SEARCH_CHUNK_WRITE_BYTES)) {
      batches.push(`[${batch.join(",")}]`); batch = []; batchBytes = 2;
    }
    batch.push(row); batchBytes += bytes;
  }
  if (batch.length) batches.push(`[${batch.join(",")}]`);
  return { metadata, batches, keys };
}

/** Serialized-worker maintenance repository; PostgreSQL never establishes source authority. */
export class PostgresSearchRepository implements SearchIndexRepository {
  private readonly database: SearchRepositoryDatabase;
  constructor(pool: SearchDatabasePool, timeoutMs?: number) { this.database = new SearchRepositoryDatabase(pool, timeoutMs); }
  close(): void { this.database.close(); }

  async readWorkspace(workspaceId: string, options: SearchRepositoryOptions = {}): Promise<SearchRepositoryWorkspace | null> {
    workspaceId = identifier(workspaceId);
    return this.database.transaction(async (tx) => {
      const result = await tx.query("SELECT workspace_id, source_revision, display_name, canonical_path, session_directory FROM search_workspaces WHERE workspace_id = $1", [workspaceId]);
      if (!result.rows.length) return null;
      if (result.rows.length !== 1) throw new SearchRepositoryError("search_database_unavailable");
      return this.decode(() => workspaceRow(result.rows[0]!));
    }, options, true);
  }

  async readWorkspacePage(request: SearchWorkspacePageRequest = {}, options: SearchRepositoryOptions = {}): Promise<SearchWorkspacePage> {
    if (!request || typeof request !== "object") invalid();
    const limit = request.limit === undefined ? MAX_SEARCH_CHECKPOINT_PAGE : integer(request.limit, MAX_SEARCH_CHECKPOINT_PAGE);
    if (limit === 0) invalid();
    const after = request.afterWorkspaceId == null ? "" : identifier(request.afterWorkspaceId);
    return this.database.transaction(async (tx) => {
      const result = await tx.query(`SELECT workspace_id, source_revision, display_name, canonical_path, session_directory FROM search_workspaces
        WHERE workspace_id COLLATE "C" > $1::text COLLATE "C" ORDER BY workspace_id COLLATE "C" LIMIT $2`, [after, limit + 1]);
      return this.decode(() => {
        if (result.rows.length > limit + 1) invalid();
        let last = after;
        const rows = result.rows.map((row) => {
          const workspace = workspaceRow(row);
          if (workspace.workspaceId <= last) invalid();
          last = workspace.workspaceId;
          return Object.freeze(workspace);
        });
        const workspaces = Object.freeze(rows.slice(0, limit));
        return Object.freeze({ workspaces, nextAfterWorkspaceId: rows.length > limit ? workspaces.at(-1)!.workspaceId : null });
      });
    }, options, true);
  }

  async synchronizeWorkspace(workspace: SearchRepositoryWorkspace, expectedRevision: string | null, options: SearchRepositoryOptions = {}): Promise<void> {
    const target = { ...scope(workspace), displayName: text(workspace.displayName, 2048), canonicalPath: sourcePath(workspace.canonicalPath), sessionDirectory: sourcePath(workspace.sessionDirectory) };
    if (expectedRevision !== null) hash(expectedRevision);
    return this.database.transaction(async (tx) => {
      if (expectedRevision === null) {
        const result = await tx.query(`INSERT INTO search_workspaces (workspace_id, source_revision, display_name, canonical_path, session_directory)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (workspace_id) DO NOTHING RETURNING workspace_id`,
        [target.workspaceId, target.sourceRevision, target.displayName, target.canonicalPath, target.sessionDirectory]);
        if (result.rows.length !== 1) changed();
        return;
      }
      const current = await this.lockScope(tx, { workspaceId: target.workspaceId, sourceRevision: expectedRevision });
      if (expectedRevision === target.sourceRevision && (current.canonical_path !== target.canonicalPath || current.session_directory !== target.sessionDirectory)) invalid();
      if (expectedRevision !== target.sourceRevision) {
        await tx.query("DELETE FROM search_documents WHERE workspace_id = $1", [target.workspaceId]);
        await tx.query(`UPDATE search_workspaces SET document_count = 0, chunk_count = 0, scan_state = 'pending',
          scan_id = NULL, last_scan_started_at = NULL, last_scan_succeeded_at = NULL, error_code = NULL WHERE workspace_id = $1`, [target.workspaceId]);
      } else if (current.display_name !== target.displayName) {
        await tx.query(`UPDATE search_chunks c SET lexical_workspace_name = $2 FROM search_documents d
          WHERE c.document_id = d.id AND d.workspace_id = $1`, [target.workspaceId, target.displayName]);
      }
      await tx.query("UPDATE search_workspaces SET source_revision = $2, display_name = $3, canonical_path = $4, session_directory = $5 WHERE workspace_id = $1",
        [target.workspaceId, target.sourceRevision, target.displayName, target.canonicalPath, target.sessionDirectory]);
    }, options);
  }

  async readCheckpoint(requested: SearchRepositoryScope, sessionId: string, options: SearchRepositoryOptions = {}): Promise<SearchDocumentCheckpoint | null> {
    const target = scope(requested); sessionId = identifier(sessionId);
    return this.database.transaction(async (tx) => {
      const result = await tx.query(`SELECT ${CHECKPOINT_COLUMNS} FROM search_documents d JOIN search_workspaces w ON w.workspace_id = d.workspace_id
        WHERE d.workspace_id = $1 AND d.source_revision = $2 AND w.source_revision = $2 AND d.session_id = $3`, [target.workspaceId, target.sourceRevision, sessionId]);
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) invalid();
      return this.decode(() => checkpoint(result.rows[0]!));
    }, options, true);
  }

  async readCheckpointPage(requested: SearchRepositoryScope, request: SearchCheckpointPageRequest = {}, options: SearchRepositoryOptions = {}): Promise<SearchCheckpointPage> {
    const target = scope(requested);
    if (!request || typeof request !== "object") invalid();
    const limit = request.limit === undefined ? MAX_SEARCH_CHECKPOINT_PAGE : integer(request.limit, MAX_SEARCH_CHECKPOINT_PAGE);
    if (limit === 0) invalid();
    const after = request.afterSessionId == null ? "" : identifier(request.afterSessionId);
    const exactPath = request.sourcePath === undefined ? undefined : sourcePath(request.sourcePath);
    return this.database.transaction(async (tx) => {
      const result = await tx.query(`SELECT ${CHECKPOINT_COLUMNS} FROM search_documents d JOIN search_workspaces w ON w.workspace_id = d.workspace_id
        WHERE d.workspace_id = $1 AND d.source_revision = $2 AND w.source_revision = $2
        AND d.session_id COLLATE "C" > $3::text COLLATE "C"
        ${exactPath === undefined ? "" : "AND md5(d.source_path) = md5($5::text) AND d.source_path = $5"}
        ORDER BY d.session_id COLLATE "C" LIMIT $4`,
      exactPath === undefined ? [target.workspaceId, target.sourceRevision, after, limit + 1] : [target.workspaceId, target.sourceRevision, after, limit + 1, exactPath]);
      return this.decode(() => {
        if (result.rows.length > limit + 1) invalid();
        let last = after;
        const rows = result.rows.map((row) => {
          const saved = checkpoint(row);
          // Session IDs are ASCII; JS ordering therefore matches PostgreSQL C collation.
          if (saved.workspaceId !== target.workspaceId || saved.sourceRevision !== target.sourceRevision || saved.sessionId <= last || (exactPath !== undefined && saved.sourcePath !== exactPath)) invalid();
          last = saved.sessionId;
          return saved;
        });
        const hasMore = rows.length > limit;
        const checkpoints = Object.freeze(rows.slice(0, limit));
        return Object.freeze({ checkpoints, nextAfterSessionId: hasMore ? checkpoints.at(-1)!.sessionId : null });
      });
    }, options, true);
  }

  async readReusableEmbeddings(previous: SearchDocumentCheckpoint, spaceSignature: string, inputHashes: readonly string[], options: SearchRepositoryOptions = {}): Promise<ReadonlyMap<string, readonly number[]>> {
    const target = scope(previous); const expected = version(previous); spaceSignature = hash(spaceSignature);
    if (!Array.isArray(inputHashes) || inputHashes.length > MAX_SEARCH_REUSE_HASHES) throw new SearchRepositoryError("search_session_limit");
    const inputs = [...new Set([...inputHashes].map(hash))];
    return this.database.transaction(async (tx) => {
      const result = await tx.query(`SELECT DISTINCT ON (c.embedding_input_hash) c.embedding_input_hash, c.embedding::text AS embedding
        FROM search_chunks c JOIN search_documents d ON d.id = c.document_id JOIN search_workspaces w ON w.workspace_id = d.workspace_id
        WHERE d.workspace_id = $1 AND d.source_revision = $2 AND w.source_revision = $2 AND d.id = $3 AND d.generation = $4::bigint
        AND c.embedding_space_signature = $5 AND d.embedding_space_signature = $5 AND c.embedding_input_hash = ANY($6::text[])
        ORDER BY c.embedding_input_hash, c.id LIMIT $7`, [target.workspaceId, target.sourceRevision, expected.documentId, expected.generation, spaceSignature, inputs, inputs.length]);
      return this.decode(() => {
        const vectors = new Map<string, readonly number[]>();
        for (const row of result.rows) {
          const key = hash(row.embedding_input_hash);
          if (!inputs.includes(key) || vectors.has(key) || typeof row.embedding !== "string" || row.embedding.length > 64 * 1024) invalid();
          vectors.set(key, Object.freeze([...embedding(JSON.parse(row.embedding) as unknown)]));
        }
        return vectors;
      });
    }, options, true);
  }

  async publishDocument(publication: SearchDocumentPublication, options: SearchRepositoryOptions = {}): Promise<SearchDocumentVersion> {
    const { metadata: target, batches, keys } = prepare(publication);
    return this.database.transaction(async (tx) => {
      const workspace = await this.lockScope(tx, target);
      if (Buffer.byteLength(workspace.display_name as string) * keys.length + batches.reduce((size, batch) => size + Buffer.byteLength(batch), 0) + Buffer.byteLength(target.title) * (keys.length + 1) > MAX_SEARCH_PUBLICATION_BYTES) {
        throw new SearchRepositoryError("search_session_limit");
      }
      const current = await tx.query("SELECT id AS document_id, generation::text AS generation FROM search_documents WHERE workspace_id = $1 AND session_id = $2 FOR UPDATE", [target.workspaceId, target.sessionId]);
      const old = current.rows.length ? this.decode(() => version({ documentId: current.rows[0]!.document_id as string, generation: current.rows[0]!.generation as string })) : null;
      if (old?.documentId !== target.expected?.documentId || old?.generation !== target.expected?.generation) changed();
      const documentId = old?.documentId ?? randomUUID();
      const oldCount = old ? await this.chunkCount(tx, documentId) : 0;
      const values = [documentId, target.workspaceId, target.sessionId, target.sourceRevision, target.sourcePath, target.fingerprint.device, target.fingerprint.inode,
        target.fingerprint.size, target.fingerprint.mtimeNs, target.fingerprint.ctimeNs, target.title, new Date(target.createdAt).toISOString(), new Date(target.modifiedAt).toISOString(),
        target.savedLeafId ?? "", target.snapshotHash, target.extractedContentHash, target.processingSignature, target.embeddingSpaceSignature, target.scanId];
      const document = await tx.query(`INSERT INTO search_documents (id, workspace_id, session_id, source_revision, source_path, source_device, source_inode,
        source_size, source_mtime_ns, source_ctime_ns, title, created_at, modified_at, saved_leaf_id, snapshot_hash, extracted_content_hash,
        processing_signature, embedding_space_signature, last_seen_scan_id, generation)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::numeric, $10::numeric, $11, $12::timestamptz, $13::timestamptz, $14, $15, $16, $17, $18, $19, 1)
        ON CONFLICT (workspace_id, session_id) DO UPDATE SET source_revision = EXCLUDED.source_revision, source_path = EXCLUDED.source_path,
          source_device = EXCLUDED.source_device, source_inode = EXCLUDED.source_inode, source_size = EXCLUDED.source_size, source_mtime_ns = EXCLUDED.source_mtime_ns,
          source_ctime_ns = EXCLUDED.source_ctime_ns, title = EXCLUDED.title, created_at = EXCLUDED.created_at, modified_at = EXCLUDED.modified_at,
          saved_leaf_id = EXCLUDED.saved_leaf_id, snapshot_hash = EXCLUDED.snapshot_hash, extracted_content_hash = EXCLUDED.extracted_content_hash,
          processing_signature = EXCLUDED.processing_signature, embedding_space_signature = EXCLUDED.embedding_space_signature,
          last_seen_scan_id = EXCLUDED.last_seen_scan_id, indexed_at = now(), generation = search_documents.generation + 1
        RETURNING id AS document_id, generation::text AS generation`, values);
      for (const batch of batches) {
        await tx.query(`INSERT INTO search_chunks (document_id, stable_key, ordinal, entry_id, role, entry_timestamp, source_byte_start, source_byte_end,
          original_text, text_hash, embedding_input_hash, embedding, embedding_space_signature, lexical_title, lexical_workspace_name)
          SELECT $1::uuid, r.stable_key, r.ordinal, r.entry_id, r.role, r.entry_timestamp, r.source_byte_start, r.source_byte_end,
            r.original_text, r.text_hash, r.embedding_input_hash, r.embedding::vector(1024), $3, $4, $5
          FROM jsonb_to_recordset($2::jsonb) AS r(stable_key text, ordinal integer, entry_id text, role text, entry_timestamp timestamptz,
            source_byte_start integer, source_byte_end integer, original_text text, text_hash text, embedding_input_hash text, embedding text)
          ON CONFLICT (document_id, stable_key) DO UPDATE SET ordinal = EXCLUDED.ordinal, entry_id = EXCLUDED.entry_id, role = EXCLUDED.role,
            entry_timestamp = EXCLUDED.entry_timestamp, source_byte_start = EXCLUDED.source_byte_start, source_byte_end = EXCLUDED.source_byte_end,
            original_text = EXCLUDED.original_text, text_hash = EXCLUDED.text_hash, embedding_input_hash = EXCLUDED.embedding_input_hash,
            embedding = EXCLUDED.embedding, embedding_space_signature = EXCLUDED.embedding_space_signature,
            lexical_title = EXCLUDED.lexical_title, lexical_workspace_name = EXCLUDED.lexical_workspace_name`,
        [documentId, batch, target.embeddingSpaceSignature, target.title, workspace.display_name]);
      }
      await tx.query("DELETE FROM search_chunks WHERE document_id = $1 AND NOT (stable_key = ANY($2::text[]))", [documentId, keys]);
      await this.adjustCounts(tx, target.workspaceId, old ? 0 : 1, keys.length - oldCount);
      if (document.rows.length !== 1) invalid();
      return this.decode(() => version({ documentId: document.rows[0]!.document_id as string, generation: document.rows[0]!.generation as string }));
    }, options);
  }

  async markDocumentSeen(previous: SearchDocumentCheckpoint, scanId: string, options: SearchRepositoryOptions = {}): Promise<void> {
    const target = scope(previous); const expected = version(previous); scanId = uuid(scanId);
    return this.database.transaction(async (tx) => {
      await this.lockScope(tx, target);
      const result = await tx.query(`UPDATE search_documents SET last_seen_scan_id = $5
        WHERE workspace_id = $1 AND source_revision = $2 AND id = $3 AND generation = $4::bigint RETURNING id`,
      [target.workspaceId, target.sourceRevision, expected.documentId, expected.generation, scanId]);
      if (result.rows.length !== 1) changed();
    }, options);
  }

  async deleteDocument(requested: SearchRepositoryScope, sessionId: string, options: SearchRepositoryOptions = {}): Promise<boolean> {
    const target = scope(requested); sessionId = identifier(sessionId);
    return this.database.transaction(async (tx) => {
      await this.lockScope(tx, target);
      const result = await tx.query("SELECT id FROM search_documents WHERE workspace_id = $1 AND source_revision = $2 AND session_id = $3", [target.workspaceId, target.sourceRevision, sessionId]);
      if (!result.rows.length) return false;
      const id = this.decode(() => uuid(result.rows[0]!.id));
      const chunks = await this.chunkCount(tx, id);
      await tx.query("DELETE FROM search_documents WHERE id = $1", [id]);
      await this.adjustCounts(tx, target.workspaceId, -1, -chunks);
      return true;
    }, options);
  }

  async deleteDocumentVersion(previous: SearchDocumentDeletion, options: SearchRepositoryOptions = {}): Promise<boolean> {
    const target = { ...scope(previous), ...version(previous), sessionId: identifier(previous.sessionId), sourcePath: sourcePath(previous.sourcePath) };
    return this.database.transaction(async (tx) => {
      // Serialize with publication/workspace replacement. Missing/replaced scopes and
      // changed document generations are safe no-ops, never a broader deletion retry.
      const workspace = await tx.query("SELECT workspace_id FROM search_workspaces WHERE workspace_id = $1 AND source_revision = $2 FOR UPDATE", [target.workspaceId, target.sourceRevision]);
      if (!workspace.rows.length) return false;
      if (workspace.rows.length !== 1) invalid();
      const values = [target.workspaceId, target.sourceRevision, target.sessionId, target.documentId, target.generation, target.sourcePath];
      const filter = "workspace_id = $1 AND source_revision = $2 AND session_id = $3 AND id = $4::uuid AND generation = $5::bigint AND source_path = $6";
      const document = await tx.query(`SELECT id FROM search_documents WHERE ${filter} FOR UPDATE`, values);
      if (!document.rows.length) return false;
      if (document.rows.length !== 1 || document.rows[0]!.id !== target.documentId) invalid();
      const chunks = await this.chunkCount(tx, target.documentId);
      const removed = await tx.query(`DELETE FROM search_documents WHERE ${filter} RETURNING id`, values);
      if (removed.rows.length !== 1 || removed.rows[0]!.id !== target.documentId) invalid();
      await this.adjustCounts(tx, target.workspaceId, -1, -chunks);
      return true;
    }, options);
  }

  async deleteWorkspace(requested: SearchRepositoryScope, options: SearchRepositoryOptions = {}): Promise<boolean> {
    const target = scope(requested);
    return this.database.transaction(async (tx) => (await tx.query("DELETE FROM search_workspaces WHERE workspace_id = $1 AND source_revision = $2 RETURNING workspace_id", [target.workspaceId, target.sourceRevision])).rows.length === 1, options);
  }

  private async lockScope(tx: SearchRepositoryTransaction, target: SearchRepositoryScope): Promise<Record<string, unknown>> {
    const result = await tx.query("SELECT source_revision, display_name, canonical_path, session_directory FROM search_workspaces WHERE workspace_id = $1 FOR UPDATE", [target.workspaceId]);
    if (!result.rows.length) throw new SearchRepositoryError("search_scope_unavailable");
    if (result.rows[0]!.source_revision !== target.sourceRevision) changed();
    this.decode(() => text(result.rows[0]!.display_name, 2048));
    return result.rows[0]!;
  }
  private async chunkCount(tx: SearchRepositoryTransaction, documentId: string): Promise<number> {
    const result = await tx.query("SELECT count(*)::text AS count FROM search_chunks WHERE document_id = $1", [documentId]);
    return this.decode(() => count(result.rows[0]));
  }
  private async adjustCounts(tx: SearchRepositoryTransaction, workspaceId: string, documents: number, chunks: number): Promise<void> {
    await tx.query("UPDATE search_workspaces SET document_count = document_count + $2, chunk_count = chunk_count + $3 WHERE workspace_id = $1", [workspaceId, documents, chunks]);
  }
  private decode<T>(read: () => T): T {
    try { return read(); }
    catch { throw new SearchRepositoryError("search_database_unavailable"); }
  }
}
