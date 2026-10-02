export type SearchRepositoryErrorCode =
  | "search_database_unavailable"
  | "search_schema_incompatible"
  | "search_index_invalid"
  | "search_scope_unavailable"
  | "search_source_changed"
  | "search_session_limit"
  | "search_busy"
  | "search_timeout"
  | "search_cancelled";

/** Repository diagnostics never expose SQL, paths, credentials, or conversation text. */
export class SearchRepositoryError extends Error {
  constructor(readonly code: SearchRepositoryErrorCode) { super(code); }
}

export type SearchQueryErrorCode = "search_disabled" | "search_initializing" | "search_schema_incompatible" | "search_query_invalid" | "search_scope_unavailable" | "search_database_unavailable" | "search_busy" | "search_timeout" | "search_cancelled";

/** Safe public query failures; dependency diagnostics never escape. */
export class SearchQueryError extends Error {
  constructor(readonly code: SearchQueryErrorCode) { super(code); }
}

export type SearchEmbeddingErrorCode =
  | "search_embedding_unavailable"
  | "search_embedding_invalid"
  | "search_embedding_space_changed"
  | "search_busy"
  | "search_timeout"
  | "search_cancelled";

/** No endpoints, inputs, provider bodies, or underlying causes may escape. */
export class SearchEmbeddingError extends Error {
  constructor(readonly code: SearchEmbeddingErrorCode) { super(code); }
}

export type SearchSourceErrorCode =
  | "search_scope_unavailable"
  | "search_session_invalid"
  | "search_session_version_unsupported"
  | "search_session_limit"
  | "search_source_changed";

/** Safe diagnostics: never include transcript text, JSON parse errors, or paths. */
export class SearchSourceError extends Error {
  constructor(
    readonly code: SearchSourceErrorCode,
    /** Legacy ownership-mismatch hint for retired authority consumers; the single-user pipeline retains cached content. */
    readonly invalidatePrevious = false,
  ) { super(code); }
}
