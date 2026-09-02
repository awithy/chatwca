import { randomBytes } from "node:crypto";
import path from "node:path";
import { chmod, lstat, mkdir, readdir, rmdir, unlink } from "node:fs/promises";

import { AppError, ERROR_CODES } from "../../shared/errors.js";
import type { ManagedNetworkConfig } from "./config.js";
import {
  NetworkDecisionAuditor,
  type NetworkBlockedListener,
  type NetworkDiagnosticSink,
} from "./audit.js";
import { ConnectionAdmission } from "./connections.js";
import { HttpPolicyProxy } from "./http-proxy.js";
import { Socks5PolicyProxy } from "./socks5-proxy.js";
import {
  PinnedDestinationConnector,
  createProductionPinnedConnector,
} from "./resolver.js";

const UNIX_SOCKET_PATH_MAX_BYTES = 107;
const PROCESS_DIRECTORY_PREFIX = "net-p-";
const RUNTIME_DIRECTORY_PREFIX = "r-";

export interface ManagedNetworkRuntimeOptions {
  readonly dataDir: string;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly config: Readonly<ManagedNetworkConfig>;
  readonly diagnosticSink?: NetworkDiagnosticSink;
}

interface RuntimeDependencies {
  readonly connector: PinnedDestinationConnector;
  readonly uid: number;
}

function randomPart(bytes = 5): string {
  return randomBytes(bytes).toString("base64url");
}

function mode(stat: Awaited<ReturnType<typeof lstat>>): number { return Number(stat.mode) & 0o777; }

async function removeVerifiedSocket(socketPath: string, uid: number): Promise<void> {
  let stat: Awaited<ReturnType<typeof lstat>>;
  try { stat = await lstat(socketPath); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isSocket() || stat.uid !== uid || mode(stat) !== 0o600) throw new Error("unverified network socket");
  await unlink(socketPath);
}

async function removeVerifiedDirectory(directory: string, uid: number): Promise<void> {
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || mode(stat) !== 0o700) {
    throw new Error("unverified network directory");
  }
  await rmdir(directory);
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes only the known two-level shape. Every entry is lstat'd, UID/mode
 * checked, and no symlink or unknown file is followed or removed.
 */
export async function cleanupStaleManagedNetworkDirectories(dataDir: string, uid = process.getuid?.() ?? 0): Promise<void> {
  let entries: string[];
  try { entries = await readdir(dataDir); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const match = /^net-p-([1-9][0-9]*)-[A-Za-z0-9_-]{4,16}$/.exec(entry);
    if (match === null || processIsAlive(Number(match[1]))) continue;
    const processDirectory = path.join(dataDir, entry);
    let processStat: Awaited<ReturnType<typeof lstat>>;
    try { processStat = await lstat(processDirectory); } catch { continue; }
    if (!processStat.isDirectory() || processStat.isSymbolicLink() || processStat.uid !== uid || mode(processStat) !== 0o700) continue;

    const runtimeEntries = await readdir(processDirectory);
    let verified = true;
    for (const runtimeEntry of runtimeEntries) {
      if (!/^r-[A-Za-z0-9_-]{4,16}$/.test(runtimeEntry)) { verified = false; break; }
      const runtimeDirectory = path.join(processDirectory, runtimeEntry);
      const runtimeStat = await lstat(runtimeDirectory);
      if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink() || runtimeStat.uid !== uid || mode(runtimeStat) !== 0o700) {
        verified = false; break;
      }
      const socketEntries = await readdir(runtimeDirectory);
      if (socketEntries.some((name) => name !== "h.sock" && name !== "s.sock")) { verified = false; break; }
      for (const socketEntry of socketEntries) {
        const socketStat = await lstat(path.join(runtimeDirectory, socketEntry));
        if (!socketStat.isSocket() || socketStat.uid !== uid || mode(socketStat) !== 0o600) { verified = false; break; }
      }
      if (!verified) break;
    }
    if (!verified) continue;
    for (const runtimeEntry of runtimeEntries) {
      const runtimeDirectory = path.join(processDirectory, runtimeEntry);
      for (const socketEntry of await readdir(runtimeDirectory)) await unlink(path.join(runtimeDirectory, socketEntry));
      await rmdir(runtimeDirectory);
    }
    await rmdir(processDirectory);
  }
}

function defaultDiagnosticSink(event: Parameters<NetworkDiagnosticSink>[0]): void {
  // The event has already passed a closed-field validator and contains no URL,
  // headers, payload, resolved address, path, or diagnostic string.
  console.info(JSON.stringify({ type: "network.policy", ...event }));
}

export class ManagedNetworkRuntime {
  readonly httpSocketPath: string;
  readonly socksSocketPath: string;
  readonly #auditor: NetworkDecisionAuditor;
  readonly #http: HttpPolicyProxy;
  readonly #socks: Socks5PolicyProxy;
  readonly #fatalListeners = new Set<(error: AppError) => void>();
  #fatalError: AppError | undefined;
  #closePromise: Promise<void> | undefined;

  private constructor(
    private readonly processDirectory: string,
    private readonly runtimeDirectory: string,
    private readonly uid: number,
    auditor: NetworkDecisionAuditor,
    http: HttpPolicyProxy,
    socks: Socks5PolicyProxy,
  ) {
    this.httpSocketPath = path.join(runtimeDirectory, "h.sock");
    this.socksSocketPath = path.join(runtimeDirectory, "s.sock");
    this.#auditor = auditor;
    this.#http = http;
    this.#socks = socks;
    http.onFatal(() => this.#fatal());
    socks.onFatal(() => this.#fatal());
  }

  static start(options: ManagedNetworkRuntimeOptions): Promise<ManagedNetworkRuntime> {
    return this.#start(options, {
      connector: createProductionPinnedConnector(),
      uid: process.getuid?.() ?? 0,
    });
  }

  /** Internal deterministic fixture boundary; never used by production construction. */
  static startForTesting(
    options: ManagedNetworkRuntimeOptions,
    connector: PinnedDestinationConnector,
    uid = process.getuid?.() ?? 0,
  ): Promise<ManagedNetworkRuntime> {
    return this.#start(options, { connector, uid });
  }

  static async #start(options: ManagedNetworkRuntimeOptions, dependencies: RuntimeDependencies): Promise<ManagedNetworkRuntime> {
    if (!path.isAbsolute(options.dataDir) || options.config.mode !== "optional") {
      throw new AppError(ERROR_CODES.NETWORK_PROXY_START_FAILED);
    }
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await cleanupStaleManagedNetworkDirectories(options.dataDir, dependencies.uid);

    const processDirectory = path.join(options.dataDir, `${PROCESS_DIRECTORY_PREFIX}${process.pid}-${randomPart()}`);
    const runtimeDirectory = path.join(processDirectory, `${RUNTIME_DIRECTORY_PREFIX}${randomPart()}`);
    const httpSocketPath = path.join(runtimeDirectory, "h.sock");
    const socksSocketPath = path.join(runtimeDirectory, "s.sock");
    if (Buffer.byteLength(httpSocketPath) > UNIX_SOCKET_PATH_MAX_BYTES || Buffer.byteLength(socksSocketPath) > UNIX_SOCKET_PATH_MAX_BYTES) {
      throw new AppError(ERROR_CODES.NETWORK_PROXY_START_FAILED);
    }

    let auditor: NetworkDecisionAuditor;
    try {
      auditor = new NetworkDecisionAuditor(
        { workspaceId: options.workspaceId, conversationId: options.conversationId },
        options.diagnosticSink ?? defaultDiagnosticSink,
      );
    } catch (error) {
      throw new AppError(ERROR_CODES.NETWORK_PROXY_START_FAILED, { cause: error });
    }
    const common = {
      policy: options.config.destinationPolicy,
      maxConnections: options.config.maxConnections,
      connectTimeoutMs: options.config.connectTimeoutMs,
      idleTimeoutMs: options.config.idleTimeoutMs,
      maxConnectionBytes: options.config.maxConnectionBytes,
      auditor,
    };
    const admission = new ConnectionAdmission(options.config.maxConnections);
    const http = new HttpPolicyProxy(common, dependencies.connector, admission);
    const socks = new Socks5PolicyProxy(common, dependencies.connector, admission);
    const runtime = new ManagedNetworkRuntime(processDirectory, runtimeDirectory, dependencies.uid, auditor, http, socks);

    try {
      // mkdir without recursive and random names guarantee no existing intended
      // path is reused. EEXIST is fatal rather than cleaned in-place.
      await mkdir(processDirectory, { mode: 0o700 });
      await chmod(processDirectory, 0o700);
      await mkdir(runtimeDirectory, { mode: 0o700 });
      await chmod(runtimeDirectory, 0o700);
      await http.listen(httpSocketPath);
      await chmod(httpSocketPath, 0o600);
      await socks.listen(socksSocketPath);
      await chmod(socksSocketPath, 0o600);
      const [httpStat, socksStat] = await Promise.all([lstat(httpSocketPath), lstat(socksSocketPath)]);
      if (!httpStat.isSocket() || !socksStat.isSocket() || httpStat.uid !== dependencies.uid || socksStat.uid !== dependencies.uid ||
          mode(httpStat) !== 0o600 || mode(socksStat) !== 0o600) throw new Error("invalid proxy socket");
      return runtime;
    } catch (error) {
      http.forceClose();
      socks.forceClose();
      auditor.close();
      try { await removeVerifiedSocket(httpSocketPath, dependencies.uid); } catch { /* retain unverified path */ }
      try { await removeVerifiedSocket(socksSocketPath, dependencies.uid); } catch { /* retain unverified path */ }
      try { await removeVerifiedDirectory(runtimeDirectory, dependencies.uid); } catch { /* partial/unverified */ }
      try { await removeVerifiedDirectory(processDirectory, dependencies.uid); } catch { /* partial/unverified */ }
      throw error instanceof AppError ? error : new AppError(ERROR_CODES.NETWORK_PROXY_START_FAILED, { cause: error });
    }
  }

  subscribeBlocked(listener: NetworkBlockedListener): () => void { return this.#auditor.subscribe(listener); }

  onFatal(listener: (error: AppError) => void): () => void {
    this.#fatalListeners.add(listener);
    if (this.#fatalError !== undefined) listener(this.#fatalError);
    return () => this.#fatalListeners.delete(listener);
  }

  #fatal(): void {
    if (this.#fatalError !== undefined || this.#closePromise !== undefined) return;
    this.#fatalError = new AppError(ERROR_CODES.NETWORK_PROXY_FAILED);
    this.#http.forceClose();
    this.#socks.forceClose();
    for (const listener of this.#fatalListeners) {
      try { listener(this.#fatalError); } catch { /* observers have no authority */ }
    }
    void this.close().catch(() => undefined);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    await Promise.allSettled([this.#http.close(), this.#socks.close()]);
    this.#auditor.close();
    await removeVerifiedSocket(this.httpSocketPath, this.uid);
    await removeVerifiedSocket(this.socksSocketPath, this.uid);
    await removeVerifiedDirectory(this.runtimeDirectory, this.uid);
    await removeVerifiedDirectory(this.processDirectory, this.uid);
    this.#fatalListeners.clear();
  }

  forceClose(): void {
    this.#http.forceClose();
    this.#socks.forceClose();
    this.#auditor.close();
    void this.close().catch(() => undefined);
  }
}
