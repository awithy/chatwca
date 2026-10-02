import { performance } from "node:perf_hooks";
import { SearchRepositoryError, type SearchRepositoryErrorCode } from "./errors.js";
import type { SearchDatabaseConnection, SearchDatabasePool } from "./migrations.js";

export const SEARCH_TRANSACTION_TIMEOUT_MS = 5_000;
export const SEARCH_DATABASE_CONNECT_TIMEOUT_MS = 3_000;
export interface SearchRepositoryOptions {
  readonly signal?: AbortSignal;
  /** Synchronous current-registration/invalidation seal; never perform provider or source IO here. */
  readonly assertCurrent?: () => undefined;
}
export interface SearchRepositoryTransaction {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

function safeError(error: unknown): SearchRepositoryError {
  if (error instanceof SearchRepositoryError) return error;
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  return new SearchRepositoryError(code === "57014" || code === "55P03" || code === "25P04" ? "search_timeout" : "search_database_unavailable");
}

/** Maintenance-only admission: one connection, no waiters; pool capacity stays reserved for retrieval. */
export class SearchRepositoryDatabase {
  private active: AbortController | undefined;
  private closed = false;
  constructor(private readonly pool: SearchDatabasePool, private readonly timeoutMs = SEARCH_TRANSACTION_TIMEOUT_MS) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > SEARCH_TRANSACTION_TIMEOUT_MS) {
      throw new SearchRepositoryError("search_index_invalid");
    }
  }

  close(): void {
    this.closed = true;
    this.active?.abort(new SearchRepositoryError("search_cancelled"));
  }

  async transaction<T>(
    work: (transaction: SearchRepositoryTransaction) => Promise<T>,
    options: SearchRepositoryOptions = {},
    readOnly = false,
  ): Promise<T> {
    if (this.closed || options.signal?.aborted) throw new SearchRepositoryError("search_cancelled");
    if (this.active) throw new SearchRepositoryError("search_busy");
    const controller = new AbortController();
    this.active = controller;
    const expiresAt = performance.now() + this.timeoutMs;
    const cancel = (code: SearchRepositoryErrorCode): void => controller.abort(new SearchRepositoryError(code));
    const callerAbort = (): void => cancel("search_cancelled");
    options.signal?.addEventListener("abort", callerAbort, { once: true });
    const timer = setTimeout(() => cancel("search_timeout"), this.timeoutMs);
    timer.unref();
    let connection: SearchDatabaseConnection | undefined;
    let released = false;
    let begun = false;
    let beginAttempted = false;
    let committing = false;
    let finished = false;
    const release = (destroy = false): void => {
      if (connection && !released) { released = true; connection.release(destroy); }
    };
    const destroy = (): void => release(true);
    controller.signal.addEventListener("abort", destroy, { once: true });
    const check = (): void => {
      if (finished) throw new SearchRepositoryError("search_cancelled");
      if (!controller.signal.aborted && performance.now() >= expiresAt) cancel("search_timeout");
      if (controller.signal.aborted) throw controller.signal.reason as SearchRepositoryError;
    };
    const wait = <R>(promise: Promise<R>): Promise<R> => new Promise<R>((resolve, reject) => {
      const abort = (): void => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
      if (controller.signal.aborted) abort();
    });
    const send = async (sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => {
      check();
      const result = await wait(connection!.query(sql, values));
      check();
      return result;
    };
    const remaining = (): string => `${Math.max(1, Math.ceil(expiresAt - performance.now()))}ms`;
    const transaction: SearchRepositoryTransaction = {
      query: async (sql, values) => {
        check();
        if (!begun || committing) throw new SearchRepositoryError("search_cancelled");
        // Limit each statement/lock to the remaining aggregate deadline too.
        await send("SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [remaining()]);
        if (!begun || committing) throw new SearchRepositoryError("search_cancelled");
        return send(sql, values);
      },
    };
    try {
      check();
      const connectTimer = setTimeout(() => cancel("search_timeout"), Math.min(this.timeoutMs, SEARCH_DATABASE_CONNECT_TIMEOUT_MS));
      connectTimer.unref();
      try {
        connection = await wait(this.pool.connect().then((client) => {
          if (controller.signal.aborted) { client.release(true); check(); }
          return client;
        }));
      } finally { clearTimeout(connectTimer); }
      check();
      beginAttempted = true;
      await send(readOnly ? "BEGIN READ ONLY" : "BEGIN");
      begun = true;
      // PostgreSQL 17 also enforces an aggregate server-side transaction deadline.
      await send("SELECT set_config('transaction_timeout', $1, true), set_config('statement_timeout', $1, true), set_config('lock_timeout', $1, true)", [remaining()]);
      options.assertCurrent?.();
      const result = await wait(work(transaction));
      check();
      options.assertCurrent?.();
      check();
      committing = true;
      await send("COMMIT");
      begun = false;
      return result;
    } catch (error) {
      if (begun && !committing && !controller.signal.aborted) {
        try { await send("ROLLBACK"); }
        catch { destroy(); }
      } else if (beginAttempted || controller.signal.aborted) destroy();
      throw safeError(controller.signal.aborted ? controller.signal.reason : error);
    } finally {
      finished = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", callerAbort);
      controller.signal.removeEventListener("abort", destroy);
      release();
      this.active = undefined;
    }
  }
}
