export type SearchAvailability = "disabled" | "initializing" | "ready" | "unavailable" | "closed";
export interface PublicSearchConfig {
  readonly mode: "disabled" | "optional";
  readonly available: boolean;
  readonly state: SearchAvailability;
  readonly rerankAvailable: boolean;
}
export interface SearchCounts { readonly documents: number; readonly chunks: number }
export interface SearchExcerpt {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly timestamp: number;
  readonly text: string;
  readonly truncated: boolean;
  readonly indexedAt: number;
}
export interface SearchConversationResult {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly sessionId: string;
  readonly title: string;
  readonly modifiedAt: number;
  readonly excerpts: readonly SearchExcerpt[];
}
export interface SearchResponse {
  readonly cached: true;
  readonly mode: "hybrid" | "lexical";
  readonly warnings: readonly string[];
  readonly results: readonly SearchConversationResult[];
  readonly freshness: SearchFreshness;
  readonly rerank: { readonly requested: boolean; readonly applied: boolean; readonly reason: string };
}
export interface SearchStatus extends SearchFreshness {
  readonly mode: "disabled" | "optional";
  readonly available: boolean;
  readonly counts: SearchCounts | null;
  readonly indexer: {
    readonly state: "idle" | "indexing" | "unavailable" | "closed";
    readonly pending: boolean;
    readonly progress: {
      readonly workspaces: number;
      readonly discovered: number;
      readonly published: number;
      readonly unchanged: number;
      readonly failed: number;
      readonly deleted: number;
      readonly removedWorkspaces: number;
    };
    readonly errors: readonly { readonly workspaceId: string | null; readonly code: string }[];
  } | null;
}
/** Full status includes bounded in-memory worker progress/errors; no source paths or dependency diagnostics. */
export interface SearchFreshness {
  readonly state: SearchAvailability;
  readonly indexing: boolean;
  readonly lastSucceededAt: number | null;
  readonly errorCode: string | null;
  readonly errorCount: number;
}
