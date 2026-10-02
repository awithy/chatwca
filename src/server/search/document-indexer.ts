import path from "node:path";
import { scopedSessionStorePath, type SessionWorkspaceScope } from "../session-scope.js";
import { chunkMessages } from "./chunk.js";
import { SEARCH_EMBEDDING_DIMENSIONS } from "./config.js";
import { MAX_EMBEDDING_BATCH, MAX_EMBEDDING_REQUEST_BYTES, type SearchEmbeddingOptions } from "./embeddings.js";
import { SearchEmbeddingError, SearchRepositoryError, SearchSourceError } from "./errors.js";
import { isWellFormedText } from "./extract.js";
import {
  MAX_SEARCH_PUBLICATION_BYTES, MAX_SEARCH_REUSE_HASHES, MAX_SEARCH_TITLE_BYTES,
  type SearchDocumentPublication, type SearchDocumentVersion, type SearchIndexRepository,
} from "./repository.js";
import {
  assertSessionSourceCurrent, readSessionSnapshot, sameSourceFingerprint, workspaceSourceRevision,
  type SessionFileCandidate, type SessionSnapshot,
} from "./session-source.js";
import { createEmbeddingSpace, searchProcessingSignature, type SearchEmbeddingSpace } from "./signatures.js";

export interface SearchDocumentEmbeddings {
  embedDocuments(inputs: readonly string[], space: SearchEmbeddingSpace, options?: SearchEmbeddingOptions): Promise<readonly (readonly number[])[]>;
  assertSpaceCurrent(space: SearchEmbeddingSpace, options?: SearchEmbeddingOptions): Promise<void>;
}
export interface SearchDocumentSources {
  read(workspace: SessionWorkspaceScope, candidate: SessionFileCandidate, options: { readonly signal: AbortSignal }): Promise<SessionSnapshot>;
  assertCurrent(candidate: SessionFileCandidate): Promise<void>;
}
export const readOnlySearchDocumentSources: SearchDocumentSources = Object.freeze({
  read: readSessionSnapshot,
  assertCurrent: assertSessionSourceCurrent,
});

export interface SearchDocumentIndexRequest {
  readonly workspace: SessionWorkspaceScope;
  readonly candidate: SessionFileCandidate;
  /** Immutable space resolved once by the pass coordinator, not by document startup. */
  readonly space: SearchEmbeddingSpace;
  readonly scanId: string;
  readonly force?: boolean;
  readonly recomputeEmbeddings?: boolean;
  readonly signal?: AbortSignal;
}
export interface SearchDocumentIndexResult {
  readonly status: "unchanged" | "published";
  readonly sessionId: string;
  readonly version: SearchDocumentVersion;
  /** Distinct inputs, not chunk count; duplicate text is embedded only once. */
  readonly reusedInputs: number;
  readonly embeddedInputs: number;
}
type Repository = Pick<SearchIndexRepository, "readCheckpointPage" | "readCheckpoint" | "readReusableEmbeddings" | "markDocumentSeen" | "publishDocument">;

function invalid(): never { throw new SearchRepositoryError("search_index_invalid"); }
function changed(): never { throw new SearchSourceError("search_source_changed"); }

/** Display/lexical metadata only; never truncate quoted body evidence or embedding input. */
export function projectSearchTitle(title: string): string {
  if (typeof title !== "string" || !isWellFormedText(title)) invalid();
  let end = 0;
  let bytes = 0;
  for (const character of title) {
    const width = Buffer.byteLength(character === "\0" ? "\ufffd" : character);
    if (bytes + width > MAX_SEARCH_TITLE_BYTES) break;
    bytes += width;
    end += character.length;
  }
  return title.slice(0, end).replaceAll("\0", "\ufffd");
}
function vector(value: readonly number[]): readonly number[] {
  if (!Array.isArray(value) || value.length !== SEARCH_EMBEDDING_DIMENSIONS) throw new SearchEmbeddingError("search_embedding_invalid");
  let norm = 0;
  for (const element of value) {
    if (typeof element !== "number" || !Number.isFinite(element)) throw new SearchEmbeddingError("search_embedding_invalid");
    norm += element * element;
  }
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > 0.0001) throw new SearchEmbeddingError("search_embedding_invalid");
  return Object.freeze([...value]);
}

/** Per-document maintenance for the serialized worker. No discovery, registry mutation, pruning, retry or scheduler. */
export class SearchDocumentIndexer {
  private active: AbortController | undefined;
  private closed = false;
  constructor(
    private readonly repository: Repository,
    private readonly embeddings: SearchDocumentEmbeddings,
    private readonly sources: SearchDocumentSources = readOnlySearchDocumentSources,
  ) {}

  /** Owns only its attempt, not the injected repository, embedder or pool. */
  close(): void { this.closed = true; this.active?.abort(); }

  async index(request: SearchDocumentIndexRequest): Promise<SearchDocumentIndexResult> {
    if (this.closed || request.signal?.aborted) throw new SearchRepositoryError("search_cancelled");
    if (this.active) throw new SearchRepositoryError("search_busy");
    const workspace = Object.freeze({ ...request.workspace });
    const candidate = Object.freeze({ ...request.candidate, fingerprint: Object.freeze({ ...request.candidate.fingerprint }) });
    const space = createEmbeddingSpace(request.space.model, request.space.digest);
    if (space.signature !== request.space.signature || space.dimensions !== request.space.dimensions || space.normalizationVersion !== request.space.normalizationVersion) throw new SearchEmbeddingError("search_embedding_space_changed");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(workspace.id) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu.test(request.scanId)) invalid();
    if (candidate.workspaceId !== workspace.id || candidate.workspacePath !== workspace.path || scopedSessionStorePath(workspace, candidate.piAgentDirectory) !== candidate.storePath) changed();
    for (const value of [workspace.path, candidate.path, candidate.canonicalPath, candidate.storePath]) {
      if (!path.isAbsolute(value) || path.normalize(value) !== value) invalid();
    }
    const scope = Object.freeze({ workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, candidate.piAgentDirectory) });
    const signature = searchProcessingSignature(space);
    const scanId = request.scanId;
    const recompute = request.recomputeEmbeddings === true;
    const force = request.force === true || recompute;
    const callerSignal = request.signal;
    const controller = new AbortController();
    this.active = controller;
    const callerAbort = (): void => controller.abort();
    callerSignal?.addEventListener("abort", callerAbort, { once: true });
    if (callerSignal?.aborted) callerAbort();
    const check = (): undefined => {
      if (controller.signal.aborted || this.closed) throw new SearchRepositoryError("search_cancelled");
    };
    const options = { signal: controller.signal, assertCurrent: check };
    // Bound cancellation even for injected adapters ignoring abort. Late results cannot
    // resume this pipeline. Repository checks cover cancellation only, not authority.
    const call = async <T>(task: () => Promise<T>, fallback: Error): Promise<T> => {
      check();
      try {
        let abort: (() => void) | undefined;
        let result: T;
        try {
          result = await new Promise<T>((resolve, reject) => {
            abort = (): void => reject(new SearchRepositoryError("search_cancelled"));
            controller.signal.addEventListener("abort", abort, { once: true });
            Promise.resolve().then(() => { check(); return task(); }).then(resolve, reject);
            if (controller.signal.aborted) abort();
          });
        } finally {
          if (abort) controller.signal.removeEventListener("abort", abort);
        }
        check();
        return result;
      } catch (error) {
        if (controller.signal.aborted || this.closed) throw new SearchRepositoryError("search_cancelled");
        if (error instanceof SearchSourceError || error instanceof SearchEmbeddingError || error instanceof SearchRepositoryError) throw error;
        throw fallback;
      }
    };
    const repoError = new SearchRepositoryError("search_database_unavailable");
    const sourceError = new SearchSourceError("search_session_invalid");
    const embeddingError = new SearchEmbeddingError("search_embedding_unavailable");
    const revalidate = async (): Promise<void> => {
      await call(() => this.embeddings.assertSpaceCurrent(space, options), embeddingError);
      // Catch source edits during provider IO. Registration comparison belongs to
      // the worker at workspace boundaries; later filesystem changes may be stale
      // until the next pass, and do not require pre-commit authority seals.
      await call(() => this.sources.assertCurrent(candidate), sourceError);
    };
    try {
      // Canonical target makes admitted in-store symlink aliases converge. Discovery
      // membership (including unreadable paths) still belongs to the future coordinator.
      const page = await call(() => this.repository.readCheckpointPage(scope, { sourcePath: candidate.canonicalPath, limit: 1 }, options), repoError);
      const byPath = page.checkpoints[0];
      if (!force && byPath && page.nextAfterSessionId === null && byPath.sourcePath === candidate.canonicalPath &&
          byPath.processingSignature === signature && byPath.embeddingSpaceSignature === space.signature && sameSourceFingerprint(byPath.fingerprint, candidate.fingerprint)) {
        const sessionId = byPath.sessionId;
        await revalidate();
        await call(() => this.repository.markDocumentSeen(byPath, scanId, options), repoError);
        return { status: "unchanged", sessionId, version: { documentId: byPath.documentId, generation: byPath.generation }, reusedInputs: 0, embeddedInputs: 0 };
      }
      const snapshot = await call(() => this.sources.read(workspace, candidate, { signal: controller.signal }), sourceError);
      if (snapshot.candidate.canonicalPath !== candidate.canonicalPath || !sameSourceFingerprint(snapshot.candidate.fingerprint, candidate.fingerprint)) changed();
      const sessionId = snapshot.session.header.id;
      check();
      const chunks = chunkMessages(snapshot.session.messages);
      const title = projectSearchTitle(snapshot.session.title);
      const metadata = {
        ...scope, sessionId, sourcePath: candidate.canonicalPath, fingerprint: candidate.fingerprint, title,
        createdAt: snapshot.session.header.timestamp, modifiedAt: snapshot.session.modifiedAt, savedLeafId: snapshot.session.savedLeafId,
        snapshotHash: snapshot.snapshotHash, extractedContentHash: snapshot.session.extractedContentHash,
        processingSignature: signature, embeddingSpaceSignature: space.signature, scanId,
      };
      const inputs = new Map<string, { readonly input: string; occurrences: number }>();
      let preparedBytes = Buffer.byteLength(title) * (chunks.length + 1);
      const account = (bytes: number): void => {
        preparedBytes += bytes;
        if (preparedBytes > MAX_SEARCH_PUBLICATION_BYTES) throw new SearchSourceError("search_session_limit");
      };
      for (const chunk of chunks) {
        account(Buffer.byteLength(JSON.stringify(chunk)));
        const prior = inputs.get(chunk.embeddingInputHash);
        if (prior && prior.input !== chunk.embeddingInput) invalid();
        if (prior) prior.occurrences += 1;
        else inputs.set(chunk.embeddingInputHash, { input: chunk.embeddingInput, occurrences: 1 });
      }
      const previous = await call(() => this.repository.readCheckpoint(scope, sessionId, options), repoError);
      const vectors = new Map<string, readonly number[]>();
      const remember = (hash: string, supplied: readonly number[]): void => {
        const saved = vector(supplied);
        account(Buffer.byteLength(JSON.stringify(saved)) * inputs.get(hash)!.occurrences);
        vectors.set(hash, saved);
      };
      const hashes = [...inputs.keys()];
      if (previous && !recompute) {
        for (let start = 0; start < hashes.length; start += MAX_SEARCH_REUSE_HASHES) {
          const batch = hashes.slice(start, start + MAX_SEARCH_REUSE_HASHES);
          const reuse = await call(() => this.repository.readReusableEmbeddings(previous, space.signature, batch, options), repoError);
          for (const [hash, supplied] of reuse) {
            if (!batch.includes(hash) || vectors.has(hash)) invalid();
            remember(hash, supplied);
          }
        }
      }
      const reusedInputs = vectors.size;
      // Bound count AND actual JSON escaping; 16 legal raw inputs can exceed 256 KiB.
      const envelopeBytes = Buffer.byteLength(JSON.stringify({ model: space.model, input: [], truncate: false, keep_alive: "10m" }));
      let batch: string[] = [];
      let batchBytes = envelopeBytes;
      const flush = async (): Promise<void> => {
        if (!batch.length) return;
        const keys = batch;
        const result = await call(() => this.embeddings.embedDocuments(keys.map((hash) => inputs.get(hash)!.input), space, options), embeddingError);
        if (!Array.isArray(result) || result.length !== keys.length) throw new SearchEmbeddingError("search_embedding_invalid");
        for (const [index, hash] of keys.entries()) remember(hash, result[index]!);
        batch = []; batchBytes = envelopeBytes;
      };
      for (const hash of hashes) {
        if (vectors.has(hash)) continue;
        const bytes = Buffer.byteLength(JSON.stringify(inputs.get(hash)!.input));
        if (envelopeBytes + bytes > MAX_EMBEDDING_REQUEST_BYTES) throw new SearchSourceError("search_session_limit");
        if (batch.length && (batch.length === MAX_EMBEDDING_BATCH || batchBytes + bytes + 1 > MAX_EMBEDDING_REQUEST_BYTES)) await flush();
        batchBytes += bytes + (batch.length ? 1 : 0);
        batch.push(hash);
      }
      await flush();
      const publication: SearchDocumentPublication = {
        ...metadata, expected: previous === null ? null : { documentId: previous.documentId, generation: previous.generation },
        chunks: chunks.map((chunk) => ({ ...chunk, embedding: vectors.get(chunk.embeddingInputHash)! })),
      };
      await revalidate();
      // Never retry ambiguous COMMIT failures. The next attempt must read fresh metadata.
      const published = await call(() => this.repository.publishDocument(publication, options), repoError);
      return { status: "published", sessionId, version: published, reusedInputs, embeddedInputs: vectors.size - reusedInputs };
    } finally {
      callerSignal?.removeEventListener("abort", callerAbort);
      this.active = undefined;
    }
  }
}
