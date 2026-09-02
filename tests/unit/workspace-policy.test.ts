import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

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
  networkPolicy: "isolated" | "managed-egress" = "isolated",
): void {
  opened.connection.prepare(`
    INSERT INTO workspaces
      (id, name, path, session_storage, security_profile, network_policy, created_at, updated_at)
    VALUES (?, ?, ?, 'pi-default', ?, ?, 1, 1)
  `).run(
    "workspace-1",
    "Workspace",
    realpathSync(workspacePath),
    securityProfile,
    networkPolicy,
  );
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
    async (mode, stored, effective, issue) => {
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
        await expect(repository.requireUsable("workspace-1")).resolves.toEqual({
          workspaceId: "workspace-1",
          cwd: realpathSync(workspacePath),
          sessionDirectory: null,
          securityProfile: effective,
          mounts: [],
          networkPolicy: effective === "workspace-sandboxed" ? "isolated" : null,
          networkPolicySetId: "default",
          effectiveNetworkPolicySetId: null,
          networkPolicySet: null,
        });
      } else {
        await expect(repository.requireUsable("workspace-1")).rejects.toMatchObject({
          code: ERROR_CODES.SANDBOX_DISABLED,
        });
      }
    },
  );

  it.each([
    ["disabled", "unrestricted", "managed-egress", null, null, true],
    ["disabled", "workspace-sandboxed", "managed-egress", "managed-egress", "managed_egress_disabled", false],
    ["optional", "workspace-sandboxed", "managed-egress", "managed-egress", null, true],
  ] as const)(
    "evaluates %s managed mode for %s workspace network %s",
    async (managedMode, profile, storedNetwork, effectiveNetwork, issue, usable) => {
      const root = temporaryDirectory();
      const workspacePath = path.join(root, "project");
      mkdirSync(workspacePath);
      const opened = database();
      seed(opened, workspacePath, profile, storedNetwork);
      const repository = new WorkspaceRepository(opened.connection, {
        policy: policy("optional", root, { managedEgressMode: managedMode }),
      });

      expect(repository.get("workspace-1")).toMatchObject({
        networkPolicy: storedNetwork,
        effectiveNetworkPolicy: effectiveNetwork,
        networkPolicyIssue: issue,
        usable,
      });
      if (usable) {
        await expect(repository.requireUsable("workspace-1")).resolves.toMatchObject({
          networkPolicy: effectiveNetwork,
        });
      } else {
        await expect(repository.requireUsable("workspace-1")).rejects.toMatchObject({
          code: ERROR_CODES.MANAGED_EGRESS_DISABLED,
        });
      }
    },
  );

  it("enforces roots on create, path update, projection, and runtime admission", async () => {
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
      INSERT INTO workspaces
        (id, name, path, session_storage, security_profile, created_at, updated_at)
      VALUES ('legacy', 'Legacy', ?, 'pi-default', 'unrestricted', 1, 1)
    `).run(realpathSync(outside));
    expect(repository.get("legacy")).toMatchObject({
      available: true,
      usable: false,
      policyIssue: "outside_workspace_roots",
    });
    expect(repository.requireAvailable("legacy").path).toBe(realpathSync(outside));
    await expect(repository.requireUsable("legacy")).rejects.toMatchObject({
      code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED,
    });
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

  it("runs fresh asynchronous admission before every sandbox policy result", async () => {
    const root = temporaryDirectory();
    const workspacePath = path.join(root, "project");
    mkdirSync(workspacePath);
    const opened = database();
    seed(opened, workspacePath, "workspace-sandboxed");
    const admit = vi.fn(async () => undefined);
    const configuredPolicy = policy("optional", root);
    const repository = new WorkspaceRepository(opened.connection, {
      policy: configuredPolicy,
      sandboxAdmission: { admit, admitMount: vi.fn(async () => undefined) },
    });

    await repository.requireUsable("workspace-1");
    await repository.requireUsable("workspace-1");
    expect(admit).toHaveBeenCalledTimes(2);
    expect(admit).toHaveBeenLastCalledWith({
      workspacePath: realpathSync(workspacePath),
      workspaceRoots: configuredPolicy.workspaceRoots,
      protectedPaths: [configuredPolicy.dataDirectory, configuredPolicy.piAgentDirectory],
    });

    const failure = Object.assign(new Error("socket appeared"), {
      code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED,
    });
    admit.mockRejectedValueOnce(failure);
    await expect(repository.requireUsable("workspace-1")).rejects.toBe(failure);
  });

  it("protects the managed helper file and installation directory only when usable", async () => {
    const root = temporaryDirectory();
    const workspacePath = path.join(root, "project");
    const helperDirectory = path.join(workspacePath, "installed-helper");
    const helperPath = path.join(helperDirectory, "chatwca-network-helper");
    mkdirSync(helperDirectory, { recursive: true });
    const opened = database();
    seed(opened, workspacePath, "workspace-sandboxed");
    const admit = vi.fn(async () => undefined);
    const repository = new WorkspaceRepository(opened.connection, {
      policy: policy("optional", root, {
        managedEgressMode: "optional",
        networkHelperPath: helperPath,
        networkHelperDirectory: helperDirectory,
      }),
      sandboxAdmission: { admit, admitMount: vi.fn(async () => undefined) },
    });

    expect(repository.get("workspace-1")).toMatchObject({
      usable: false,
      policyIssue: "protected_path_overlap",
    });
    await expect(repository.requireUsable("workspace-1")).rejects.toMatchObject({
      code: ERROR_CODES.SANDBOX_WORKSPACE_REJECTED,
    });
    expect(admit).not.toHaveBeenCalled();
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

  it("requires acknowledgement only when adding managed network exposure", () => {
    const root = temporaryDirectory();
    const workspacePath = path.join(root, "project");
    mkdirSync(workspacePath);
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      policy: policy("optional", root, { managedEgressMode: "optional" }),
      uuid: () => "workspace-network",
    });
    const created = repository.create({
      name: "Network",
      path: workspacePath,
      securityProfile: "workspace-sandboxed",
    });

    expect(() => repository.update(created.id, {
      networkPolicy: "managed-egress",
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    expect(repository.update(created.id, {
      networkPolicy: "managed-egress",
      acknowledgeNetworkExposure: true,
    })).toMatchObject({
      networkPolicy: "managed-egress",
      effectiveNetworkPolicy: "managed-egress",
    });
    expect(() => repository.update(created.id, {
      networkPolicy: "isolated",
      acknowledgeNetworkExposure: true,
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    expect(repository.update(created.id, {
      networkPolicy: "isolated",
    })).toMatchObject({ networkPolicy: "isolated" });
    expect(() => repository.update(created.id, {
      name: "Smuggled",
      acknowledgeNetworkExposure: true,
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
  });
});
