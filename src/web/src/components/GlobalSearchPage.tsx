import { useState } from "react";
import type { WorkspaceSummary } from "../../../shared/protocol.js";
import type { SearchConversationResult, SearchExcerpt, SearchResponse } from "../../../shared/search.js";
import type { GlobalSearchState } from "../api/search.js";

export interface GlobalSearchPageProps {
  readonly search: GlobalSearchState;
  readonly rerankAvailable: boolean;
  readonly workspaces: readonly WorkspaceSummary[];
  readonly onOpenConversations: () => void;
  readonly onOpenJobs: () => void;
  readonly onOpenResult: (result: SearchConversationResult, excerpt: SearchExcerpt) => Promise<boolean>;
}
function date(timestamp: number | null): string {
  return timestamp === null ? "Not yet reconciled" : new Date(timestamp).toLocaleString();
}

const rerankReasons: Readonly<Record<string, string>> = {
  unsupported_model: "configured model is unsupported",
  unavailable: "Pi reranking is unavailable",
  input_limit: "excerpts exceed reranking limits",
  invalid_response: "Pi returned an invalid ordering",
  timeout: "Pi reranking timed out",
};
function rerankLabel(rerank: SearchResponse["rerank"]): string {
  if (rerank.applied) return "Pi reranking applied";
  if (!rerank.requested) return "Local ordering — Pi reranking off";
  if (rerank.reason === "too_few_candidates") return "Local ordering — too few matches to rerank";
  return `Local fallback — ${rerankReasons[rerank.reason] ?? "Pi reranking was not applied"}`;
}

export function GlobalSearchPage({ search, rerankAvailable, workspaces, onOpenConversations, onOpenJobs, onOpenResult }: GlobalSearchPageProps) {
  const [opening, setOpening] = useState(false);
  const [stale, setStale] = useState(false);
  const { status, response, submitted } = search;
  const workspaceMissing = search.workspaceId !== null && !workspaces.some((workspace) => workspace.id === search.workspaceId);
  async function open(result: SearchConversationResult, excerpt: SearchExcerpt): Promise<void> {
    setOpening(true); setStale(false);
    try { if (!await onOpenResult(result, excerpt)) setStale(true); }
    finally { setOpening(false); }
  }
  return (
    <main className="search-page">
      <nav className="search-mobile-navigation" aria-label="Mobile application sections">
        <button type="button" onClick={onOpenConversations}>Conversations</button>
        <button type="button" onClick={onOpenJobs}>Jobs</button>
        <button type="button" aria-current="page">Global Search</button>
      </nav>
      <header className="search-header">
        <p className="eyebrow">Saved conversations</p>
        <h1>Global Search</h1>
        <p>Search saved user and assistant text. Results are cached; sources may have changed since indexing.</p>
      </header>
      <form className="search-form" aria-label="Search conversations" onSubmit={(event) => { event.preventDefault(); void search.submit(); }}>
        <label>Query
          <input type="search" value={search.query} onChange={(event) => search.setQuery(event.target.value)} placeholder="Find a message or topic" />
        </label>
        <div className="search-workspace-field">
          <label htmlFor="global-search-workspace">Workspace</label>
          <select id="global-search-workspace" value={search.workspaceId ?? ""} onChange={(event) => search.setWorkspaceId(event.target.value || null)}>
            <option value="">All workspaces</option>
            {workspaceMissing && <option value={search.workspaceId!}>Removed workspace</option>}
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </div>
        <button type="submit" disabled={!search.query.trim() || workspaceMissing}>{search.searching ? "Search again" : "Search"}</button>
        {search.searching && <button type="button" onClick={search.cancel}>Cancel search</button>}
        <div className="search-rerank">
          <label><input type="checkbox" checked={search.rerank} onChange={(event) => search.setRerank(event.target.checked)} aria-describedby="search-rerank-help" /> Pi reranking</label>
          <p id="search-rerank-help">{rerankAvailable ? "When on, sends the query and selected excerpts to the configured Pi provider." : "Currently unavailable; local results remain usable. When available and on, sends the query and selected excerpts to the configured Pi provider."}</p>
        </div>
      </form>
      <section className="search-status" aria-label="Search index status">
        <div role="status">
          <strong>{status === null ? "Checking search status…" : status.state === "ready" ? "Local search ready" : status.state === "initializing" ? "Search initializing…" : "Search unavailable — cached queries may still work"}</strong>
          <p>Last successful reconciliation: {date(status?.lastSucceededAt ?? null)}</p>
          {status?.counts && <p>{status.counts.documents} conversations · {status.counts.chunks} chunks cached across registered workspaces</p>}
          {status?.indexing && status.indexer && <p>Indexing: {status.indexer.progress.discovered} discovered · {status.indexer.progress.published} updated · {status.indexer.progress.unchanged} unchanged · {status.indexer.progress.failed} failed</p>}
          {status?.indexer?.pending && <p>Another indexing pass is queued.</p>}
          {(status?.errorCount ?? 0) > 0 && <p>{status!.errorCount} indexing/dependency errors. Previous cached excerpts may remain. Refresh retries failed work.</p>}
          {status?.errorCode === "search_schema_incompatible" && <p>The search cache needs an administrator's migration.</p>}
          {search.statusError && <p>{search.statusError}</p>}
        </div>
        <div className="search-maintenance">
          <button type="button" disabled={search.maintaining || workspaceMissing} onClick={() => void search.maintain("refresh")}>Refresh index</button>
          <button type="button" disabled={search.maintaining || workspaceMissing} onClick={() => {
            const scope = workspaces.find((workspace) => workspace.id === search.workspaceId)?.name ?? "all registered workspaces";
            if (window.confirm(`Rebuild the search cache for ${scope}? Saved conversations are not changed. Existing results remain available while files are reread.`)) void search.maintain("rebuild");
          }}>Rebuild index</button>
        </div>
      </section>
      {workspaceMissing && <p role="alert" className="page-error">This workspace was removed. Select All or another workspace.</p>}
      {search.error && <p role="alert" className="page-error">{search.error}</p>}
      {search.notice && <p role="status">{search.notice}</p>}
      {stale && <p role="alert" className="page-error">Conversation unavailable. This cached result may be stale or deleted. Refresh the index or try another result.</p>}
      {search.searching && <p role="status">Searching saved conversations…</p>}
      {response && submitted && (
        <section className="search-results" aria-label="Search results">
          <h2>Results for “{submitted.query}”</h2>
          <p>{submitted.workspaceId === null ? "All workspaces" : workspaces.find((workspace) => workspace.id === submitted.workspaceId)?.name ?? "Removed workspace"} · {response.mode === "hybrid" ? "Local hybrid search" : "Lexical search only"} · Cached results</p>
          <p role="status">{rerankLabel(response.rerank)}</p>
          {response.warnings.length > 0 && <p role="status">Semantic search unavailable; showing local lexical results.</p>}
          <p>At query time: last successful reconciliation {date(response.freshness.lastSucceededAt)}{response.freshness.errorCount > 0 ? ` · ${response.freshness.errorCount} indexing/dependency errors` : ""}.</p>
          {!response.results.length && <p>No matching saved conversations. Try different words, All workspaces, or refresh the index.</p>}
          <ol className="search-result-list">
            {response.results.map((result) => (
              <li key={JSON.stringify([result.workspaceId, result.sessionId])}>
                <article className="search-result">
                  <h3>{result.title || "Untitled conversation"}</h3>
                  <p>{result.workspaceName} · Modified {date(result.modifiedAt)}</p>
                  {result.excerpts.map((excerpt, index) => (
                    <div className="search-excerpt" key={`${excerpt.entryId}-${index}`}>
                      <p>{excerpt.role === "user" ? "You" : "Assistant"} · {date(excerpt.timestamp)} · Indexed {date(excerpt.indexedAt)}</p>
                      <p className="search-excerpt-text">{excerpt.text}{excerpt.truncated && <span aria-label="Excerpt truncated">…</span>}</p>
                      <button type="button" disabled={opening} onClick={() => void open(result, excerpt)}>Open matching message</button>
                    </div>
                  ))}
                </article>
              </li>
            ))}
          </ol>
        </section>
      )}
    </main>
  );
}
