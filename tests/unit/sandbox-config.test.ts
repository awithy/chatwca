import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConfigurationError,
  DEFAULT_BWRAP_PATH,
  DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
  DEFAULT_SANDBOX_MAX_COMMAND_OUTPUT_BYTES,
  DEFAULT_SANDBOX_PATH,
  DEFAULT_SANDBOX_START_TIMEOUT_MS,
  loadSandboxConfig,
  publicSandboxConfig,
} from "../../src/server/sandbox/config.js";

const temporaryDirectories: string[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "chatwca-sandbox-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("sandbox configuration", () => {
  it("defaults to a deeply immutable, disabled configuration", () => {
    const config = loadSandboxConfig({});
    expect(config).toEqual({
      mode: "disabled",
      bwrapPath: DEFAULT_BWRAP_PATH,
      workspaceRoots: [],
      readOnlyMounts: [],
      guestPath: DEFAULT_SANDBOX_PATH,
      startTimeoutMs: DEFAULT_SANDBOX_START_TIMEOUT_MS,
      commandTimeoutMs: DEFAULT_SANDBOX_COMMAND_TIMEOUT_MS,
      maxCommandOutputBytes: DEFAULT_SANDBOX_MAX_COMMAND_OUTPUT_BYTES,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.workspaceRoots)).toBe(true);
    expect(Object.isFrozen(config.readOnlyMounts)).toBe(true);
  });

  it("canonicalizes roots and enabled read-only mounts and parses limits", () => {
    const root = temporaryDirectory();
    const workspaceRoot = path.join(root, "workspaces");
    const mount = "/usr/share";
    mkdirSync(workspaceRoot);
    const alias = path.join(root, "workspace-alias");
    symlinkSync(workspaceRoot, alias, "dir");

    const config = loadSandboxConfig({
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_BWRAP_PATH: "/opt/bwrap",
      CHATWCA_WORKSPACE_ROOTS: JSON.stringify([alias]),
      CHATWCA_SANDBOX_RO_MOUNTS: JSON.stringify([mount]),
      CHATWCA_SANDBOX_PATH: `${mount}:/usr/bin:/bin`,
      CHATWCA_SANDBOX_START_TIMEOUT_MS: "12",
      CHATWCA_SANDBOX_COMMAND_TIMEOUT_MS: "34",
      CHATWCA_SANDBOX_MAX_COMMAND_OUTPUT_BYTES: "56",
    });

    expect(config).toMatchObject({
      mode: "optional",
      bwrapPath: "/opt/bwrap",
      workspaceRoots: [workspaceRoot],
      guestPath: `${mount}:/usr/bin:/bin`,
      startTimeoutMs: 12,
      commandTimeoutMs: 34,
      maxCommandOutputBytes: 56,
    });
    expect(config.readOnlyMounts).toEqual([{
      source: mount,
      destination: mount,
      kind: "directory",
    }]);
    expect(Object.isFrozen(config.readOnlyMounts[0])).toBe(true);
  });

  it("enforces roots in disabled mode without inspecting Bubblewrap or mounts", () => {
    const root = temporaryDirectory();
    const stat = vi.fn(() => ({ isDirectory: () => true, isFile: () => false }));
    const realpath = vi.fn((target: string) => {
      if (target === root) return target;
      throw new Error("sandbox runtime path must remain untouched");
    });

    const config = loadSandboxConfig({
      CHATWCA_WORKSPACE_ROOTS: JSON.stringify([root]),
      CHATWCA_BWRAP_PATH: "/missing/bwrap",
      CHATWCA_SANDBOX_RO_MOUNTS: JSON.stringify(["/missing/toolchain"]),
    }, { realpath, stat });

    expect(config.workspaceRoots).toEqual([root]);
    expect(config.readOnlyMounts).toMatchObject([{ source: "/missing/toolchain" }]);
    expect(realpath).toHaveBeenCalledExactlyOnceWith(root);
    expect(stat).toHaveBeenCalledExactlyOnceWith(root);
  });

  it.each([
    ["CHATWCA_WORKSPACE_ROOTS", "not-json"],
    ["CHATWCA_WORKSPACE_ROOTS", "{}"],
    ["CHATWCA_WORKSPACE_ROOTS", "[1]"],
    ["CHATWCA_WORKSPACE_ROOTS", '[""]'],
    ["CHATWCA_SANDBOX_RO_MOUNTS", '["relative"]'],
  ])("rejects malformed path arrays in %s", (variable, value) => {
    expect(() => loadSandboxConfig({ [variable]: value })).toThrow(ConfigurationError);
  });

  it("rejects canonical duplicates and non-directory roots", () => {
    const root = temporaryDirectory();
    const alias = path.join(path.dirname(root), `${path.basename(root)}-alias`);
    symlinkSync(root, alias, "dir");
    temporaryDirectories.push(alias);
    expect(() => loadSandboxConfig({
      CHATWCA_WORKSPACE_ROOTS: JSON.stringify([root, alias]),
    })).toThrow(/canonical duplicate/);

    const file = path.join(root, "file");
    writeFileSync(file, "x");
    expect(() => loadSandboxConfig({
      CHATWCA_WORKSPACE_ROOTS: JSON.stringify([file]),
    })).toThrow(/existing directories/);
  });

  it("requires roots in required mode and validates guest PATH coverage", () => {
    expect(() => loadSandboxConfig({ CHATWCA_SANDBOX_MODE: "required" }))
      .toThrow(/at least one root/);
    for (const guestPath of ["", "usr/bin", "/usr//bin", "/usr/bin:", "/opt/bin"]) {
      expect(() => loadSandboxConfig({ CHATWCA_SANDBOX_PATH: guestPath }))
        .toThrow(ConfigurationError);
    }
  });

  it("rejects protected enabled mounts and non-regular mount sources", () => {
    expect(() => loadSandboxConfig({
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_SANDBOX_RO_MOUNTS: JSON.stringify(["/usr/share"]),
    })).not.toThrow();
    expect(() => loadSandboxConfig({
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_SANDBOX_RO_MOUNTS: JSON.stringify(["/tmp"]),
    })).toThrow(/protected destination/);
  });

  it("projects only mode, choices, disclosure, and probe status", () => {
    const publicConfig = publicSandboxConfig(loadSandboxConfig({
      CHATWCA_SANDBOX_MODE: "optional",
    }), true);
    expect(publicConfig).toEqual({
      mode: "optional",
      selectableProfiles: ["unrestricted", "workspace-sandboxed"],
      remoteProviderWarning:
        "Workspace content may still be sent to the configured model provider.",
      functionalProbeSucceeded: true,
    });
    expect(JSON.stringify(publicConfig)).not.toContain("bwrap");
  });
});
