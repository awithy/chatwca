import { describe, expect, it } from "vitest";
import { canonicalEmbeddingModel, createEmbeddingSpace, SEARCH_PROCESSING_PROFILES, searchProcessingSignature, searchQuerySignature } from "../../src/server/search/signatures.js";
import { FAKE_CHANGED_DIGEST, FAKE_EMBEDDING_DIGEST, FAKE_EMBEDDING_MODEL } from "../fixtures/search-ollama.js";

const space = createEmbeddingSpace(FAKE_EMBEDDING_MODEL, FAKE_EMBEDDING_DIGEST);

describe("search embedding and processing signatures", () => {
  it("uses canonical tags, full immutable SHA-256 digests, fixed dimensions and normalization", () => {
    expect(canonicalEmbeddingModel("qwen3-embedding")).toBe("qwen3-embedding:latest");
    expect(canonicalEmbeddingModel("registry:5000/project/model")).toBe("registry:5000/project/model:latest");
    expect(canonicalEmbeddingModel("registry:5000/project/model:tag")).toBe("registry:5000/project/model:tag");
    expect(createEmbeddingSpace("fake-conversation", `sha256:${FAKE_EMBEDDING_DIGEST.toUpperCase()}`)).toEqual(space);
    expect(space.dimensions).toBe(1024);
    expect(space.normalizationVersion).toBe("scaled-l2-v1");
    expect(space.digest).toBe(`sha256:${FAKE_EMBEDDING_DIGEST}`);
    expect(space.signature).toMatch(/^[a-f0-9]{64}$/u);
    expect(Object.isFrozen(space)).toBe(true);
  });

  it.each(["", "abc", "g".repeat(64), "a".repeat(63), "a".repeat(65), `sha256:${"a".repeat(63)}`, ` ${FAKE_EMBEDDING_DIGEST}`])("rejects non-immutable digest %s", (digest) => {
    expect(() => createEmbeddingSpace(FAKE_EMBEDDING_MODEL, digest)).toThrow("search_embedding_invalid");
  });

  it.each(["", " model", "model ", "model\n", "model\u0000", "a".repeat(513)])("rejects invalid model names (%#)", (model) => {
    expect(() => createEmbeddingSpace(model, FAKE_EMBEDDING_DIGEST)).toThrow("search_embedding_invalid");
  });

  it("isolates digest/tag changes even with identical dimensions", () => {
    for (const other of [createEmbeddingSpace(FAKE_EMBEDDING_MODEL, FAKE_CHANGED_DIGEST), createEmbeddingSpace("different:tag", FAKE_EMBEDDING_DIGEST)]) {
      expect(other.signature).not.toBe(space.signature);
      expect(searchProcessingSignature(other)).not.toBe(searchProcessingSignature(space));
      expect(searchQuerySignature(other)).not.toBe(searchQuerySignature(space));
    }
  });

  it.each(["extractor", "chunker", "documentInput"] as const)("versions %s without changing the vector space or query profile", (key) => {
    const changed = { ...SEARCH_PROCESSING_PROFILES, [key]: "changed-version" };
    expect(searchProcessingSignature(space, changed)).not.toBe(searchProcessingSignature(space));
    expect(searchQuerySignature(space)).toBe(searchQuerySignature(space));
  });

  it("keeps query-profile invalidation independent of document processing", () => {
    const processing = searchProcessingSignature(space);
    expect(searchQuerySignature(space, "query-v2")).not.toBe(searchQuerySignature(space));
    expect(searchProcessingSignature(space)).toBe(processing);
  });
});
