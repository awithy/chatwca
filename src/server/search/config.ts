import { ConfigurationError } from "../sandbox/config.js";

export const SEARCH_EMBEDDING_DIMENSIONS = 1_024;
export const MAX_SEARCH_INDEX_INTERVAL_MS = 86_400_000;
export const MAX_SEARCH_EMBEDDING_TIMEOUT_MS = 120_000;
export const MAX_SEARCH_RERANK_TIMEOUT_MS = 35_000;

export interface SearchConfig {
  readonly mode: "disabled" | "optional";
  /** Server-only credential. Never project this object directly into an API. */
  readonly databaseUrl: string | undefined;
  readonly ollamaUrl: string;
  readonly embeddingModel: string;
  readonly indexIntervalMs: number;
  readonly embeddingTimeoutMs: number;
  /** Undefined means use the complete global Pi default pair, not auto-selection. */
  readonly rerankOverride: Readonly<{
    provider: "openai" | "openai-codex";
    model: string;
  }> | undefined;
  readonly rerankTimeoutMs: number;
}

function optionalString(environment: NodeJS.ProcessEnv, variable: string): string | undefined {
  const value = environment[variable];
  if (value !== undefined && (value.trim().length === 0 || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value))) {
    throw new ConfigurationError(`${variable} must be a non-empty trimmed string without control characters`);
  }
  return value;
}

function boundedInteger(environment: NodeJS.ProcessEnv, variable: string, fallback: number, maximum: number): number {
  const raw = environment[variable];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ConfigurationError(`${variable} must be a positive safe integer at most ${String(maximum)}`);
  }
  return value;
}

/** Syntax validation only: no network, filesystem, model catalog, or auth access. */
export function validateSearchDatabaseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!value || value.trim() !== value || /[\u0000-\u0020\u007f]/u.test(value) ||
        !["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname ||
        url.pathname.length <= 1 || url.hash) throw new Error("invalid");
    return value;
  } catch {
    // URLs may contain passwords. Never include the supplied value in errors.
    throw new ConfigurationError("CHATWCA_SEARCH_DATABASE_URL must be a PostgreSQL URL with a host and database name, without a fragment");
  }
}

export function loadSearchConfig(environment: NodeJS.ProcessEnv = process.env): Readonly<SearchConfig> {
  const mode = environment.CHATWCA_SEARCH_MODE ?? "disabled";
  if (mode !== "disabled" && mode !== "optional") {
    throw new ConfigurationError("CHATWCA_SEARCH_MODE must be disabled or optional");
  }
  const rawDatabaseUrl = optionalString(environment, "CHATWCA_SEARCH_DATABASE_URL");
  const databaseUrl = rawDatabaseUrl === undefined ? undefined : validateSearchDatabaseUrl(rawDatabaseUrl);
  if (mode === "optional" && databaseUrl === undefined) {
    throw new ConfigurationError("CHATWCA_SEARCH_MODE=optional requires CHATWCA_SEARCH_DATABASE_URL");
  }

  const rawOllamaUrl = optionalString(environment, "CHATWCA_SEARCH_OLLAMA_URL") ?? "http://127.0.0.1:11434";
  let ollamaUrl: string;
  try {
    const url = new URL(rawOllamaUrl);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash || /[?#]/u.test(rawOllamaUrl)) throw new Error("invalid");
    ollamaUrl = url.toString().replace(/\/$/u, "");
  } catch {
    throw new ConfigurationError("CHATWCA_SEARCH_OLLAMA_URL must be an HTTP(S) base URL without credentials, query, or fragment");
  }

  const provider = optionalString(environment, "CHATWCA_SEARCH_RERANK_PROVIDER");
  const model = optionalString(environment, "CHATWCA_SEARCH_RERANK_MODEL");
  if ((provider === undefined) !== (model === undefined)) {
    throw new ConfigurationError("CHATWCA_SEARCH_RERANK_PROVIDER and CHATWCA_SEARCH_RERANK_MODEL must be specified together");
  }
  if (provider !== undefined && provider !== "openai" && provider !== "openai-codex") {
    throw new ConfigurationError("CHATWCA_SEARCH_RERANK_PROVIDER must be openai or openai-codex");
  }

  return Object.freeze({
    mode,
    databaseUrl,
    ollamaUrl,
    embeddingModel: optionalString(environment, "CHATWCA_SEARCH_EMBEDDING_MODEL") ?? "qwen3-embedding:0.6b",
    indexIntervalMs: boundedInteger(environment, "CHATWCA_SEARCH_INDEX_INTERVAL_MS", 900_000, MAX_SEARCH_INDEX_INTERVAL_MS),
    embeddingTimeoutMs: boundedInteger(environment, "CHATWCA_SEARCH_EMBEDDING_TIMEOUT_MS", 30_000, MAX_SEARCH_EMBEDDING_TIMEOUT_MS),
    rerankOverride: provider === undefined || model === undefined ? undefined : Object.freeze({ provider, model }),
    rerankTimeoutMs: boundedInteger(environment, "CHATWCA_SEARCH_RERANK_TIMEOUT_MS", 20_000, MAX_SEARCH_RERANK_TIMEOUT_MS),
  });
}

/** Configuration intent only, not a claim that indexing/retrieval is ready. */
export function publicSearchConfig(config: Readonly<SearchConfig>): { mode: SearchConfig["mode"] } {
  return { mode: config.mode };
}
