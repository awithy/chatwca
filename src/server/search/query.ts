import { performance } from "node:perf_hooks";
import type { SearchConversationResult, SearchExcerpt, SearchResponse } from "../../shared/search.js";
import type { SearchRerankResult } from "./rerank.js";
export type { SearchConversationResult, SearchExcerpt } from "../../shared/search.js";
import type { SearchEmbeddingOptions } from "./embeddings.js";
import { SearchEmbeddingError, SearchQueryError, SearchRepositoryError, type SearchEmbeddingErrorCode } from "./errors.js";
import type { SearchIndexerRegistrations } from "./indexer.js";
import { MAX_SEARCH_CONCURRENT_QUERIES, validateSearchQuery, type SearchCandidate, type SearchRetrievedCandidates, type SearchRetrievalRepository, type SearchQueryVector } from "./retrieval.js";
import { workspaceSourceRevision } from "./session-source.js";
import type { SearchEmbeddingSpace } from "./signatures.js";

export const SEARCH_RRF_K = 60;
export const MAX_SEARCH_TIMEOUT_MS = 35_000;
export const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;
export const MAX_SEARCH_EXCERPT_CHARACTERS = 1200;
export interface SearchQueryEmbeddings {
  embedSearchQuery(query: string, options?: SearchEmbeddingOptions): Promise<{ space: SearchEmbeddingSpace; embedding: readonly number[] }>;
}
export interface SearchQueryReranker {
  rerank(query: string, candidates: readonly SearchCandidate[], options?: { readonly signal?: AbortSignal }): Promise<SearchRerankResult<SearchCandidate>>;
}
export interface SearchQueryRequest { readonly query: string; readonly workspaceId?: string | null; readonly limit?: number; readonly rerank?: boolean }
export interface SearchQueryResponse {
  /** All hits are derived cached content; freshness/errors are supplied by indexer status, not file probes. */
  readonly cached: true;
  readonly mode: "hybrid" | "lexical";
  readonly warnings: readonly SearchEmbeddingErrorCode[];
  readonly results: readonly SearchConversationResult[];
  readonly rerank: SearchResponse["rerank"];
}
interface Ranked { readonly candidate: SearchCandidate; score: number }
const compareId = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const conversationKey = (candidate: SearchCandidate): string => JSON.stringify([candidate.workspaceId, candidate.sessionId]);

/** One lexical channel (English/simple combined), one vector channel; scores remain internal. */
export function fuseSearchCandidates(channels: SearchRetrievedCandidates): readonly Ranked[] {
  const merged = new Map<string, Ranked>();
  for (const channel of [channels.lexical, channels.vector]) {
    const seen = new Set<string>();
    for (const [index, candidate] of channel.entries()) {
      if (seen.has(candidate.chunkId)) continue;
      seen.add(candidate.chunkId);
      const item = merged.get(candidate.chunkId) ?? { candidate, score: 0 };
      item.score += 1 / (SEARCH_RRF_K + index + 1);
      merged.set(candidate.chunkId, item);
    }
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score || compareId(a.candidate.chunkId, b.candidate.chunkId));
  const kept: Ranked[] = []; const conversations = new Map<string, SearchCandidate[]>();
  for (const item of ranked) {
    const candidate = item.candidate; const key = conversationKey(candidate); const previous = conversations.get(key) ?? [];
    if (previous.length >= 5 || previous.some((other) => other.entryId === candidate.entryId &&
        other.sourceByteStart < candidate.sourceByteEnd && candidate.sourceByteStart < other.sourceByteEnd)) continue;
    previous.push(candidate); conversations.set(key, previous); kept.push(item);
    if (kept.length === 100) break;
  }
  return kept;
}
function shorten(text: string, maximum: number): string { return [...text].slice(0, maximum).join(""); }
function excerpt(candidate: SearchCandidate, query: string): SearchExcerpt {
  const points = [...candidate.text]; let start = 0;
  // Prefer an exact query occurrence when it falls beyond the first excerpt. No markup/highlighting is emitted.
  const match = candidate.text.toLowerCase().indexOf(query.trim().toLowerCase());
  if (match >= 0) start = Math.max(0, [...candidate.text.slice(0, match)].length - 200);
  const end = Math.min(points.length, start + MAX_SEARCH_EXCERPT_CHARACTERS);
  return { entryId: candidate.entryId, role: candidate.role, timestamp: candidate.timestamp, text: points.slice(start, end).join(""),
    truncated: start > 0 || end < points.length, indexedAt: candidate.indexedAt };
}
export function groupSearchCandidates(channels: SearchRetrievedCandidates, query: string, limit: number): SearchConversationResult[] {
  return groupRankedCandidates(fuseSearchCandidates(channels).map(({ candidate }) => candidate), query, limit);
}
function groupRankedCandidates(candidates: readonly SearchCandidate[], query: string, limit: number): SearchConversationResult[] {
  const groups = new Map<string, { candidate: SearchCandidate; excerpts: SearchExcerpt[] }>();
  for (const candidate of candidates) {
    const key = conversationKey(candidate);
    let group = groups.get(key);
    if (!group) {
      if (groups.size >= limit) continue;
      group = { candidate, excerpts: [] }; groups.set(key, group);
    }
    if (group.excerpts.length < 3) group.excerpts.push(excerpt(candidate, query));
  }
  return [...groups.values()].map(({ candidate, excerpts }) => ({ workspaceId: candidate.workspaceId, workspaceName: shorten(candidate.workspaceName, 512),
    sessionId: candidate.sessionId, title: shorten(candidate.title, 512), modifiedAt: candidate.modifiedAt, excerpts }));
}

/** Cached local retrieval with optional Pi ordering. No filesystem IO or membership recovery. */
export class SearchQueryService {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(private readonly options: { repository: SearchRetrievalRepository; registrations: SearchIndexerRegistrations;
    embeddings: SearchQueryEmbeddings; piAgentDirectory: string; timeoutMs?: number; reranker?: SearchQueryReranker }) {
    const timeout = options.timeoutMs ?? MAX_SEARCH_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > MAX_SEARCH_TIMEOUT_MS) throw new SearchQueryError("search_query_invalid");
  }
  close(): void { this.closed = true; for (const controller of this.active) controller.abort(new SearchQueryError("search_cancelled")); }

  async search(request: SearchQueryRequest, options: SearchEmbeddingOptions = {}): Promise<SearchQueryResponse> {
    if (this.closed || options.signal?.aborted) throw new SearchQueryError("search_cancelled");
    if (!request || typeof request !== "object") throw new SearchQueryError("search_query_invalid");
    const query = validateSearchQuery(request.query); const limit = request.limit === undefined ? 10 : request.limit; const workspaceId = request.workspaceId ?? null;
    if ((request.rerank !== undefined && typeof request.rerank !== "boolean") || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 || (workspaceId !== null && (typeof workspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(workspaceId)))) {
      throw new SearchQueryError("search_query_invalid");
    }
    if (this.active.size >= MAX_SEARCH_CONCURRENT_QUERIES) throw new SearchQueryError("search_busy");
    let scopes;
    try {
      const registrations = this.options.registrations.list();
      if (workspaceId !== null && !registrations.some((workspace) => workspace.id === workspaceId)) throw new Error("unknown scope");
      scopes = registrations.filter((workspace) => workspaceId === null || workspace.id === workspaceId)
        .map((workspace) => ({ workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, this.options.piAgentDirectory) }));
    } catch { throw new SearchQueryError("search_scope_unavailable"); }
    const requested = request.rerank !== false;
    let rerank: SearchResponse["rerank"] = { requested, applied: false, reason: requested ? "too_few_candidates" : "not_requested" };
    if (!scopes.length) return { cached: true, mode: "lexical", warnings: [], results: [], rerank };
    const controller = new AbortController(); this.active.add(controller);
    const timeout = this.options.timeoutMs ?? MAX_SEARCH_TIMEOUT_MS; const expiresAt = performance.now() + timeout;
    const timer = setTimeout(() => controller.abort(new SearchQueryError("search_timeout")), timeout); timer.unref();
    const abort = (): void => controller.abort(new SearchQueryError("search_cancelled"));
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    const check = (): void => {
      if (performance.now() >= expiresAt && !controller.signal.aborted) controller.abort(new SearchQueryError("search_timeout"));
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    const call = async <T>(task: () => Promise<T>): Promise<T> => {
      check(); let cancel: (() => void) | undefined;
      try {
        const result = await new Promise<T>((resolve, reject) => {
          cancel = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", cancel, { once: true });
          Promise.resolve().then(() => { check(); return task(); }).then(resolve, reject);
          if (controller.signal.aborted) cancel();
        });
        check(); return result;
      } finally { if (cancel) controller.signal.removeEventListener("abort", cancel); }
    };
    try {
      let vector: SearchQueryVector | undefined; const warnings: SearchEmbeddingErrorCode[] = [];
      try {
        const embedded = await call(() => this.options.embeddings.embedSearchQuery(query, { signal: controller.signal }));
        vector = { spaceSignature: embedded.space.signature, embedding: embedded.embedding };
      } catch (error) {
        check();
        // Caller/shutdown cancellation is never converted into an apparently successful fallback.
        if (error instanceof SearchEmbeddingError && error.code === "search_cancelled") throw new SearchQueryError("search_cancelled");
        warnings.push(error instanceof SearchEmbeddingError ? error.code : "search_embedding_unavailable");
      }
      const channels = await call(() => this.options.repository.retrieve({ query, scopes, candidateLimit: Math.min(100, Math.max(30, limit * 5)),
        ...(vector ? { vector } : {}) }, { signal: controller.signal }));
      let candidates = fuseSearchCandidates(channels).map(({ candidate }) => candidate);
      if (requested && candidates.length >= 2) {
        rerank = { requested, applied: false, reason: "unavailable" };
        if (this.options.reranker) {
          try {
            const ranked = await call(() => this.options.reranker!.rerank(query, candidates, { signal: controller.signal }));
            candidates = [...ranked.candidates];
            rerank = { requested, applied: ranked.applied, reason: ranked.reason };
          } catch (error) {
            check();
            if (error instanceof SearchQueryError && ["search_cancelled", "search_timeout"].includes(error.code)) throw error;
            // Optional ordering failures must not turn a usable local query into a database outage.
          }
        }
      }
      const results = groupRankedCandidates(candidates, query, limit);
      const response: SearchQueryResponse = { cached: true, mode: vector && channels.vector.length > 0 ? "hybrid" : "lexical", warnings, results, rerank };
      while (Buffer.byteLength(JSON.stringify(response)) > MAX_SEARCH_RESPONSE_BYTES && results.length) results.pop();
      check(); return response;
    } catch (error) {
      check();
      if (error instanceof SearchQueryError) throw error;
      if (error instanceof SearchRepositoryError && ["search_cancelled", "search_timeout", "search_busy"].includes(error.code)) {
        throw new SearchQueryError(error.code as "search_cancelled" | "search_timeout" | "search_busy");
      }
      throw new SearchQueryError("search_database_unavailable");
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); this.active.delete(controller); }
  }
}
