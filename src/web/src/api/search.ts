import { useCallback, useEffect, useRef, useState } from "react";
import type { SearchResponse, SearchStatus } from "../../../shared/search.js";

const errors: Readonly<Record<string, string>> = {
  search_query_invalid: "Enter a query of at most 2,048 characters (8 KiB).",
  search_scope_unavailable: "This workspace is no longer registered. Select another workspace or All.",
  search_busy: "Search is busy. Try again shortly.",
  search_timeout: "Search timed out. Try again.",
  search_initializing: "Search is initializing. Try again shortly.",
  search_disabled: "Search is disabled on this server.",
  search_schema_incompatible: "The search cache needs an administrator's migration.",
  search_cancelled: "Search was cancelled.",
};

async function request<T>(path: string, signal: AbortSignal, body?: object): Promise<T> {
  const response = await fetch(`/api/search${path}`, {
    signal, cache: "no-store",
    ...(body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: { code?: string } } | null;
    throw new Error(errors[failure?.error?.code ?? ""] ?? "Search is unavailable. Conversations and jobs are unaffected.");
  }
  return await response.json() as T;
}
function message(error: unknown): string {
  return error instanceof Error ? error.message : "Unable to reach search.";
}

/** Browser-memory state lives in App, not the mounted page. No query/excerpt persistence. */
export function useGlobalSearch(enabled: boolean, active: boolean) {
  const [query, setQuery] = useState("");
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [rerank, setRerank] = useState(true);
  const [response, setResponse] = useState<SearchResponse | null>(null);
  const [submitted, setSubmitted] = useState<{ query: string; workspaceId: string | null } | null>(null);
  const [status, setStatus] = useState<SearchStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  const [maintaining, setMaintaining] = useState(false);
  const [pollRevision, setPollRevision] = useState(0);
  const queryController = useRef<AbortController | null>(null);
  const maintenanceController = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    queryController.current?.abort(); queryController.current = null;
    setSearching(false);
  }, []);

  useEffect(() => {
    if (!enabled || !active) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll(): Promise<void> {
      let delay = 3_000;
      try {
        const next = await request<SearchStatus>("/status", AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]));
        if (controller.signal.aborted) return;
        setStatus(next); setStatusError(null);
        if (next.state === "ready" && !next.indexing && !next.indexer?.pending) delay = 15_000;
      } catch {
        if (controller.signal.aborted) return;
        setStatusError("Freshness status is unavailable. You can still try cached search.");
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), delay);
    }
    void poll();
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [enabled, active, pollRevision]);

  useEffect(() => {
    if (!active || !enabled) {
      cancel(); maintenanceController.current?.abort(); setMaintaining(false);
    }
    return () => { queryController.current?.abort(); maintenanceController.current?.abort(); };
  }, [active, enabled, cancel]);

  async function submit(): Promise<void> {
    cancel(); setError(null); setNotice(null);
    const text = query.trim();
    if (!text || [...text].length > 2_048 || new TextEncoder().encode(text).length > 8_192) {
      setError(errors.search_query_invalid!); return;
    }
    const controller = new AbortController(); queryController.current = controller;
    setSearching(true);
    try {
      const next = await request<SearchResponse>("", AbortSignal.any([controller.signal, AbortSignal.timeout(40_000)]), { query: text, workspaceId, rerank });
      if (controller.signal.aborted) return;
      setResponse(next); setSubmitted({ query: text, workspaceId });
    } catch (cause) {
      if (!controller.signal.aborted) setError(message(cause));
    } finally {
      if (queryController.current === controller) { queryController.current = null; setSearching(false); }
    }
  }
  async function maintain(action: "refresh" | "rebuild"): Promise<void> {
    if (maintenanceController.current && !maintenanceController.current.signal.aborted) return;
    const controller = new AbortController(); maintenanceController.current = controller;
    setMaintaining(true); setNotice(null); setError(null);
    try {
      await request("/" + action, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]), { workspaceId });
      if (controller.signal.aborted) return;
      setNotice(`${action === "rebuild" ? "Rebuild" : "Refresh"} queued. Cached results remain available; submit again after indexing for updated results.`);
      setPollRevision((value) => value + 1);
    } catch (cause) { if (!controller.signal.aborted) setError(message(cause)); }
    finally { if (maintenanceController.current === controller) { maintenanceController.current = null; setMaintaining(false); } }
  }
  return { query, setQuery, workspaceId, setWorkspaceId, rerank, setRerank, response, submitted, status, statusError, error, notice, searching, maintaining, cancel, submit, maintain };
}
export type GlobalSearchState = ReturnType<typeof useGlobalSearch>;
