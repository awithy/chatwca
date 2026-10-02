import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaSearchEmbeddings } from "../../src/server/search/embeddings.js";
import { queryEmbeddingInput } from "../../src/server/search/chunk.js";
import { createEmbeddingSpace, searchProcessingSignature } from "../../src/server/search/signatures.js";
import { FAKE_CHANGED_DIGEST, FAKE_EMBEDDING_DIGEST, FAKE_EMBEDDING_MODEL, fakeSearchVector, startFakeSearchOllama } from "../fixtures/search-ollama.js";

const servers: Awaited<ReturnType<typeof startFakeSearchOllama>>[] = [];
const adapters: OllamaSearchEmbeddings[] = [];
async function fixture(timeoutMs = 1000) {
  const server = await startFakeSearchOllama();
  servers.push(server);
  const adapter = new OllamaSearchEmbeddings({ ollamaUrl: server.url, embeddingModel: FAKE_EMBEDDING_MODEL, embeddingTimeoutMs: timeoutMs });
  adapters.push(adapter);
  return { server, adapter };
}
afterEach(async () => {
  for (const adapter of adapters.splice(0)) adapter.close();
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("isolated loopback embedding API", () => {
  it("resolves, embeds bounded document batches and profiled queries, and checks publication identity", async () => {
    const { server, adapter } = await fixture();
    expect(server.requests).toHaveLength(0);
    const space = await adapter.resolveSpace();
    expect(space.digest).toBe(`sha256:${FAKE_EMBEDDING_DIGEST}`);
    const inputs = Array.from({ length: 16 }, (_, index) => `User message:\nSynthetic turn ${index}: Code_Name.ts`);
    const vectors = await adapter.embedDocuments(inputs, space);
    expect(vectors).toHaveLength(16);
    expect(vectors.every((vector) => vector.length === 1024 && vector.every(Number.isFinite))).toBe(true);
    expect(vectors[0]?.slice(0, 3)).toEqual([0.6, 0.8, 0]);
    expect(await adapter.embedQuery("synthetic identifier question", space)).toEqual(vectors[0]);
    const embeds = server.requests.filter((request) => request.path === "/api/embed");
    expect(embeds.map((request) => request.body)).toEqual([
      { model: FAKE_EMBEDDING_MODEL, input: inputs, truncate: false, keep_alive: "10m" },
      { model: FAKE_EMBEDDING_MODEL, input: [queryEmbeddingInput("synthetic identifier question")], truncate: false, keep_alive: "10m" },
    ]);
    await adapter.assertSpaceCurrent(space);
    server.state.digest = FAKE_CHANGED_DIGEST;
    await expect(adapter.assertSpaceCurrent(space)).rejects.toThrow("search_embedding_space_changed");
    const changed = await adapter.resolveSpace();
    expect(changed.signature).not.toBe(space.signature);
    expect(searchProcessingSignature(changed)).not.toBe(searchProcessingSignature(space));
    expect(await adapter.embedDocuments(["new synthetic input"], changed)).toHaveLength(1);
    expect(server.requests.every(({ path }) => ["/api/tags", "/api/show", "/api/embed"].includes(path))).toBe(true);
  });

  it("discards vectors if the model tag changes while embedding", async () => {
    const { server, adapter } = await fixture();
    const space = await adapter.resolveSpace();
    server.state.handler = (request, response) => {
      if (request.path === "/api/tags") {
        response.end(JSON.stringify({ models: [{ name: FAKE_EMBEDDING_MODEL, digest: server.state.digest }] }));
      } else {
        server.state.digest = FAKE_CHANGED_DIGEST;
        response.end(JSON.stringify({ model: FAKE_EMBEDDING_MODEL, embeddings: [fakeSearchVector()] }));
      }
    };
    await expect(adapter.embedDocuments(["synthetic input"], space)).rejects.toThrow("search_embedding_space_changed");
    expect(server.requests.slice(-3).map(({ path }) => path)).toEqual(["/api/tags", "/api/embed", "/api/tags"]);
  });

  it("bounds chunked bodies without relying on Content-Length", async () => {
    const { server, adapter } = await fixture();
    const space = await adapter.resolveSpace();
    server.state.handler = (request, response) => {
      if (request.path === "/api/tags") response.end(JSON.stringify({ models: [{ name: FAKE_EMBEDDING_MODEL, digest: server.state.digest }] }));
      else {
        response.writeHead(200, { "content-type": "application/json" });
        for (let index = 0; index < 9; index += 1) response.write(" ".repeat(8192));
        response.end("{}");
      }
    };
    await expect(adapter.embedDocuments(["synthetic input"], space)).rejects.toThrow("search_embedding_invalid");
  });

  it("has an aggregate deadline even after response headers arrive", async () => {
    const { server, adapter } = await fixture(200);
    server.state.handler = (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write("{"); // never finish the body
    };
    await expect(adapter.resolveSpace()).rejects.toThrow("search_timeout");
    expect(server.requests).toHaveLength(1);
    server.state.handler = undefined;
    expect(await adapter.resolveSpace()).toEqual(createEmbeddingSpace(FAKE_EMBEDDING_MODEL, FAKE_EMBEDDING_DIGEST));
  });

  it("cancels live sockets and queued queries on shutdown, without late model probes", async () => {
    const { server, adapter } = await fixture();
    const space = await adapter.resolveSpace();
    let embedStarted = false;
    server.state.handler = (request, response) => {
      if (request.path === "/api/tags") response.end(JSON.stringify({ models: [{ name: FAKE_EMBEDDING_MODEL, digest: server.state.digest }] }));
      else { embedStarted = true; response.writeHead(200); response.flushHeaders(); }
    };
    const active = expect(adapter.embedQuery("synthetic query", space)).rejects.toThrow("search_cancelled");
    await vi.waitFor(() => expect(embedStarted).toBe(true));
    const queued = expect(adapter.embedQuery("queued synthetic query", space)).rejects.toThrow("search_cancelled");
    adapter.close();
    await Promise.all([active, queued]);
    const count = server.requests.length;
    await expect(adapter.embedDocuments(["late input"], space)).rejects.toThrow("search_cancelled");
    expect(server.requests).toHaveLength(count);
  });

  it("does not follow redirects or leak remote diagnostic bodies", async () => {
    const { server, adapter } = await fixture();
    server.state.handler = (_request, response) => { response.writeHead(302, { location: `${server.url}/api/pull` }).end("private provider diagnostic"); };
    const error: unknown = await adapter.resolveSpace().catch((value: unknown) => value);
    expect(String(error)).toBe("Error: search_embedding_unavailable");
    expect((error as Error).cause).toBeUndefined();
    expect(server.requests.map(({ path }) => path)).toEqual(["/api/tags"]);
  });
});
