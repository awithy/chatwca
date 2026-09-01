import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  accessSync,
  constants as fsConstants,
  lstatSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import { AppError, ERROR_CODES } from "../../shared/errors.js";
import type { SandboxConfig, SandboxReadOnlyMount } from "./config.js";

export const SANDBOX_PROTOCOL_VERSION = 1;
export const SANDBOX_WORKER_VERSION = "1";
export const BWRAP_MINIMUM_VERSION = Object.freeze([0, 6, 1] as const);
export const SANDBOX_REQUEST_FD = 8;
export const SANDBOX_RESPONSE_FD = 9;
export const SANDBOX_STDIO_COUNT = 10;

export const SANDBOX_ENVIRONMENT = Object.freeze({
  HOME: "/home/sandbox",
  TMPDIR: "/tmp",
  PATH: "/usr/bin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TERM: "dumb",
  NO_COLOR: "1",
  CI: "1",
  USER: "sandbox",
  LOGNAME: "sandbox",
  SHELL: "/bin/bash",
});

export const SANDBOX_EXPECTED_ENVIRONMENT_WITH_PWD = Object.freeze({
  ...SANDBOX_ENVIRONMENT,
  PWD: "/workspace",
});

export interface SandboxWorkerArtifact {
  readonly source: Buffer;
  readonly sha256: string;
  readonly version: string;
}

export interface BwrapDataBinding {
  readonly fd: number;
  readonly destination: string;
  readonly payload: Buffer;
}

export interface BwrapCompatibilityLinks {
  readonly bin: boolean;
  readonly sbin: boolean;
  readonly lib: boolean;
  readonly lib64: boolean;
}

export interface ValidatedSandboxHost {
  readonly bwrapPath: string;
  readonly bwrapVersion: string;
  readonly nodeVersion: string;
  readonly rgPath: string;
  readonly rgVersion: string;
  readonly compatibilityLinks: Readonly<BwrapCompatibilityLinks>;
}

export interface BwrapLaunchSpecification {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly dataBindings: readonly BwrapDataBinding[];
  readonly requestFd: number;
  readonly responseFd: number;
  readonly expectedRootEntries: readonly string[];
}

export interface BwrapValidationFileSystem {
  readonly realpath: (target: string) => string;
  readonly lstat: (target: string) => {
    readonly uid: number;
    readonly mode: number;
    readonly isFile: () => boolean;
    readonly isDirectory: () => boolean;
  };
  readonly access: (target: string, mode: number) => void;
}

export interface BwrapValidationPlatform {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  readonly spawn: (
    executable: string,
    argv: readonly string[],
  ) => SpawnSyncReturns<string>;
}

const validationFileSystem: BwrapValidationFileSystem = {
  realpath: realpathSync,
  lstat: lstatSync,
  access: accessSync,
};

const validationPlatform: BwrapValidationPlatform = {
  platform: process.platform,
  architecture: process.arch,
  spawn: (executable, argv) => spawnSync(executable, argv, {
    encoding: "utf8",
    shell: false,
    timeout: 3_000,
    maxBuffer: 256 * 1024,
    env: {},
  }),
};

const MINIMAL_ETC = Object.freeze([
  [3, "/app/worker.mjs", undefined],
  [4, "/etc/passwd", "sandbox:x:0:0:Sandbox:/home/sandbox:/bin/bash\n"],
  [5, "/etc/group", "sandbox:x:0:\n"],
  [6, "/etc/hosts", "127.0.0.1 localhost\n::1 localhost\n"],
  [7, "/etc/nsswitch.conf", "hosts: files dns\n"],
] as const);

const LINK_DEFINITIONS = Object.freeze([
  ["bin", "usr/bin", "/bin", "/usr/bin"],
  ["sbin", "usr/sbin", "/sbin", "/usr/sbin"],
  ["lib", "usr/lib", "/lib", "/usr/lib"],
  ["lib64", "usr/lib64", "/lib64", "/usr/lib64"],
] as const);

function configurationFailure(cause: unknown): AppError {
  return new AppError(ERROR_CODES.SANDBOX_CONFIGURATION_ERROR, { cause });
}

function unavailable(cause: unknown): AppError {
  return new AppError(ERROR_CODES.SANDBOX_UNAVAILABLE, { cause });
}

function parseVersion(output: string, pattern: RegExp): readonly [number, number, number] | undefined {
  const match = pattern.exec(output.trim());
  if (match === null) return undefined;
  const values = match.slice(1, 4).map(Number);
  return values.every(Number.isSafeInteger)
    ? values as unknown as readonly [number, number, number]
    : undefined;
}

function atLeast(
  actual: readonly [number, number, number],
  minimum: readonly [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index]! > minimum[index]!;
  }
  return true;
}

function requireExecutable(
  executable: string,
  fileSystem: BwrapValidationFileSystem,
): void {
  const metadata = fileSystem.lstat(executable);
  if (!metadata.isFile()) throw new Error("required executable is not a regular file");
  fileSystem.access(executable, fsConstants.X_OK);
}

function directoryExists(directory: string, fileSystem: BwrapValidationFileSystem): boolean {
  try {
    return fileSystem.lstat(directory).isDirectory();
  } catch {
    return false;
  }
}

function runVersion(
  executable: string,
  args: readonly string[],
  platform: BwrapValidationPlatform,
): string {
  const result = platform.spawn(executable, args);
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) {
    throw result.error ?? new Error("required executable version command failed");
  }
  return result.stdout.trim();
}

function hostPathForGuestPath(entry: string): string {
  if (entry === "/bin" || entry.startsWith("/bin/")) return `/usr${entry}`;
  if (entry === "/sbin" || entry.startsWith("/sbin/")) return `/usr${entry}`;
  return entry;
}

/** Validate every host/toolchain assumption used by the synthetic root. */
export function validateBwrapAndToolchain(
  config: Readonly<SandboxConfig>,
  options: {
    readonly fileSystem?: BwrapValidationFileSystem;
    readonly platform?: BwrapValidationPlatform;
  } = {},
): Readonly<ValidatedSandboxHost> {
  const fileSystem = options.fileSystem ?? validationFileSystem;
  const platform = options.platform ?? validationPlatform;
  if (platform.platform !== "linux") {
    throw unavailable(new Error("Bubblewrap sandboxing requires Linux"));
  }
  if (platform.architecture !== "x64" && platform.architecture !== "arm64") {
    throw configurationFailure(new Error("unsupported sandbox architecture"));
  }

  let canonicalBwrap: string;
  try {
    canonicalBwrap = fileSystem.realpath(config.bwrapPath);
    if (canonicalBwrap !== config.bwrapPath) {
      throw new Error("Bubblewrap path is not canonical");
    }
    const metadata = fileSystem.lstat(canonicalBwrap);
    if (!metadata.isFile() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error("Bubblewrap executable ownership or mode is unsafe");
    }
    fileSystem.access(canonicalBwrap, fsConstants.X_OK);
  } catch (error) {
    throw configurationFailure(error);
  }

  try {
    const bwrapOutput = runVersion(canonicalBwrap, ["--version"], platform);
    const bwrapVersion = parseVersion(bwrapOutput, /^bubblewrap\s+(\d+)\.(\d+)\.(\d+)(?:\s|$)/i);
    if (bwrapVersion === undefined || !atLeast(bwrapVersion, BWRAP_MINIMUM_VERSION)) {
      throw new Error("Bubblewrap 0.6.1 or newer is required");
    }

    requireExecutable("/usr/bin/node", fileSystem);
    const nodeOutput = runVersion("/usr/bin/node", ["--version"], platform);
    const nodeVersion = parseVersion(nodeOutput, /^v(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/);
    if (nodeVersion === undefined || !atLeast(nodeVersion, [22, 19, 0])) {
      throw new Error("sandbox Node 22.19.0 or newer is required");
    }

    const compatibilityLinks = Object.fromEntries(LINK_DEFINITIONS.map(
      ([name, , , target]) => [name, directoryExists(target, fileSystem)],
    )) as unknown as BwrapCompatibilityLinks;
    if (!compatibilityLinks.bin) throw new Error("/bin compatibility link is unavailable");
    requireExecutable("/usr/bin/bash", fileSystem);

    let rgPath: string | undefined;
    for (const entry of config.guestPath.split(":")) {
      const candidate = path.join(hostPathForGuestPath(entry), "rg");
      try {
        requireExecutable(candidate, fileSystem);
        rgPath = candidate;
        break;
      } catch {
        // Continue through the fixed administrator-approved PATH.
      }
    }
    if (rgPath === undefined) throw new Error("ripgrep is not available on the sandbox PATH");
    const rgVersion = runVersion(rgPath, ["--version"], platform);
    if (!/^ripgrep\s+\d+/i.test(rgVersion)) throw new Error("invalid ripgrep executable");

    return Object.freeze({
      bwrapPath: canonicalBwrap,
      bwrapVersion: bwrapOutput,
      nodeVersion: nodeOutput,
      rgPath,
      rgVersion: rgVersion.split("\n", 1)[0]!,
      compatibilityLinks: Object.freeze(compatibilityLinks),
    });
  } catch (error) {
    throw unavailable(error);
  }
}

function mountParentDirectories(mounts: readonly SandboxReadOnlyMount[]): string[] {
  const directories = new Set<string>();
  for (const mount of mounts) {
    let current = path.posix.dirname(mount.destination);
    while (current !== "/") {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...directories].sort((left, right) =>
    left.split("/").length - right.split("/").length || left.localeCompare(right)
  );
}

/** Pure construction of Bubblewrap argv and immutable inherited-FD payloads. */
export function buildBwrapLaunchSpecification(input: {
  readonly config: Readonly<SandboxConfig>;
  readonly host: Readonly<ValidatedSandboxHost>;
  readonly workspace: string;
  readonly worker: Readonly<SandboxWorkerArtifact>;
}): Readonly<BwrapLaunchSpecification> {
  const dataBindings = MINIMAL_ETC.map(([fd, destination, payload]) => Object.freeze({
    fd,
    destination,
    payload: payload === undefined ? input.worker.source : Buffer.from(payload),
  }));
  const argv: string[] = [
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--unshare-net",
    "--hostname", "chatwca-sandbox",
    "--cap-drop", "ALL",
    "--new-session",
    "--die-with-parent",
    "--clearenv",
    "--ro-bind", "/usr", "/usr",
  ];

  for (const [name, target, destination] of LINK_DEFINITIONS) {
    if (input.host.compatibilityLinks[name]) argv.push("--symlink", target, destination);
  }
  argv.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/home",
    "--dir", "/home/sandbox",
    "--tmpfs", "/tmp",
    "--dir", "/var",
    "--tmpfs", "/var/tmp",
    "--dir", "/etc",
    "--dir", "/app",
  );

  for (const directory of mountParentDirectories(input.config.readOnlyMounts)) {
    argv.push("--dir", directory);
  }
  for (const mount of input.config.readOnlyMounts) {
    argv.push("--ro-bind", mount.source, mount.destination);
  }
  argv.push("--bind", input.workspace, "/workspace");
  argv.push("--tmpfs", "/workspace/.chatwca");
  for (const binding of dataBindings) {
    argv.push("--ro-bind-data", String(binding.fd), binding.destination);
  }
  for (const [name, value] of Object.entries({
    ...SANDBOX_ENVIRONMENT,
    PATH: input.config.guestPath,
  })) {
    argv.push("--setenv", name, value);
  }
  argv.push("--chdir", "/workspace", "/usr/bin/node", "/app/worker.mjs");

  const roots = new Set([
    "app", "dev", "etc", "home", "proc", "tmp", "usr", "var", "workspace",
  ]);
  for (const [name] of LINK_DEFINITIONS) {
    if (input.host.compatibilityLinks[name]) roots.add(name);
  }
  for (const mount of input.config.readOnlyMounts) {
    const top = mount.destination.split("/").filter(Boolean)[0];
    if (top !== undefined) roots.add(top);
  }

  return Object.freeze({
    executable: input.host.bwrapPath,
    argv: Object.freeze(argv),
    dataBindings: Object.freeze(dataBindings),
    requestFd: SANDBOX_REQUEST_FD,
    responseFd: SANDBOX_RESPONSE_FD,
    expectedRootEntries: Object.freeze([...roots].sort()),
  });
}
