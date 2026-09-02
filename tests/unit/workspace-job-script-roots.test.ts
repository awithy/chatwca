import {
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

import { openDatabase, type ChatWcaDatabase } from "../../src/server/database.js";
import { JobHookPathAdmission } from "../../src/server/job-hook-path.js";
import { JobRepository } from "../../src/server/job-repository.js";
import { WorkspaceRepository } from "../../src/server/workspace-repository.js";
import { ERROR_CODES } from "../../src/shared/errors.js";

const roots: string[] = [];
const databases: ChatWcaDatabase[] = [];

function root(): string {
  const result = mkdtempSync(path.join(tmpdir(), "chatwca-workspace-hooks-"));
  roots.push(result);
  return result;
}

function directory(parent: string, name: string): string {
  const target = path.join(parent, name);
  mkdirSync(target, { recursive: true });
  return realpathSync(target);
}

function database(): ChatWcaDatabase {
  const result = openDatabase("/tmp", ":memory:");
  databases.push(result);
  return result;
}

function repository(
  db: ChatWcaDatabase,
  jobScriptRoots: readonly string[],
  id = "workspace-1",
): WorkspaceRepository {
  return new WorkspaceRepository(db.connection, {
    uuid: () => id,
    policy: {
      mode: "disabled",
      workspaceRoots: [],
      dataDirectory: "/var/lib/chatwca-test-data",
      piAgentDirectory: "/var/lib/chatwca-test-pi",
      readOnlyMounts: [],
      jobScriptRoots,
    },
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const target of roots.splice(0)) rmSync(target, { recursive: true, force: true });
});

describe("trusted job roots in workspace policy", () => {
  it("rejects roots above, below, or equal to unrestricted workspace paths", () => {
    for (const relation of ["above", "below", "equal"] as const) {
      const base = root();
      const project = directory(base, "project");
      const scriptRoot = relation === "above"
        ? base
        : relation === "below"
          ? directory(project, "trusted-hooks")
          : project;
      expect(() => repository(database(), [scriptRoot], `workspace-${relation}`).create({
        name: relation,
        path: project,
        securityProfile: "unrestricted",
      })).toThrow(expect.objectContaining({ code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED }));
    }
  });

  it("rejects roots above, below, or equal to mounts and path/mount updates that introduce overlap", () => {
    const base = root();
    const project = directory(base, "project");
    const other = directory(base, "other");
    const scripts = directory(base, "trusted-hooks");
    const db = database();
    const repo = repository(db, [scripts]);
    const workspace = repo.create({ name: "Safe", path: project });

    expect(() => repo.update(workspace.id, { path: scripts })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED }),
    );
    expect(() => repo.update(workspace.id, {
      mounts: [{ name: "hooks", source: scripts, access: "read-only" }],
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_MOUNT }));
    expect(repo.update(workspace.id, {
      path: other,
      mounts: [{ name: "safe", source: project, access: "read-only" }],
    })).toMatchObject({ usable: true, policyIssue: null });

    for (const relation of ["above", "below", "equal"] as const) {
      const relationBase = root();
      const relationProject = directory(relationBase, "project");
      const mountParent = directory(relationBase, "mount-parent");
      const mount = directory(mountParent, "source");
      const scriptRoot = relation === "above"
        ? mountParent
        : relation === "below"
          ? directory(mount, "scripts")
          : mount;
      const relationRepo = repository(database(), [scriptRoot], `mount-${relation}`);
      expect(() => relationRepo.create({
        name: relation,
        path: relationProject,
        mounts: [{ name: "shared", source: mount, access: "read-only" }],
      })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_MOUNT }));
    }
  });

  it("marks existing unrestricted workspace and mount overlaps unusable when roots are introduced on restart", async () => {
    const base = root();
    const project = directory(base, "project");
    const scripts = directory(project, "hooks-added-later");
    const db = database();
    repository(db, []).create({ name: "Existing", path: project });

    const restarted = repository(db, [scripts]);
    expect(restarted.get("workspace-1")).toMatchObject({
      available: true,
      usable: false,
      policyIssue: "protected_path_overlap",
    });
    await expect(restarted.requireUsable("workspace-1")).rejects.toMatchObject({
      code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED,
    });

    const mountDb = database();
    const mountedProject = directory(base, "mounted-project");
    const shared = directory(base, "shared");
    repository(mountDb, []).create({
      name: "Mounted",
      path: mountedProject,
      mounts: [{ name: "shared", source: shared, access: "read-only" }],
    });
    expect(repository(mountDb, [shared]).get("workspace-1")).toMatchObject({
      usable: false,
      policyIssue: "protected_path_overlap",
    });
  });

  it("stores only canonical hook paths during repository create and update", () => {
    const base = root();
    const project = directory(base, "project");
    const scripts = directory(base, "trusted-hooks");
    const alias = path.join(base, "hook-alias");
    symlinkSync(scripts, alias, "dir");
    const pre = path.join(scripts, "pre.sh");
    const post = path.join(scripts, "post.sh");
    writeFileSync(pre, "true\n");
    writeFileSync(post, "true\n");
    const db = database();
    const workspaces = repository(db, [scripts]);
    const workspace = workspaces.create({ name: "Safe", path: project });
    const hooks = new JobHookPathAdmission({ scriptRoots: [scripts], protectedPaths: [] });
    const jobs = new JobRepository(db.connection, {
      uuid: () => "job-canonical",
      clock: () => 1_000,
      workspaceRepository: workspaces,
      hookPathAdmission: hooks,
    });
    const job = jobs.create({
      name: "Canonical",
      workspaceId: workspace.id,
      prompt: "Run",
      schedule: { kind: "interval", intervalMinutes: 1 },
      preRunScript: path.join(alias, "pre.sh"),
      enabled: false,
      acknowledgeHostHooks: true,
    });
    expect(job.preRunScript).toBe(realpathSync(pre));
    expect(jobs.update(job.id, {
      postRunScript: path.join(alias, "post.sh"),
      acknowledgeHostHooks: true,
    }).postRunScript).toBe(realpathSync(post));
  });

  it("reports job references as workspace_busy before the FK restriction", () => {
    const base = root();
    const project = directory(base, "project");
    const db = database();
    const workspaces = repository(db, []);
    const workspace = workspaces.create({ name: "Referenced", path: project });
    const jobs = new JobRepository(db.connection, { uuid: () => "job-1", clock: () => 1_000 });
    const job = jobs.create({
      name: "Job",
      workspaceId: workspace.id,
      prompt: "Run",
      schedule: { kind: "interval", intervalMinutes: 1 },
      enabled: false,
    });

    expect(() => workspaces.delete(workspace.id)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.WORKSPACE_BUSY }),
    );
    jobs.delete(job.id);
    expect(() => workspaces.delete(workspace.id)).not.toThrow();
  });
});
