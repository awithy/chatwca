import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/shared/errors.js";
import {
  NETWORK_HELPER_BUILD_VERSION,
  NETWORK_HELPER_NAME,
  NETWORK_HELPER_PROTOCOL_VERSION,
  validateNetworkHelper,
  type NetworkHelperValidationPlatform,
} from "../../src/server/network/helper.js";
const directories: string[] = [];
afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const directory = mkdtempSync(path.join(tmpdir(), "network-helper-"));
  directories.push(directory);
  const helperPath = path.join(directory, NETWORK_HELPER_NAME);
  const bytes = Buffer.alloc(128);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  bytes.writeUInt16LE(3, 16);
  bytes.writeUInt16LE(62, 18);
  writeFileSync(helperPath, bytes, { mode: 0o500 });
  const manifestPath = path.join(directory, "network-helper-manifest.json");
  const manifest = {
    schemaVersion: 1,
    name: NETWORK_HELPER_NAME,
    buildVersion: NETWORK_HELPER_BUILD_VERSION,
    protocolVersion: NETWORK_HELPER_PROTOCOL_VERSION,
    platform: "linux",
    architecture: "x64",
    file: NETWORK_HELPER_NAME,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...overrides,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o644 });
  return { directory, helperPath, manifestPath, bytes, manifest };
}

function runtime(version = NETWORK_HELPER_BUILD_VERSION): NetworkHelperValidationPlatform {
  return {
    platform: "linux",
    architecture: "x64",
    uid: process.geteuid?.() ?? process.getuid(),
    spawn: () => ({
      pid: 1,
      output: [],
      stdout: JSON.stringify({
        name: NETWORK_HELPER_NAME,
        version,
        protocol: NETWORK_HELPER_PROTOCOL_VERSION,
      }),
      stderr: "",
      status: 0,
      signal: null,
    }),
  };
}

function expectUnavailable(callback: () => unknown): void {
  try {
    callback();
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toMatchObject({ code: ERROR_CODES.NETWORK_HELPER_UNAVAILABLE });
  }
}

describe("managed-network helper validation", () => {
  it("validates canonical ownership, mode, ELF, manifest hash, and reported protocol", () => {
    const value = fixture();
    expect(validateNetworkHelper({
      helperPath: value.helperPath,
      manifestPath: value.manifestPath,
      protectedPaths: [path.join(tmpdir(), "unrelated-workspaces")],
    }, { platform: runtime() })).toEqual({
      path: value.helperPath,
      directory: value.directory,
      manifestPath: value.manifestPath,
      architecture: "x64",
      buildVersion: NETWORK_HELPER_BUILD_VERSION,
      protocolVersion: NETWORK_HELPER_PROTOCOL_VERSION,
      sha256: value.manifest.sha256,
    });
  });

  it("rejects manifest hash, architecture, closed-schema, and reported-version mismatches", () => {
    for (const overrides of [
      { sha256: "0".repeat(64) },
      { architecture: "arm64" },
      { unexpected: true },
      { protocolVersion: 2 },
    ]) {
      const value = fixture(overrides);
      expectUnavailable(() => validateNetworkHelper(value, { platform: runtime() }));
    }
    const value = fixture();
    expectUnavailable(() => validateNetworkHelper(value, { platform: runtime("different") }));
  });

  it("rejects the wrong ELF machine and unsafe writable files", () => {
    const wrongElf = fixture();
    const bytes = Buffer.from(wrongElf.bytes);
    bytes.writeUInt16LE(183, 18);
    chmodSync(wrongElf.helperPath, 0o700);
    writeFileSync(wrongElf.helperPath, bytes);
    chmodSync(wrongElf.helperPath, 0o500);
    expectUnavailable(() => validateNetworkHelper(wrongElf, { platform: runtime() }));

    const writable = fixture();
    chmodSync(writable.helperPath, 0o520);
    expectUnavailable(() => validateNetworkHelper(writable, { platform: runtime() }));

    const writableDirectory = fixture();
    chmodSync(writableDirectory.directory, 0o770);
    expectUnavailable(() => validateNetworkHelper(writableDirectory, { platform: runtime() }));
  });

  it("rejects symlink aliases and overlap with workspace/protected roots", () => {
    const value = fixture();
    const alias = path.join(value.directory, "alias");
    symlinkSync(value.helperPath, alias);
    expectUnavailable(() => validateNetworkHelper({
      helperPath: alias,
      manifestPath: value.manifestPath,
    }, { platform: runtime() }));

    expectUnavailable(() => validateNetworkHelper({
      helperPath: value.helperPath,
      manifestPath: value.manifestPath,
      protectedPaths: [path.dirname(value.directory)],
    }, { platform: runtime() }));

    const protectedChild = path.join(value.directory, "workspace");
    mkdirSync(protectedChild);
    expectUnavailable(() => validateNetworkHelper({
      helperPath: value.helperPath,
      manifestPath: value.manifestPath,
      protectedPaths: [protectedChild],
    }, { platform: runtime() }));
  });
});
