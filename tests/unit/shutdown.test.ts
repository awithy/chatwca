import { describe, expect, it, vi } from "vitest";

import { GracefulShutdown } from "../../src/server/shutdown.js";

function deferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve: () => resolve?.() };
}

describe("GracefulShutdown", () => {
  it("orders admission, notification, abort, disposal, and transport cleanup", async () => {
    const calls: string[] = [];
    const shutdown = new GracefulShutdown({
      gracePeriodMs: 100,
      beginShutdown: () => calls.push("reject"),
      stopAccepting: () => calls.push("stop-accepting"),
      notifyAndCloseClients: () => calls.push("notify-clients"),
      closeTransports: async () => {
        calls.push("close-transports");
      },
      abortActive: async () => {
        calls.push("abort-active");
      },
      disposeRuntimes: async () => {
        calls.push("dispose-runtimes");
      },
      disposeListeners: () => calls.push("dispose-listeners"),
      forceClose: () => calls.push("force-close"),
      wait: () => new Promise(() => undefined),
    });

    const first = shutdown.shutdown();
    const second = shutdown.shutdown();
    expect(first).toBe(second);
    await first;

    expect(calls).toEqual([
      "reject",
      "stop-accepting",
      "notify-clients",
      "close-transports",
      "abort-active",
      "dispose-runtimes",
      "dispose-listeners",
    ]);
  });

  it("forces cleanup at the deadline even when abort and transport promises hang", async () => {
    const deadline = deferred();
    const abort = deferred();
    const transports = deferred();
    const disposeRuntimes = vi.fn(() => new Promise<void>(() => undefined));
    const forceClose = vi.fn();
    const disposeListeners = vi.fn();
    const shutdown = new GracefulShutdown({
      gracePeriodMs: 25,
      beginShutdown: vi.fn(),
      stopAccepting: vi.fn(),
      notifyAndCloseClients: vi.fn(),
      closeTransports: () => transports.promise,
      abortActive: () => abort.promise,
      disposeRuntimes,
      disposeListeners,
      forceClose,
      wait: (milliseconds) => {
        expect(milliseconds).toBe(25);
        return deadline.promise;
      },
    });

    const completion = shutdown.shutdown();
    expect(disposeRuntimes).not.toHaveBeenCalled();
    deadline.resolve();
    await completion;

    expect(disposeRuntimes).toHaveBeenCalledOnce();
    expect(forceClose).toHaveBeenCalledOnce();
    expect(disposeListeners).toHaveBeenCalledOnce();
  });
});
