import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  SandboxWorkspaceAdmission,
  SANDBOX_SOCKET_WALK_DEADLINE_MS,
  SANDBOX_SOCKET_WALK_MAX_ENTRIES,
  canonicalPathsOverlap,
  isCanonicalPathContained,
} from "../../src/server/sandbox/admission.js";
import { ERROR_CODES } from "../../src/shared/errors.js";

const roots: string[] = [];
const servers: Server[] = [];

async function root(): Promise<string> {
  const created = await mkdtemp(path.join(tmpdir(), "chatwca-admission-"));
  roots.push(created);
  return created;
}

async function listenUnix(socketPath: string): Promise<Server> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return server;
}

function policy(workspacePath: string, workspaceRoot: string, protectedPaths: readonly string[] = []) {
  return { workspacePath, workspaceRoots: [workspaceRoot], protectedPaths };
}

async function rejected(operation: Promise<unknown>): Promise<void> {
  await expect(operation).rejects.toMatchObject({ code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED });
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("sandbox workspace admission", () => {
  it("exports canonical containment/overlap checks that do not use string prefixes", () => {
    expect(isCanonicalPathContained("/srv/work", "/srv/work/project")).toBe(true);
    expect(isCanonicalPathContained("/srv/work", "/srv/work-other")).toBe(false);
    expect(canonicalPathsOverlap("/srv/work/project", "/srv/work/project/data")).toBe(true);
    expect(canonicalPathsOverlap("/srv/work/project", "/srv/other")).toBe(false);
  });

  it("accepts an absent or real .chatwca directory and a socket-free no-follow tree", async () => {
    const workspaceRoot = await root();
    const workspace = path.join(workspaceRoot, "project");
    await mkdir(path.join(workspace, "nested"), { recursive: true });
    await writeFile(path.join(workspace, "nested", "file.txt"), "ok");
    const admission = new SandboxWorkspaceAdmission();
    await expect(admission.admit(policy(workspace, workspaceRoot))).resolves.toBeUndefined();

    await mkdir(path.join(workspace, ".chatwca"));
    await expect(admission.admit(policy(workspace, workspaceRoot))).resolves.toBeUndefined();
  });

  it("rejects a .chatwca file or symlink", async () => {
    const firstRoot = await root();
    const fileWorkspace = path.join(firstRoot, "file-project");
    await mkdir(fileWorkspace);
    await writeFile(path.join(fileWorkspace, ".chatwca"), "not a directory");
    await rejected(new SandboxWorkspaceAdmission().admit(policy(fileWorkspace, firstRoot)));

    const symlinkWorkspace = path.join(firstRoot, "link-project");
    await mkdir(symlinkWorkspace);
    await symlink(firstRoot, path.join(symlinkWorkspace, ".chatwca"), "dir");
    await rejected(new SandboxWorkspaceAdmission().admit(policy(symlinkWorkspace, firstRoot)));
  });

  it("rejects nested Unix sockets but never follows a symlink to an outside socket", async () => {
    const workspaceRoot = await root();
    const workspace = path.join(workspaceRoot, "project");
    const nested = path.join(workspace, "nested");
    const outside = await root();
    await mkdir(nested, { recursive: true });
    await listenUnix(path.join(nested, "service.sock"));
    await rejected(new SandboxWorkspaceAdmission().admit(policy(workspace, workspaceRoot)));

    await new Promise<void>((resolve) => servers.shift()!.close(() => resolve()));
    await rm(path.join(nested, "service.sock"), { force: true });
    await listenUnix(path.join(outside, "outside.sock"));
    await symlink(outside, path.join(workspace, "outside-link"), "dir");
    await expect(new SandboxWorkspaceAdmission().admit(policy(workspace, workspaceRoot)))
      .resolves.toBeUndefined();
  });

  it("rejects canonical identity changes, root violations, and overlap in either direction", async () => {
    const workspaceRoot = await root();
    const workspace = path.join(workspaceRoot, "project");
    const child = path.join(workspace, "data");
    await mkdir(child, { recursive: true });
    const outside = await root();
    const admission = new SandboxWorkspaceAdmission();

    await rejected(admission.admit(policy(workspace, outside)));
    await rejected(admission.admit(policy(workspace, workspaceRoot, [child])));
    await rejected(admission.admit(policy(child, workspaceRoot, [workspace])));

    const alias = path.join(workspaceRoot, "alias");
    await symlink(workspace, alias, "dir");
    await rejected(admission.admit(policy(alias, workspaceRoot)));
  });

  it("admits canonical socket-free mount directories and rejects aliases or sockets", async () => {
    const mountRoot = await root();
    const source = path.join(mountRoot, "shared");
    await mkdir(source);
    await writeFile(path.join(source, "data.txt"), "ok");
    const admission = new SandboxWorkspaceAdmission();
    await expect(admission.admitMount({ sourcePath: source, writable: true }))
      .resolves.toBeUndefined();

    const alias = path.join(mountRoot, "alias");
    await symlink(source, alias, "dir");
    await rejected(admission.admitMount({ sourcePath: alias, writable: false }));

    await listenUnix(path.join(source, "service.sock"));
    await rejected(admission.admitMount({ sourcePath: source, writable: false }));
  });

  it("fails closed at the named entry and deadline bounds", async () => {
    expect(SANDBOX_SOCKET_WALK_MAX_ENTRIES).toBe(100_000);
    expect(SANDBOX_SOCKET_WALK_DEADLINE_MS).toBe(2_000);
    const workspaceRoot = await root();
    const workspace = path.join(workspaceRoot, "project");
    await mkdir(workspace);
    await Promise.all(["one", "two"].map((name) => writeFile(path.join(workspace, name), name)));
    await rejected(new SandboxWorkspaceAdmission({ bounds: { maxEntries: 1 } })
      .admit(policy(workspace, workspaceRoot)));

    let clock = 0;
    const real = new SandboxWorkspaceAdmission({
      bounds: { deadlineMs: 2 },
      fileSystem: {
        realpath: (await import("node:fs/promises")).realpath,
        access: (await import("node:fs/promises")).access,
        lstat: (await import("node:fs/promises")).lstat,
        opendir: (await import("node:fs/promises")).opendir,
        now: () => ++clock,
      },
    });
    await rejected(real.admit(policy(workspace, workspaceRoot)));
  });
});
