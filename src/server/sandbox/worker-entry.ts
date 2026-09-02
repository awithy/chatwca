import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { TextDecoder } from "node:util";

import {
  WORKER_MAX_ACTIVE_OPERATIONS,
  WORKER_MAX_ASSEMBLED_REQUEST_BYTES,
  WORKER_MAX_FRAME_BYTES,
  WORKER_MAX_RAW_CHUNK_BYTES,
  workerIsParentFrame,
  type WorkerOperation,
} from "./worker-protocol.js";
import {
  WorkerFileSystemError,
  mapFileSystemError,
  workerEditFile,
  workerListDirectory,
  workerReadFile,
  workerWriteFile,
} from "./worker-fs.js";
import {
  FatalWorkerProcessError,
  workerExec,
  workerFind,
  workerGrep,
} from "./worker-process.js";

const REQUEST_FD = 8;
const RESPONSE_FD = 9;
const WORKER_VERSION = "1";
const NAMESPACE_NAMES = ["user", "mnt", "pid", "ipc", "uts", "net"] as const;

type ParentFrame = Record<string, unknown> & { readonly type: string };
interface ActiveRequest {
  readonly id: string;
  readonly operation: WorkerOperation;
  readonly arguments: Record<string, unknown>;
  sequence: number;
  bytes: number;
  readonly hash: ReturnType<typeof createHash>;
  readonly chunks: Buffer[];
  readonly declaredBytes: number;
  readonly declaredSha256: string;
  cancelled: boolean;
  started: boolean;
}

class FrameDecoder {
  readonly prefix = Buffer.allocUnsafe(4);
  prefixBytes = 0;
  payload: Buffer | undefined;
  payloadBytes = 0;
  push(source: Buffer): unknown[] {
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < source.byteLength) {
      if (this.payload === undefined) {
        const take = Math.min(4 - this.prefixBytes, source.byteLength - offset);
        source.copy(this.prefix, this.prefixBytes, offset, offset + take);
        this.prefixBytes += take; offset += take;
        if (this.prefixBytes < 4) continue;
        const length = this.prefix.readUInt32BE(0); this.prefixBytes = 0;
        if (length === 0 || length > WORKER_MAX_FRAME_BYTES) throw new Error("invalid frame length");
        this.payload = Buffer.allocUnsafe(length); this.payloadBytes = 0;
      }
      const take = Math.min(this.payload.byteLength - this.payloadBytes, source.byteLength - offset);
      source.copy(this.payload, this.payloadBytes, offset, offset + take);
      this.payloadBytes += take; offset += take;
      if (this.payloadBytes !== this.payload.byteLength) continue;
      const payload = this.payload; this.payload = undefined; this.payloadBytes = 0;
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload)) as unknown;
      if (!workerIsParentFrame(value)) throw new Error("invalid parent frame");
      frames.push(value);
    }
    return frames;
  }
  end(): void { if (this.prefixBytes !== 0 || this.payload !== undefined) throw new Error("truncated frame"); }
}

function writeAll(data: Buffer): void {
  let offset = 0;
  while (offset < data.byteLength) offset += fs.writeSync(RESPONSE_FD, data, offset, data.byteLength - offset);
}
function writeFrame(value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > WORKER_MAX_FRAME_BYTES) throw new Error("frame too large");
  const prefix = Buffer.allocUnsafe(4); prefix.writeUInt32BE(payload.byteLength);
  writeAll(prefix); writeAll(payload);
}
function writeChunkedResponse(id: string, data: Buffer, result: unknown): void {
  const chunkBytes = WORKER_MAX_RAW_CHUNK_BYTES;
  for (let offset = 0, sequence = 0; offset < data.byteLength; offset += chunkBytes, sequence += 1) {
    writeFrame({ type: "response.chunk", id, sequence, encoding: "base64", data: data.subarray(offset, offset + chunkBytes).toString("base64") });
  }
  writeFrame({ type: "response.end", id, bytes: data.byteLength, sha256: createHash("sha256").update(data).digest("hex"), result });
}
function decodeData(encoding: unknown, data: unknown): Buffer {
  if (typeof data !== "string") throw new Error("invalid chunk");
  if (encoding === "utf8") return Buffer.from(data, "utf8");
  if (encoding !== "base64" || data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error("invalid base64");
  return Buffer.from(data, "base64");
}
function statusValue(status: string, name: string): string | undefined {
  return new RegExp(`^${name}:\\s*(.+)$`, "m").exec(status)?.[1];
}
function command(executable: string, args: readonly string[]): object {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 3_000, env: process.env });
  return { status: result.status, signal: result.signal, stdout: result.stdout.trim() };
}
function connect(options: net.NetConnectOpts): Promise<object> {
  return new Promise((resolve) => {
    const socket = net.createConnection(options); let finished = false;
    const finish = (connected: boolean, error: string | null) => {
      if (finished) return; finished = true; socket.destroy(); resolve({ connected, error });
    };
    socket.setTimeout(1_000, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true, null));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(false, error.code ?? "error"));
  });
}
function lookup(): Promise<object> {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => { if (!finished) { finished = true; resolve({ resolved: false, error: "timeout" }); } }, 1_000);
    dns.lookup("example.com", (error, address) => {
      if (finished) return; finished = true; clearTimeout(timer);
      resolve({ resolved: error === null, address: address || null, error: error?.code ?? null });
    });
  });
}
function httpLocalDenial(port: number): Promise<object> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let data = Buffer.alloc(0); let finished = false;
    const finish = (result: object) => { if (finished) return; finished = true; socket.destroy(); resolve(result); };
    socket.setTimeout(1_000, () => finish({ connected: false, denied: false, error: "timeout" }));
    socket.once("connect", () => socket.write("GET http://127.0.0.1:80/ HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"));
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]).subarray(0, 4096);
      const text = data.toString("latin1");
      if (text.includes("\r\n\r\n")) finish({
        connected: true,
        // The administrator policy may reject the synthetic loopback target
        // before address classification. Any closed stable policy denial proves
        // that this worker reached its parent-owned HTTP proxy; generic errors
        // and successful responses do not satisfy the handshake.
        denied: /^HTTP\/1\.1 403 /i.test(text) &&
          /\r\nx-chatwca-proxy-error: (?:blocked-by-allowlist|blocked-by-denylist|blocked-local-address|blocked-port|policy-unavailable)\r\n/i.test(text),
        error: null,
      });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => finish({ connected: false, denied: false, error: error.code ?? "error" }));
    socket.once("end", () => finish({ connected: true, denied: false, error: "truncated" }));
  });
}
function socksLocalDenial(port: number): Promise<object> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let data = Buffer.alloc(0); let requested = false; let finished = false;
    const finish = (result: object) => { if (finished) return; finished = true; socket.destroy(); resolve(result); };
    socket.setTimeout(1_000, () => finish({ connected: false, denied: false, error: "timeout" }));
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      if (!requested && data.length >= 2) {
        if (data[0] !== 5 || data[1] !== 0) { finish({ connected: true, denied: false, error: "negotiation" }); return; }
        data = data.subarray(2); requested = true;
        socket.write(Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]));
      }
      if (requested && data.length >= 10) finish({ connected: true, denied: data[0] === 5 && data[1] === 2, error: null });
    });
    socket.once("error", (error: NodeJS.ErrnoException) => finish({ connected: false, denied: false, error: error.code ?? "error" }));
  });
}
function unixSocketCreation(marker: string): Promise<object> {
  return new Promise((resolve) => {
    const server = net.createServer(); const socketPath = `/tmp/${marker}.sock`; let finished = false;
    const finish = (created: boolean, error: string | null) => { if (finished) return; finished = true; server.close(); resolve({ created, error }); };
    server.once("error", (error: NodeJS.ErrnoException) => finish(false, error.code ?? "error"));
    server.listen(socketPath, () => finish(true, null));
  });
}
function directWithoutProxyVariables(): Promise<object> {
  return new Promise((resolve) => {
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !name.toLowerCase().includes("proxy") && name !== "CHATWCA_MANAGED_EGRESS"
    ));
    const script = "const n=require('node:net');const s=n.createConnection({host:'1.1.1.1',port:53});s.setTimeout(500,()=>process.exit(0));s.once('error',()=>process.exit(0));s.once('connect',()=>process.exit(1));";
    const child = spawn("/usr/bin/node", ["-e", script], { env: environment, stdio: "ignore" });
    child.once("error", (error: NodeJS.ErrnoException) => resolve({ blocked: false, error: error.code ?? "error" }));
    child.once("exit", (code) => resolve({ blocked: code === 0, error: code === 0 ? null : "connected" }));
  });
}
function unixSocketpairAvailable(): Promise<object> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("/usr/bin/node", ["-e", "process.exit(0)"], { env: process.env, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    } catch (error) { resolve({ available: false, error: (error as NodeJS.ErrnoException).code ?? "error" }); return; }
    child.once("error", (error: NodeJS.ErrnoException) => resolve({ available: false, error: error.code ?? "error" }));
    child.once("exit", (code) => resolve({ available: code === 0, error: code === 0 ? null : "exit" }));
  });
}
function protocolDescriptorTargets(): object {
  const unixTypes = new Map<string, string>();
  try {
    for (const line of fs.readFileSync("/proc/net/unix", "utf8").trim().split("\n").slice(1)) {
      const columns = line.trim().split(/\s+/);
      if (columns[4] !== undefined && columns[6] !== undefined) unixTypes.set(columns[6], columns[4]);
    }
  } catch { /* absence is reported by the descriptor target itself */ }
  const targets: Record<string, string> = {};
  for (let fd = 3; fd <= 17; fd += 1) {
    try {
      const target = fs.readlinkSync(`/proc/self/fd/${String(fd)}`);
      const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
      targets[String(fd)] = inode === undefined ? target : `${target};unix-type=${unixTypes.get(inode) ?? "unknown"}`;
    } catch { /* closed */ }
  }
  return targets;
}
async function collectProbe(hello: ParentFrame, actualHash: string): Promise<object> {
  const nonce = hello.nonce as string;
  const hiddenPaths = hello.hiddenPaths as string[];
  const mountPaths = hello.mountPaths as string[];
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const managed = process.env.CHATWCA_MANAGED_EGRESS === "1";
  const helperVersion = process.env.CHATWCA_NETWORK_HELPER_VERSION_INTERNAL ?? null;
  delete process.env.CHATWCA_NETWORK_HELPER_VERSION_INTERNAL;
  const marker = `.chatwca-probe-${nonce}`;
  fs.writeFileSync(`/workspace/${marker}`, "sandbox probe\n", { flag: "wx" });
  fs.writeFileSync("/workspace/.chatwca/guest-only.txt", "ephemeral\n");
  const workspace = fs.statSync("/workspace", { bigint: true });
  const mountLines = fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n");
  const decodeMountPath = (value: string) => value.replace(/\\(040|011|012|134)/g, (match, code: string) => ({
    "040": " ", "011": "\t", "012": "\n", "134": "\\",
  })[code] ?? match);
  const mountIdentities = Object.fromEntries(mountPaths.map((mountPath) => {
    const metadata = fs.statSync(mountPath, { bigint: true });
    const line = mountLines.find((candidate) => decodeMountPath(candidate.split(" ")[4] ?? "") === mountPath);
    return [mountPath, { dev: String(metadata.dev), ino: String(metadata.ino), readOnly: line?.split(" ")[5]?.split(",").includes("ro") ?? false }];
  }));
  return {
    namespaces: Object.fromEntries(NAMESPACE_NAMES.map((name) => [name, fs.readlinkSync(`/proc/self/ns/${name}`)])),
    hostname: os.hostname(),
    capInh: statusValue(status, "CapInh"), capPrm: statusValue(status, "CapPrm"),
    capEff: statusValue(status, "CapEff"), capBnd: statusValue(status, "CapBnd"),
    capAmb: statusValue(status, "CapAmb"), noNewPrivs: statusValue(status, "NoNewPrivs"),
    seccomp: statusValue(status, "Seccomp"),
    environment: process.env, rootEntries: fs.readdirSync("/").sort(), devEntries: fs.readdirSync("/dev").sort(), etcEntries: fs.readdirSync("/etc").sort(),
    hiddenPaths: hiddenPaths.map((hiddenPath) => !fs.existsSync(hiddenPath)),
    chatwcaMask: { hostSessionHidden: !fs.existsSync("/workspace/.chatwca/host-session.json"), guestWriteVisible: fs.existsSync("/workspace/.chatwca/guest-only.txt") },
    workspace: { dev: String(workspace.dev), ino: String(workspace.ino), marker }, mountIdentities,
    artifact: { sha256: actualHash, version: WORKER_VERSION },
    commands: { node: command("/usr/bin/node", ["--version"]), bash: command("/bin/bash", ["-lc", "printf bubblewrap-bash"]), rg: command("rg", ["--version"]) },
    network: managed ? await (async () => {
      const httpPort = Number(new URL(process.env.HTTP_PROXY!).port);
      const socksPort = Number(new URL(process.env.ALL_PROXY!).port);
      const arbitraryPort = httpPort !== 9 && socksPort !== 9 ? 9 : 7;
      return {
        profile: "managed-egress", helperVersion, guestPorts: { http: httpPort, socks: socksPort },
        ipv4: await connect({ host: "1.1.1.1", port: 53 }),
        ipv6: await connect({ host: "2606:4700:4700::1111", port: 53, family: 6 }),
        loopback4: await connect({ host: "127.0.0.1", port: arbitraryPort }),
        loopback6: await connect({ host: "::1", port: arbitraryPort, family: 6 }),
        dns: await lookup(),
        httpEndpoint: await connect({ host: "127.0.0.1", port: httpPort }),
        socksEndpoint: await connect({ host: "127.0.0.1", port: socksPort }),
        httpLocalDenial: await httpLocalDenial(httpPort),
        socksLocalDenial: await socksLocalDenial(socksPort),
        directWithoutProxy: await directWithoutProxyVariables(),
        unixSocket: await unixSocketCreation(marker),
        unixSocketpair: await unixSocketpairAvailable(),
        protocolDescriptors: protocolDescriptorTargets(),
      };
    })() : {
      profile: "isolated",
      ipv4: await connect({ host: "1.1.1.1", port: 53 }), ipv6: await connect({ host: "2606:4700:4700::1111", port: 53, family: 6 }),
      loopback4: await connect({ host: "127.0.0.1", port: 9 }), loopback6: await connect({ host: "::1", port: 9, family: 6 }), dns: await lookup(),
      protocolDescriptors: protocolDescriptorTargets(),
    },
  };
}

async function main(): Promise<void> {
  const source = fs.readFileSync(new URL(import.meta.url));
  const actualHash = createHash("sha256").update(source).digest("hex");
  const decoder = new FrameDecoder();
  const requestStream = new net.Socket({ fd: REQUEST_FD, readable: true, writable: false });
  let helloDone = false;
  let shutdown = false;
  let processOperationTail = Promise.resolve();
  let commandTimeoutMs = 900_000;
  let maxCommandOutputBytes = 64 * 1024 * 1024;
  const active = new Map<string, ActiveRequest>();
  const tasks = new Set<Promise<void>>();
  const withProcessOperation = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = processOperationTail;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    processOperationTail = previous.catch(() => undefined).then(() => gate);
    await previous.catch(() => undefined);
    try { return await operation(); } finally { release(); }
  };

  const execute = async (request: ActiveRequest): Promise<void> => {
    if (request.started) throw new Error("request executed twice");
    request.started = true;
    try {
      if (request.cancelled) throw new WorkerFileSystemError("cancelled");
      switch (request.operation) {
        case "health": writeFrame({ type: "response", id: request.id, result: { healthy: true } }); break;
        case "readFile": {
          const result = await workerReadFile(request.arguments as never, request);
          writeChunkedResponse(request.id, result.data, { mimeType: result.mimeType });
          break;
        }
        case "writeFile": {
          const result = await workerWriteFile(request.arguments as never, Buffer.concat(request.chunks, request.bytes), request);
          writeFrame({ type: "response", id: request.id, result });
          break;
        }
        case "editFile": {
          const result = await workerEditFile(request.arguments as never, request);
          writeFrame({ type: "response", id: request.id, result });
          break;
        }
        case "listDirectory": {
          const result = await workerListDirectory(request.arguments as never, request);
          writeFrame({ type: "response", id: request.id, result });
          break;
        }
        case "grep": {
          const result = await withProcessOperation(() => workerGrep(request.arguments as never, request));
          writeFrame({ type: "response", id: request.id, result });
          break;
        }
        case "find": {
          const result = await withProcessOperation(() => workerFind(request.arguments as never, request));
          writeFrame({ type: "response", id: request.id, result });
          break;
        }
        case "exec": {
          let outputSequence = 0;
          const result = await withProcessOperation(() => workerExec(
            request.arguments as never,
            { commandTimeoutMs, maxCommandOutputBytes },
            (stream, data) => writeFrame({ type: "output", id: request.id, sequence: outputSequence++, stream, data }),
            request,
          ));
          writeFrame({ type: "response", id: request.id, result });
          break;
        }
        default: throw new WorkerFileSystemError("operation_not_implemented");
      }
    } catch (error) {
      if (error instanceof FatalWorkerProcessError) throw error;
      const failure = error instanceof WorkerFileSystemError ? error : mapFileSystemError(error);
      writeFrame({ type: "error", id: request.id, code: request.cancelled ? "cancelled" : failure.code });
    } finally { active.delete(request.id); }
  };
  const start = (request: ActiveRequest) => {
    const task = execute(request).catch((error) => { throw error; }).finally(() => tasks.delete(task));
    tasks.add(task);
    // A response-pipe failure is process-fatal; keep the rejection observed while
    // allowing the outer loop to be terminated by the resulting uncaught error.
    void task.catch((error) => { process.stderr.write(String(error).slice(0, 1_024)); process.exitCode = 1; requestStream.destroy(error as Error); });
  };

  const handle = async (frame: ParentFrame): Promise<void> => {
    if (!helloDone) {
      if (frame.type !== "hello" || frame.artifactSha256 !== actualHash || frame.artifactVersion !== WORKER_VERSION) throw new Error("invalid worker handshake");
      helloDone = true;
      commandTimeoutMs = frame.commandTimeoutMs as number;
      maxCommandOutputBytes = frame.maxCommandOutputBytes as number;
      writeFrame({ type: "ready", protocol: 1, nonce: frame.nonce, probe: await collectProbe(frame, actualHash) });
      if (frame.exitAfterProbe === true) shutdown = true;
      else fs.unlinkSync(`/workspace/.chatwca-probe-${String(frame.nonce)}`);
      return;
    }
    if (frame.type === "hello") throw new Error("duplicate hello");
    if (frame.type === "shutdown") {
      for (const request of active.values()) request.cancelled = true;
      await Promise.allSettled([...tasks]);
      writeFrame({ type: "shutdown.complete" }); shutdown = true; return;
    }
    if (frame.type === "cancel.all") { for (const request of active.values()) request.cancelled = true; return; }
    if (frame.type === "cancel") {
      // Cancellation can cross a terminal response in the pipes. An unknown ID
      // therefore conveys no authority and is safely ignored by the worker.
      const request = active.get(frame.id as string);
      if (request !== undefined) request.cancelled = true;
      return;
    }
    if (frame.type === "request") {
      const id = frame.id as string; const operation = frame.operation as WorkerOperation;
      if (active.has(id) || active.size >= WORKER_MAX_ACTIVE_OPERATIONS) throw new Error("duplicate id or active operation overflow");
      const arguments_ = frame.arguments as Record<string, unknown>;
      const request: ActiveRequest = {
        id, operation, arguments: arguments_, sequence: 0, bytes: 0, hash: createHash("sha256"), chunks: [],
        declaredBytes: operation === "writeFile" ? arguments_.bytes as number : 0,
        declaredSha256: operation === "writeFile" ? arguments_.sha256 as string : createHash("sha256").digest("hex"),
        cancelled: false, started: false,
      };
      active.set(id, request);
      if (operation !== "writeFile") start(request);
      return;
    }
    const id = frame.id as string; const request = active.get(id);
    if (request === undefined || request.operation !== "writeFile" || request.started) throw new Error("unknown request data id");
    if (frame.type === "request.chunk") {
      if (frame.sequence !== request.sequence || request.sequence > Math.ceil(WORKER_MAX_ASSEMBLED_REQUEST_BYTES / WORKER_MAX_RAW_CHUNK_BYTES)) throw new Error("chunk sequence gap or overflow");
      const bytes = decodeData(frame.encoding, frame.data);
      if (bytes.byteLength > WORKER_MAX_RAW_CHUNK_BYTES || request.bytes + bytes.byteLength > WORKER_MAX_ASSEMBLED_REQUEST_BYTES) throw new Error("request data overflow");
      request.sequence += 1; request.bytes += bytes.byteLength; request.hash.update(bytes); request.chunks.push(bytes); return;
    }
    if (frame.type === "request.end") {
      const requestHash = request.hash.digest("hex");
      if (frame.bytes !== request.bytes || frame.sha256 !== requestHash || request.declaredBytes !== request.bytes || request.declaredSha256 !== requestHash) throw new Error("request hash mismatch");
      start(request); return;
    }
    throw new Error("unexpected parent frame");
  };

  for await (const chunk of requestStream) {
    for (const frame of decoder.push(chunk as Buffer)) { await handle(frame as ParentFrame); if (shutdown) break; }
    if (shutdown) break;
  }
  if (!shutdown) decoder.end();
  if (!helloDone) throw new Error("protocol pipe closed before hello");
  await Promise.allSettled([...tasks]);
  requestStream.destroy();
  try { fs.closeSync(RESPONSE_FD); } catch { /* already closed */ }
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : "worker failed").slice(0, 1_024));
  process.exitCode = 1;
});
