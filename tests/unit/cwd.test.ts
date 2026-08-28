import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  inspectStoredCwd,
  resolveConversationCwd,
} from "../../src/server/cwd.js";
import { ERROR_CODES } from "../../src/shared/errors.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "chatwca-cwd-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("resolveConversationCwd", () => {
  it("resolves relative paths against the supplied base directory", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "projects", "demo");
    await mkdir(workspace, { recursive: true });

    await expect(resolveConversationCwd("projects/demo", root)).resolves.toBe(
      workspace,
    );
  });

  it("canonicalizes symlink aliases", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "workspace");
    const alias = path.join(root, "workspace-alias");
    await mkdir(workspace);
    await symlink(workspace, alias, "dir");

    await expect(resolveConversationCwd(alias)).resolves.toBe(workspace);
  });

  it("rejects files and blank paths", async () => {
    const root = await temporaryRoot();
    const file = path.join(root, "not-a-directory");
    await writeFile(file, "content");

    await expect(resolveConversationCwd(file)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CWD,
    });
    await expect(resolveConversationCwd("   ", root)).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CWD,
    });
  });

  it("reports a missing directory with a stable, redacted error", async () => {
    const root = await temporaryRoot();
    const missing = path.join(root, "private", "missing");

    await expect(resolveConversationCwd(missing)).rejects.toMatchObject({
      code: ERROR_CODES.CWD_NOT_FOUND,
      message: "The working directory does not exist.",
    });

    try {
      await resolveConversationCwd(missing);
    } catch (error) {
      expect((error as Error).message).not.toContain(root);
    }
  });

  it("rejects a directory the process cannot search or read", async () => {
    const root = await temporaryRoot();
    const workspace = path.join(root, "restricted");
    await mkdir(workspace);
    await chmod(workspace, 0o000);

    try {
      await expect(resolveConversationCwd(workspace)).rejects.toMatchObject({
        code: ERROR_CODES.CWD_NOT_ACCESSIBLE,
      });
    } finally {
      await chmod(workspace, 0o700);
    }
  });
});

describe("inspectStoredCwd", () => {
  it("keeps a missing stored path visible and detects when it is restored", async () => {
    const root = await temporaryRoot();
    const storedCwd = path.join(root, "restorable-workspace");

    await expect(inspectStoredCwd(storedCwd)).resolves.toEqual({
      storedCwd,
      runnable: false,
      errorCode: ERROR_CODES.CWD_NOT_FOUND,
    });

    await mkdir(storedCwd);

    await expect(inspectStoredCwd(storedCwd)).resolves.toEqual({
      storedCwd,
      runnable: true,
      canonicalCwd: storedCwd,
    });
  });
});
