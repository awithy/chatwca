import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as dns from "node:dns";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";

const REQUEST_FD = 8;
const RESPONSE_FD = 9;
const MAX_HANDSHAKE_FRAME_BYTES = 1024 * 1024;
const WORKER_VERSION = "1";
const NAMESPACE_NAMES = ["user", "mnt", "pid", "ipc", "uts", "net"] as const;

interface HelloFrame {
  readonly type: "hello";
  readonly protocol: 1;
  readonly nonce: string;
  readonly artifactSha256: string;
  readonly artifactVersion: string;
  readonly hiddenPaths: readonly string[];
  readonly mountPaths: readonly string[];
  readonly exitAfterProbe: boolean;
}

function readExactly(fd: number, bytes: number): Buffer {
  const result = Buffer.allocUnsafe(bytes);
  let offset = 0;
  while (offset < bytes) {
    const read = fs.readSync(fd, result, offset, bytes - offset, null);
    if (read === 0) throw new Error("protocol pipe closed");
    offset += read;
  }
  return result;
}

function readFrame(): unknown {
  const length = readExactly(REQUEST_FD, 4).readUInt32BE(0);
  if (length === 0 || length > MAX_HANDSHAKE_FRAME_BYTES) {
    throw new Error("invalid handshake frame length");
  }
  return JSON.parse(readExactly(REQUEST_FD, length).toString("utf8")) as unknown;
}

function writeFrame(value: unknown): void {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.byteLength > MAX_HANDSHAKE_FRAME_BYTES) throw new Error("handshake frame too large");
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(payload.byteLength);
  fs.writeSync(RESPONSE_FD, prefix);
  fs.writeSync(RESPONSE_FD, payload);
}

function isHello(value: unknown): value is HelloFrame {
  if (typeof value !== "object" || value === null) return false;
  const frame = value as Partial<HelloFrame>;
  return frame.type === "hello" &&
    frame.protocol === 1 &&
    typeof frame.nonce === "string" && frame.nonce.length >= 16 && frame.nonce.length <= 256 &&
    typeof frame.artifactSha256 === "string" && /^[a-f0-9]{64}$/.test(frame.artifactSha256) &&
    frame.artifactVersion === WORKER_VERSION &&
    Array.isArray(frame.hiddenPaths) && frame.hiddenPaths.every((entry) => typeof entry === "string") &&
    Array.isArray(frame.mountPaths) && frame.mountPaths.every((entry) => typeof entry === "string") &&
    typeof frame.exitAfterProbe === "boolean";
}

function statusValue(status: string, name: string): string | undefined {
  return new RegExp(`^${name}:\\s*(.+)$`, "m").exec(status)?.[1];
}

function command(executable: string, args: readonly string[]): object {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    timeout: 3_000,
    env: process.env,
  });
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout.trim(),
  };
}

function connect(options: net.NetConnectOpts): Promise<object> {
  return new Promise((resolve) => {
    const socket = net.createConnection(options);
    let finished = false;
    const finish = (connected: boolean, error: string | null) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve({ connected, error });
    };
    socket.setTimeout(1_000, () => finish(false, "timeout"));
    socket.once("connect", () => finish(true, null));
    socket.once("error", (error: NodeJS.ErrnoException) => finish(false, error.code ?? "error"));
  });
}

function lookup(): Promise<object> {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      resolve({ resolved: false, error: "timeout" });
    }, 1_000);
    dns.lookup("example.com", (error, address) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ resolved: error === null, address: address || null, error: error?.code ?? null });
    });
  });
}

async function collectProbe(hello: HelloFrame, actualHash: string): Promise<object> {
  const status = fs.readFileSync("/proc/self/status", "utf8");
  const marker = `.chatwca-probe-${hello.nonce}`;
  fs.writeFileSync(`/workspace/${marker}`, "sandbox probe\n", { flag: "wx" });
  fs.writeFileSync("/workspace/.chatwca/guest-only.txt", "ephemeral\n");
  const workspace = fs.statSync("/workspace", { bigint: true });
  const mountLines = fs.readFileSync("/proc/self/mountinfo", "utf8").trim().split("\n");
  const decodeMountPath = (value: string) => value.replace(/\\(040|011|012|134)/g, (match, code: string) => ({
    "040": " ", "011": "\t", "012": "\n", "134": "\\",
  })[code] ?? match);
  const mountIdentities = Object.fromEntries(hello.mountPaths.map((mountPath) => {
    const metadata = fs.statSync(mountPath, { bigint: true });
    const line = mountLines.find((candidate) => decodeMountPath(candidate.split(" ")[4] ?? "") === mountPath);
    const options = line?.split(" ")[5]?.split(",") ?? [];
    return [mountPath, { dev: String(metadata.dev), ino: String(metadata.ino), readOnly: options.includes("ro") }];
  }));
  return {
    namespaces: Object.fromEntries(NAMESPACE_NAMES.map((name) => [
      name,
      fs.readlinkSync(`/proc/self/ns/${name}`),
    ])),
    hostname: os.hostname(),
    capEff: statusValue(status, "CapEff"),
    noNewPrivs: statusValue(status, "NoNewPrivs"),
    environment: process.env,
    rootEntries: fs.readdirSync("/").sort(),
    devEntries: fs.readdirSync("/dev").sort(),
    etcEntries: fs.readdirSync("/etc").sort(),
    hiddenPaths: hello.hiddenPaths.map((hiddenPath) => !fs.existsSync(hiddenPath)),
    chatwcaMask: {
      hostSessionHidden: !fs.existsSync("/workspace/.chatwca/host-session.json"),
      guestWriteVisible: fs.existsSync("/workspace/.chatwca/guest-only.txt"),
    },
    workspace: { dev: String(workspace.dev), ino: String(workspace.ino), marker },
    mountIdentities,
    artifact: { sha256: actualHash, version: WORKER_VERSION },
    commands: {
      node: command("/usr/bin/node", ["--version"]),
      bash: command("/bin/bash", ["-lc", "printf bubblewrap-bash"]),
      rg: command("rg", ["--version"]),
    },
    network: {
      ipv4: await connect({ host: "1.1.1.1", port: 53 }),
      ipv6: await connect({ host: "2606:4700:4700::1111", port: 53, family: 6 }),
      loopback4: await connect({ host: "127.0.0.1", port: 9 }),
      loopback6: await connect({ host: "::1", port: 9, family: 6 }),
      dns: await lookup(),
    },
  };
}

async function main(): Promise<void> {
  const source = fs.readFileSync(new URL(import.meta.url));
  const actualHash = createHash("sha256").update(source).digest("hex");
  const frame = readFrame();
  if (!isHello(frame) || frame.artifactSha256 !== actualHash) {
    throw new Error("invalid worker handshake");
  }
  writeFrame({
    type: "ready",
    protocol: 1,
    nonce: frame.nonce,
    probe: await collectProbe(frame, actualHash),
  });
  if (frame.exitAfterProbe) return;

  const shutdown = readFrame();
  if (typeof shutdown !== "object" || shutdown === null ||
      (shutdown as { readonly type?: unknown }).type !== "shutdown") {
    throw new Error("unexpected worker frame");
  }
  writeFrame({ type: "shutdown.complete" });
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "worker failed";
  process.stderr.write(message.slice(0, 1_024));
  process.exitCode = 1;
});
