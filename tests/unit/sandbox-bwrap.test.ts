import type { SpawnSyncReturns } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  buildBwrapLaunchSpecification,
  SANDBOX_ENVIRONMENT,
  validateBwrapAndToolchain,
  type BwrapValidationFileSystem,
  type BwrapValidationPlatform,
  type SandboxWorkerArtifact,
  type ValidatedSandboxHost,
} from "../../src/server/sandbox/bwrap.js";
import type { SandboxConfig } from "../../src/server/sandbox/config.js";
import { ERROR_CODES } from "../../src/shared/errors.js";

function config(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    mode: "optional",
    bwrapPath: "/usr/bin/bwrap",
    workspaceRoots: ["/srv/workspaces"],
    readOnlyMounts: [],
    guestPath: "/usr/bin:/bin",
    startTimeoutMs: 5_000,
    commandTimeoutMs: 900_000,
    maxCommandOutputBytes: 64 * 1024 * 1024,
    ...overrides,
  };
}

const host: ValidatedSandboxHost = {
  bwrapPath: "/usr/bin/bwrap",
  bwrapVersion: "bubblewrap 0.6.1",
  nodeVersion: "v22.19.0",
  rgPath: "/usr/bin/rg",
  rgVersion: "ripgrep 13.0.0",
  compatibilityLinks: { bin: true, sbin: true, lib: true, lib64: false },
};
const worker: SandboxWorkerArtifact = {
  source: Buffer.from("worker source"),
  sha256: "a".repeat(64),
  version: "1",
};

function pairs(argv: readonly string[], option: string): string[][] {
  const found: string[][] = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === option) found.push([argv[index + 1]!, argv[index + 2]!]);
  }
  return found;
}

function spawnResult(stdout: string): SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [null, stdout, ""],
    stdout,
    stderr: "",
    status: 0,
    signal: null,
    error: undefined,
  };
}

describe("Bubblewrap argument builder", () => {
  it("builds the exact namespace, synthetic-root, environment, data-FD, and final command profile", () => {
    const built = buildBwrapLaunchSpecification({
      config: config(), host, workspace: "/srv/workspaces/project", worker,
    });
    expect(built.executable).toBe("/usr/bin/bwrap");
    expect(built.argv.slice(0, 12)).toEqual([
      "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
      "--unshare-net", "--hostname", "chatwca-sandbox", "--cap-drop", "ALL",
      "--new-session", "--die-with-parent", "--clearenv",
    ]);
    expect(pairs(built.argv, "--ro-bind")).toEqual([["/usr", "/usr"]]);
    expect(pairs(built.argv, "--bind")).toEqual([["/srv/workspaces/project", "/workspace"]]);
    expect(pairs(built.argv, "--symlink")).toEqual([
      ["usr/bin", "/bin"], ["usr/sbin", "/sbin"], ["usr/lib", "/lib"],
    ]);
    expect(built.argv).toContain("--new-session");
    expect(built.argv).toContain("--die-with-parent");
    expect(built.argv).toContain("--clearenv");
    expect(built.argv.slice(-4)).toEqual(["--chdir", "/workspace", "/usr/bin/node", "/app/worker.mjs"]);
    expect(built.dataBindings.map(({ fd, destination }) => [fd, destination])).toEqual([
      [3, "/app/worker.mjs"], [4, "/etc/passwd"], [5, "/etc/group"],
      [6, "/etc/hosts"], [7, "/etc/nsswitch.conf"],
    ]);
    expect(built.dataBindings[0]?.payload).toBe(worker.source);
    expect(built.requestFd).toBe(8);
    expect(built.responseFd).toBe(9);

    const environment = Object.fromEntries(pairs(built.argv, "--setenv"));
    expect(environment).toEqual(SANDBOX_ENVIRONMENT);
    expect(Object.keys(environment).sort()).toEqual(Object.keys(SANDBOX_ENVIRONMENT).sort());
  });

  it("orders canonical extra mounts before the workspace and masks .chatwca afterwards", () => {
    const built = buildBwrapLaunchSpecification({
      config: config({ readOnlyMounts: [{
        source: "/opt/toolchain", destination: "/opt/toolchain", kind: "directory",
      }] }),
      host,
      workspace: "/srv/workspaces/project",
      worker,
    });
    const mountIndex = built.argv.findIndex((value, index) =>
      value === "--ro-bind" && built.argv[index + 1] === "/opt/toolchain");
    const workspaceIndex = built.argv.findIndex((value, index) =>
      value === "--bind" && built.argv[index + 1] === "/srv/workspaces/project");
    const maskIndex = built.argv.findIndex((value, index) =>
      value === "--tmpfs" && built.argv[index + 1] === "/workspace/.chatwca");
    expect(mountIndex).toBeGreaterThan(-1);
    expect(mountIndex).toBeLessThan(workspaceIndex);
    expect(workspaceIndex).toBeLessThan(maskIndex);
    expect(built.argv).toContain("/opt");
    expect(built.expectedRootEntries).toContain("opt");
  });

  it("never binds a host root, protected store, session path, home, temp, run, sys, or checkout", () => {
    const workspace = "/srv/workspaces/project";
    const built = buildBwrapLaunchSpecification({ config: config(), host, workspace, worker });
    const hostBindSources = [
      ...pairs(built.argv, "--bind").map(([source]) => source),
      ...pairs(built.argv, "--ro-bind").map(([source]) => source),
    ];
    expect(hostBindSources).toEqual([workspace, "/usr"]);
    for (const forbidden of [
      "/", "/var/lib/chatwca", "/home/server/.pi/agent",
      "/srv/workspaces/project/.chatwca/sessions", "/home/server", "/tmp", "/run", "/sys",
      process.cwd(),
    ]) {
      expect(hostBindSources).not.toContain(forbidden);
    }
    expect(built.argv.join("\0")).not.toContain(process.cwd());
  });
});

describe("Bubblewrap and synthetic toolchain validation", () => {
  function fakes(overrides: Partial<BwrapValidationFileSystem> = {}) {
    const directories = new Set(["/usr/bin", "/usr/sbin", "/usr/lib", "/usr/lib64"]);
    const fileSystem: BwrapValidationFileSystem = {
      realpath: (target) => target,
      lstat: (target) => ({
        uid: target === "/usr/bin/bwrap" ? 0 : 1000,
        mode: 0o100755,
        isFile: () => !directories.has(target),
        isDirectory: () => directories.has(target),
      }),
      access: () => undefined,
      ...overrides,
    };
    const spawn = vi.fn((executable: string) => spawnResult(
      executable.endsWith("bwrap") ? "bubblewrap 0.6.1\n" :
        executable.endsWith("node") ? "v22.19.0\n" : "ripgrep 14.1.0\n",
    ));
    const platform: BwrapValidationPlatform = { platform: "linux", architecture: "x64", spawn };
    return { fileSystem, platform, spawn };
  }

  it("requires canonical secure Bubblewrap and validates versions without a shell", () => {
    const { fileSystem, platform, spawn } = fakes();
    expect(validateBwrapAndToolchain(config(), { fileSystem, platform })).toMatchObject({
      bwrapVersion: "bubblewrap 0.6.1",
      nodeVersion: "v22.19.0",
      rgPath: "/usr/bin/rg",
    });
    expect(spawn).toHaveBeenCalledWith("/usr/bin/bwrap", ["--version"]);
    expect(spawn).toHaveBeenCalledWith("/usr/bin/node", ["--version"]);
    expect(spawn).toHaveBeenCalledWith("/usr/bin/rg", ["--version"]);
  });

  it.each([
    ["noncanonical path", { realpath: () => "/real/bwrap" }],
    ["non-root owner", { lstat: (target: string) => ({ uid: 1000, mode: 0o100755, isFile: () => true, isDirectory: () => false }) }],
    ["group writable", { lstat: (target: string) => ({ uid: 0, mode: 0o100775, isFile: () => true, isDirectory: () => false }) }],
  ])("rejects an insecure %s as configuration", (_name, override) => {
    const { fileSystem, platform } = fakes(override as Partial<BwrapValidationFileSystem>);
    expect(() => validateBwrapAndToolchain(config(), { fileSystem, platform })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SANDBOX_CONFIGURATION_ERROR }),
    );
  });

  it("rejects old Bubblewrap/Node, missing ripgrep, and unsupported hosts fail closed", () => {
    const first = fakes();
    first.platform.spawn = () => spawnResult("bubblewrap 0.5.0\n");
    expect(() => validateBwrapAndToolchain(config(), first)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SANDBOX_UNAVAILABLE }),
    );
    const unsupported = { ...fakes().platform, platform: "darwin" as const };
    expect(() => validateBwrapAndToolchain(config(), { platform: unsupported })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SANDBOX_UNAVAILABLE }),
    );
  });
});
