import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, type ChatWcaDatabase } from "../../src/server/database.js";
import { WorkspaceRepository } from "../../src/server/workspace-repository.js";
import { SearchIndexAuthority, type SearchInvalidation } from "../../src/server/search/authority.js";
import { discoverSessionFiles, workspaceSourceRevision } from "../../src/server/search/session-source.js";
import { searchJsonl, searchSessionHeader, searchUserEntry } from "../fixtures/search-session.js";

let root: string | undefined;
let database: ChatWcaDatabase | undefined;
let ledger: SearchIndexAuthority | undefined;
afterEach(async () => { ledger?.close(); database?.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function fixture(storage: "workspace" | "pi-default" = "workspace") {
  root = await mkdtemp(path.join(tmpdir(), "chatwca-search-authority-"));
  const workspacePath = path.join(root, "workspace");
  await mkdir(workspacePath);
  database = openDatabase(root, ":memory:");
  const registrations = new WorkspaceRepository(database.connection, { uuid: () => "synthetic-workspace" });
  const created = registrations.create({ name: "Synthetic registration", path: workspacePath, sessionStorage: storage });
  const piAgentDirectory = path.join(root, "absent-pi-universe");
  const invalidations: SearchInvalidation[] = [];
  ledger = new SearchIndexAuthority({ read: (id) => registrations.get(id) }, piAgentDirectory, {
    onInvalidate: (event): undefined => { invalidations.push(event); },
  });
  const workspace = ledger.admitWorkspace(created.id);
  const scope = { workspaceId: workspace.id, sourceRevision: workspaceSourceRevision(workspace, piAgentDirectory) };
  const sessionDirectory = created.sessionDirectory ?? path.join(piAgentDirectory, "sessions", `--${workspacePath.replace(/^\//u, "").replaceAll("/", "-")}--`);
  await mkdir(sessionDirectory, { recursive: true });
  const file = path.join(sessionDirectory, "session.jsonl");
  await writeFile(file, searchJsonl([searchSessionHeader(workspacePath), searchUserEntry("entry", null, "Synthetic visible text")]));
  const discovery = await discoverSessionFiles(workspace, piAgentDirectory);
  const candidate = discovery.candidates[0]!;
  const authority = ledger.capture(workspace, candidate);
  return { registrations, workspace, scope, sessionDirectory, file, candidate, authority, ledger, invalidations, piAgentDirectory };
}

describe("search authority with current SQLite registrations and filesystem admission", () => {
  it("uses default read-only canonical admission without mutating history or creating a Pi universe", async () => {
    const f = await fixture(); const bytes = await readFile(f.file); const before = await stat(f.file, { bigint: true });
    await f.authority.revalidate("synthetic-session", new AbortController().signal);
    expect(await readFile(f.file)).toEqual(bytes);
    const after = await stat(f.file, { bigint: true });
    expect(after.mtimeNs).toBe(before.mtimeNs); expect(after.ctimeNs).toBe(before.ctimeNs);
    await expect(stat(f.piAgentDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(f.invalidations).toEqual([]);
  });

  it("admits Pi-default storage only in the selected state universe", async () => {
    const f = await fixture("pi-default");
    await f.authority.revalidate("synthetic-session", new AbortController().signal);
    expect(f.candidate.storePath).toBe(f.sessionDirectory);
    expect(f.candidate.piAgentDirectory).toBe(f.piAgentDirectory);
  });

  it("canonical admission rejects a missing workspace without mistaking it for unregister/deletion", async () => {
    const f = await fixture(); await rm(f.workspace.path, { recursive: true });
    await expect(f.authority.revalidate(undefined, new AbortController().signal)).rejects.toThrow("search_scope_unavailable");
    expect(f.registrations.get(f.workspace.id).available).toBe(false);
    expect(f.invalidations).toEqual([]); // no pruning authority from an unavailable filesystem
  });

  it("a canonical workspace replaced by an alias fails source admission", async () => {
    const f = await fixture(); const elsewhere = path.join(root!, "elsewhere"); await mkdir(elsewhere);
    await rm(f.workspace.path, { recursive: true }); await symlink(elsewhere, f.workspace.path);
    await expect(f.authority.revalidate(undefined, new AbortController().signal)).rejects.toThrow("search_scope_unavailable");
    expect(f.invalidations).toEqual([]);
  });

  it("observes SQLite path changes and hooks retire same-revision re-registrations", async () => {
    const f = await fixture(); const elsewhere = path.join(root!, "moved"); await mkdir(elsewhere);
    f.registrations.update(f.workspace.id, { path: elsewhere });
    expect(() => f.authority.assertCurrent("synthetic-session")).toThrow("search_source_changed");
    f.ledger.invalidateWorkspace(f.workspace.id);
    f.registrations.update(f.workspace.id, { path: f.workspace.path }); f.ledger.admitWorkspace(f.workspace.id);
    expect(() => f.authority.assertCurrent("synthetic-session")).toThrow("search_source_changed");
    expect(f.invalidations).toEqual([{ ...f.scope, kind: "workspace" }]);
  });

  it("unregistration seals source operations without deleting retained session files", async () => {
    const f = await fixture(); const before = await readFile(f.file);
    f.registrations.delete(f.workspace.id); f.ledger.invalidateWorkspace(f.workspace.id);
    await expect(f.authority.revalidate("synthetic-session", new AbortController().signal)).rejects.toThrow("search_source_changed");
    expect(f.ledger.isSuppressed(f.scope, "synthetic-session", f.file)).toBe(true);
    expect(await readFile(f.file)).toEqual(before);
  });
});
