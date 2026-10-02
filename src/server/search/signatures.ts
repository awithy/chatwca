import { SEARCH_CHUNKER_VERSION, SEARCH_DOCUMENT_INPUT_VERSION, SEARCH_QUERY_INPUT_VERSION } from "./chunk.js";
import { SEARCH_EMBEDDING_DIMENSIONS } from "./config.js";
import { SearchEmbeddingError } from "./errors.js";
import { SEARCH_EXTRACTOR_VERSION, searchHash } from "./extract.js";

export const SEARCH_NORMALIZATION_VERSION = "scaled-l2-v1";

export interface SearchEmbeddingSpace {
  readonly model: string;
  readonly digest: string;
  readonly dimensions: typeof SEARCH_EMBEDDING_DIMENSIONS;
  readonly normalizationVersion: typeof SEARCH_NORMALIZATION_VERSION;
  readonly signature: string;
}

/** Ollama defaults untagged names to latest; a registry port is not a tag. */
export function canonicalEmbeddingModel(model: string): string {
  if (typeof model !== "string" || !model || model.trim() !== model || /[\u0000-\u0020\u007f]/u.test(model) || model.length > 512) {
    throw new SearchEmbeddingError("search_embedding_invalid");
  }
  return model.slice(model.lastIndexOf("/") + 1).includes(":") ? model : `${model}:latest`;
}

export function createEmbeddingSpace(model: string, digest: string): Readonly<SearchEmbeddingSpace> {
  model = canonicalEmbeddingModel(model);
  if (!/^(?:sha256:)?[a-fA-F0-9]{64}$/u.test(digest)) throw new SearchEmbeddingError("search_embedding_invalid");
  digest = `sha256:${digest.replace(/^sha256:/u, "").toLowerCase()}`;
  const identity = { model, digest, dimensions: SEARCH_EMBEDDING_DIMENSIONS, normalizationVersion: SEARCH_NORMALIZATION_VERSION } as const;
  return Object.freeze({ ...identity, signature: searchHash(JSON.stringify(["conversation-embedding-space-v1", model, digest, identity.dimensions, identity.normalizationVersion])) });
}

export interface SearchProcessingProfiles {
  readonly extractor: string;
  readonly chunker: string;
  readonly documentInput: string;
}

export const SEARCH_PROCESSING_PROFILES: Readonly<SearchProcessingProfiles> = Object.freeze({
  extractor: SEARCH_EXTRACTOR_VERSION,
  chunker: SEARCH_CHUNKER_VERSION,
  documentInput: SEARCH_DOCUMENT_INPUT_VERSION,
});

/** Document processing and query caching have deliberately independent versions. */
export function searchProcessingSignature(
  space: SearchEmbeddingSpace,
  profiles: Readonly<SearchProcessingProfiles> = SEARCH_PROCESSING_PROFILES,
): string {
  return searchHash(JSON.stringify(["conversation-processing-v1", profiles.extractor, profiles.chunker, profiles.documentInput, space.signature]));
}

export function searchQuerySignature(space: SearchEmbeddingSpace, queryProfile: string = SEARCH_QUERY_INPUT_VERSION): string {
  return searchHash(JSON.stringify(["conversation-query-space-v1", queryProfile, space.signature]));
}
