import { AppError, ERROR_CODES } from "../../shared/errors.js";
import type {
  EditFileArguments,
  EditFileResult,
  ExecArguments,
  ExecResult,
  FindArguments,
  FindResult,
  GrepArguments,
  GrepResult,
  HealthResult,
  ListDirectoryArguments,
  ListDirectoryResult,
  ReadFileArguments,
  ReadFileResult,
  WriteFileResult,
} from "./protocol.js";
import {
  SandboxWorkerOperationError,
  type SandboxCallOptions,
  type SandboxExecOptions,
  type SandboxWorkerFatal,
} from "./worker-client.js";

export type SandboxControllerState = "healthy" | "restarting" | "error" | "closed";
export interface SandboxControllerWorkerPort {
  readFile(arguments_: Readonly<ReadFileArguments>, options?: SandboxCallOptions): Promise<ReadFileResult>;
  writeFile(path: string, data: Buffer | string, options?: SandboxCallOptions & { readonly createParents?: boolean }): Promise<WriteFileResult>;
  editFile(arguments_: Readonly<EditFileArguments>, options?: SandboxCallOptions): Promise<EditFileResult>;
  listDirectory(arguments_: Readonly<ListDirectoryArguments>, options?: SandboxCallOptions): Promise<ListDirectoryResult>;
  grep(arguments_: Readonly<GrepArguments>, options?: SandboxCallOptions): Promise<GrepResult>;
  find(arguments_: Readonly<FindArguments>, options?: SandboxCallOptions): Promise<FindResult>;
  exec(arguments_: Readonly<ExecArguments>, options?: SandboxExecOptions): Promise<ExecResult>;
  health(options?: SandboxCallOptions): Promise<HealthResult>;
  /** Bounded graceful shutdown followed by forced namespace teardown. */
  close(): Promise<void>;
  /** Immediate namespace teardown for abort, timeout, and fatal failure. */
  invalidate(): Promise<void>;
}
export type SandboxControllerWorkerFactory = (
  onFatal: (failure: Readonly<SandboxWorkerFatal>) => void,
) => Promise<SandboxControllerWorkerPort>;

export interface SandboxControllerOptions {
  readonly createWorker: SandboxControllerWorkerFactory;
  readonly commandTimeoutMs: number;
  /** Abort the active Pi run. This callback must never execute tools itself. */
  readonly abortActiveRun: () => void | Promise<void>;
  /** Resolves only after Pi has settled from the abort/fatal tool rejection. */
  readonly waitForPiIdle: () => void | Promise<void>;
  /** Registry/runtime notification after Pi settles and the state is terminal. */
  readonly onFatal: (failure: Readonly<SandboxWorkerFatal>) => void;
}

/**
 * Stable tool-facing ownership for a replaceable sandbox worker.
 * No state transition invokes an unrestricted implementation or retries an operation.
 */
export class SandboxController {
  readonly #options: SandboxControllerOptions;
  #worker: SandboxControllerWorkerPort;
  #state: SandboxControllerState = "healthy";
  #transition: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #pendingTerminalFailure: Readonly<SandboxWorkerFatal> | undefined;
  #fatalFailure: Readonly<SandboxWorkerFatal> | undefined;
  readonly #fatalListeners = new Set<(failure: Readonly<SandboxWorkerFatal>) => void>();

  private constructor(options: SandboxControllerOptions, worker: SandboxControllerWorkerPort) {
    this.#options = options; this.#worker = worker;
  }

  static async start(options: SandboxControllerOptions): Promise<SandboxController> {
    let controller: SandboxController | undefined;
    let startupFatal: Readonly<SandboxWorkerFatal> | undefined;
    const worker = await options.createWorker((failure) => {
      if (controller === undefined) startupFatal = failure;
      else controller.#workerFatal(failure);
    });
    if (startupFatal !== undefined) {
      await worker.invalidate().catch(() => undefined);
      throw new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED, { cause: startupFatal.error });
    }
    controller = new SandboxController(options, worker);
    return controller;
  }

  get state(): SandboxControllerState { return this.#state; }

  /** Resolves only when a replacement worker has completed its handshake. */
  async waitUntilReady(): Promise<void> {
    await this.#current();
  }

  /** Fatal notifications are terminal and replayed to late runtime subscribers. */
  onFatalFailure(listener: (failure: Readonly<SandboxWorkerFatal>) => void): () => void {
    this.#fatalListeners.add(listener);
    if (this.#fatalFailure !== undefined) listener(this.#fatalFailure);
    return () => this.#fatalListeners.delete(listener);
  }

  /**
   * Enter the terminal fail-closed state for a parent-owned dependency such as
   * the managed network proxy. This transition is synchronous at admission:
   * no tool call or planned restart can select a replacement afterward.
   */
  failTerminal(error: AppError): void {
    this.#terminalFailure({ error, diagnostic: "" });
  }

  async readFile(arguments_: Readonly<ReadFileArguments>, options?: SandboxCallOptions): Promise<ReadFileResult> {
    return (await this.#current()).readFile(arguments_, options);
  }
  async writeFile(path: string, data: Buffer | string, options?: SandboxCallOptions & { readonly createParents?: boolean }): Promise<WriteFileResult> {
    return (await this.#current()).writeFile(path, data, options);
  }
  async editFile(arguments_: Readonly<EditFileArguments>, options?: SandboxCallOptions): Promise<EditFileResult> {
    return (await this.#current()).editFile(arguments_, options);
  }
  async listDirectory(arguments_: Readonly<ListDirectoryArguments>, options?: SandboxCallOptions): Promise<ListDirectoryResult> {
    return (await this.#current()).listDirectory(arguments_, options);
  }
  async grep(arguments_: Readonly<GrepArguments>, options?: SandboxCallOptions): Promise<GrepResult> {
    return (await this.#current()).grep(arguments_, options);
  }
  async find(arguments_: Readonly<FindArguments>, options?: SandboxCallOptions): Promise<FindResult> {
    return (await this.#current()).find(arguments_, options);
  }
  async health(options?: SandboxCallOptions): Promise<HealthResult> {
    return (await this.#current()).health(options);
  }

  async exec(arguments_: Readonly<ExecArguments>, options: SandboxExecOptions = {}): Promise<ExecResult> {
    const worker = await this.#current();
    const timeoutMs = Math.min(arguments_.timeoutMs, this.#options.commandTimeoutMs);
    let timer: NodeJS.Timeout | undefined; let removeAbort: (() => void) | undefined;
    let invalidate!: (reason: "timeout" | "abort") => void;
    const planned = new Promise<"timeout" | "abort">((resolve) => { invalidate = resolve; });
    timer = setTimeout(() => invalidate("timeout"), timeoutMs);
    if (options.signal !== undefined) {
      const abort = () => invalidate("abort");
      options.signal.addEventListener("abort", abort, { once: true });
      removeAbort = () => options.signal?.removeEventListener("abort", abort);
      if (options.signal.aborted) invalidate("abort");
    }
    const operation = worker.exec({ ...arguments_, timeoutMs }, options);
    // The namespace teardown rejects this promise; observe it even when the planned branch wins.
    void operation.catch(() => undefined);
    try {
      const outcome = await Promise.race([
        operation.then((result) => ({ kind: "result" as const, result })),
        planned.then((reason) => ({ kind: "planned" as const, reason })),
      ]);
      if (outcome.kind === "result") return outcome.result;
      await this.#plannedRestart();
      if (outcome.reason === "abort") throw options.signal?.reason ?? new SandboxWorkerOperationError("cancelled");
      throw new SandboxWorkerOperationError("timeout");
    } finally {
      if (timer !== undefined) clearTimeout(timer); removeAbort?.();
    }
  }

  /** Conversation abort: namespace first, Pi abort/settle second, replacement last. */
  abort(): Promise<void> { return this.#plannedRestart(); }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    if (this.#state === "closed") return;
    // Close admission before the first await. If a restart is already settling
    // Pi, its old namespace begins teardown here and any later replacement is
    // immediately invalidated by the closed-state check below.
    this.#state = "closed";
    const worker = this.#worker;
    const transition = this.#transition;
    try {
      await worker.close();
    } catch (closeError) {
      try {
        await worker.invalidate();
      } catch (invalidateError) {
        throw new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED, {
          cause: { closeError, invalidateError },
        });
      }
    }
    if (transition !== undefined) await transition.catch(() => undefined);
    this.#fatalListeners.clear();
  }

  async #current(): Promise<SandboxControllerWorkerPort> {
    if (this.#state === "restarting" && this.#transition !== undefined) await this.#transition;
    if (this.#state !== "healthy") throw new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED);
    return this.#worker;
  }

  #plannedRestart(): Promise<void> {
    if (this.#state === "closed") return Promise.reject(new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED));
    if (this.#state === "restarting" && this.#transition !== undefined) return this.#transition;
    if (this.#state === "error") return Promise.reject(new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED));
    this.#state = "restarting";
    const previous = this.#worker;
    const transition = (async () => {
      try {
        // Never trust process-group cleanup on timeout/abort.
        await previous.invalidate();
        await this.#options.abortActiveRun();
        await this.#options.waitForPiIdle();
        if (this.#state === "closed") return;
        if (this.#state !== "restarting") {
          throw this.#pendingTerminalFailure?.error ?? this.#fatalFailure?.error ??
            new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED);
        }

        let replacementFatal: Readonly<SandboxWorkerFatal> | undefined;
        const replacement = await this.#options.createWorker((failure) => {
          replacementFatal = failure;
          this.#workerFatal(failure);
        });
        if (replacementFatal !== undefined || this.#state !== "restarting") {
          await replacement.invalidate().catch(() => undefined);
          throw replacementFatal?.error ?? this.#pendingTerminalFailure?.error ??
            this.#fatalFailure?.error ?? new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED);
        }
        this.#worker = replacement;
        this.#state = "healthy";
      } catch (cause) {
        if (this.#state === "closed") return;
        if (this.#pendingTerminalFailure !== undefined) {
          throw this.#pendingTerminalFailure.error;
        }
        if (this.#fatalFailure !== undefined) throw this.#fatalFailure.error;
        this.#state = "error";
        const failure = {
          error: new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED, { cause }),
          diagnostic: "",
        };
        this.#notifyFatal(failure);
        throw failure.error;
      }
    })();
    const tracked = transition.finally(() => { if (this.#transition === tracked) this.#transition = undefined; });
    this.#transition = tracked;
    return tracked;
  }

  #workerFatal(failure: Readonly<SandboxWorkerFatal>): void {
    this.#terminalFailure(failure);
  }

  #terminalFailure(failure: Readonly<SandboxWorkerFatal>): void {
    if (this.#state === "closed" || this.#pendingTerminalFailure !== undefined ||
        this.#fatalFailure !== undefined) return;
    // Lock admission and replacement synchronously before beginning teardown.
    this.#state = "error";
    this.#pendingTerminalFailure = failure;
    void (async () => {
      await this.#worker.invalidate().catch(() => undefined);
      await Promise.resolve(this.#options.abortActiveRun()).catch(() => undefined);
      await Promise.resolve(this.#options.waitForPiIdle()).catch(() => undefined);
      this.#notifyFatal(failure);
    })();
  }

  #notifyFatal(failure: Readonly<SandboxWorkerFatal>): void {
    if (this.#state === "closed") return;
    this.#fatalFailure ??= failure;
    this.#pendingTerminalFailure = undefined;
    try { this.#options.onFatal(this.#fatalFailure); } catch { /* observers have no authority */ }
    for (const listener of this.#fatalListeners) {
      try { listener(this.#fatalFailure); } catch { /* observers have no authority */ }
    }
  }
}
