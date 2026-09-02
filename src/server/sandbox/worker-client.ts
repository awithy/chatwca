import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";

import { AppError, ERROR_CODES } from "../../shared/errors.js";
import type { WorkspaceMount } from "../../shared/protocol.js";
import {
  SANDBOX_PROTOCOL_VERSION,
  buildSandboxLaunchSpecification,
  type BwrapLaunchSpecification,
  type SandboxNetworkLaunchProfile,
  type SandboxWorkerArtifact,
  type ValidatedSandboxHost,
} from "./bwrap.js";
import type { SandboxConfig } from "./config.js";
import {
  OrderedChunkAssembler,
  SANDBOX_MAX_ACTIVE_OPERATIONS,
  SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES,
  SANDBOX_MAX_DIAGNOSTIC_BYTES,
  SANDBOX_MAX_PENDING_OUTPUT_BYTES,
  SANDBOX_MAX_PENDING_OUTPUT_FRAMES,
  SandboxFrameDecoder,
  SandboxProtocolError,
  chunkBuffer,
  encodeSandboxFrame,
  isParentFrame,
  isWorkerFrame,
  validateOperationArguments,
  validateOperationResult,
  type EditFileArguments,
  type EditFileResult,
  type ExecArguments,
  type ExecResult,
  type FindArguments,
  type FindResult,
  type GrepArguments,
  type GrepResult,
  type HealthResult,
  type ListDirectoryArguments,
  type ListDirectoryResult,
  type ParentFrame,
  type ReadFileArguments,
  type ReadFileResult,
  type SandboxOperation,
  type WorkerErrorCode,
  type WorkerFrame,
  type WriteFileResult,
} from "./protocol.js";
import {
  buildSandboxProbeContext,
  validateSandboxWorkerReady,
  type SandboxProbeContext,
} from "./probe.js";

export interface SandboxOutputEvent {
  readonly stream: "stdout" | "stderr";
  readonly data: string;
  readonly sequence: number;
}
export interface SandboxCallOptions {
  readonly signal?: AbortSignal;
}
export interface SandboxExecOptions extends SandboxCallOptions {
  readonly onOutput?: (event: Readonly<SandboxOutputEvent>) => void | Promise<void>;
}
export interface SandboxWorkerFatal {
  readonly error: AppError;
  readonly diagnostic: string;
}

export class SandboxWorkerOperationError extends Error {
  override readonly name = "SandboxWorkerOperationError";
  constructor(readonly code: WorkerErrorCode) { super("Sandbox operation failed"); }
}

interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdio: readonly (NodeJS.ReadableStream | NodeJS.WritableStream | null | undefined)[];
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: string, listener: (...args: any[]) => void): this;
  on(event: string, listener: (...args: any[]) => void): this;
}
export type SandboxSpawn = (specification: Readonly<BwrapLaunchSpecification>) => ChildLike;

export interface SandboxWorkerLaunchOptions {
  readonly config: Readonly<SandboxConfig>;
  readonly host: Readonly<ValidatedSandboxHost>;
  readonly worker: Readonly<SandboxWorkerArtifact>;
  readonly workspace: string;
  readonly mounts?: readonly WorkspaceMount[];
  readonly hiddenPaths: readonly string[];
  readonly onFatal: (failure: Readonly<SandboxWorkerFatal>) => void;
  readonly networkProfile?: SandboxNetworkLaunchProfile;
  readonly spawn?: SandboxSpawn;
}

export interface SandboxWorkerClientStartOptions {
  readonly specification: Readonly<BwrapLaunchSpecification>;
  readonly probeContext: Readonly<SandboxProbeContext>;
  readonly startTimeoutMs: number;
  readonly hiddenPaths: readonly string[];
  readonly commandTimeoutMs?: number;
  readonly maxCommandOutputBytes?: number;
  readonly onFatal: (failure: Readonly<SandboxWorkerFatal>) => void;
  readonly spawn?: SandboxSpawn;
}

interface PendingOperation {
  readonly id: string;
  readonly operation: SandboxOperation;
  readonly resolve: (value: { readonly result: unknown; readonly data?: Buffer }) => void;
  readonly reject: (error: unknown) => void;
  readonly assembler: OrderedChunkAssembler;
  readonly onOutput?: ((event: Readonly<SandboxOutputEvent>) => void | Promise<void>) | undefined;
  readonly outputTasks: Set<Promise<void>>;
  outputSequence: number;
  terminalReceived: boolean;
  settled: boolean;
  aborted: boolean;
  removeAbort?: () => void;
}

function productionSpawn(specification: Readonly<BwrapLaunchSpecification>): ChildLike {
  const stdio = Array.from({ length: specification.stdioCount }, (_, fd) =>
    fd === 0 || fd === 1 ? "ignore" : "pipe"
  ) as ("ignore" | "pipe")[];
  return spawn(specification.executable, specification.argv, {
    shell: false,
    detached: true,
    stdio,
    ...(specification.emptyEnvironment ? { env: {} } : {}),
  }) as ChildProcess;
}

function streamAt<T>(child: ChildLike, fd: number): T {
  const stream = child.stdio[fd];
  if (stream === null || stream === undefined) throw new Error(`sandbox fd ${String(fd)} is unavailable`);
  return stream as T;
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function exited(child: ChildLike): boolean { return child.exitCode !== null || child.signalCode !== null; }

function waitForHelperReady(child: ChildLike, specification: Readonly<BwrapLaunchSpecification>): Promise<void> {
  if (specification.helperReadyFd === undefined) return Promise.resolve();
  const stream = streamAt<Readable>(child, specification.helperReadyFd);
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expected: number | undefined;
    const finish = (error?: unknown) => {
      stream.off("data", onData); stream.off("end", onEnd); stream.off("error", onError);
      if (error === undefined) resolve(); else reject(error);
    };
    const onEnd = () => finish(new AppError(ERROR_CODES.NETWORK_BRIDGE_START_FAILED));
    const onError = (cause: unknown) => finish(new AppError(ERROR_CODES.NETWORK_BRIDGE_START_FAILED, { cause }));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > 4 * 1024 + 4) { finish(new AppError(ERROR_CODES.NETWORK_BRIDGE_START_FAILED)); return; }
      if (expected === undefined && buffer.byteLength >= 4) {
        expected = buffer.readUInt32BE(0);
        if (expected === 0 || expected > 4 * 1024) { finish(new AppError(ERROR_CODES.NETWORK_BRIDGE_START_FAILED)); return; }
      }
      if (expected === undefined || buffer.byteLength < expected + 4) return;
      if (buffer.byteLength !== expected + 4) { finish(new AppError(ERROR_CODES.NETWORK_BRIDGE_START_FAILED)); return; }
      try {
        const value = JSON.parse(buffer.subarray(4).toString("utf8")) as Record<string, unknown>;
        const keys = Object.keys(value).sort().join("\0");
        if (value.type !== "ready" || value.protocol !== 1 ||
            !Number.isSafeInteger(value.helperPid) || !Number.isSafeInteger(value.bwrapPid) ||
            keys !== ["bwrapPid", "helperPid", "protocol", "type"].sort().join("\0")) {
          throw new Error("invalid helper ready frame");
        }
        finish();
      } catch (cause) { finish(new AppError(ERROR_CODES.NETWORK_BRIDGE_START_FAILED, { cause })); }
    };
    stream.on("data", onData); stream.once("end", onEnd); stream.once("error", onError);
  });
}

/** Production ownership boundary: builder, per-worker probe context, and client lifecycle. */
export async function startSandboxWorkerClient(options: SandboxWorkerLaunchOptions): Promise<SandboxWorkerClient> {
  const specification = buildSandboxLaunchSpecification({
    ...options,
    networkProfile: options.networkProfile ?? { kind: "isolated" },
  });
  const nonce = randomBytes(24).toString("hex");
  const probeContext = await buildSandboxProbeContext({
    config: options.config, worker: options.worker, workspace: options.workspace,
    ...(options.mounts === undefined ? {} : { mounts: options.mounts }),
    hiddenPaths: options.hiddenPaths, nonce, specification,
  });
  return SandboxWorkerClient.start({
    specification, probeContext, startTimeoutMs: options.config.startTimeoutMs,
    hiddenPaths: options.hiddenPaths,
    commandTimeoutMs: options.config.commandTimeoutMs,
    maxCommandOutputBytes: options.config.maxCommandOutputBytes,
    onFatal: options.onFatal,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  });
}

export class SandboxWorkerClient {
  readonly #child: ChildLike;
  readonly #specification: Readonly<BwrapLaunchSpecification>;
  readonly #request: Writable;
  readonly #response: Readable;
  readonly #onFatal: (failure: Readonly<SandboxWorkerFatal>) => void;
  readonly #probeContext: Readonly<SandboxProbeContext>;
  readonly #decoder = new SandboxFrameDecoder(isWorkerFrame);
  readonly #pending = new Map<string, PendingOperation>();
  readonly #exitPromise: Promise<void>;
  #resolveExit!: () => void;
  #helloResolve!: () => void;
  #helloReject!: (error: unknown) => void;
  #helloPending = true;
  #shutdownResolve?: () => void;
  #writeChain = Promise.resolve();
  #queuedWriteBytes = 0;
  #pendingOutputBytes = 0;
  #pendingOutputFrames = 0;
  #diagnostic = Buffer.alloc(0);
  #fatal = false;
  #closing = false;
  #closed = false;
  #closePromise?: Promise<void>;
  #terminationPromise?: Promise<void>;

  private constructor(options: SandboxWorkerClientStartOptions, child: ChildLike) {
    this.#child = child;
    this.#specification = options.specification;
    this.#onFatal = options.onFatal;
    this.#probeContext = options.probeContext;
    this.#request = streamAt<Writable>(child, options.specification.requestFd);
    this.#response = streamAt<Readable>(child, options.specification.responseFd);
    this.#exitPromise = new Promise((resolve) => { this.#resolveExit = resolve; });

    const diagnostic = streamAt<Readable>(child, 2);
    diagnostic.on("data", (value: Buffer | string) => {
      const rawChunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const chunk = rawChunk.subarray(Math.max(0, rawChunk.byteLength - SANDBOX_MAX_DIAGNOSTIC_BYTES));
      const combined = Buffer.concat([this.#diagnostic, chunk]);
      this.#diagnostic = combined.subarray(Math.max(0, combined.byteLength - SANDBOX_MAX_DIAGNOSTIC_BYTES));
    });
    diagnostic.on("error", () => undefined);
    for (const [fd, stream] of child.stdio.entries()) {
      if (fd !== 2 && fd !== options.specification.responseFd && stream !== null && stream !== undefined) {
        stream.on("error", (error) => this.#fail(error));
      }
    }
    this.#request.on("error", (error) => this.#fail(error));
    this.#response.on("data", (chunk: Buffer) => this.#receive(chunk));
    this.#response.on("end", () => {
      try { this.#decoder.end(); } catch (error) { this.#fail(error); return; }
      if (!this.#closing) this.#fail(new Error("sandbox response pipe closed"));
    });
    this.#response.on("error", (error) => this.#fail(error));
    child.once("error", (error: unknown) => this.#fail(error));
    child.once("exit", () => {
      this.#resolveExit();
      if (!this.#closing) this.#fail(new Error("sandbox worker exited unexpectedly"));
      this.#rejectPending(new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED));
    });
  }

  static async start(options: SandboxWorkerClientStartOptions): Promise<SandboxWorkerClient> {
    let child: ChildLike;
    try { child = (options.spawn ?? productionSpawn)(options.specification); }
    catch (cause) {
      const error = new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED, { cause });
      try { options.onFatal({ error, diagnostic: "" }); } catch { /* observers have no authority */ }
      throw error;
    }
    let client: SandboxWorkerClient;
    try {
      client = new SandboxWorkerClient(options, child);
    } catch (cause) {
      try { child.kill("SIGKILL"); } catch { /* failed construction still fails closed */ }
      for (const stream of child.stdio) (stream as { destroy?: () => void } | null | undefined)?.destroy?.();
      const error = new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED, { cause });
      try { options.onFatal({ error, diagnostic: "" }); } catch { /* observers have no authority */ }
      throw error;
    }
    const nonce = options.probeContext.nonce;
    const helperReady = waitForHelperReady(child, options.specification);
    void helperReady.catch(() => undefined);
    const hello = new Promise<void>((resolve, reject) => {
      client.#helloResolve = resolve;
      client.#helloReject = reject;
    });
    // Child errors can race the first pipe write; mark the handshake promise
    // handled immediately while preserving its rejection for the race below.
    void hello.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("sandbox worker handshake timed out")), options.startTimeoutMs);
      });
      const startup = (async () => {
        for (const binding of options.specification.dataBindings) {
          streamAt<Writable>(child, binding.fd).end(binding.payload);
        }
        await helperReady;
        await client.#send({
          type: "hello", protocol: SANDBOX_PROTOCOL_VERSION, nonce,
          artifactSha256: options.probeContext.artifact.sha256,
          artifactVersion: options.probeContext.artifact.version,
          hiddenPaths: [...options.hiddenPaths], mountPaths: Object.keys(options.probeContext.mounts), exitAfterProbe: false,
          commandTimeoutMs: options.commandTimeoutMs ?? 900_000,
          maxCommandOutputBytes: options.maxCommandOutputBytes ?? 64 * 1024 * 1024,
        });
        await hello;
      })();
      await Promise.race([startup, timeout]);
      return client;
    } catch (cause) {
      client.#fail(cause);
      await client.#terminate();
      if (cause instanceof AppError && cause.code === ERROR_CODES.NETWORK_BRIDGE_START_FAILED) throw cause;
      throw new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED, { cause });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  get diagnostic(): string { return this.#diagnostic.toString("utf8"); }
  get activeOperations(): number { return this.#pending.size; }

  async readFile(arguments_: Readonly<ReadFileArguments>, options: SandboxCallOptions = {}): Promise<ReadFileResult> {
    const terminal = await this.#requestOperation("readFile", arguments_, options);
    if (terminal.data === undefined) throw new SandboxProtocolError("readFile response was not chunked");
    return { ...(terminal.result as Omit<ReadFileResult, "data">), data: terminal.data };
  }
  async writeFile(path: string, data: Buffer | string, options: SandboxCallOptions & { readonly createParents?: boolean } = {}): Promise<WriteFileResult> {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    if (bytes.byteLength > SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES) throw new SandboxWorkerOperationError("output_limit");
    const encoding = Buffer.isBuffer(data) ? "base64" as const : "utf8" as const;
    const arguments_ = {
      path, createParents: options.createParents ?? true, encoding, bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    return (await this.#requestOperation("writeFile", arguments_, options, bytes, "base64")).result as WriteFileResult;
  }
  async editFile(arguments_: Readonly<EditFileArguments>, options: SandboxCallOptions = {}): Promise<EditFileResult> {
    return (await this.#requestOperation("editFile", arguments_, options)).result as EditFileResult;
  }
  async listDirectory(arguments_: Readonly<ListDirectoryArguments>, options: SandboxCallOptions = {}): Promise<ListDirectoryResult> {
    return (await this.#requestOperation("listDirectory", arguments_, options)).result as ListDirectoryResult;
  }
  async grep(arguments_: Readonly<GrepArguments>, options: SandboxCallOptions = {}): Promise<GrepResult> {
    return (await this.#requestOperation("grep", arguments_, options)).result as GrepResult;
  }
  async find(arguments_: Readonly<FindArguments>, options: SandboxCallOptions = {}): Promise<FindResult> {
    return (await this.#requestOperation("find", arguments_, options)).result as FindResult;
  }
  async exec(arguments_: Readonly<ExecArguments>, options: SandboxExecOptions = {}): Promise<ExecResult> {
    return (await this.#requestOperation("exec", arguments_, options)).result as ExecResult;
  }
  async health(options: SandboxCallOptions = {}): Promise<HealthResult> {
    return (await this.#requestOperation("health", {}, options)).result as HealthResult;
  }

  async cancelAll(): Promise<void> { if (!this.#closed && !this.#fatal) await this.#send({ type: "cancel.all" }); }

  /** Planned invalidation tears down the complete PID namespace immediately. */
  invalidate(): Promise<void> {
    if (!this.#closing && !this.#closed) {
      this.#closing = true;
      this.#rejectPending(new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED));
    }
    return this.#terminate();
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#rejectPending(new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED));
    if (!exited(this.#child)) {
      const graceful = new Promise<void>((resolve) => { this.#shutdownResolve = resolve; });
      await this.#send({ type: "shutdown" }).catch(() => undefined);
      await Promise.race([graceful, delay(500)]);
    }
    await this.#terminate();
  }

  async #requestOperation(
    operation: SandboxOperation,
    arguments_: unknown,
    options: SandboxCallOptions | SandboxExecOptions,
    requestData?: Buffer,
    requestEncoding: "utf8" | "base64" = "base64",
  ): Promise<{ readonly result: unknown; readonly data?: Buffer }> {
    if (this.#fatal || this.#closing || this.#closed) throw new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED);
    if (options.signal?.aborted === true) throw options.signal.reason ?? new Error("aborted");
    if (!validateOperationArguments(operation, arguments_)) throw new SandboxWorkerOperationError("invalid_arguments");
    if (this.#pending.size >= SANDBOX_MAX_ACTIVE_OPERATIONS) throw new SandboxWorkerOperationError("operation_failed");
    const id = randomUUID().replaceAll("-", "");
    // Inline operation arguments must themselves fit one frame. Reject this as
    // a healthy bounded-operation failure rather than poisoning the worker.
    try { encodeSandboxFrame({ type: "request", id, operation, arguments: arguments_ } as ParentFrame); }
    catch { throw new SandboxWorkerOperationError("output_limit"); }
    const result = new Promise<{ readonly result: unknown; readonly data?: Buffer }>((resolve, reject) => {
      const pending: PendingOperation = {
        id, operation, resolve, reject, assembler: new OrderedChunkAssembler(), outputSequence: 0,
        outputTasks: new Set(), onOutput: "onOutput" in options ? options.onOutput : undefined,
        terminalReceived: false, settled: false, aborted: false,
      };
      if (options.signal !== undefined) {
        const abort = () => {
          pending.aborted = true;
          if (!pending.settled) { pending.settled = true; pending.reject(options.signal?.reason ?? new Error("aborted")); }
          void this.#send({ type: "cancel", id }).catch(() => undefined);
        };
        options.signal.addEventListener("abort", abort, { once: true });
        pending.removeAbort = () => options.signal?.removeEventListener("abort", abort);
      }
      this.#pending.set(id, pending);
    });
    try {
      await this.#send({ type: "request", id, operation, arguments: arguments_ } as ParentFrame);
      if (requestData !== undefined) {
        for (const chunk of chunkBuffer(requestData, requestEncoding)) {
          await this.#send({ type: "request.chunk", id, ...chunk });
        }
        await this.#send({
          type: "request.end", id, bytes: requestData.byteLength,
          sha256: createHash("sha256").update(requestData).digest("hex"),
        });
      }
    } catch (error) {
      this.#fail(error);
    }
    return result;
  }

  #receive(chunk: Buffer): void {
    if (this.#fatal || this.#closed) return;
    try {
      for (const value of this.#decoder.push(chunk)) this.#handle(value as WorkerFrame);
    } catch (error) { this.#fail(error); }
  }

  #handle(frame: WorkerFrame): void {
    if (frame.type === "ready") {
      if (!this.#helloPending) throw new SandboxProtocolError("duplicate or unsolicited ready frame");
      validateSandboxWorkerReady(frame, this.#probeContext);
      this.#helloPending = false;
      this.#helloResolve();
      return;
    }
    if (this.#helloPending) throw new SandboxProtocolError("worker sent data before ready");
    if (frame.type === "shutdown.complete") {
      if (!this.#closing || this.#shutdownResolve === undefined) throw new SandboxProtocolError("unsolicited shutdown response");
      this.#shutdownResolve();
      return;
    }
    const pending = this.#pending.get(frame.id);
    if (pending === undefined) throw new SandboxProtocolError("unknown or duplicate request id");
    if (pending.terminalReceived) throw new SandboxProtocolError("duplicate terminal or output after terminal");
    if (frame.type === "output") {
      if (pending.operation !== "exec" || frame.sequence !== pending.outputSequence) throw new SandboxProtocolError("invalid output sequence");
      pending.outputSequence += 1;
      this.#queueOutput(pending, frame);
      return;
    }
    if (frame.type === "response.chunk") { pending.assembler.push(frame); return; }
    if (frame.type === "error") {
      this.#terminal(pending, new SandboxWorkerOperationError(frame.code));
      return;
    }
    if (!validateOperationResult(pending.operation, frame.result)) throw new SandboxProtocolError("operation response schema mismatch");
    let data: Buffer | undefined;
    if (frame.type === "response.end") data = pending.assembler.finish(frame.bytes, frame.sha256);
    else if (pending.operation === "readFile" || pending.assembler.hasChunks) throw new SandboxProtocolError("invalid non-chunked terminal response");
    this.#terminal(pending, undefined, { result: frame.result, ...(data === undefined ? {} : { data }) });
  }

  #queueOutput(pending: PendingOperation, event: Readonly<SandboxOutputEvent>): void {
    const bytes = Buffer.byteLength(event.data, "utf8");
    if (this.#pendingOutputBytes + bytes > SANDBOX_MAX_PENDING_OUTPUT_BYTES ||
        this.#pendingOutputFrames >= SANDBOX_MAX_PENDING_OUTPUT_FRAMES) throw new SandboxProtocolError("pending worker output overflow");
    this.#pendingOutputBytes += bytes;
    this.#pendingOutputFrames += 1;
    if (this.#pendingOutputBytes >= 3 * 1024 * 1024) this.#response.pause();
    const task = Promise.resolve().then(() => pending.onOutput?.(event)).then(() => undefined).catch((error) => {
      this.#fail(error);
    }).finally(() => {
      this.#pendingOutputBytes -= bytes;
      this.#pendingOutputFrames -= 1;
      pending.outputTasks.delete(task);
      if (!this.#closed && this.#pendingOutputBytes <= 2 * 1024 * 1024) this.#response.resume();
    });
    pending.outputTasks.add(task);
  }

  #terminal(pending: PendingOperation, error?: unknown, value?: { readonly result: unknown; readonly data?: Buffer }): void {
    pending.terminalReceived = true;
    pending.removeAbort?.();
    void Promise.allSettled([...pending.outputTasks]).then(() => {
      this.#pending.delete(pending.id);
      if (pending.settled) return;
      pending.settled = true;
      if (error !== undefined) pending.reject(error); else pending.resolve(value!);
    });
  }

  #send(frame: ParentFrame): Promise<void> {
    if (!isParentFrame(frame)) return Promise.reject(new SandboxProtocolError("invalid parent sandbox frame"));
    if (this.#closed) return Promise.reject(new Error("sandbox worker is closed"));
    const encoded = encodeSandboxFrame(frame);
    if (this.#queuedWriteBytes + encoded.byteLength > SANDBOX_MAX_PENDING_OUTPUT_BYTES) {
      const error = new SandboxProtocolError("sandbox request queue overflow");
      this.#fail(error);
      return Promise.reject(error);
    }
    this.#queuedWriteBytes += encoded.byteLength;
    const write = async () => {
      try {
        if (this.#closed || this.#fatal) throw new Error("sandbox worker is unavailable");
        if (!this.#request.write(encoded)) {
          await new Promise<void>((resolve, reject) => {
            const cleanup = () => { this.#request.off("drain", drain); this.#request.off("error", rejectWith); };
            const drain = () => { cleanup(); resolve(); };
            const rejectWith = (error: unknown) => { cleanup(); reject(error); };
            this.#request.once("drain", drain); this.#request.once("error", rejectWith);
          });
        }
      } finally { this.#queuedWriteBytes -= encoded.byteLength; }
    };
    const next = this.#writeChain.then(write);
    this.#writeChain = next.catch(() => undefined);
    return next;
  }


  #fail(cause: unknown): void {
    if (this.#fatal || this.#closing || this.#closed) return;
    this.#fatal = true;
    const error = new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED, { cause });
    if (this.#helloPending) this.#helloReject(cause);
    this.#rejectPending(error);
    try { this.#onFatal({ error, diagnostic: this.diagnostic }); } catch { /* fatal observers have no authority */ }
    void this.#terminate();
  }

  #rejectPending(error: unknown): void {
    for (const pending of this.#pending.values()) {
      pending.removeAbort?.();
      if (!pending.settled) { pending.settled = true; pending.reject(error); }
    }
    this.#pending.clear();
  }

  #terminate(): Promise<void> {
    this.#terminationPromise ??= this.#terminateOnce();
    return this.#terminationPromise;
  }

  async #terminateOnce(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    if (!exited(this.#child)) {
      this.#signal("SIGTERM");
      await Promise.race([this.#exitPromise, delay(500)]);
    }
    if (!exited(this.#child)) {
      this.#signal("SIGKILL");
      await Promise.race([this.#exitPromise, delay(1_000)]);
    }
    this.#closed = true;
    for (const stream of this.#child.stdio) (stream as { destroy?: () => void } | null | undefined)?.destroy?.();
  }

  #signal(signal: NodeJS.Signals): void {
    try {
      if (this.#child.pid !== undefined) process.kill(-this.#child.pid, signal);
      else this.#child.kill(signal);
    } catch { try { this.#child.kill(signal); } catch { /* already gone */ } }
  }
}
