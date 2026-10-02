import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type ChatWcaDatabase } from "../../src/server/database.js";
import { WorkspaceRepository } from "../../src/server/workspace-repository.js";
import { SearchIndexAuthority } from "../../src/server/search/authority.js";
import { loadSearchMigrations, migrateSearchDatabase, type SearchDatabasePool } from "../../src/server/search/migrations.js";
import { createSearchPool } from "../../src/server/search/postgres.js";
import { PostgresSearchRepository } from "../../src/server/search/repository.js";
import { SearchWorkspaceSynchronizer } from "../../src/server/search/workspace-sync.js";
import { searchPublication } from "../fixtures/search-repository.js";

const resources: { root: string; database: ChatWcaDatabase; authority: SearchIndexAuthority; sync?: SearchWorkspaceSynchronizer }[] = [];
afterEach(async () => {
  for (const resource of resources.splice(0)) {
    resource.sync?.close(); resource.authority.close(); resource.database.close(); await rm(resource.root, { recursive: true, force: true });
  }
});
async function fixture(storage: "workspace" | "pi-default" = "workspace") {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-search-workspace-sync-")); const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath); const database = openDatabase(root, ":memory:");
  const registry = new WorkspaceRepository(database.connection, { uuid: () => "synthetic-workspace" });
  const registered = registry.create({ name: "Synthetic registration", path: workspacePath, sessionStorage: storage });
  const piAgentDirectory = path.join(root, "absent-pi"); const registrations = { read: (id: string) => registry.get(id) };
  const authority = new SearchIndexAuthority(registrations, piAgentDirectory, { onInvalidate: (): undefined => {} });
  const resource = { root, database, authority, sync: undefined as SearchWorkspaceSynchronizer | undefined }; resources.push(resource);
  return { ...resource, resource, registry, registrations, registered, piAgentDirectory };
}

describe("workspace preparation with fresh SQLite and read-only filesystem admission", () => {
  it.each(["workspace", "pi-default"] as const)("synchronizes %s metadata without creating session stores or a Pi universe", async (storage) => {
    const f = await fixture(storage);
    const repository = { readWorkspace: vi.fn(async () => null), synchronizeWorkspace: vi.fn(async () => {}) };
    const sync = f.resource.sync = new SearchWorkspaceSynchronizer(repository, f.registrations, f.authority, f.piAgentDirectory);
    const result = await sync.synchronize(f.registered.id);
    expect(result.status).toBe("created"); expect(result.workspace.canonicalPath).toBe(f.registered.path);
    await expect(stat(result.workspace.sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(f.piAgentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    // This success means derived workspace preparation, NOT an authoritative empty scan.
    expect(repository.synchronizeWorkspace).toHaveBeenCalledOnce();
  });

  it("preserves derived metadata for unavailable workspaces without authorizing cleanup", async () => {
    const f = await fixture(); await rm(f.registered.path, { recursive: true });
    const repository = { readWorkspace: vi.fn(async () => null), synchronizeWorkspace: vi.fn(async () => {}) };
    const sync = f.resource.sync = new SearchWorkspaceSynchronizer(repository, f.registrations, f.authority, f.piAgentDirectory);
    await expect(sync.synchronize(f.registered.id)).rejects.toThrow("search_scope_unavailable");
    expect(repository.readWorkspace).not.toHaveBeenCalled(); expect(repository.synchronizeWorkspace).not.toHaveBeenCalled();
  });
});

const testUrl = process.env.CHATWCA_SEARCH_TEST_DATABASE_URL;
describe.skipIf(testUrl === undefined)("guarded workspace synchronization composed with PostgreSQL", () => {
  const schema = `chatwca_search_workspace_sync_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool; let pool: Pool; let repository: PostgresSearchRepository; let created = false;
  beforeAll(async () => {
    admin = createSearchPool(testUrl!); await admin.query(`CREATE SCHEMA ${schema}`); created = true;
    const url = new URL(testUrl!); url.searchParams.set("options", `-c search_path=${schema},public`);
    pool = createSearchPool(url.toString()); await migrateSearchDatabase(pool, await loadSearchMigrations()); repository = new PostgresSearchRepository(pool);
  });
  beforeEach(async () => { await pool.query("TRUNCATE search_workspaces CASCADE"); });
  afterAll(async () => {
    repository?.close(); await pool?.end(); if (created) await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin?.end();
  });
  async function prepared() {
    const f = await fixture(); const sync = f.resource.sync = new SearchWorkspaceSynchronizer(repository, f.registrations, f.authority, f.piAgentDirectory);
    const target = (await sync.synchronize(f.registered.id)).workspace;
    await repository.publishDocument(searchPublication(["Synthetic committed evidence"], { ...target, sourcePath: path.join(target.sessionDirectory, "session.jsonl") }));
    return { ...f, sync, target };
  }
  function injected(hook: (sql: string, query: () => Promise<{ rows: Record<string, unknown>[] }>) => Promise<{ rows: Record<string, unknown>[] }>): SearchDatabasePool {
    return { connect: async () => {
      const client = await pool.connect(); return { query: (sql, values) => hook(sql, () => client.query(sql, values)), release: (destroy) => client.release(destroy) };
    } };
  }

  it("creates/renames metadata transactionally, preserving the complete document generation", async () => {
    const f = await prepared(); const before = (await repository.readCheckpointPage(f.target)).checkpoints;
    f.registry.update(f.registered.id, { name: "Renamed lexical workspace" });
    expect((await f.sync.synchronize(f.registered.id)).status).toBe("updated");
    expect((await repository.readCheckpointPage(f.target)).checkpoints).toEqual(before);
    expect((await pool.query("SELECT lexical_workspace_name FROM search_chunks")).rows).toEqual([{ lexical_workspace_name: "Renamed lexical workspace" }]);
    expect((await f.sync.synchronize(f.registered.id)).status).toBe("unchanged");
  });

  it("CAS source-revision replacement removes obsolete derived documents only", async () => {
    const f = await prepared(); const moved = path.join(f.root, "moved"); await mkdir(moved);
    f.registry.update(f.registered.id, { path: moved }); f.authority.invalidateWorkspace(f.registered.id);
    const result = await f.sync.synchronize(f.registered.id);
    expect(result.status).toBe("updated"); expect(result.workspace.sourceRevision).not.toBe(f.target.sourceRevision);
    expect((await repository.readCheckpointPage(f.target)).checkpoints).toEqual([]);
    expect((await pool.query("SELECT document_count, chunk_count FROM search_workspaces")).rows).toEqual([{ document_count: 0, chunk_count: 0 }]);
    expect((await stat(f.registered.path)).isDirectory()).toBe(true); await expect(stat(result.workspace.sessionDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("synchronous pre-commit name seals roll back copied lexical changes and workspace metadata together", async () => {
    const f = await prepared(); f.registry.update(f.registered.id, { name: "Intermediate name" });
    const guarded = new PostgresSearchRepository(injected(async (sql, query) => {
      const result = await query(); if (sql.startsWith("UPDATE search_workspaces SET source_revision")) f.registry.update(f.registered.id, { name: "Newer durable name" }); return result;
    }));
    const sync = new SearchWorkspaceSynchronizer(guarded, f.registrations, f.authority, f.piAgentDirectory);
    try {
      await expect(sync.synchronize(f.registered.id)).rejects.toThrow("search_source_changed");
      expect(await repository.readWorkspace(f.registered.id)).toEqual(f.target);
      expect((await pool.query("SELECT lexical_workspace_name FROM search_chunks")).rows).toEqual([{ lexical_workspace_name: f.target.displayName }]);
      expect((await f.sync.synchronize(f.registered.id)).workspace.displayName).toBe("Newer durable name");
    } finally { sync.close(); guarded.close(); }
  });

  it("re-reads acknowledged metadata after an ambiguous COMMIT response without blind retry", async () => {
    const f = await fixture(); let writing = false; let failOnce = true;
    const guarded = new PostgresSearchRepository(injected(async (sql, query) => {
      if (sql.startsWith("INSERT INTO search_workspaces")) writing = true;
      const result = await query();
      if (sql === "COMMIT" && writing && failOnce) { failOnce = false; throw new Error("private transport diagnostic"); }
      return result;
    }));
    const sync = new SearchWorkspaceSynchronizer(guarded, f.registrations, f.authority, f.piAgentDirectory);
    try {
      await expect(sync.synchronize(f.registered.id)).rejects.toThrow("search_database_unavailable");
      expect((await sync.synchronize(f.registered.id)).status).toBe("unchanged");
      expect((await pool.query("SELECT count(*) FROM search_workspaces")).rows[0]!.count).toBe("1");
    } finally { sync.close(); guarded.close(); }
  });
});
