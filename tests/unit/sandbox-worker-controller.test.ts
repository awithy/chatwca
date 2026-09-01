import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import { PiConversationRuntime } from "../../src/server/pi-runtime.js";
import {
  SandboxController,
  type SandboxControllerWorkerPort,
} from "../../src/server/sandbox/worker-controller.js";
import { SandboxWorkerOperationError, type SandboxWorkerFatal } from "../../src/server/sandbox/worker-client.js";

function worker(overrides: Partial<SandboxControllerWorkerPort> = {}): SandboxControllerWorkerPort {
  const failed = () => Promise.reject(new Error("unused"));
  return {
    readFile: failed, writeFile: failed, editFile: failed, listDirectory: failed,
    grep: failed, find: failed, exec: failed, health: async () => ({ healthy: true }),
    close: vi.fn(async () => undefined), invalidate: vi.fn(async () => undefined), ...overrides,
  } as SandboxControllerWorkerPort;
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve };
}

const failure: SandboxWorkerFatal = {
  error: new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED), diagnostic: "private",
};

describe("SandboxController fail-closed lifecycle", () => {
  it("tears down a worker that reports fatal failure during startup", async () => {
    const active = worker();
    const createWorker = vi.fn(async (onFatal: (value: SandboxWorkerFatal) => void) => {
      onFatal(failure);
      return active;
    });

    await expect(SandboxController.start({
      createWorker,
      commandTimeoutMs: 1_000,
      abortActiveRun: vi.fn(),
      waitForPiIdle: vi.fn(),
      onFatal: vi.fn(),
    })).rejects.toMatchObject({ code: ERROR_CODES.SANDBOX_WORKER_START_FAILED });
    expect(active.invalidate).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledOnce();
  });

  it("keeps healthy operation failures on the same worker", async () => {
    const operationError = new SandboxWorkerOperationError("not_found");
    const first = worker({ readFile: vi.fn(async () => { throw operationError; }) });
    const createWorker = vi.fn(async () => first); const abort = vi.fn(); const fatal = vi.fn();
    const controller = await SandboxController.start({
      createWorker, commandTimeoutMs: 1_000, abortActiveRun: abort,
      waitForPiIdle: vi.fn(), onFatal: fatal,
    });
    await expect(controller.readFile({ path: "missing", maxBytes: 10, detectMime: false })).rejects.toBe(operationError);
    expect(await controller.health()).toEqual({ healthy: true });
    expect(controller.state).toBe("healthy"); expect(createWorker).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled(); expect(fatal).not.toHaveBeenCalled();
    await controller.close();
  });

  it("tears down, settles Pi, and handshakes one replacement for coalesced aborts", async () => {
    const order: string[] = []; const first = worker({ invalidate: vi.fn(async () => { order.push("invalidate"); }) });
    const second = worker(); let calls = 0;
    const createWorker = vi.fn(async () => { calls += 1; order.push(`start-${calls}`); return calls === 1 ? first : second; });
    const controller = await SandboxController.start({
      createWorker, commandTimeoutMs: 1_000,
      abortActiveRun: async () => { order.push("abort-pi"); },
      waitForPiIdle: async () => { order.push("idle"); }, onFatal: vi.fn(),
    });
    await Promise.all([controller.abort(), controller.abort(), controller.abort()]);
    expect(order).toEqual(["start-1", "invalidate", "abort-pi", "idle", "start-2"]);
    expect(controller.state).toBe("healthy"); expect(await controller.health()).toEqual({ healthy: true });
    await controller.close();
  });

  it("uses the lower hard deadline, tears down the namespace, and never retries the command", async () => {
    const exec = vi.fn(() => new Promise<never>(() => undefined)); const first = worker({ exec }); const second = worker();
    const createWorker = vi.fn(); createWorker.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const controller = await SandboxController.start({
      createWorker, commandTimeoutMs: 15, abortActiveRun: vi.fn(), waitForPiIdle: vi.fn(), onFatal: vi.fn(),
    });
    await expect(controller.exec({ command: "sleep forever", timeoutMs: 60_000 })).rejects.toEqual(new SandboxWorkerOperationError("timeout"));
    expect(first.invalidate).toHaveBeenCalledTimes(1); expect(exec).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledTimes(2); expect(controller.state).toBe("healthy");
    await controller.close();
  });

  it("reports a fatal worker only after Pi settles and never starts a replacement", async () => {
    const idle = deferred(); const active = worker(); let workerFatal!: (value: SandboxWorkerFatal) => void;
    const createWorker = vi.fn(async (callback: (value: SandboxWorkerFatal) => void) => { workerFatal = callback; return active; });
    const abort = vi.fn(); const onFatal = vi.fn();
    const controller = await SandboxController.start({
      createWorker, commandTimeoutMs: 1_000, abortActiveRun: abort,
      waitForPiIdle: () => idle.promise, onFatal,
    });
    workerFatal(failure); workerFatal(failure);
    await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(1));
    expect(controller.state).toBe("error");
    expect(onFatal).not.toHaveBeenCalled(); expect(createWorker).toHaveBeenCalledTimes(1);
    await expect(controller.health()).rejects.toMatchObject({ code: "sandbox_worker_failed" });
    idle.resolve(); await vi.waitFor(() => expect(onFatal).toHaveBeenCalledTimes(1));
    expect(onFatal).toHaveBeenCalledWith(failure);
    await controller.close();
  });

  it("rejects prompts during replacement and coalesces runtime aborts", async () => {
    const first = worker();
    const replacement = worker();
    const idle = deferred();
    const createWorker = vi.fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(replacement);
    const controller = await SandboxController.start({
      createWorker,
      commandTimeoutMs: 1_000,
      abortActiveRun: vi.fn(),
      waitForPiIdle: () => idle.promise,
      onFatal: vi.fn(),
    });
    const prompt = vi.fn(async () => undefined);
    const sdkRuntime = {
      session: { prompt },
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentSessionRuntime;
    const runtime = new PiConversationRuntime(
      sdkRuntime,
      "workspace-sandboxed",
      controller,
    );

    const firstAbort = runtime.abort();
    const repeatedAbort = runtime.abort();
    await expect(runtime.prompt("blocked while replacing")).rejects.toMatchObject({
      code: ERROR_CODES.SANDBOX_WORKER_FAILED,
    });
    expect(prompt).not.toHaveBeenCalled();
    idle.resolve();
    await Promise.all([firstAbort, repeatedAbort]);
    expect(createWorker).toHaveBeenCalledTimes(2);
    await expect(runtime.prompt("ready again")).resolves.toBeUndefined();
    await runtime.dispose();
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("starts worker teardown even when Pi disposal fails", async () => {
    const active = worker();
    const controller = await SandboxController.start({
      createWorker: async () => active,
      commandTimeoutMs: 1_000,
      abortActiveRun: vi.fn(),
      waitForPiIdle: vi.fn(),
      onFatal: vi.fn(),
    });
    const piFailure = new Error("Pi disposal failed");
    const sdkRuntime = {
      session: {},
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      dispose: vi.fn(async () => { throw piFailure; }),
    } as unknown as AgentSessionRuntime;
    const runtime = new PiConversationRuntime(
      sdkRuntime,
      "workspace-sandboxed",
      controller,
    );

    await expect(runtime.dispose()).rejects.toBe(piFailure);
    expect(active.close).toHaveBeenCalledOnce();
    expect(runtime.disposed).toBe(true);
    expect(runtime.teardownComplete).toBe(true);
  });

  it("transitions to error when replacement handshake fails and does not fallback", async () => {
    const first = worker(); const createWorker = vi.fn();
    createWorker.mockResolvedValueOnce(first).mockRejectedValueOnce(new Error("bwrap unavailable"));
    const onFatal = vi.fn();
    const controller = await SandboxController.start({
      createWorker, commandTimeoutMs: 1_000, abortActiveRun: vi.fn(), waitForPiIdle: vi.fn(), onFatal,
    });
    await expect(controller.abort()).rejects.toMatchObject({ code: "sandbox_worker_start_failed" });
    expect(controller.state).toBe("error"); expect(createWorker).toHaveBeenCalledTimes(2);
    expect(onFatal).toHaveBeenCalledTimes(1);
    await expect(controller.health()).rejects.toMatchObject({ code: "sandbox_worker_failed" });
    await controller.close();
  });
});
