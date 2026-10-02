import express, { type Express, type Request, type Response } from "express";
import { hasAllowedWebSocketOrigin } from "../websocket-boundary.js";
import type { SearchResponse } from "../../shared/search.js";
import { SearchQueryError, type SearchQueryErrorCode } from "./errors.js";
import { MAX_SEARCH_RESPONSE_BYTES } from "./query.js";
import type { SearchServicePort } from "./service.js";

function body(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new SearchQueryError("search_query_invalid");
  return value as Record<string, unknown>;
}
function workspace(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) throw new SearchQueryError("search_query_invalid");
  return value;
}
function failure(response: Response, code: SearchQueryErrorCode): void {
  const status = code === "search_query_invalid" ? 400 : code === "search_scope_unavailable" ? 404 :
    code === "search_busy" ? 429 : code === "search_timeout" ? 504 : 503;
  response.status(status).json({ error: { code } });
}

/** Same trusted-client/same-authority conventions as WS; direct clients without Origin remain supported. */
export function mountSearchRoutes(app: Express, service: SearchServicePort, accepting: () => boolean): void {
  const router = express.Router();
  router.use((request, response, next) => {
    response.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    if (!accepting()) { failure(response, "search_cancelled"); return; }
    if (!hasAllowedWebSocketOrigin(request) || request.headers["sec-fetch-site"] === "cross-site") { response.status(403).json({ error: { code: "search_origin_rejected" } }); return; }
    next();
  });
  router.use(express.json({ limit: "32kb", strict: true, type: "application/json" }));
  const run = async (request: Request, response: Response, action: (signal: AbortSignal) => Promise<unknown>): Promise<void> => {
    const controller = new AbortController();
    const abort = (): void => { if (!response.writableEnded) controller.abort(); };
    request.once("aborted", abort); response.once("close", abort);
    try {
      const result = await action(controller.signal);
      if (!controller.signal.aborted && !response.destroyed) response.json(result);
    } catch (error) {
      if (!controller.signal.aborted && !response.destroyed) failure(response, error instanceof SearchQueryError ? error.code : "search_database_unavailable");
    } finally { request.off("aborted", abort); response.off("close", abort); }
  };
  router.get("/status", (request, response) => run(request, response, (signal) => service.status({ signal })));
  router.post("/", (request, response) => run(request, response, async (signal) => {
    const input = body(request.body, ["query", "workspaceId", "limit", "rerank"]);
    if (typeof input.query !== "string" || (input.limit !== undefined && (typeof input.limit !== "number" || !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20)) ||
        (input.rerank !== undefined && typeof input.rerank !== "boolean")) throw new SearchQueryError("search_query_invalid");
    const result = await service.search({ query: input.query, workspaceId: workspace(input.workspaceId), ...(input.limit === undefined ? {} : { limit: input.limit as number }),
      rerank: input.rerank !== false }, { signal });
    const responseBody = { ...result, freshness: service.freshness() } satisfies SearchResponse;
    // Account for added status/feature metadata in the same hard public response bound.
    const results = [...result.results]; responseBody.results = results;
    while (Buffer.byteLength(JSON.stringify(responseBody)) > MAX_SEARCH_RESPONSE_BYTES && results.length) results.pop();
    return responseBody;
  }));
  for (const action of ["refresh", "rebuild"] as const) {
    router.post(`/${action}`, (request, response) => {
      try {
        const input = body(request.body, ["workspaceId"]);
        service.requestRefresh({ workspaceId: workspace(input.workspaceId), rebuild: action === "rebuild" });
        response.status(202).json({ accepted: true });
      } catch (error) { failure(response, error instanceof SearchQueryError ? error.code : "search_database_unavailable"); }
    });
  }
  // Body-parser diagnostics may include source input. Never use Express's default diagnostic response here.
  router.use((_error: unknown, _request: Request, response: Response, _next: express.NextFunction) => failure(response, "search_query_invalid"));
  app.use("/api/search", router);
}
