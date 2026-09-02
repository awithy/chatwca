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
import { workspaceMountGuestPath, type WorkspaceMount } from "../../shared/protocol.js";
import type { ManagedNetworkConfig } from "../network/config.js";
import type { ValidatedNetworkHelper } from "../network/helper.js";
import { ManagedNetworkRuntime } from "../network/managed-runtime.js";
import { compileDestinationPolicy } from "../network/policy.js";
import {
  buildBwrapLaunchSpecification,
  buildManagedBwrapLaunchSpecification,
  managedSandboxEnvironment,
  SANDBOX_EXPECTED_ENVIRONMENT_WITH_PWD,
  SANDBOX_PROTOCOL_VERSION,
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
  readonly profile: "isolated" | "managed-egress";
  readonly helperVersion: string | null;
  readonly guestPath: string;
  readonly artifact: Readonly<SandboxWorkerArtifact>;
  readonly parentNamespaces: Readonly<Record<(typeof NAMESPACES)[number], string>>;
  readonly expectedRootEntries: readonly string[];
  readonly expectedEnvironment: Readonly<Record<string, string>>;
  readonly workspaceDevice: string;
  readonly workspaceInode: string;
  readonly hiddenPathCount: number;
  readonly mounts: Readonly<Record<string, {
    readonly dev: string;
    readonly ino: string;
    readonly readOnly: boolean;
  }>>;
}

export interface SandboxFunctionalProbeResult {
  readonly succeeded: true;
  readonly managedEgressSucceeded?: boolean;
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
  for (const name of ["capInh", "capPrm", "capEff", "capBnd", "capAmb"] as const) {
    if (typeof probe[name] !== "string" || !/^0+$/.test(probe[name] as string)) {
      throw new Error(`${name} capabilities are not empty`);
    }
  }
  if (probe.noNewPrivs !== "1") throw new Error("NoNewPrivs is not enabled");
  const network = object(probe.network);
  if (network.profile !== context.profile) throw new Error("sandbox network profile differs");
  let expectedEnvironment = context.expectedEnvironment;
  if (context.profile === "managed-egress") {
    const ports = object(network.guestPorts);
    if (!Number.isInteger(ports.http) || !Number.isInteger(ports.socks) || ports.http === ports.socks) {
      throw new Error("managed guest proxy ports are invalid");
    }
    expectedEnvironment = managedSandboxEnvironment(ports.http as number, ports.socks as number, context.guestPath);
  }
  if (!equalStringRecord(probe.environment, expectedEnvironment)) {
    throw new Error("sandbox environment differs from the fixed policy");
  }
  if (!equalJson(probe.rootEntries, [...context.expectedRootEntries].sort())) {
    throw new Error("synthetic root entries differ");
  }
  if (!equalJson(probe.devEntries, EXPECTED_DEV_ENTRIES)) {
    throw new Error("minimal /dev differs");
  }
  const expectedEtcEntries = context.profile === "managed-egress"
    ? [...EXPECTED_ETC_ENTRIES, "ssl"].sort()
    : EXPECTED_ETC_ENTRIES;
  if (!equalJson(probe.etcEntries, expectedEtcEntries)) {
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
    if (identity.dev !== expected.dev || identity.ino !== expected.ino || identity.readOnly !== expected.readOnly) {
      throw new Error("filesystem mount identity or mode differs");
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
  for (const name of ["ipv4", "ipv6", "loopback4", "loopback6"] as const) {
    if (object(network[name]).connected !== false) throw new Error(`${name} network probe succeeded`);
  }
  if (object(network.dns).resolved !== false) throw new Error("DNS probe succeeded");
  const descriptorTargets = object(network.protocolDescriptors);
  if (typeof descriptorTargets["8"] !== "string" || typeof descriptorTargets["9"] !== "string") {
    throw new Error("worker control IPC descriptors changed");
  }
  if (Object.values(descriptorTargets).some((target) =>
    typeof target !== "string" || target.includes("chatwca-") || target.endsWith(";unix-type=0005")
  )) throw new Error("helper bootstrap or artifact descriptor survived");
  if (context.profile === "managed-egress") {
    if (probe.seccomp !== "2") throw new Error("managed seccomp is not active");
    if (network.caBundleReadable !== true) throw new Error("managed CA certificate bundle is unavailable");
    if (network.helperVersion !== context.helperVersion) throw new Error("managed helper version differs");
    for (const name of ["httpEndpoint", "socksEndpoint"] as const) {
      if (object(network[name]).connected !== true) throw new Error(`${name} did not answer`);
    }
    for (const name of ["httpLocalDenial", "socksLocalDenial"] as const) {
      const denial = object(network[name]);
      if (denial.connected !== true || denial.denied !== true) throw new Error(`${name} did not cross the managed bridge`);
    }
    if (object(network.directWithoutProxy).blocked !== true) throw new Error("direct network fallback became available without proxy variables");
    const unixSocket = object(network.unixSocket);
    if (unixSocket.created !== false || unixSocket.error !== "EPERM") throw new Error("Unix socket creation was not denied");
    if (object(network.unixSocketpair).available !== true) throw new Error("Unix socketpair is unavailable");
  }
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
  readonly mounts?: readonly WorkspaceMount[];
  readonly hiddenPaths: readonly string[];
  readonly nonce: string;
  readonly specification: Readonly<BwrapLaunchSpecification>;
}): Promise<Readonly<SandboxProbeContext>> {
  const workspaceMetadata = await stat(input.workspace, { bigint: true });
  const mountEntries = [
    ...input.config.readOnlyMounts.map((mount) => ({
      source: mount.source,
      destination: mount.destination,
      readOnly: true,
    })),
    ...(input.mounts ?? []).map((mount) => ({
      source: mount.source,
      destination: workspaceMountGuestPath(mount.name),
      readOnly: mount.access === "read-only",
    })),
  ];
  const mounts = Object.fromEntries(await Promise.all(mountEntries.map(async (mount) => {
    const metadata = await stat(mount.source, { bigint: true });
    return [mount.destination, {
      dev: String(metadata.dev),
      ino: String(metadata.ino),
      readOnly: mount.readOnly,
    }];
  })));
  return Object.freeze({
    nonce: input.nonce,
    profile: input.specification.profile,
    helperVersion: input.specification.helperBuildVersion ?? null,
    guestPath: input.config.guestPath,
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
  readonly mounts?: readonly WorkspaceMount[];
  readonly hiddenPaths: readonly string[];
  readonly managedProfile?: {
    readonly helper: import("../network/helper.js").ValidatedNetworkHelper;
    readonly httpSocketPath: string;
    readonly socksSocketPath: string;
  };
}): Promise<void> {
  const specification = input.managedProfile === undefined
    ? buildBwrapLaunchSpecification(input)
    : buildManagedBwrapLaunchSpecification({ ...input, ...input.managedProfile });
  const nonce = randomBytes(24).toString("hex");
  const context = await buildSandboxProbeContext({
    ...input, nonce, specification,
  });
  const stdio = Array.from({ length: specification.stdioCount }, (_, fd) =>
    fd === 0 || fd === 1 ? "ignore" : "pipe"
  ) as ("ignore" | "pipe")[];
  const child = spawn(specification.executable, specification.argv, {
    shell: false,
    detached: true,
    stdio,
    ...(specification.emptyEnvironment ? { env: {} } : {}),
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
    const helperReadyPromise = specification.helperReadyFd === undefined
      ? Promise.resolve()
      : readOneFrame(pipe(child, specification.helperReadyFd) as unknown as Readable, input.config.startTimeoutMs).then((value) => {
          const message = object(value);
          if (message.type !== "ready" || message.protocol !== 1 ||
              !Number.isSafeInteger(message.helperPid) || !Number.isSafeInteger(message.bwrapPid) ||
              Object.keys(message).sort().join("\0") !== ["bwrapPid", "helperPid", "protocol", "type"].sort().join("\0")) {
            throw new Error("managed helper did not report ready");
          }
        });
    request.write(encodeFrame({
      type: "hello",
      protocol: SANDBOX_PROTOCOL_VERSION,
      nonce,
      artifactSha256: input.worker.sha256,
      artifactVersion: input.worker.version,
      hiddenPaths: input.hiddenPaths,
      mountPaths: Object.keys(context.mounts),
      exitAfterProbe: true,
      commandTimeoutMs: input.config.commandTimeoutMs,
      maxCommandOutputBytes: input.config.maxCommandOutputBytes,
    }));
    const [ready] = await Promise.all([readyPromise, helperReadyPromise]);
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
  readonly managedNetwork?: {
    readonly config: Readonly<ManagedNetworkConfig>;
    readonly helper: Readonly<ValidatedNetworkHelper>;
  };
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
    if (input.managedNetwork !== undefined) {
      const destinationPolicy = compileDestinationPolicy({
        allowedDomainPatterns: ["127.0.0.1"],
        deniedDomainPatterns: [],
        allowedPorts: [80],
      });
      const probePolicySet = Object.freeze({
        id: "default",
        label: "Startup probe",
        allowedDomainPatterns: Object.freeze(["127.0.0.1"]),
        allowedPorts: Object.freeze([80]),
        destinationPolicy,
      });
      const probeConfig: ManagedNetworkConfig = Object.freeze({
        ...input.managedNetwork.config,
        allowedDomainPatterns: Object.freeze(["127.0.0.1"]),
        deniedDomainPatterns: Object.freeze([]),
        allowedPorts: Object.freeze([80]),
        policySets: new Map([[probePolicySet.id, probePolicySet]]),
        orderedPolicySets: Object.freeze([probePolicySet]),
        allowedPortSet: destinationPolicy.allowedPorts,
        destinationPolicy,
      });
      const runtime = await ManagedNetworkRuntime.start({
        dataDir: input.dataDirectory,
        workspaceId: "startup-probe",
        conversationId: `startup-probe-${randomBytes(8).toString("hex")}`,
        policySetId: probePolicySet.id,
        policySet: probePolicySet,
        config: probeConfig,
        diagnosticSink: () => undefined,
      });
      try {
        await runSandboxWorkerProbe({
          ...input,
          workspace,
          hiddenPaths,
          managedProfile: {
            helper: input.managedNetwork.helper,
            httpSocketPath: runtime.httpSocketPath,
            socksSocketPath: runtime.socksSocketPath,
          },
        });
      } finally {
        await runtime.close();
      }
    }
    return Object.freeze({
      succeeded: true,
      managedEgressSucceeded: input.managedNetwork !== undefined,
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
