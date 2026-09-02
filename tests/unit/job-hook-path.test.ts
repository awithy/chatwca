import {
  accessSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  JobHookPathAdmission,
  type JobHookPathFileSystem,
  type JobHookPathMetadata,
} from "../../src/server/job-hook-path.js";
import { ERROR_CODES } from "../../src/shared/errors.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const result = mkdtempSync(path.join(tmpdir(), "chatwca-hook-path-"));
  temporaryDirectories.push(result);
  return result;
}

function directory(parent: string, name: string): string {
  const result = path.join(parent, name);
  mkdirSync(result, { recursive: true });
  return realpathSync(result);
}

function file(parent: string, name = "hook.sh"): string {
  const result = path.join(parent, name);
  writeFileSync(result, "echo ok\n", { mode: 0o600 });
  return realpathSync(result);
}

function admission(
  scriptRoots: readonly string[],
  protectedPaths: readonly string[] = [],
  fileSystem?: JobHookPathFileSystem,
): JobHookPathAdmission {
  return new JobHookPathAdmission({
    scriptRoots,
    protectedPaths,
    ...(fileSystem === undefined ? {} : { fileSystem }),
  });
}

function expectCode(operation: () => unknown, code: string): void {
  expect(operation).toThrow(expect.objectContaining({ code }));
}

const realFileSystem: JobHookPathFileSystem = {
  lstat: lstatSync,
  realpath: realpathSync,
  access: accessSync,
};

afterEach(() => {
  for (const target of temporaryDirectories.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("JobHookPathAdmission", () => {
  it("canonicalizes parent aliases and admits a readable regular file beneath exactly one root", () => {
    const base = temporaryDirectory();
    const root = directory(base, "scripts");
    const workspace = directory(base, "workspace");
    const script = file(root);
    const alias = path.join(base, "scripts-alias");
    symlinkSync(root, alias, "dir");

    expect(admission([root]).validateForConfiguration(
      path.join(alias, path.basename(script)),
      { cwd: workspace },
    )).toBe(script);
  });

  it("rejects empty roots, malformed paths, outside files, directories, and final symlinks", () => {
    const base = temporaryDirectory();
    const root = directory(base, "scripts");
    const workspace = directory(base, "workspace");
    const script = file(root);
    const outside = file(directory(base, "outside"));
    const alias = path.join(root, "alias.sh");
    symlinkSync(script, alias, "file");

    expectCode(
      () => admission([]).validateForConfiguration(script, { cwd: workspace }),
      ERROR_CODES.JOB_SCRIPT_ROOTS_UNAVAILABLE,
    );
    for (const invalid of ["", "relative.sh", `bad\0path`, "x".repeat(4_097)]) {
      expectCode(
        () => admission([root]).validateForConfiguration(invalid, { cwd: workspace }),
        ERROR_CODES.JOB_SCRIPT_INVALID,
      );
    }
    for (const invalid of [outside, root, alias]) {
      expectCode(
        () => admission([root]).validateForConfiguration(invalid, { cwd: workspace }),
        ERROR_CODES.JOB_SCRIPT_INVALID,
      );
    }
    expectCode(
      () => admission([base, root]).validateForConfiguration(script, { cwd: workspace }),
      ERROR_CODES.JOB_SCRIPT_INVALID,
    );
  });

  it("rejects overlap in either direction with workspaces, mounts, and runtime paths", () => {
    const base = temporaryDirectory();
    const root = directory(base, "scripts");
    const script = file(root);
    const unrelated = directory(base, "workspace");
    const validator = admission([root]);

    for (const workspace of [root, script, base]) {
      expectCode(
        () => validator.validateForConfiguration(script, { cwd: workspace }),
        ERROR_CODES.JOB_SCRIPT_INVALID,
      );
    }
    expectCode(
      () => validator.validateForConfiguration(script, {
        cwd: unrelated,
        mounts: [{ source: root }],
      }),
      ERROR_CODES.JOB_SCRIPT_INVALID,
    );
    for (const protectedPath of [root, script, base, path.join(script, "nested")]) {
      expectCode(
        () => admission([root], [protectedPath]).validateForConfiguration(script, { cwd: unrelated }),
        ERROR_CODES.JOB_SCRIPT_INVALID,
      );
    }
  });

  it("maps disappearance, type/access changes, and swaps to the run-time unavailable code", () => {
    const base = temporaryDirectory();
    const root = directory(base, "scripts");
    const workspace = directory(base, "workspace");
    const script = file(root);

    const inaccessible: JobHookPathFileSystem = {
      ...realFileSystem,
      access: (target, mode) => {
        if (target === script) throw Object.assign(new Error("private"), { code: "EACCES" });
        accessSync(target, mode);
      },
    };
    expectCode(
      () => admission([root], [], inaccessible).validateForRun(script, { cwd: workspace }),
      ERROR_CODES.JOB_SCRIPT_UNAVAILABLE,
    );

    let scriptStats = 0;
    const swapped: JobHookPathFileSystem = {
      ...realFileSystem,
      lstat: (target): JobHookPathMetadata => {
        const metadata = lstatSync(target);
        if (target === script && ++scriptStats === 3) {
          return {
            dev: metadata.dev,
            ino: metadata.ino + 1,
            isDirectory: () => metadata.isDirectory(),
            isFile: () => metadata.isFile(),
            isSymbolicLink: () => metadata.isSymbolicLink(),
          };
        }
        return metadata;
      },
    };
    expectCode(
      () => admission([root], [], swapped).validateForRun(script, { cwd: workspace }),
      ERROR_CODES.JOB_SCRIPT_UNAVAILABLE,
    );

    rmSync(script);
    mkdirSync(script);
    expectCode(
      () => admission([root]).validateForRun(script, { cwd: workspace }),
      ERROR_CODES.JOB_SCRIPT_UNAVAILABLE,
    );
  });
});
