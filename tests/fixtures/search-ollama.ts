import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { SEARCH_EMBEDDING_DIMENSIONS } from "../../src/server/search/config.js";

export const FAKE_EMBEDDING_MODEL = "fake-conversation:latest";
export const FAKE_EMBEDDING_DIGEST = "a".repeat(64);
export const FAKE_CHANGED_DIGEST = "b".repeat(64);

export function fakeSearchVector(first = 3, second = 4): number[] {
  return [first, second, ...Array<number>(SEARCH_EMBEDDING_DIMENSIONS - 2).fill(0)];
}

export interface FakeOllamaRequest {
  readonly path: string;
  readonly method: string;
  readonly body: Record<string, unknown> | undefined;
}
export type FakeOllamaHandler = (request: FakeOllamaRequest, response: ServerResponse) => void | Promise<void>;

/** Loopback-only synthetic fixture; never probes the shared daemon or persists inputs. */
export async function startFakeSearchOllama() {
  const requests: FakeOllamaRequest[] = [];
  const state: { digest: string; handler: FakeOllamaHandler | undefined } = { digest: FAKE_EMBEDDING_DIGEST, handler: undefined };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const parts: Buffer[] = [];
      let bytes = 0;
      for await (const part of request) {
        bytes += Buffer.byteLength(part as Buffer);
        if (bytes > 512 * 1024) { response.writeHead(413).end(); return; }
        parts.push(Buffer.from(part as Buffer));
      }
      const body = parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown> : undefined;
      const entry = { path: request.url ?? "", method: request.method ?? "", body };
      requests.push(entry);
      if (state.handler) { await state.handler(entry, response); return; }
      response.setHeader("content-type", "application/json");
      if (entry.path === "/api/tags" && entry.method === "GET") {
        response.end(JSON.stringify({ models: [{ name: FAKE_EMBEDDING_MODEL, model: FAKE_EMBEDDING_MODEL, digest: state.digest }] }));
      } else if (entry.path === "/api/show" && entry.method === "POST") {
        response.end(JSON.stringify({ capabilities: ["embedding"] }));
      } else if (entry.path === "/api/embed" && entry.method === "POST") {
        const input = body?.input as string[];
        response.end(JSON.stringify({ model: FAKE_EMBEDDING_MODEL, embeddings: input.map(() => fakeSearchVector()) }));
      } else response.writeHead(404).end();
    })().catch(() => { response.destroy(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    state,
    close: async (): Promise<void> => {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
