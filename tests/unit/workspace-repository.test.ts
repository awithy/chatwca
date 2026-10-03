import {
  accessSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DATABASE_FILENAME,
  openDatabase,
  type ChatWcaDatabase,
} from "../../src/server/database.js";
import {
  WorkspaceRepository,
  type WorkspaceFileSystem,
} from "../../src/server/workspace-repository.js";
import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import { loadManagedNetworkConfig } from "../../src/server/network/config.js";
import { decideDestination } from "../../src/server/network/policy.js";

const temporaryDirectories: string[] = [];
const databases: ChatWcaDatabase[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "chatwca-workspaces-"));
  temporaryDirectories.push(directory);
  return directory;
}

function database(dataDir = temporaryDirectory(), filename = ":memory:") {
  const opened = openDatabase(dataDir, filename);
  databases.push(opened);
  return opened;
}

function directory(parent: string, name: string): string {
  const target = path.join(parent, name);
  mkdirSync(target, { recursive: true });
  return target;
}

const realFileSystem: WorkspaceFileSystem = {
  realpath: realpathSync,
  stat: statSync,
  access: accessSync,
};

afterEach(() => {
  for (const opened of databases.splice(0)) opened.close();
  for (const target of temporaryDirectories.splice(0)) {
    rmSync(target, { recursive: true, force: true });
  }
});

describe("WorkspaceRepository CRUD", () => {
  it("creates, gets, renames, repoints, and removes workspace rows only", () => {
    const root = temporaryDirectory();
    const firstPath = directory(root, "first");
    const secondPath = directory(root, "second");
    const retainedFile = path.join(secondPath, "session.jsonl");
    writeFileSync(retainedFile, "retained");
    const opened = database();
    const times = [10, 20, 30];
    const repository = new WorkspaceRepository(opened.connection, {
      cwd: root,
      uuid: () => "workspace-1",
      clock: () => times.shift() ?? 99,
    });

    const created = repository.create({ name: "  Example  ", path: "first" });
    expect(created).toEqual({
      id: "workspace-1",
      name: "Example",
      path: realpathSync(firstPath),
      sessionStorage: "pi-default",
      sessionDirectory: null,
      securityProfile: "unrestricted",
      mounts: [],
      networkPolicy: "isolated",
      networkPolicySetId: "default",
      effectiveSecurityProfile: "unrestricted",
      effectiveNetworkPolicy: null,
      effectiveNetworkPolicySetId: null,
      networkPolicyIssue: null,
      enabledHttpTools: [],
      effectiveHttpTools: [],
      conversationToolsEnabled: false,
      effectiveConversationTools: [],
      createdAt: 10,
      updatedAt: 10,
      available: true,
      usable: true,
      policyIssue: null,
    });
    expect(repository.get(created.id)).toEqual(created);

    expect(repository.update(created.id, { name: " Renamed " })).toMatchObject({
      id: created.id,
      name: "Renamed",
      path: realpathSync(firstPath),
      createdAt: 10,
      updatedAt: 20,
    });
    expect(
      repository.update(created.id, { name: "Final", path: secondPath }),
    ).toMatchObject({
      name: "Final",
      path: realpathSync(secondPath),
      createdAt: 10,
      updatedAt: 30,
    });

    repository.delete(created.id);
    expect(repository.list()).toEqual([]);
    expect(() => repository.get(created.id)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.WORKSPACE_NOT_FOUND }),
    );
    expect(() => repository.delete(created.id)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.WORKSPACE_NOT_FOUND }),
    );
    expect(statSync(retainedFile).isFile()).toBe(true);
  });

  it("lists immutable stored session registrations without filesystem probes or runtime-policy evaluation", () => {
    const root = temporaryDirectory(); const opened = database();
    const fileSystem = { realpath: vi.fn(realFileSystem.realpath), stat: vi.fn(realFileSystem.stat), access: vi.fn(realFileSystem.access) };
    let sequence = 0;
    const repository = new WorkspaceRepository(opened.connection, { uuid: () => `workspace-${++sequence}`, fileSystem });
    const first = repository.create({ name: "Zulu", path: directory(root, "first"), sessionStorage: "workspace" });
    const second = repository.create({ name: "Alpha", path: directory(root, "second"), sessionStorage: "pi-default" });
    opened.connection.prepare("UPDATE workspaces SET security_profile = 'workspace-sandboxed' WHERE id = ?").run(first.id);
    for (const method of [fileSystem.realpath, fileSystem.stat, fileSystem.access]) {
      method.mockClear(); method.mockImplementation(() => { throw new Error("Source directory unavailable"); });
    }
    const registrations = repository.listRegistrations();
    expect(registrations).toEqual([second, first].map(({ id, name, path, sessionDirectory }) => ({ id, name, path, sessionDirectory })));
    expect(Object.isFrozen(registrations)).toBe(true); expect(registrations.every(Object.isFrozen)).toBe(true);
    expect(fileSystem.realpath).not.toHaveBeenCalled(); expect(fileSystem.stat).not.toHaveBeenCalled(); expect(fileSystem.access).not.toHaveBeenCalled();
    expect(repository.list().find((workspace) => workspace.id === first.id)).toMatchObject({ available: false, usable: false, policyIssue: "sandbox_disabled" });
    repository.update(second.id, { name: "Renamed" });
    expect(repository.listRegistrations()[0]?.name).toBe("Renamed");
    repository.delete(second.id);
    expect(repository.listRegistrations().map(({ id }) => id)).toEqual([first.id]);
  });

  it("persists rows when the SQLite database is reopened", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const dataDir = temporaryDirectory();
    const firstDatabase = database(dataDir, "chatwca.sqlite");
    const firstRepository = new WorkspaceRepository(firstDatabase.connection, {
      uuid: () => "workspace-persisted",
      clock: () => 123,
    });
    firstRepository.create({ name: "Persisted", path: workspacePath });
    firstDatabase.close();

    const reopened = database(dataDir, "chatwca.sqlite");
    const reopenedRepository = new WorkspaceRepository(reopened.connection);
    expect(reopenedRepository.list()).toEqual([
      {
        id: "workspace-persisted",
        name: "Persisted",
        path: realpathSync(workspacePath),
        sessionStorage: "pi-default",
        sessionDirectory: null,
        securityProfile: "unrestricted",
        mounts: [],
        networkPolicy: "isolated",
        networkPolicySetId: "default",
        effectiveSecurityProfile: "unrestricted",
        effectiveNetworkPolicy: null,
        effectiveNetworkPolicySetId: null,
        networkPolicyIssue: null,
        enabledHttpTools: [],
        effectiveHttpTools: [],
        conversationToolsEnabled: false,
        effectiveConversationTools: [],
        createdAt: 123,
        updatedAt: 123,
        available: true,
        usable: true,
        policyIssue: null,
      },
    ]);
  });

  it("stores an immutable workspace-local session policy without creating files", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "local-project");
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-local",
      clock: () => 10,
    });

    const created = repository.create({
      name: "Local sessions",
      path: workspacePath,
      sessionStorage: "workspace",
    });

    expect(created).toMatchObject({
      sessionStorage: "workspace",
      sessionDirectory: path.join(workspacePath, ".chatwca", "sessions"),
      available: true,
    });
    expect(() => statSync(path.join(workspacePath, ".chatwca"))).toThrow();
    expect(repository.update(created.id, { name: "Renamed" })).toMatchObject({
      sessionStorage: "workspace",
      sessionDirectory: path.join(workspacePath, ".chatwca", "sessions"),
    });
  });

  it("persists directory mounts, requires writable acknowledgement, and resolves an immutable runtime snapshot", async () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const referencePath = directory(root, "reference");
    const artifactsPath = directory(root, "artifacts");
    const dataPath = directory(root, "data");
    const piPath = directory(root, "pi");
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-mounted",
      policy: {
        mode: "optional",
        workspaceRoots: [root],
        dataDirectory: dataPath,
        piAgentDirectory: piPath,
        readOnlyMounts: [],
      },
    });
    const mounts = [
      { name: "reference", source: referencePath, access: "read-only" as const },
      { name: "artifacts", source: artifactsPath, access: "read-write" as const },
    ];

    expect(() => repository.create({
      name: "Mounted", path: workspacePath,
      securityProfile: "workspace-sandboxed", mounts,
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));

    const created = repository.create({
      name: "Mounted", path: workspacePath,
      securityProfile: "workspace-sandboxed", mounts,
      acknowledgeWritableMounts: true,
    });
    expect(created.mounts).toEqual(mounts.map((mount) => ({
      ...mount, source: realpathSync(mount.source),
    })));
    await expect(repository.requireUsable(created.id)).resolves.toMatchObject({
      securityProfile: "workspace-sandboxed",
      mounts: expect.arrayContaining(created.mounts),
    });
    expect(opened.connection.prepare(
      "SELECT name, source_path, access FROM workspace_mounts ORDER BY name",
    ).all()).toEqual([
      { name: "artifacts", source_path: realpathSync(artifactsPath), access: "read-write" },
      { name: "reference", source_path: realpathSync(referencePath), access: "read-only" },
    ]);

    const readOnly = repository.update(created.id, {
      mounts: mounts.map((mount) => ({ ...mount, access: "read-only" as const })),
    });
    expect(readOnly.mounts.every(({ access }) => access === "read-only")).toBe(true);
    expect(() => repository.update(created.id, { mounts })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }),
    );
    repository.update(created.id, { mounts, acknowledgeWritableMounts: true });
    rmSync(referencePath, { recursive: true, force: true });
    expect(repository.get(created.id)).toMatchObject({
      available: true,
      usable: false,
      policyIssue: "mount_unavailable",
    });

    repository.delete(created.id);
    expect(opened.connection.prepare("SELECT * FROM workspace_mounts").all()).toEqual([]);
  });

  it("rejects mount files, duplicate destinations, overlaps, and protected paths", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const sharedPath = directory(root, "shared");
    const dataPath = directory(root, "data");
    const piPath = directory(root, "pi");
    const filePath = path.join(root, "file.txt");
    writeFileSync(filePath, "not a directory");
    const repository = new WorkspaceRepository(database().connection, {
      uuid: () => "workspace-invalid-mount",
      policy: {
        mode: "optional", workspaceRoots: [root], dataDirectory: dataPath,
        piAgentDirectory: piPath, readOnlyMounts: [],
      },
    });
    const create = (mounts: readonly { name: string; source: string; access: "read-only" }[]) =>
      repository.create({
        name: "Invalid", path: workspacePath,
        securityProfile: "workspace-sandboxed", mounts,
      });

    for (const mounts of [
      [{ name: "file", source: filePath, access: "read-only" as const }],
      [
        { name: "same", source: sharedPath, access: "read-only" as const },
        { name: "same", source: root, access: "read-only" as const },
      ],
      [{ name: "shared", source: root, access: "read-only" as const }],
      [{ name: "data", source: dataPath, access: "read-only" as const }],
    ]) {
      expect(() => create(mounts)).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_MOUNT }),
      );
    }
  });

  it("rejects empty names and preserves the prior timestamp after failed updates", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const times = [10, 20, 30];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-1",
      clock: () => times.shift() ?? 99,
    });

    expect(() => repository.create({ name: " \t ", path: workspacePath })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_NAME }),
    );
    const created = repository.create({ name: "Valid", path: workspacePath });
    expect(() => repository.update(created.id, { name: "\n" })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_NAME }),
    );
    expect(() => repository.update(created.id, {})).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }),
    );
    expect(repository.get(created.id).updatedAt).toBe(10);
  });
});

describe("workspace destination policy sets", () => {
  function managedConfig() {
    return loadManagedNetworkConfig({
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["registry.example","**.github.com"]',
      CHATWCA_NETWORK_ALLOWED_PORTS: "[443]",
      CHATWCA_NETWORK_POLICY_SETS: JSON.stringify([
        { id: "default", label: "Registry", allowedDomains: ["registry.example"], allowedPorts: [443] },
        { id: "github", label: "GitHub", allowedDomains: ["**.github.com"], allowedPorts: [443] },
      ]),
    }, "optional", { processCwd: "/tmp/chatwca-config" });
  }

  function managedRepository(
    opened: ChatWcaDatabase,
    root: string,
    policySets = managedConfig().policySets,
  ) {
    return new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-managed",
      clock: () => 10,
      policy: {
        mode: "optional",
        workspaceRoots: [root],
        dataDirectory: "/var/lib/chatwca",
        piAgentDirectory: "/var/lib/pi",
        readOnlyMounts: [],
        managedEgressMode: "optional",
        networkPolicySets: policySets,
      },
    });
  }

  it("migrates a legacy managed workspace onto the synthesized decision-compatible default", async () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "legacy-project");
    const dataDir = temporaryDirectory();
    const legacy = new Database(path.join(dataDir, DATABASE_FILENAME));
    legacy.exec(`
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE,
        session_storage TEXT NOT NULL DEFAULT 'pi-default',
        security_profile TEXT NOT NULL DEFAULT 'unrestricted',
        network_policy TEXT NOT NULL DEFAULT 'isolated',
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      INSERT INTO workspaces VALUES
        ('legacy-managed', 'Legacy managed', '${workspacePath.replaceAll("'", "''")}',
         'pi-default', 'workspace-sandboxed', 'managed-egress', 11, 12);
      PRAGMA user_version = 4;
    `);
    legacy.close();

    const opened = database(dataDir, DATABASE_FILENAME);
    const legacyConfig = loadManagedNetworkConfig({
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["legacy.example"]',
      CHATWCA_NETWORK_ALLOWED_PORTS: "[443]",
      // Deliberately omit CHATWCA_NETWORK_POLICY_SETS.
    }, "optional", { processCwd: "/tmp/chatwca-config" });
    const repository = managedRepository(opened, root, legacyConfig.policySets);
    const migrated = repository.get("legacy-managed");

    expect(migrated).toMatchObject({
      networkPolicy: "managed-egress",
      networkPolicySetId: "default",
      effectiveNetworkPolicySetId: "default",
      createdAt: 11,
      updatedAt: 12,
      usable: true,
    });
    const runtime = await repository.requireUsable("legacy-managed");
    expect(runtime.networkPolicySet).toBe(legacyConfig.policySets.get("default"));
    expect(decideDestination(runtime.networkPolicySet!.destinationPolicy, {
      host: "legacy.example",
      port: 443,
    })).toMatchObject({ allowed: true, reason: "allowlist" });
  });

  it("defaults to default, persists configured selections, and returns the immutable compiled set", async () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const repository = managedRepository(opened, root);
    const created = repository.create({
      name: "Managed",
      path: workspacePath,
      securityProfile: "workspace-sandboxed",
      networkPolicy: "managed-egress",
      networkPolicySetId: "github",
    });
    expect(created).toMatchObject({
      networkPolicySetId: "github",
      effectiveNetworkPolicySetId: "github",
      networkPolicyIssue: null,
      usable: true,
    });
    expect(opened.connection.prepare(
      "SELECT network_policy_set_id FROM workspaces WHERE id = ?",
    ).get(created.id)).toEqual({ network_policy_set_id: "github" });
    const runtime = await repository.requireUsable(created.id);
    expect(runtime.networkPolicySetId).toBe("github");
    // Enforce the selected policy bytes rather than relying on mutable browser
    // state or a global destination policy.
    expect(runtime.networkPolicySet).toMatchObject({
      id: "github",
      allowedDomainPatterns: ["**.github.com"],
      allowedPorts: [443],
    });
    expect(Object.isFrozen(runtime.networkPolicySet)).toBe(true);
  });

  it("retains a removed set, fails closed only when managed egress is effective, and permits recovery", async () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const configured = managedConfig();
    const initial = managedRepository(opened, root, configured.policySets);
    initial.create({
      name: "Managed",
      path: workspacePath,
      securityProfile: "workspace-sandboxed",
      networkPolicy: "managed-egress",
      networkPolicySetId: "github",
    });
    const defaultOnly = new Map([
      ["default", configured.policySets.get("default")!],
    ]);
    const removed = managedRepository(opened, root, defaultOnly);
    expect(removed.get("workspace-managed")).toMatchObject({
      networkPolicySetId: "github",
      effectiveNetworkPolicySetId: null,
      networkPolicyIssue: "managed_egress_policy_set_unavailable",
      usable: false,
    });
    await expect(removed.requireUsable("workspace-managed")).rejects.toMatchObject({
      code: ERROR_CODES.NETWORK_POLICY_INVALID,
    });
    expect(removed.update("workspace-managed", {
      networkPolicy: "isolated",
    })).toMatchObject({
      networkPolicySetId: "github",
      effectiveNetworkPolicySetId: null,
      networkPolicyIssue: null,
      usable: true,
    });
    expect(removed.update("workspace-managed", {
      networkPolicySetId: "default",
    })).toMatchObject({ networkPolicySetId: "default" });
  });

  it("validates configured IDs and requires acknowledgements exactly for exposure transitions", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const repository = managedRepository(opened, root);
    const created = repository.create({
      name: "Managed",
      path: workspacePath,
      securityProfile: "workspace-sandboxed",
      networkPolicy: "managed-egress",
    });
    expect(created.networkPolicySetId).toBe("default");
    expect(() => repository.update(created.id, { networkPolicySetId: "github" }))
      .toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    expect(repository.update(created.id, {
      networkPolicySetId: "github",
      acknowledgeNetworkExposure: true,
    })).toMatchObject({ networkPolicySetId: "github" });
    expect(() => repository.update(created.id, {
      name: "Smuggled",
      acknowledgeNetworkExposure: true,
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    expect(() => repository.update(created.id, {
      networkPolicySetId: "missing",
      acknowledgeNetworkExposure: true,
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    expect(() => repository.create({
      name: "Invalid",
      path: directory(root, "invalid"),
      networkPolicySetId: "Bad ID",
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
  });

  it("requires acknowledgement when a stored managed policy becomes effective through a profile change", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const repository = managedRepository(opened, root);
    const created = repository.create({
      name: "Future managed",
      path: workspacePath,
      securityProfile: "unrestricted",
      networkPolicy: "managed-egress",
      networkPolicySetId: "github",
    });
    expect(created).toMatchObject({
      effectiveNetworkPolicy: null,
      effectiveNetworkPolicySetId: null,
      networkPolicyIssue: null,
    });
    expect(() => repository.update(created.id, {
      securityProfile: "workspace-sandboxed",
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    expect(repository.update(created.id, {
      securityProfile: "workspace-sandboxed",
      acknowledgeNetworkExposure: true,
    })).toMatchObject({ effectiveNetworkPolicySetId: "github" });
  });

  it("allows an isolated workspace to narrow its future set without a network acknowledgement", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const repository = managedRepository(opened, root);
    const created = repository.create({
      name: "Isolated",
      path: workspacePath,
      securityProfile: "workspace-sandboxed",
    });
    expect(repository.update(created.id, { networkPolicySetId: "github" }))
      .toMatchObject({ networkPolicy: "isolated", networkPolicySetId: "github" });
    expect(() => repository.update(created.id, {
      networkPolicy: "managed-egress",
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    expect(repository.update(created.id, {
      networkPolicy: "managed-egress",
      acknowledgeNetworkExposure: true,
    })).toMatchObject({
      effectiveNetworkPolicy: "managed-egress",
      effectiveNetworkPolicySetId: "github",
    });
  });
});

describe("workspace path canonicalization and availability", () => {
  it("canonicalizes symlinks and rejects duplicate canonical paths", () => {
    const root = temporaryDirectory();
    const target = directory(root, "target");
    const alias = path.join(root, "alias");
    symlinkSync(target, alias, "dir");
    const opened = database();
    const ids = ["workspace-target", "workspace-alias"];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => ids.shift() ?? "workspace-extra",
      clock: () => 10,
    });

    const created = repository.create({ name: "Target", path: alias });
    expect(created.path).toBe(realpathSync(target));
    expect(() => repository.create({ name: "Alias", path: target })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.DUPLICATE_WORKSPACE_PATH }),
    );
    expect(repository.list()).toHaveLength(1);
  });

  it("rejects workspace-local session directories that escape through a symlink", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const outside = directory(root, "outside");
    symlinkSync(outside, path.join(workspacePath, ".chatwca"), "dir");
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-local",
      clock: () => 10,
    });

    expect(() => repository.create({
      name: "Escaped",
      path: workspacePath,
      sessionStorage: "workspace",
    })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_PATH }),
    );
    expect(repository.list()).toEqual([]);
  });

  it("enforces canonical path uniqueness on updates without changing the row", () => {
    const root = temporaryDirectory();
    const first = directory(root, "first");
    const second = directory(root, "second");
    const opened = database();
    const ids = ["workspace-1", "workspace-2"];
    const times = [10, 20, 30];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => ids.shift() ?? "workspace-extra",
      clock: () => times.shift() ?? 99,
    });
    repository.create({ name: "First", path: first });
    const secondWorkspace = repository.create({ name: "Second", path: second });

    expect(() =>
      repository.update(secondWorkspace.id, { name: "Changed", path: first }),
    ).toThrow(
      expect.objectContaining({ code: ERROR_CODES.DUPLICATE_WORKSPACE_PATH }),
    );
    expect(repository.get(secondWorkspace.id)).toMatchObject({
      name: "Second",
      path: realpathSync(second),
      updatedAt: 20,
    });
  });

  it("rejects missing, non-directory, and inaccessible create/update paths safely", () => {
    const root = temporaryDirectory();
    const valid = directory(root, "valid");
    const inaccessible = directory(root, "private-project");
    const file = path.join(root, "file.txt");
    writeFileSync(file, "not a directory");
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-1",
      clock: () => 10,
    });

    for (const invalidPath of [path.join(root, "missing"), file]) {
      expect(() => repository.create({ name: "Invalid", path: invalidPath })).toThrow(
        expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_PATH }),
      );
    }

    const privateError = Object.assign(
      new Error(`EACCES at ${inaccessible}`),
      { code: "EACCES" },
    );
    const inaccessibleRepository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-private",
      clock: () => 20,
      fileSystem: {
        ...realFileSystem,
        access: (target, mode) => {
          if (target === realpathSync(inaccessible)) throw privateError;
          accessSync(target, mode);
        },
      },
    });
    let failure: unknown;
    try {
      inaccessibleRepository.create({ name: "Private", path: inaccessible });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({ code: ERROR_CODES.INVALID_WORKSPACE_PATH });
    expect((failure as Error).message).not.toContain(inaccessible);

    const created = repository.create({ name: "Valid", path: valid });
    expect(() => repository.update(created.id, { path: file })).toThrow(
      expect.objectContaining({ code: ERROR_CODES.INVALID_WORKSPACE_PATH }),
    );
    expect(repository.get(created.id)).toMatchObject({
      path: realpathSync(valid),
      updatedAt: 10,
    });
  });

  it("keeps unavailable rows, permits renaming, and recovers when the path returns", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const times = [10, 20];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-1",
      clock: () => times.shift() ?? 30,
    });
    const created = repository.create({ name: "Original", path: workspacePath });

    rmSync(workspacePath, { recursive: true });
    expect(repository.get(created.id).available).toBe(false);
    expect(() => repository.requireAvailable(created.id)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.WORKSPACE_UNAVAILABLE }),
    );
    expect(repository.update(created.id, { name: "Renamed" })).toMatchObject({
      name: "Renamed",
      path: created.path,
      available: false,
      updatedAt: 20,
    });

    mkdirSync(workspacePath);
    expect(repository.requireAvailable(created.id)).toMatchObject({
      id: created.id,
      name: "Renamed",
      path: realpathSync(workspacePath),
    });
    expect(repository.get(created.id).available).toBe(true);
  });

  it("marks a stored path unavailable when directory access fails", () => {
    const root = temporaryDirectory();
    const workspacePath = directory(root, "project");
    const opened = database();
    const normal = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-1",
      clock: () => 10,
    });
    normal.create({ name: "Private", path: workspacePath });

    const inaccessible = new WorkspaceRepository(opened.connection, {
      fileSystem: {
        ...realFileSystem,
        access: () => {
          throw Object.assign(new Error("private path"), { code: "EACCES" });
        },
      },
    });
    expect(inaccessible.list()[0]?.available).toBe(false);
    expect(() => inaccessible.requireAvailable("workspace-1")).toThrow(
      expect.objectContaining({ code: ERROR_CODES.WORKSPACE_UNAVAILABLE }),
    );
  });
});

describe("workspace conversation tool selections", () => {
  it("defaults off, persists toggles and preserves omitted selection across reopen", () => {
    const root = temporaryDirectory();
    const dataDir = temporaryDirectory();
    const opened = database(dataDir, DATABASE_FILENAME);
    const repository = new WorkspaceRepository(opened.connection, { searchMode: "optional" });
    const created = repository.create({ name: "History", path: directory(root, "history") });
    expect(created).toMatchObject({ conversationToolsEnabled: false, effectiveConversationTools: [] });
    expect(repository.update(created.id, { conversationToolsEnabled: true })).toMatchObject({
      conversationToolsEnabled: true, effectiveConversationTools: ["conversation_search", "conversation_read"],
    });
    repository.update(created.id, { name: "Renamed" });
    opened.close();
    const reopened = database(dataDir, DATABASE_FILENAME);
    const restored = new WorkspaceRepository(reopened.connection, { searchMode: "optional" });
    expect(restored.get(created.id)).toMatchObject({ name: "Renamed", conversationToolsEnabled: true });
    expect(restored.update(created.id, { conversationToolsEnabled: false })).toMatchObject({
      conversationToolsEnabled: false, effectiveConversationTools: [],
    });
    restored.delete(created.id);
    expect(reopened.connection.prepare("SELECT conversation_tools_enabled FROM workspaces").all()).toEqual([]);
  });

  it("retains selection while search is disabled without making the workspace unusable", async () => {
    const root = temporaryDirectory();
    const opened = database();
    const disabled = new WorkspaceRepository(opened.connection);
    const created = disabled.create({
      name: "History", path: directory(root, "history"), conversationToolsEnabled: true,
    });
    expect(created).toMatchObject({ conversationToolsEnabled: true, effectiveConversationTools: [], usable: true });
    await expect(disabled.requireUsable(created.id)).resolves.toMatchObject({ workspaceId: created.id, effectiveConversationTools: [] });
    const optional = new WorkspaceRepository(opened.connection, { searchMode: "optional" });
    expect(optional.get(created.id)).toMatchObject({
      conversationToolsEnabled: true, effectiveConversationTools: ["conversation_search", "conversation_read"], usable: true,
    });
    const captured = await optional.requireUsable(created.id);
    expect(captured.effectiveConversationTools).toEqual(["conversation_search", "conversation_read"]);
    expect(Object.isFrozen(captured.effectiveConversationTools)).toBe(true);
    const projection = optional.get(created.id);
    projection.effectiveConversationTools.pop();
    expect(optional.get(created.id).effectiveConversationTools).toHaveLength(2);
    expect(disabled.update(created.id, { name: "Preserved" }).conversationToolsEnabled).toBe(true);
    expect(disabled.update(created.id, { conversationToolsEnabled: false }).effectiveConversationTools).toEqual([]);
    expect(captured.effectiveConversationTools).toHaveLength(2);
    expect((await optional.requireUsable(created.id)).effectiveConversationTools).toEqual([]);
  });

  it("validates direct inputs before persistence and rejects corrupt stored selections", () => {
    const root = temporaryDirectory();
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection);
    const target = directory(root, "history");
    for (const invalid of [null, 0, 1, "true", [], {}]) {
      expect(() => repository.create({ name: "Bad", path: target, conversationToolsEnabled: invalid as boolean }))
        .toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    }
    const created = repository.create({ name: "History", path: target });
    for (const invalid of [null, 0, 1, "false", [], {}]) {
      expect(() => repository.update(created.id, { conversationToolsEnabled: invalid as boolean }))
        .toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    }
    expect(repository.get(created.id).conversationToolsEnabled).toBe(false);
    opened.connection.pragma("ignore_check_constraints = ON");
    opened.connection.prepare("UPDATE workspaces SET conversation_tools_enabled = 2 WHERE id = ?").run(created.id);
    expect(() => repository.get(created.id)).toThrow(expect.objectContaining({ code: ERROR_CODES.DATABASE_ERROR }));
  });
});

describe("workspace HTTP tool selections", () => {
  const tool = Object.freeze({
    name: "network_brain_search",
    label: "Network Brain Search",
    description: "Search local infrastructure docs.",
    method: "POST" as const,
    url: "http://127.0.0.1:53147/v1/search",
    parameters: Object.freeze({ type: "object", properties: {}, additionalProperties: false }),
    timeoutMs: 1_000,
    maxResponseBytes: 4_096,
  });
  const catalog = Object.freeze({ sourcePath: "/tools.json", tools: Object.freeze([tool]) });

  it("defaults off, persists selections, and resolves frozen runtime definitions", async () => {
    const root = temporaryDirectory();
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-tools",
      clock: () => 10,
      httpTools: catalog,
    });
    const created = repository.create({
      name: "Tools",
      path: directory(root, "tools"),
      enabledHttpTools: [tool.name],
    });

    expect(created.enabledHttpTools).toEqual([tool.name]);
    expect(created.effectiveHttpTools).toEqual([tool.name]);
    const policy = await repository.requireUsable(created.id);
    expect(policy.effectiveHttpTools).toEqual([tool]);
    expect(Object.isFrozen(policy.effectiveHttpTools)).toBe(true);

    const withoutCatalog = new WorkspaceRepository(opened.connection);
    expect(withoutCatalog.get(created.id)).toMatchObject({
      enabledHttpTools: [tool.name],
      effectiveHttpTools: [],
      usable: true,
    });
    expect((await withoutCatalog.requireUsable(created.id)).effectiveHttpTools).toEqual([]);
  });

  it("validates browser selections and cascades rows on workspace deletion", () => {
    const root = temporaryDirectory();
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => "workspace-tools",
      httpTools: catalog,
    });
    const created = repository.create({ name: "Tools", path: directory(root, "tools") });
    expect(created.enabledHttpTools).toEqual([]);

    expect(() => repository.update(created.id, {
      enabledHttpTools: [tool.name, tool.name],
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));
    expect(() => repository.update(created.id, {
      enabledHttpTools: ["unknown_tool"],
    })).toThrow(expect.objectContaining({ code: ERROR_CODES.INVALID_COMMAND }));

    repository.update(created.id, { enabledHttpTools: [tool.name] });
    expect(opened.connection.prepare("SELECT tool_name FROM workspace_http_tools").all())
      .toEqual([{ tool_name: tool.name }]);
    repository.delete(created.id);
    expect(opened.connection.prepare("SELECT * FROM workspace_http_tools").all()).toEqual([]);
  });
});

describe("workspace ordering and database errors", () => {
  it("sorts case-insensitive names deterministically and breaks ties by ID", () => {
    const root = temporaryDirectory();
    const opened = database();
    const ids = ["id-z", "id-b", "id-a"];
    const repository = new WorkspaceRepository(opened.connection, {
      uuid: () => ids.shift() ?? "id-extra",
      clock: () => 10,
    });
    repository.create({ name: "Alpha", path: directory(root, "one") });
    repository.create({ name: "beta", path: directory(root, "two") });
    repository.create({ name: "alpha", path: directory(root, "three") });

    expect(repository.list().map(({ id, name }) => `${name}:${id}`)).toEqual([
      "alpha:id-a",
      "Alpha:id-z",
      "beta:id-b",
    ]);
  });

  it("converts SQLite failures to a stable redacted database error", () => {
    const opened = database();
    const repository = new WorkspaceRepository(opened.connection);
    opened.close();

    let failure: unknown;
    try {
      repository.list();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      code: ERROR_CODES.DATABASE_ERROR,
      message: "The workspace database operation failed.",
    });
    expect(JSON.stringify(failure)).not.toContain("database connection");
  });
});
