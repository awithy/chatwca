import { spawnSync } from "node:child_process";
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

const REQUEST_FD = 8;
const RESPONSE_FD = 9;
const WORKER_VERSION = "1";
const NAMESPACE_NAMES = ["user", "mnt", "pid", "ipc", "uts", "net"] as const;

type ParentFrame = Record<string, unknown> & { readonly type: string };
interface ActiveRequest {
  readonly operation: WorkerOperation;
  sequence: number;
  bytes: number;
  readonly hash: ReturnType<typeof createHash>;
  readonly declaredBytes: number;
  readonly declaredSha256: string;
  cancelled: boolean;
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
async function collectProbe(hello: ParentFrame, actualHash: string): Promise<object> {
  const nonce = hello.nonce as string;
  const hiddenPaths = hello.hiddenPaths as string[];
  const mountPaths = hello.mountPaths as string[];
  const status = fs.readFileSync("/proc/self/status", "utf8");
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
    hostname: os.hostname(), capEff: statusValue(status, "CapEff"), noNewPrivs: statusValue(status, "NoNewPrivs"),
    environment: process.env, rootEntries: fs.readdirSync("/").sort(), devEntries: fs.readdirSync("/dev").sort(), etcEntries: fs.readdirSync("/etc").sort(),
    hiddenPaths: hiddenPaths.map((hiddenPath) => !fs.existsSync(hiddenPath)),
    chatwcaMask: { hostSessionHidden: !fs.existsSync("/workspace/.chatwca/host-session.json"), guestWriteVisible: fs.existsSync("/workspace/.chatwca/guest-only.txt") },
    workspace: { dev: String(workspace.dev), ino: String(workspace.ino), marker }, mountIdentities,
    artifact: { sha256: actualHash, version: WORKER_VERSION },
    commands: { node: command("/usr/bin/node", ["--version"]), bash: command("/bin/bash", ["-lc", "printf bubblewrap-bash"]), rg: command("rg", ["--version"]) },
    network: {
      ipv4: await connect({ host: "1.1.1.1", port: 53 }), ipv6: await connect({ host: "2606:4700:4700::1111", port: 53, family: 6 }),
      loopback4: await connect({ host: "127.0.0.1", port: 9 }), loopback6: await connect({ host: "::1", port: 9, family: 6 }), dns: await lookup(),
    },
  };
}

async function main(): Promise<void> {
  const source = fs.readFileSync(new URL(import.meta.url));
  const actualHash = createHash("sha256").update(source).digest("hex");
  const decoder = new FrameDecoder();
  const requestStream = new net.Socket({ fd: REQUEST_FD, readable: true, writable: false });
  let helloDone = false;
  let exitAfterProbe = false;
  let shutdown = false;
  const active = new Map<string, ActiveRequest>();

  const handle = async (frame: ParentFrame): Promise<void> => {
    if (!helloDone) {
      if (frame.type !== "hello" || frame.artifactSha256 !== actualHash || frame.artifactVersion !== WORKER_VERSION) throw new Error("invalid worker handshake");
      helloDone = true; exitAfterProbe = frame.exitAfterProbe as boolean;
      writeFrame({ type: "ready", protocol: 1, nonce: frame.nonce, probe: await collectProbe(frame, actualHash) });
      if (exitAfterProbe) shutdown = true;
      else fs.unlinkSync(`/workspace/.chatwca-probe-${String(frame.nonce)}`);
      return;
    }
    if (frame.type === "hello") throw new Error("duplicate hello");
    if (frame.type === "shutdown") { writeFrame({ type: "shutdown.complete" }); shutdown = true; return; }
    if (frame.type === "cancel.all") { for (const request of active.values()) request.cancelled = true; return; }
    if (frame.type === "cancel") {
      const request = active.get(frame.id as string); if (request === undefined) throw new Error("unknown cancel id");
      request.cancelled = true; return;
    }
    if (frame.type === "request") {
      const id = frame.id as string; const operation = frame.operation as WorkerOperation;
      if (active.has(id) || active.size >= WORKER_MAX_ACTIVE_OPERATIONS) throw new Error("duplicate id or active operation overflow");
      if (operation === "health") { writeFrame({ type: "response", id, result: { healthy: true } }); return; }
      if (operation !== "writeFile") { writeFrame({ type: "error", id, code: "operation_not_implemented" }); return; }
      const arguments_ = frame.arguments as { readonly bytes: number; readonly sha256: string };
      active.set(id, {
        operation, sequence: 0, bytes: 0, hash: createHash("sha256"),
        declaredBytes: arguments_.bytes, declaredSha256: arguments_.sha256, cancelled: false,
      }); return;
    }
    const id = frame.id as string; const request = active.get(id);
    if (request === undefined) throw new Error("unknown request id");
    if (frame.type === "request.chunk") {
      if (frame.sequence !== request.sequence ||
          request.sequence > Math.ceil(WORKER_MAX_ASSEMBLED_REQUEST_BYTES / WORKER_MAX_RAW_CHUNK_BYTES)) throw new Error("chunk sequence gap or overflow");
      const bytes = decodeData(frame.encoding, frame.data);
      if (bytes.byteLength > WORKER_MAX_RAW_CHUNK_BYTES || request.bytes + bytes.byteLength > WORKER_MAX_ASSEMBLED_REQUEST_BYTES) throw new Error("request data overflow");
      request.sequence += 1; request.bytes += bytes.byteLength; request.hash.update(bytes); return;
    }
    if (frame.type === "request.end") {
      active.delete(id);
      const actualHash = request.hash.digest("hex");
      if (frame.bytes !== request.bytes || frame.sha256 !== actualHash ||
          request.declaredBytes !== request.bytes || request.declaredSha256 !== actualHash) throw new Error("request hash mismatch");
      writeFrame({ type: "error", id, code: request.cancelled ? "cancelled" : "operation_not_implemented" }); return;
    }
    throw new Error("unexpected parent frame");
  };

  for await (const chunk of requestStream) {
    for (const frame of decoder.push(chunk as Buffer)) {
      await handle(frame as ParentFrame);
      if (shutdown) break;
    }
    if (shutdown) break;
  }
  if (!shutdown) decoder.end();
  if (!helloDone) throw new Error("protocol pipe closed before hello");
  requestStream.destroy();
  try { fs.closeSync(RESPONSE_FD); } catch { /* already closed */ }
}

void main().catch((error: unknown) => {
  process.stderr.write((error instanceof Error ? error.message : "worker failed").slice(0, 1_024));
  process.exitCode = 1;
});
