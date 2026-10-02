import { describe, expect, it } from "vitest";

import { ConfigurationError, loadConfig } from "../../src/server/config.js";
import { loadSearchConfig, publicSearchConfig, SEARCH_EMBEDDING_DIMENSIONS } from "../../src/server/search/config.js";

const databaseUrl = "postgresql://chatwca_search:private-password@127.0.0.1:55432/chatwca_search";

describe("conversation search configuration", () => {
  it("is disabled by default, immutable, and syntax-only even with unreachable dependencies", () => {
    const config = loadSearchConfig({});
    expect(config).toEqual({
      mode: "disabled", databaseUrl: undefined,
      ollamaUrl: "http://127.0.0.1:11434", embeddingModel: "qwen3-embedding:0.6b",
      indexIntervalMs: 900_000, embeddingTimeoutMs: 30_000,
      rerankOverride: undefined, rerankTimeoutMs: 20_000,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(SEARCH_EMBEDDING_DIMENSIONS).toBe(1_024);
    expect(loadConfig({ CHATWCA_SEARCH_MODE: "optional", CHATWCA_SEARCH_DATABASE_URL: databaseUrl }).search.mode).toBe("optional");
  });

  it("parses startup overrides without inspecting Pi settings or auth", () => {
    const config = loadSearchConfig({
      CHATWCA_SEARCH_MODE: "optional", CHATWCA_SEARCH_DATABASE_URL: databaseUrl,
      CHATWCA_SEARCH_OLLAMA_URL: "https://ollama.example/base/",
      CHATWCA_SEARCH_EMBEDDING_MODEL: "local-model:tag",
      CHATWCA_SEARCH_INDEX_INTERVAL_MS: "15000", CHATWCA_SEARCH_EMBEDDING_TIMEOUT_MS: "5000",
      CHATWCA_SEARCH_RERANK_TIMEOUT_MS: "10000", CHATWCA_SEARCH_RERANK_PROVIDER: "openai-codex",
      CHATWCA_SEARCH_RERANK_MODEL: "example-model", OPENAI_API_KEY: "not-copied", PI_OFFLINE: "0",
    });
    expect(config).toEqual({
      mode: "optional", databaseUrl, ollamaUrl: "https://ollama.example/base", embeddingModel: "local-model:tag",
      indexIntervalMs: 15000, embeddingTimeoutMs: 5000,
      rerankTimeoutMs: 10000, rerankOverride: { provider: "openai-codex", model: "example-model" },
    });
    expect(Object.isFrozen(config.rerankOverride)).toBe(true);
    expect(JSON.stringify(config)).not.toContain("not-copied");
    expect(publicSearchConfig(config)).toEqual({ mode: "optional" });
    expect(JSON.stringify(publicSearchConfig(config))).not.toContain("private-password");
  });

  it("requires a database only when enabled and rejects unknown modes", () => {
    expect(() => loadSearchConfig({ CHATWCA_SEARCH_MODE: "optional" })).toThrow(/requires CHATWCA_SEARCH_DATABASE_URL/);
    for (const mode of ["", "enabled", "required"]) {
      expect(() => loadSearchConfig({ CHATWCA_SEARCH_MODE: mode })).toThrow(ConfigurationError);
    }
  });

  it.each(["CHATWCA_SEARCH_INDEX_INTERVAL_MS", "CHATWCA_SEARCH_EMBEDDING_TIMEOUT_MS", "CHATWCA_SEARCH_RERANK_TIMEOUT_MS"])("strictly bounds %s", (variable) => {
    for (const value of ["", "0", "-1", "1.5", "12garbage", "Infinity", "NaN", "9007199254740992", "86400001"]) {
      expect(() => loadSearchConfig({ [variable]: value })).toThrow(new RegExp(variable));
    }
    expect(() => loadSearchConfig({ [variable]: "1" })).not.toThrow();
  });

  it("caps embedding and reranking deadlines", () => {
    expect(() => loadSearchConfig({ CHATWCA_SEARCH_EMBEDDING_TIMEOUT_MS: "120001" })).toThrow(ConfigurationError);
    expect(() => loadSearchConfig({ CHATWCA_SEARCH_RERANK_TIMEOUT_MS: "35001" })).toThrow(ConfigurationError);
  });

  it.each(["", "http://user:private-password@host/db", "postgresql:///db", "postgresql://host/", "postgresql://host/db#private-password", " postgres://host/db"])("rejects invalid database URLs without disclosing their value", (value) => {
    try {
      loadSearchConfig({ CHATWCA_SEARCH_DATABASE_URL: value });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain("private-password");
    }
  });

  it.each(["ftp://host", "http://user:secret@host", "http://host?token=secret", "http://host#secret", "http://host?", "http://host#", "/relative", ""])("rejects unsafe Ollama URLs (%s)", (url) => {
    expect(() => loadSearchConfig({ CHATWCA_SEARCH_OLLAMA_URL: url })).toThrow(ConfigurationError);
  });

  it("requires a complete supported OpenAI override", () => {
    expect(() => loadSearchConfig({ CHATWCA_SEARCH_RERANK_PROVIDER: "openai" })).toThrow(/specified together/);
    expect(() => loadSearchConfig({ CHATWCA_SEARCH_RERANK_MODEL: "model" })).toThrow(/specified together/);
    expect(() => loadSearchConfig({ CHATWCA_SEARCH_RERANK_MODEL: "model", CHATWCA_SEARCH_RERANK_PROVIDER: "anthropic" })).toThrow(/openai/);
    for (const variable of ["CHATWCA_SEARCH_EMBEDDING_MODEL", "CHATWCA_SEARCH_RERANK_MODEL", "CHATWCA_SEARCH_RERANK_PROVIDER"]) {
      for (const value of [" ", "value\n", "\u0000"]) expect(() => loadSearchConfig({ [variable]: value })).toThrow(ConfigurationError);
    }
  });
});
