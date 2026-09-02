import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { AppError, ERROR_CODES } from "../../shared/errors.js";

export const NETWORK_HELPER_NAME = "chatwca-network-helper";
export const NETWORK_HELPER_BUILD_VERSION = "1.0.0";
export const NETWORK_HELPER_PROTOCOL_VERSION = 1;
export const NETWORK_HELPER_MANIFEST_SCHEMA_VERSION = 1;
export const NETWORK_HELPER_LAUNCH_FD = 3;
export const NETWORK_HELPER_READY_FD = 4;
export const NETWORK_HELPER_INNER_CONFIG_FD = 7;
export const NETWORK_HELPER_WORKER_REQUEST_FD = 8;
export const NETWORK_HELPER_WORKER_RESPONSE_FD = 9;
export const NETWORK_HELPER_HTTP_BOOTSTRAP_FD = 10;
export const NETWORK_HELPER_SOCKS_BOOTSTRAP_FD = 11;
export const NETWORK_HELPER_SELF_ARTIFACT_FD = 12;
export const NETWORK_HELPER_MAX_LAUNCH_BYTES = 64 * 1024;

export interface NetworkHelperManifest {
  readonly schemaVersion: 1;
  readonly name: typeof NETWORK_HELPER_NAME;
  readonly buildVersion: typeof NETWORK_HELPER_BUILD_VERSION;
  readonly protocolVersion: typeof NETWORK_HELPER_PROTOCOL_VERSION;
  readonly platform: "linux";
  readonly architecture: "x64" | "arm64";
  readonly file: typeof NETWORK_HELPER_NAME;
  readonly sha256: string;
}

export interface ValidatedNetworkHelper {
  readonly path: string;
  readonly directory: string;
  readonly manifestPath: string;
  readonly architecture: "x64" | "arm64";
  readonly buildVersion: string;
  readonly protocolVersion: number;
  readonly sha256: string;
}

export interface NetworkHelperValidationInput {
  readonly helperPath: string;
  readonly manifestPath: string;
  readonly protectedPaths?: readonly string[];
}

export interface NetworkHelperValidationFileSystem {
  readonly realpath: (target: string) => string;
  readonly lstat: (target: string) => {
    readonly uid: number;
    readonly mode: number;
    readonly size: number;
    readonly isFile: () => boolean;
    readonly isDirectory: () => boolean;
  };
  readonly access: (target: string, mode: number) => void;
  readonly readFile: (target: string) => Buffer;
}

export interface NetworkHelperValidationPlatform {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly uid: number;
  readonly spawn: (
    executable: string,
    argv: readonly string[],
  ) => SpawnSyncReturns<string>;
}

const fileSystem: NetworkHelperValidationFileSystem = {
  realpath: realpathSync,
  lstat: lstatSync,
  access: accessSync,
  readFile: (target) => readFileSync(target),
};

const platform: NetworkHelperValidationPlatform = {
  platform: process.platform,
  architecture: process.arch,
  uid: process.geteuid?.() ?? process.getuid?.() ?? -1,
  spawn: (executable, argv) => spawnSync(executable, argv, {
    encoding: "utf8",
    env: {},
    shell: false,
    timeout: 3_000,
    maxBuffer: 4 * 1024,
  }),
};

function unavailable(cause: unknown): AppError {
  return new AppError(ERROR_CODES.NETWORK_HELPER_UNAVAILABLE, { cause });
}

function safeDirectory(
  target: string,
  expectedUid: number,
  fs: NetworkHelperValidationFileSystem,
): string {
  const canonical = fs.realpath(target);
  if (canonical !== path.resolve(target)) throw new Error("network helper directory is not canonical");
  const metadata = fs.lstat(canonical);
  if (!metadata.isDirectory() || (metadata.uid !== 0 && metadata.uid !== expectedUid)
      || (metadata.mode & 0o022) !== 0) {
    throw new Error("network helper directory ownership or mode is unsafe");
  }
  return canonical;
}

function safeFile(
  target: string,
  expectedUid: number,
  fs: NetworkHelperValidationFileSystem,
  executable: boolean,
): { readonly canonical: string; readonly bytes: Buffer } {
  const canonical = fs.realpath(target);
  if (canonical !== path.resolve(target)) {
    throw new Error("network helper path is not canonical");
  }
  const metadata = fs.lstat(canonical);
  if (!metadata.isFile() || (metadata.uid !== 0 && metadata.uid !== expectedUid)) {
    throw new Error("network helper file ownership or type is unsafe");
  }
  if ((metadata.mode & 0o022) !== 0 || metadata.size <= 0 || metadata.size > 64 * 1024 * 1024) {
    throw new Error("network helper file mode or size is unsafe");
  }
  if (executable) fs.access(canonical, fsConstants.X_OK);
  const bytes = fs.readFile(canonical);
  if (bytes.byteLength !== metadata.size) throw new Error("network helper file changed while validating");
  return { canonical, bytes };
}

function isClosedObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

function parseManifest(bytes: Buffer): NetworkHelperManifest {
  if (bytes.byteLength > 64 * 1024) throw new Error("network helper manifest is oversized");
  let value: unknown;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("network helper manifest is invalid"); }
  const keys = [
    "schemaVersion", "name", "buildVersion", "protocolVersion",
    "platform", "architecture", "file", "sha256",
  ] as const;
  if (!isClosedObject(value, keys)
      || value.schemaVersion !== NETWORK_HELPER_MANIFEST_SCHEMA_VERSION
      || value.name !== NETWORK_HELPER_NAME
      || value.buildVersion !== NETWORK_HELPER_BUILD_VERSION
      || value.protocolVersion !== NETWORK_HELPER_PROTOCOL_VERSION
      || value.platform !== "linux"
      || (value.architecture !== "x64" && value.architecture !== "arm64")
      || value.file !== NETWORK_HELPER_NAME
      || typeof value.sha256 !== "string"
      || !/^[a-f0-9]{64}$/.test(value.sha256)) {
    throw new Error("network helper manifest contract is invalid");
  }
  return value as unknown as NetworkHelperManifest;
}

function validateElf(bytes: Buffer, architecture: "x64" | "arm64"): void {
  const machine = architecture === "x64" ? 62 : 183;
  if (bytes.byteLength < 64
      || bytes[0] !== 0x7f || bytes.subarray(1, 4).toString("ascii") !== "ELF"
      || bytes[4] !== 2 // ELFCLASS64
      || bytes[5] !== 1 // little endian
      || bytes.readUInt16LE(16) !== 2 && bytes.readUInt16LE(16) !== 3
      || bytes.readUInt16LE(18) !== machine) {
    throw new Error("network helper ELF architecture is invalid");
  }
}

function overlaps(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function validateSeparation(
  helperPath: string,
  helperDirectory: string,
  protectedPaths: readonly string[],
): void {
  for (const protectedPath of protectedPaths) {
    const protectedAbsolute = path.resolve(protectedPath);
    if (overlaps(protectedAbsolute, helperPath) || overlaps(helperDirectory, protectedAbsolute)) {
      throw new Error("network helper overlaps a protected path");
    }
  }
}

function validateReportedVersion(
  helperPath: string,
  expected: NetworkHelperManifest,
  runtime: NetworkHelperValidationPlatform,
): void {
  const result = runtime.spawn(helperPath, ["--version"]);
  if (result.error !== undefined || result.status !== 0 || result.signal !== null
      || result.stderr.length !== 0 || Buffer.byteLength(result.stdout) > 4 * 1024) {
    throw result.error ?? new Error("network helper version command failed");
  }
  let reported: unknown;
  try { reported = JSON.parse(result.stdout); } catch { throw new Error("network helper version output is invalid"); }
  if (!isClosedObject(reported, ["name", "version", "protocol"])
      || reported.name !== expected.name || reported.version !== expected.buildVersion
      || reported.protocol !== expected.protocolVersion) {
    throw new Error("network helper reported an incompatible protocol");
  }
}

/** Validate the packaged identity before any managed worker may be launched. */
export function validateNetworkHelper(
  input: Readonly<NetworkHelperValidationInput>,
  options: {
    readonly fileSystem?: NetworkHelperValidationFileSystem;
    readonly platform?: NetworkHelperValidationPlatform;
  } = {},
): Readonly<ValidatedNetworkHelper> {
  const fs = options.fileSystem ?? fileSystem;
  const runtime = options.platform ?? platform;
  try {
    if (runtime.platform !== "linux" || (runtime.architecture !== "x64" && runtime.architecture !== "arm64")) {
      throw new Error("managed egress requires supported Linux architecture");
    }
    const manifestDirectory = safeDirectory(path.dirname(input.manifestPath), runtime.uid, fs);
    const manifestFile = safeFile(input.manifestPath, runtime.uid, fs, false);
    if (path.dirname(manifestFile.canonical) !== manifestDirectory) throw new Error("network helper manifest directory changed");
    const manifest = parseManifest(manifestFile.bytes);
    if (manifest.architecture !== runtime.architecture) throw new Error("network helper manifest architecture mismatch");
    const helperDirectory = safeDirectory(path.dirname(input.helperPath), runtime.uid, fs);
    const helper = safeFile(input.helperPath, runtime.uid, fs, true);
    if (path.dirname(helper.canonical) !== helperDirectory) throw new Error("network helper directory changed");
    if (path.basename(helper.canonical) !== manifest.file) throw new Error("network helper filename is invalid");
    validateElf(helper.bytes, runtime.architecture);
    const actualHash = Buffer.from(createHash("sha256").update(helper.bytes).digest("hex"), "ascii");
    const expectedHash = Buffer.from(manifest.sha256, "ascii");
    if (actualHash.byteLength !== expectedHash.byteLength || !timingSafeEqual(actualHash, expectedHash)) {
      throw new Error("network helper hash mismatch");
    }
    const directory = helperDirectory;
    validateSeparation(helper.canonical, directory, input.protectedPaths ?? []);
    validateReportedVersion(helper.canonical, manifest, runtime);
    return Object.freeze({
      path: helper.canonical,
      directory,
      manifestPath: manifestFile.canonical,
      architecture: runtime.architecture,
      buildVersion: manifest.buildVersion,
      protocolVersion: manifest.protocolVersion,
      sha256: manifest.sha256,
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unavailable(error);
  }
}
