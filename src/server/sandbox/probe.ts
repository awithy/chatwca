import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { TextDecoder } from "node:util";

import { AppError, ERROR_CODES } from "../../shared/errors.js";
import {
  buildBwrapLaunchSpecification,
  SANDBOX_EXPECTED_ENVIRONMENT_WITH_PWD,
  SANDBOX_PROTOCOL_VERSION,
  SANDBOX_STDIO_COUNT,
  SANDBOX_WORKER_VERSION,
  type BwrapLaunchSpecification,
  type SandboxWorkerArtifact,
  type ValidatedSandboxHost,
} from "./bwrap.js";
import type { SandboxConfig } from "./config.js";

const NAMESPACES = Object.freeze(["user", "mnt", "pid", "ipc", "uts", "net"] as const);
const MAX_PROBE_FRAME_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 16 * 1024;
const EXPECTED_DEV_ENTRIES = Object.freeze([
  "core", "fd", "full", "null", "ptmx", "pts", "random", "shm",
  "stderr", "stdin", "stdout", "tty", "urandom", "zero",
]);
const EXPECTED_ETC_ENTRIES = Object.freeze(["group", "hosts", "nsswitch.conf", "passwd"]);

export interface SandboxProbeContext {
  readonly nonce: string;
  readonly artifact: Readonly<SandboxWorkerArtifact>;
  readonly parentNamespaces: Readonly<Record<(typeof NAMESPACES)[number], string>>;
  readonly expectedRootEntries: readonly string[];
  readonly expectedEnvironment: Readonly<Record<string, string>>;
  readonly workspaceDevice: string;
  readonly workspaceInode: string;
  readonly hiddenPathCount: number;
  readonly mounts: Readonly<Record<string, { readonly dev: string; readonly ino: string }>>;
}

export interface SandboxFunctionalProbeResult {
  readonly succeeded: true;
  readonly bwrapVersion: string;
  readonly nodeVersion: string;
  readonly rgVersion: string;
  readonly workerSha256: string;
}

export function loadSandboxWorkerArtifact(
  artifactPath = path.resolve(process.cwd(), "dist", "sandbox", "worker.mjs"),
): Promise<Readonly<SandboxWorkerArtifact>> {
  return readFile(artifactPath).then((source) => Object.freeze({
    source,
    sha256: createHash("sha256").update(source).digest("hex"),
    version: SANDBOX_WORKER_VERSION,
  }));
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("probe value is not an object");
  }
  return value as Record<string, unknown>;
}

function equalJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function equalStringRecord(left: unknown, right: Readonly<Record<string, string>>): boolean {
  if (typeof left !== "object" || left === null || Array.isArray(left)) return false;
  const candidate = left as Record<string, unknown>;
  const names = Object.keys(candidate).sort();
  const expectedNames = Object.keys(right).sort();
  return equalJson(names, expectedNames) && expectedNames.every((name) => candidate[name] === right[name]);
}

/** Strict parent-side checks shared by startup and future per-worker handshakes. */
export function validateSandboxWorkerReady(
  value: unknown,
  context: Readonly<SandboxProbeContext>,
): void {
  const ready = object(value);
  if (ready.type !== "ready" || ready.protocol !== SANDBOX_PROTOCOL_VERSION ||
      ready.nonce !== context.nonce) {
    throw new Error("worker handshake identity did not match");
  }
  const probe = object(ready.probe);
  const namespaces = object(probe.namespaces);
  for (const namespace of NAMESPACES) {
    if (typeof namespaces[namespace] !== "string" ||
        namespaces[namespace] === context.parentNamespaces[namespace]) {
      throw new Error(`${namespace} namespace was not isolated`);
    }
  }
  if (probe.hostname !== "chatwca-sandbox") throw new Error("sandbox hostname differs");
  if (typeof probe.capEff !== "string" || !/^0+$/.test(probe.capEff)) {
    throw new Error("effective capabilities are not empty");
  }
  if (probe.noNewPrivs !== "1") throw new Error("NoNewPrivs is not enabled");
  if (!equalStringRecord(probe.environment, context.expectedEnvironment)) {
    throw new Error("sandbox environment differs from the fixed policy");
  }
  if (!equalJson(probe.rootEntries, [...context.expectedRootEntries].sort())) {
    throw new Error("synthetic root entries differ");
  }
  if (!equalJson(probe.devEntries, EXPECTED_DEV_ENTRIES)) {
    throw new Error("minimal /dev differs");
  }
  if (!equalJson(probe.etcEntries, EXPECTED_ETC_ENTRIES)) {
    throw new Error("minimal /etc differs");
  }
  if (!Array.isArray(probe.hiddenPaths) ||
      probe.hiddenPaths.length !== context.hiddenPathCount ||
      !probe.hiddenPaths.every((hidden) => hidden === true)) {
    throw new Error("a protected parent path is visible");
  }
  const mask = object(probe.chatwcaMask);
  if (mask.hostSessionHidden !== true || mask.guestWriteVisible !== true) {
    throw new Error(".chatwca mask failed");
  }
  const workspace = object(probe.workspace);
  if (workspace.dev !== context.workspaceDevice || workspace.ino !== context.workspaceInode ||
      typeof workspace.marker !== "string") {
    throw new Error("workspace mount identity differs");
  }
  const mountIdentities = object(probe.mountIdentities);
  if (!equalJson(Object.keys(mountIdentities).sort(), Object.keys(context.mounts).sort())) {
    throw new Error("read-only mount set differs");
  }
  for (const [destination, expected] of Object.entries(context.mounts)) {
    const identity = object(mountIdentities[destination]);
    if (identity.dev !== expected.dev || identity.ino !== expected.ino || identity.readOnly !== true) {
      throw new Error("read-only mount identity or mode differs");
    }
  }
  const artifact = object(probe.artifact);
  if (artifact.sha256 !== context.artifact.sha256 ||
      artifact.version !== context.artifact.version) {
    throw new Error("worker artifact identity differs");
  }
  const commands = object(probe.commands);
  for (const name of ["node", "bash", "rg"] as const) {
    if (object(commands[name]).status !== 0) throw new Error(`${name} is unavailable in sandbox`);
  }
  if (object(commands.bash).stdout !== "bubblewrap-bash") throw new Error("sandbox bash failed");
  if (!/^v(?:22\.(?:19|[2-9]\d)|2[3-9]\.|[3-9]\d\.)/.test(String(object(commands.node).stdout))) {
    throw new Error("sandbox Node is too old");
  }
  if (!/^ripgrep\s+\d+/i.test(String(object(commands.rg).stdout))) {
    throw new Error("sandbox ripgrep failed");
  }
  const network = object(probe.network);
  for (const name of ["ipv4", "ipv6", "loopback4", "loopback6"] as const) {
    if (object(network[name]).connected !== false) throw new Error(`${name} network probe succeeded`);
  }
  if (object(network.dns).resolved !== false) throw new Error("DNS probe succeeded");
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  if (payload.byteLength === 0 || payload.byteLength > MAX_PROBE_FRAME_BYTES) {
    throw new Error("probe frame exceeds limit");
  }
  const prefix = Buffer.allocUnsafe(4);
  prefix.writeUInt32BE(payload.byteLength);
  return Buffer.concat([prefix, payload]);
}

function readOneFrame(stream: Readable, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let expected: number | undefined;
    const timer = setTimeout(() => finish(new Error("sandbox worker handshake timed out")), timeoutMs);
    const finish = (error?: unknown, result?: unknown) => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onError);
      if (error !== undefined) reject(error);
      else resolve(result);
    };
    const onEnd = () => finish(new Error("sandbox response pipe closed during handshake"));
    const onError = (error: unknown) => finish(error);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (expected === undefined && buffer.byteLength >= 4) {
        expected = buffer.readUInt32BE(0);
        if (expected === 0 || expected > MAX_PROBE_FRAME_BYTES) {
          finish(new Error("invalid sandbox handshake frame length"));
          return;
        }
      }
      if (expected !== undefined && buffer.byteLength >= expected + 4) {
        if (buffer.byteLength !== expected + 4) {
          finish(new Error("unexpected extra sandbox handshake data"));
          return;
        }
        try {
          const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4));
          finish(undefined, JSON.parse(text) as unknown);
        } catch (error) {
          finish(error);
        }
      }
    };
    stream.on("data", onData);
    stream.once("end", onEnd);
    stream.once("error", onError);
  });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("sandbox process did not exit")), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function pipe(child: ChildProcess, fd: number): NodeJS.ReadableStream & NodeJS.WritableStream {
  const stream = child.stdio[fd];
  if (stream === null || stream === undefined) throw new Error(`sandbox fd ${String(fd)} was not piped`);
  return stream as unknown as NodeJS.ReadableStream & NodeJS.WritableStream;
}

async function namespaceLinks(): Promise<Record<(typeof NAMESPACES)[number], string>> {
  return Object.fromEntries(await Promise.all(NAMESPACES.map(async (name) => [
    name,
    await readlink(`/proc/self/ns/${name}`),
  ]))) as Record<(typeof NAMESPACES)[number], string>;
}

/** Build the trusted expectations used by every nonce-bound worker handshake. */
export async function buildSandboxProbeContext(input: {
  readonly config: Readonly<SandboxConfig>;
  readonly worker: Readonly<SandboxWorkerArtifact>;
  readonly workspace: string;
  readonly hiddenPaths: readonly string[];
  readonly nonce: string;
  readonly specification: Readonly<BwrapLaunchSpecification>;
}): Promise<Readonly<SandboxProbeContext>> {
  const workspaceMetadata = await stat(input.workspace, { bigint: true });
  const mounts = Object.fromEntries(await Promise.all(input.config.readOnlyMounts.map(async (mount) => {
    const metadata = await stat(mount.source, { bigint: true });
    return [mount.destination, { dev: String(metadata.dev), ino: String(metadata.ino) }];
  })));
  return Object.freeze({
    nonce: input.nonce,
    artifact: input.worker,
    parentNamespaces: await namespaceLinks(),
    expectedRootEntries: input.specification.expectedRootEntries,
    expectedEnvironment: { ...SANDBOX_EXPECTED_ENVIRONMENT_WITH_PWD, PATH: input.config.guestPath },
    workspaceDevice: String(workspaceMetadata.dev),
    workspaceInode: String(workspaceMetadata.ino),
    hiddenPathCount: input.hiddenPaths.length,
    mounts,
  });
}

/** Launch the real profile and perform a nonce-bound worker handshake. */
export async function runSandboxWorkerProbe(input: {
  readonly config: Readonly<SandboxConfig>;
  readonly host: Readonly<ValidatedSandboxHost>;
  readonly worker: Readonly<SandboxWorkerArtifact>;
  readonly workspace: string;
  readonly hiddenPaths: readonly string[];
}): Promise<void> {
  const specification = buildBwrapLaunchSpecification(input);
  const nonce = randomBytes(24).toString("hex");
  const context = await buildSandboxProbeContext({
    ...input, nonce, specification,
  });
  const stdio = Array.from({ length: SANDBOX_STDIO_COUNT }, (_, fd) =>
    fd === 0 || fd === 1 ? "ignore" : "pipe"
  ) as ("ignore" | "pipe")[];
  const child = spawn(specification.executable, specification.argv, {
    shell: false,
    detached: true,
    stdio,
  });
  let diagnostic = "";
  let processError: unknown;
  child.once("error", (error) => { processError = error; });
  for (const stream of child.stdio) stream?.on("error", () => undefined);
  const diagnosticStream = pipe(child, 2) as unknown as Readable;
  diagnosticStream.setEncoding("utf8");
  diagnosticStream.on("data", (chunk: string) => {
    diagnostic = (diagnostic + chunk).slice(-MAX_DIAGNOSTIC_BYTES);
  });

  try {
    for (const binding of specification.dataBindings) {
      (pipe(child, binding.fd) as unknown as Writable).end(binding.payload);
    }
    const request = pipe(child, specification.requestFd) as unknown as Writable;
    const response = pipe(child, specification.responseFd) as unknown as Readable;
    const readyPromise = readOneFrame(response, input.config.startTimeoutMs);
    request.write(encodeFrame({
      type: "hello",
      protocol: SANDBOX_PROTOCOL_VERSION,
      nonce,
      artifactSha256: input.worker.sha256,
      artifactVersion: input.worker.version,
      hiddenPaths: input.hiddenPaths,
      mountPaths: input.config.readOnlyMounts.map((mount) => mount.destination),
      exitAfterProbe: true,
    }));
    const ready = await readyPromise;
    validateSandboxWorkerReady(ready, context);
    await waitForExit(child, input.config.startTimeoutMs);
    if (processError !== undefined) throw processError;
    if (child.exitCode !== 0) throw new Error("sandbox probe worker exited unsuccessfully");

    const probe = object(object(ready).probe);
    const marker = object(probe.workspace).marker;
    if (typeof marker !== "string" ||
        await readFile(path.join(input.workspace, marker), "utf8") !== "sandbox probe\n") {
      throw new Error("sandbox workspace write did not reach the host");
    }
    const hostChatWcaEntries = await import("node:fs/promises").then(({ readdir }) =>
      readdir(path.join(input.workspace, ".chatwca"))
    );
    if (!equalJson(hostChatWcaEntries.sort(), ["host-session.json"])) {
      throw new Error("ephemeral .chatwca data reached the host");
    }
    await rm(path.join(input.workspace, marker), { force: true });
  } catch (error) {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    await waitForExit(child, Math.min(input.config.startTimeoutMs, 2_000)).catch(() => undefined);
    throw new AppError(ERROR_CODES.SANDBOX_UNAVAILABLE, {
      cause: diagnostic.length === 0 ? error : { error, diagnostic },
    });
  } finally {
    for (const stream of child.stdio) stream?.destroy();
  }
}

/** Process-wide startup probe using the production builder and immutable worker. */
export async function runSandboxStartupProbe(input: {
  readonly config: Readonly<SandboxConfig>;
  readonly host: Readonly<ValidatedSandboxHost>;
  readonly worker: Readonly<SandboxWorkerArtifact>;
  readonly dataDirectory: string;
  readonly piAgentDirectory: string;
}): Promise<Readonly<SandboxFunctionalProbeResult>> {
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "chatwca-sandbox-probe-"));
  const workspace = path.join(temporaryRoot, "workspace");
  const canary = path.join(temporaryRoot, "parent-canary");
  try {
    await mkdir(path.join(workspace, ".chatwca"), { recursive: true });
    await writeFile(path.join(workspace, ".chatwca", "host-session.json"), "host only\n");
    await writeFile(canary, "parent only\n");
    const hiddenPaths = [
      await realpath(canary),
      input.dataDirectory,
      input.piAgentDirectory,
    ];
    await runSandboxWorkerProbe({ ...input, workspace, hiddenPaths });
    return Object.freeze({
      succeeded: true,
      bwrapVersion: input.host.bwrapVersion,
      nodeVersion: input.host.nodeVersion,
      rgVersion: input.host.rgVersion,
      workerSha256: input.worker.sha256,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(ERROR_CODES.SANDBOX_UNAVAILABLE, { cause: error });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
