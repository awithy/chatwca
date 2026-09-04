import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import { PiConversationRuntime } from "../../src/server/pi-runtime.js";
import { compileDestinationPolicy } from "../../src/server/network/policy.js";
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

const managedPolicySet = Object.freeze({
  id: "default",
  label: "Default",
  allowedDomainPatterns: Object.freeze(["example.com"]),
  allowedPorts: Object.freeze([443]),
  destinationPolicy: compileDestinationPolicy({
    allowedDomainPatterns: ["example.com"],
    deniedDomainPatterns: [],
    allowedPorts: [443],
  }),
});

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
    await controller.waitUntilReady();
    expect(first.invalidate).toHaveBeenCalledTimes(1); expect(exec).toHaveBeenCalledTimes(1);
    expect(createWorker).toHaveBeenCalledTimes(2); expect(controller.state).toBe("healthy");
    await controller.close();
  });

  it("lets a timed-out tool settle before Pi abort settlement and completes replacement", async () => {
    const signal = new AbortController();
    const toolSettled = deferred();
    const first = worker({ exec: vi.fn(() => new Promise<never>(() => undefined)) });
    const second = worker();
    const createWorker = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const abortActiveRun = vi.fn(async () => {
      signal.abort(new Error("Pi abort"));
      await toolSettled.promise;
    });
    const controller = await SandboxController.start({
      createWorker,
      commandTimeoutMs: 15,
      abortActiveRun,
      waitForPiIdle: vi.fn(),
      onFatal: vi.fn(),
    });

    const operation = controller.exec(
      { command: "sleep forever", timeoutMs: 60_000 },
      { signal: signal.signal },
    ).finally(toolSettled.resolve);
    await expect(operation).rejects.toEqual(new SandboxWorkerOperationError("timeout"));
    await controller.waitUntilReady();

    expect(abortActiveRun).toHaveBeenCalledOnce();
    expect(first.invalidate).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(controller.state).toBe("healthy");
    await controller.close();
  });

  it("rejects an active tool without waiting on the externally initiated abort transition", async () => {
    const signal = new AbortController();
    const piAbortSettled = deferred();
    const abortReason = new Error("operator abort");
    const first = worker({ exec: vi.fn(() => new Promise<never>(() => undefined)) });
    const second = worker();
    const createWorker = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const controller = await SandboxController.start({
      createWorker,
      commandTimeoutMs: 60_000,
      abortActiveRun: async () => {
        signal.abort(abortReason);
        await piAbortSettled.promise;
      },
      waitForPiIdle: vi.fn(),
      onFatal: vi.fn(),
    });

    const operation = controller.exec(
      { command: "sleep forever", timeoutMs: 60_000 },
      { signal: signal.signal },
    );
    await vi.waitFor(() => expect(first.exec).toHaveBeenCalledOnce());
    const restarting = controller.abort();

    await expect(operation).rejects.toBe(abortReason);
    expect(controller.state).toBe("restarting");
    piAbortSettled.resolve();
    await restarting;

    expect(first.invalidate).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledTimes(2);
    expect(controller.state).toBe("healthy");
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

  it("terminally fails during a restart and never creates a post-proxy replacement", async () => {
    const idle = deferred();
    const first = worker();
    const createWorker = vi.fn(async () => first);
    const onFatal = vi.fn();
    const controller = await SandboxController.start({
      createWorker,
      commandTimeoutMs: 1_000,
      abortActiveRun: vi.fn(),
      waitForPiIdle: () => idle.promise,
      onFatal,
    });

    const restarting = controller.abort();
    await vi.waitFor(() => expect(first.invalidate).toHaveBeenCalled());
    const proxyFailure = new AppError(ERROR_CODES.NETWORK_PROXY_FAILED);
    controller.failTerminal(proxyFailure);
    expect(controller.state).toBe("error");
    await expect(controller.health()).rejects.toMatchObject({
      code: ERROR_CODES.SANDBOX_WORKER_FAILED,
    });
    idle.resolve();
    await expect(restarting).rejects.toBe(proxyFailure);
    await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith({
      error: proxyFailure,
      diagnostic: "",
    }));
    expect(createWorker).toHaveBeenCalledTimes(1);
    await controller.close();
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

  it("propagates a parent proxy fatal through Pi without retry or weaker fallback", async () => {
    const active = worker();
    const createWorker = vi.fn(async () => active);
    const abortPi = vi.fn(async () => undefined);
    const waitForIdle = vi.fn(async () => undefined);
    const controller = await SandboxController.start({
      createWorker,
      commandTimeoutMs: 1_000,
      abortActiveRun: abortPi,
      waitForPiIdle: waitForIdle,
      onFatal: vi.fn(),
    });
    let proxyFatal!: (error: AppError) => void;
    const managed = {
      httpSocketPath: "/private/one/http.sock",
      socksSocketPath: "/private/one/socks.sock",
      policySetId: "default",
      policySet: managedPolicySet,
      subscribeBlocked: vi.fn(() => () => undefined),
      onFatal: vi.fn((listener: (error: AppError) => void) => {
        proxyFatal = listener;
        return () => undefined;
      }),
      close: vi.fn(async () => undefined),
      forceClose: vi.fn(),
    };
    const sdkRuntime = {
      session: { prompt: vi.fn(async () => undefined) },
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } as unknown as AgentSessionRuntime;
    const runtime = new PiConversationRuntime(
      sdkRuntime,
      "workspace-sandboxed",
      controller,
      "managed-egress",
      managed,
      "default",
      managedPolicySet,
    );
    const fatal = vi.fn();
    runtime.onFatalFailure(fatal);
    expect(runtime.networkPolicySetId).toBe("default");
    expect(runtime.networkPolicySet).toBe(managedPolicySet);

    const failure = new AppError(ERROR_CODES.NETWORK_PROXY_FAILED);
    proxyFatal(failure);
    expect(controller.state).toBe("error");
    await expect(runtime.prompt("never accepted after proxy failure")).rejects.toMatchObject({
      code: ERROR_CODES.SANDBOX_WORKER_FAILED,
    });
    await vi.waitFor(() => expect(fatal).toHaveBeenCalledWith(failure));
    expect(active.invalidate).toHaveBeenCalledOnce();
    expect(abortPi).toHaveBeenCalledOnce();
    expect(waitForIdle).toHaveBeenCalledOnce();
    expect(createWorker).toHaveBeenCalledTimes(1);
    expect(sdkRuntime.session.prompt).not.toHaveBeenCalled();
    await runtime.dispose();
    expect(managed.close).toHaveBeenCalledOnce();
  });

  it("disposes Pi, worker/bridges, and managed network concurrently", async () => {
    const piGate = deferred();
    const workerGate = deferred();
    const networkGate = deferred();
    const active = worker({ close: vi.fn(() => workerGate.promise) });
    const controller = await SandboxController.start({
      createWorker: async () => active,
      commandTimeoutMs: 1_000,
      abortActiveRun: vi.fn(),
      waitForPiIdle: vi.fn(),
      onFatal: vi.fn(),
    });
    const sdkRuntime = {
      session: {},
      setBeforeSessionInvalidate: vi.fn(),
      setRebindSession: vi.fn(),
      dispose: vi.fn(() => piGate.promise),
    } as unknown as AgentSessionRuntime;
    const managed = {
      httpSocketPath: "/private/http.sock",
      socksSocketPath: "/private/socks.sock",
      policySetId: "default",
      policySet: managedPolicySet,
      subscribeBlocked: vi.fn(() => () => undefined),
      onFatal: vi.fn(() => () => undefined),
      close: vi.fn(() => networkGate.promise),
      forceClose: vi.fn(),
    };
    const runtime = new PiConversationRuntime(
      sdkRuntime,
      "workspace-sandboxed",
      controller,
      "managed-egress",
      managed,
      "default",
      managedPolicySet,
    );

    expect(runtime.networkPolicySetId).toBe("default");
    expect(runtime.networkPolicySet).toBe(managedPolicySet);
    const disposal = runtime.dispose();
    expect(sdkRuntime.dispose).toHaveBeenCalledOnce();
    expect(active.close).toHaveBeenCalledOnce();
    expect(managed.close).toHaveBeenCalledOnce();
    expect(runtime.teardownComplete).toBe(false);
    piGate.resolve();
    workerGate.resolve();
    networkGate.resolve();
    await disposal;
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
