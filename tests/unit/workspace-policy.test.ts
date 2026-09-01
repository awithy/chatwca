import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openDatabase, type ChatWcaDatabase } from "../../src/server/database.js";
import {
  WorkspaceRepository,
  type WorkspacePolicyInputs,
} from "../../src/server/workspace-repository.js";
import { ERROR_CODES } from "../../src/shared/errors.js";
import type { SandboxMode, WorkspaceSecurityProfile } from "../../src/shared/protocol.js";

const temporaryDirectories: string[] = [];
const databases: ChatWcaDatabase[] = [];
function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "chatwca-policy-"));
  temporaryDirectories.push(directory);
  return directory;
}
function database(): ChatWcaDatabase {
  const opened = openDatabase(temporaryDirectory(), ":memory:");
  databases.push(opened);
  return opened;
}
function policy(
  mode: SandboxMode,
  root: string,
  overrides: Partial<WorkspacePolicyInputs> = {},
): WorkspacePolicyInputs {
  return {
    mode,
    workspaceRoots: [realpathSync(root)],
    dataDirectory: realpathSync(temporaryDirectory()),
    piAgentDirectory: realpathSync(temporaryDirectory()),
    readOnlyMounts: [],
    ...overrides,
  };
}
function seed(
  opened: ChatWcaDatabase,
  workspacePath: string,
  securityProfile: WorkspaceSecurityProfile,
): void {
  opened.connection.prepare(`
    INSERT INTO workspaces
      (id, name, path, session_storage, security_profile, created_at, updated_at)
    VALUES (?, ?, ?, 'pi-default', ?, 1, 1)
  `).run("workspace-1", "Workspace", realpathSync(workspacePath), securityProfile);
}
afterEach(() => {
  for (const opened of databases.splice(0)) opened.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("workspace security policy", () => {
  it.each([
    ["optional", "unrestricted", "unrestricted", null],
    ["optional", "workspace-sandboxed", "workspace-sandboxed", null],
    ["required", "unrestricted", "workspace-sandboxed", null],
    ["required", "workspace-sandboxed", "workspace-sandboxed", null],
    ["disabled", "unrestricted", "unrestricted", null],
    ["disabled", "workspace-sandboxed", null, "sandbox_disabled"],
  ] as const)(
    "evaluates %s mode with stored %s",
    (mode, stored, effective, issue) => {
      const root = temporaryDirectory();
      const workspacePath = path.join(root, "project");
      mkdirSync(workspacePath);
      const opened = database();
      seed(opened, workspacePath, stored);
      const repository = new WorkspaceRepository(opened.connection, {
        policy: policy(mode, root),
      });

      expect(repository.get("workspace-1")).toMatchObject({
        securityProfile: stored,
        effectiveSecurityProfile: effective,
        usable: issue === null,
        policyIssue: issue,
      });
      if (issue === null) {
        expect(repository.requireUsable("workspace-1")).toEqual({
          workspaceId: "workspace-1",
          cwd: realpathSync(workspacePath),
          sessionDirectory: null,
          securityProfile: effective,
        });
      } else {
        expect(() => repository.requireUsable("workspace-1")).toThrow(
          expect.objectContaining({ code: ERROR_CODES.SANDBOX_DISABLED }),
        );
      }
    },
  );

  it("enforces roots on create, path update, projection, and runtime admission", () => {
    const approvedRoot = temporaryDirectory();
    const approved = path.join(approvedRoot, "approved");
    mkdirSync(approved);
    const outside = temporaryDirectory();
    const opened = database();
    const configuredPolicy = policy("optional", approvedRoot);
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-approved",
      policy: configuredPolicy,
    });

    expect(() => repository.create({
      name: "Outside",
      path: outside,
      securityProfile: "unrestricted",
    })).toThrow(expect.objectContaining({
      code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED,
    }));
    const created = repository.create({
      name: "Approved",
      path: approved,
      securityProfile: "unrestricted",
    });
    expect(() => repository.update(created.id, { path: outside })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED }),
    );

    // A row predating the configured root remains listable and history-available,
    // but is never admitted to runtime construction.
    opened.connection.prepare(`
      INSERT INTO workspaces VALUES
      ('legacy', 'Legacy', ?, 'pi-default', 'unrestricted', 1, 1)
    `).run(realpathSync(outside));
    expect(repository.get("legacy")).toMatchObject({
      available: true,
      usable: false,
      policyIssue: "outside_workspace_roots",
    });
    expect(repository.requireAvailable("legacy").path).toBe(realpathSync(outside));
    expect(() => repository.requireUsable("legacy")).toThrow(
      expect.objectContaining({ code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED }),
    );
  });

  it("rejects sandbox overlap in either direction while unrestricted remains usable", () => {
    const root = temporaryDirectory();
    const workspacePath = path.join(root, "project");
    const protectedChild = path.join(workspacePath, "server-data");
    mkdirSync(protectedChild, { recursive: true });
    const opened = database();
    const configuredPolicy = policy("optional", root, {
      dataDirectory: realpathSync(protectedChild),
    });
    const repository = new WorkspaceRepository(opened.connection, {
      policy: configuredPolicy,
      uuid: () => "workspace-1",
    });

    expect(() => repository.create({
      name: "Sandboxed",
      path: workspacePath,
      securityProfile: "workspace-sandboxed",
    })).toThrow(expect.objectContaining({
      code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED,
    }));
    expect(repository.create({
      name: "Unrestricted",
      path: workspacePath,
      securityProfile: "unrestricted",
    })).toMatchObject({ usable: true, policyIssue: null });
  });

  it("enforces mode ceilings and explicit downgrade acknowledgement", () => {
    const root = temporaryDirectory();
    const workspacePath = path.join(root, "project");
    mkdirSync(workspacePath);

    const disabledDb = database();
    const disabled = new WorkspaceRepository(disabledDb.connection, {
      policy: policy("disabled", root),
    });
    expect(() => disabled.create({
      name: "Blocked",
      path: workspacePath,
      securityProfile: "workspace-sandboxed",
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.SANDBOX_DISABLED }));

    const requiredDb = database();
    const required = new WorkspaceRepository(requiredDb.connection, {
      policy: policy("required", root),
    });
    expect(() => required.create({
      name: "Wrong profile",
      path: workspacePath,
      securityProfile: "unrestricted",
    })).toThrow(expect.objectContaining({
      code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED,
    }));

    const optionalDb = database();
    const optional = new WorkspaceRepository(optionalDb.connection, {
      policy: policy("optional", root),
      uuid: () => "workspace-optional",
    });
    const created = optional.create({
      name: "Sandboxed",
      path: workspacePath,
      securityProfile: "workspace-sandboxed",
    });
    expect(() => optional.update(created.id, {
      securityProfile: "unrestricted",
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    expect(optional.update(created.id, {
      securityProfile: "unrestricted",
      acknowledgeSecurityDowngrade: true,
    })).toMatchObject({
      securityProfile: "unrestricted",
      effectiveSecurityProfile: "unrestricted",
    });
    expect(() => optional.update(created.id, {
      name: "No smuggled acknowledgement",
      acknowledgeSecurityDowngrade: true,
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
  });
});
