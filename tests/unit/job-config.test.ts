import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_JOB_HOOK_MAX_OUTPUT_BYTES,
  DEFAULT_JOB_HOOK_TIMEOUT_MS,
  JOB_BASH_PATH,
  MAX_JOB_HOOK_TIMEOUT_MS,
  loadJobConfig,
  publicJobConfig,
} from "../../src/server/job-config.js";
import { ConfigurationError } from "../../src/server/config.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "chatwca-job-config-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    try { chmodSync(directory, 0o700); } catch { /* already absent */ }
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadJobConfig", () => {
  it("uses frozen defaults and does not inspect Bash while hooks are disabled", () => {
    const config = loadJobConfig({}, {
      realpath: () => { throw new Error("must not inspect paths"); },
      stat: () => { throw new Error("must not inspect paths"); },
      access: () => { throw new Error("must not inspect paths"); },
    });

    expect(config).toEqual({
      scriptRoots: [],
      hookTimeoutMs: DEFAULT_JOB_HOOK_TIMEOUT_MS,
      hookMaxOutputBytes: DEFAULT_JOB_HOOK_MAX_OUTPUT_BYTES,
      bashPath: JOB_BASH_PATH,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.scriptRoots)).toBe(true);
  });

  it.each(["", "not json", "{}", "[1]", '[" "]'])(
    "rejects malformed root input %j",
    (value) => {
      expect(() => loadJobConfig({ CHATWCA_JOB_SCRIPT_ROOTS: value })).toThrow(
        ConfigurationError,
      );
    },
  );

  it("rejects relative, missing, non-directory, and inaccessible roots", () => {
    const root = temporaryDirectory();
    const file = path.join(root, "file");
    writeFileSync(file, "not a directory");

    for (const candidate of ["relative", path.join(root, "missing"), file]) {
      expect(() => loadJobConfig({
        CHATWCA_JOB_SCRIPT_ROOTS: JSON.stringify([candidate]),
      })).toThrow(ConfigurationError);
    }

    const inaccessible = path.join(root, "inaccessible");
    mkdirSync(inaccessible);
    expect(() => loadJobConfig({
      CHATWCA_JOB_SCRIPT_ROOTS: JSON.stringify([inaccessible]),
    }, {
      realpath: (target) => target,
      stat: () => ({ isDirectory: () => true, isFile: () => true }),
      access: (target) => {
        if (target === inaccessible) throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    })).toThrow(/readable and searchable/);
  });

  it("rejects canonical duplicates and roots overlapping in either direction", () => {
    const parent = temporaryDirectory();
    const child = path.join(parent, "child");
    mkdirSync(child);

    expect(() => loadJobConfig({
      CHATWCA_JOB_SCRIPT_ROOTS: JSON.stringify([parent, parent]),
    })).toThrow(/canonical duplicate/);
    expect(() => loadJobConfig({
      CHATWCA_JOB_SCRIPT_ROOTS: JSON.stringify([parent, child]),
    })).toThrow(/overlapping roots/);
    expect(() => loadJobConfig({
      CHATWCA_JOB_SCRIPT_ROOTS: JSON.stringify([child, parent]),
    })).toThrow(/overlapping roots/);
  });

  it("requires executable regular /usr/bin/bash only when roots enable hooks", () => {
    const root = temporaryDirectory();
    const environment = { CHATWCA_JOB_SCRIPT_ROOTS: JSON.stringify([root]) };
    const calls: string[] = [];
    const fileSystem = {
      realpath: (target: string) => target,
      stat: (target: string) => ({
        isDirectory: () => target === root,
        isFile: () => target === JOB_BASH_PATH,
      }),
      access: (target: string) => { calls.push(target); },
    };

    expect(loadJobConfig(environment, fileSystem).scriptRoots).toEqual([root]);
    expect(calls).toContain(JOB_BASH_PATH);
    expect(() => loadJobConfig(environment, {
      ...fileSystem,
      stat: (target) => ({
        isDirectory: () => target === root,
        isFile: () => false,
      }),
    })).toThrow(/executable regular file/);
  });

  it.each(["", "0", "-1", "1.5", "Infinity", "no"])(
    "rejects invalid timeout and output bounds %j",
    (value) => {
      expect(() => loadJobConfig({ CHATWCA_JOB_HOOK_TIMEOUT_MS: value })).toThrow(
        /positive safe integer/,
      );
      expect(() => loadJobConfig({ CHATWCA_JOB_HOOK_MAX_OUTPUT_BYTES: value })).toThrow(
        /positive safe integer/,
      );
    },
  );

  it("caps hook timeouts and accepts positive safe output overrides", () => {
    expect(() => loadJobConfig({
      CHATWCA_JOB_HOOK_TIMEOUT_MS: String(MAX_JOB_HOOK_TIMEOUT_MS + 1),
    })).toThrow(/must not exceed/);
    expect(loadJobConfig({
      CHATWCA_JOB_HOOK_TIMEOUT_MS: String(MAX_JOB_HOOK_TIMEOUT_MS),
      CHATWCA_JOB_HOOK_MAX_OUTPUT_BYTES: "1",
    })).toMatchObject({
      hookTimeoutMs: MAX_JOB_HOOK_TIMEOUT_MS,
      hookMaxOutputBytes: 1,
    });
  });
});

describe("publicJobConfig", () => {
  it("projects only accepted display roots, bounds, timezones, and disclosures", () => {
    const projection = publicJobConfig(loadJobConfig({}));
    expect(projection).toMatchObject({
      schedulerAvailable: true,
      hooksAvailable: false,
      scriptRoots: [],
      minIntervalMinutes: 1,
      maxIntervalMinutes: 525_600,
    });
    expect(projection.supportedTimeZones).toContain("UTC");
    expect(projection.hostAuthorityWarning).toContain("host");
    expect(projection.unattendedUsageWarning).toContain("unattended");
    expect(projection).not.toHaveProperty("hookTimeoutMs");
    expect(projection).not.toHaveProperty("bashPath");
  });
});
