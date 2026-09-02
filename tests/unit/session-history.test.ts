import { existsSync, unlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/shared/errors.js";
import {
  SessionHistory,
  type SessionHistoryWorkspace,
} from "../../src/server/session-history.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function temporaryHistoryRoot() {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-history-"));
  temporaryRoots.push(root);
  const cwdA = path.join(root, "workspace-a");
  const cwdB = path.join(root, "workspace-b");
  await Promise.all([mkdir(cwdA), mkdir(cwdB)]);
  return {
    root,
    workspaceA: {
      id: "workspace-a",
      path: cwdA,
      sessionDirectory: null,
    } satisfies SessionHistoryWorkspace,
    workspaceB: {
      id: "workspace-b",
      path: cwdB,
      sessionDirectory: null,
    } satisfies SessionHistoryWorkspace,
  };
}

function sessionInfo(
  sessionFile: string,
  cwd: string,
  overrides: Partial<SessionInfo> = {},
): SessionInfo {
  return {
    path: sessionFile,
    id: path.basename(sessionFile, ".jsonl"),
    cwd,
    created: new Date("2025-01-01T00:00:00.000Z"),
    modified: new Date("2025-01-02T00:00:00.000Z"),
    messageCount: 2,
    firstMessage: "First user prompt",
    allMessagesText: "First user prompt Assistant response",
    ...overrides,
  };
}

describe("SessionHistory", () => {
  it("does not list any Pi history during service construction", () => {
    const listSessions = vi.fn(async () => []);
    new SessionHistory({ listSessions });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("lists only the supplied canonical workspace and normalizes deterministic summaries", async () => {
    const { root, workspaceA, workspaceB } = await temporaryHistoryRoot();
    const olderFile = path.join(root, "older.jsonl");
    const firstTieFile = path.join(root, "first-tie.jsonl");
    const secondTieFile = path.join(root, "second-tie.jsonl");
    const foreignFile = path.join(root, "foreign.jsonl");
    const alias = path.join(root, "first-tie-alias.jsonl");
    await Promise.all([
      writeFile(olderFile, "listed by Pi"),
      writeFile(firstTieFile, "listed by Pi"),
      writeFile(secondTieFile, "listed by Pi"),
      writeFile(foreignFile, "listed by Pi"),
    ]);
    await symlink(firstTieFile, alias);

    const listSessions = vi.fn(async () => [
      sessionInfo(secondTieFile, workspaceA.path, {
        id: "z-tie",
        modified: new Date("2025-01-03T00:00:00.000Z"),
      }),
      sessionInfo(olderFile, workspaceA.path, {
        id: "older",
        firstMessage: "  fallback prompt  ",
      }),
      sessionInfo(alias, workspaceA.path, {
        id: "a-tie",
        name: "  Explicit Pi name  ",
        modified: new Date("2025-01-03T00:00:00.000Z"),
      }),
      // Even if an injected/compromised listing returns it, another CWD is not authority.
      sessionInfo(foreignFile, workspaceB.path, { id: "foreign" }),
    ]);
    const history = new SessionHistory({
      listSessions,
      getLiveStatus: ({ id }) =>
        id === "a-tie"
          ? {
              workspaceId: workspaceA.id,
              status: "aborting",
              owner: { kind: "scheduled-job", jobId: "job-1", runId: "run-1" },
            }
          : id === "older"
            ? { workspaceId: workspaceA.id, status: "idle" }
            : id === "z-tie"
              ? { workspaceId: workspaceB.id, status: "streaming" }
              : undefined,
    });

    const snapshot = await history.refresh(workspaceA);

    expect(listSessions).toHaveBeenCalledExactlyOnceWith(workspaceA.path);
    expect(snapshot.conversations.map(({ id }) => id)).toEqual([
      "a-tie",
      "z-tie",
      "older",
    ]);
    expect(snapshot.conversations[0]).toMatchObject({
      workspaceId: workspaceA.id,
      sessionFile: firstTieFile,
      title: "Explicit Pi name",
      status: "streaming",
      runnable: true,
      owner: { kind: "scheduled-job", jobId: "job-1", runId: "run-1" },
    });
    expect(snapshot.conversations[1]).toMatchObject({
      id: "z-tie",
      status: "closed",
    });
    expect(snapshot.conversations[1]).not.toHaveProperty("owner");
    expect(snapshot.conversations[2]).toMatchObject({
      title: "fallback prompt",
      status: "idle",
    });
    expect(snapshot.allowedSessionFiles).toEqual(
      new Set([olderFile, firstTieFile, secondTieFile]),
    );
  });

  it("passes a workspace-local session directory only for local storage", async () => {
    const { workspaceA } = await temporaryHistoryRoot();
    const localDirectory = path.join(workspaceA.path, ".chatwca", "sessions");
    const listSessions = vi.fn(async () => []);
    const history = new SessionHistory({ listSessions });

    await history.list({ ...workspaceA, sessionDirectory: localDirectory });

    expect(listSessions).toHaveBeenCalledExactlyOnceWith(
      workspaceA.path,
      localDirectory,
    );
  });

  it("keys latest snapshots by workspace and calls only each selected workspace CWD", async () => {
    const { root, workspaceA, workspaceB } = await temporaryHistoryRoot();
    const fileA = path.join(root, "a.jsonl");
    const fileB = path.join(root, "b.jsonl");
    await Promise.all([writeFile(fileA, "a"), writeFile(fileB, "b")]);
    const listSessions = vi.fn(async (cwd: string) =>
      cwd === workspaceA.path
        ? [sessionInfo(fileA, workspaceA.path, { id: "a" })]
        : [sessionInfo(fileB, workspaceB.path, { id: "b" })],
    );
    const history = new SessionHistory({ listSessions });

    await expect(history.list(workspaceA)).resolves.toMatchObject([{ id: "a" }]);
    await expect(history.list(workspaceB)).resolves.toMatchObject([{ id: "b" }]);

    expect(listSessions.mock.calls).toEqual([
      [workspaceA.path],
      [workspaceB.path],
    ]);
    expect(history.latest(workspaceA.id).conversations).toMatchObject([
      { id: "a" },
    ]);
    expect(history.latest(workspaceB.id).conversations).toMatchObject([
      { id: "b" },
    ]);
    expect(history.latest("never-listed").conversations).toEqual([]);
  });

  it("freshly lists the supplied workspace for every resolve and rejects cross-workspace IDs", async () => {
    const { root, workspaceA, workspaceB } = await temporaryHistoryRoot();
    const fileA = path.join(root, "a.jsonl");
    const fileB = path.join(root, "b.jsonl");
    await Promise.all([writeFile(fileA, "a"), writeFile(fileB, "b")]);
    let includeA = true;
    const listSessions = vi.fn(async (cwd: string) => {
      if (cwd === workspaceA.path) {
        return includeA ? [sessionInfo(fileA, workspaceA.path, { id: "a" })] : [];
      }
      return [sessionInfo(fileB, workspaceB.path, { id: "b" })];
    });
    const history = new SessionHistory({ listSessions });

    await expect(history.resolve(workspaceA, "a")).resolves.toMatchObject({
      summary: { id: "a", workspaceId: workspaceA.id, sessionFile: fileA },
    });
    await expect(history.resolve(workspaceA, "b")).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_LISTED,
    });
    await expect(history.resolve(workspaceB, "a")).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_LISTED,
    });
    includeA = false;
    await expect(history.resolve(workspaceA, "a")).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_LISTED,
    });

    expect(listSessions.mock.calls).toEqual([
      [workspaceA.path],
      [workspaceA.path],
      [workspaceB.path],
      [workspaceA.path],
    ]);
  });

  it("freshly authorizes deletion, checks workspace-aware live ownership, and refreshes only that workspace", async () => {
    const { root, workspaceA } = await temporaryHistoryRoot();
    const sessionFile = path.join(root, "session.jsonl");
    await writeFile(sessionFile, "listed by Pi");
    let liveWorkspaceId: string | undefined = workspaceA.id;
    const info = sessionInfo(sessionFile, workspaceA.path, { id: "session-id" });
    const listSessions = vi.fn(async () =>
      existsSync(sessionFile) ? [info] : [],
    );
    const history = new SessionHistory({
      listSessions,
      getLiveStatus: () =>
        liveWorkspaceId === undefined
          ? undefined
          : { workspaceId: liveWorkspaceId, status: "idle" },
    });

    await expect(history.delete(workspaceA, "session-id")).rejects.toMatchObject({
      code: ERROR_CODES.LIVE_SESSION_DELETE,
    });
    expect(existsSync(sessionFile)).toBe(true);

    liveWorkspaceId = undefined;
    await expect(history.delete(workspaceA, "session-id")).resolves.toEqual([]);
    expect(existsSync(sessionFile)).toBe(false);
    // Rejected fresh authorization, successful fresh authorization, post-delete refresh.
    expect(listSessions).toHaveBeenCalledTimes(3);
    expect(history.latest(workspaceA.id).allowedSessionFiles.size).toBe(0);
  });

  it("drops stale files and safely rejects files removed after fresh authorization", async () => {
    const { root, workspaceA } = await temporaryHistoryRoot();
    const vanishedBeforeRefresh = path.join(root, "vanished.jsonl");
    const deletionRace = path.join(root, "race.jsonl");
    await writeFile(deletionRace, "listed by Pi");

    let liveChecks = 0;
    const history = new SessionHistory({
      listSessions: () =>
        Promise.resolve([
          sessionInfo(vanishedBeforeRefresh, workspaceA.path, { id: "vanished" }),
          sessionInfo(deletionRace, workspaceA.path, { id: "race" }),
        ]),
      getLiveStatus: ({ id }) => {
        if (id === "race" && ++liveChecks === 2) {
          // realpath admitted the canonical file, then it disappeared before unlink.
          unlinkSync(deletionRace);
        }
        return undefined;
      },
    });

    await expect(history.resolve(workspaceA, "vanished")).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_LISTED,
    });
    await expect(history.delete(workspaceA, "race")).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_FILE_MISSING,
    });
  });

  it("reports an unavailable/noncanonical workspace without invoking any listing boundary", async () => {
    const { root, workspaceA } = await temporaryHistoryRoot();
    const listSessions = vi.fn(async () => []);
    const history = new SessionHistory({ listSessions });
    await rm(workspaceA.path, { recursive: true });

    await expect(history.list(workspaceA)).rejects.toMatchObject({
      code: ERROR_CODES.WORKSPACE_UNAVAILABLE,
    });
    await expect(history.resolve(workspaceA, "anything")).rejects.toMatchObject({
      code: ERROR_CODES.WORKSPACE_UNAVAILABLE,
    });
    await expect(history.delete(workspaceA, "anything")).rejects.toMatchObject({
      code: ERROR_CODES.WORKSPACE_UNAVAILABLE,
    });
    expect(listSessions).not.toHaveBeenCalled();

    const alias = path.join(root, "workspace-alias");
    await mkdir(workspaceA.path);
    await symlink(workspaceA.path, alias);
    await expect(
      history.list({ ...workspaceA, path: alias }),
    ).rejects.toMatchObject({ code: ERROR_CODES.WORKSPACE_UNAVAILABLE });
    expect(listSessions).not.toHaveBeenCalled();
  });

  it("contains no production SessionManager.listAll call", async () => {
    const serverDirectory = path.resolve("src/server");
    const files = (await readdir(serverDirectory))
      .filter((file) => file.endsWith(".ts"));
    const sources = await Promise.all(
      files.map((file) => readFile(path.join(serverDirectory, file), "utf8")),
    );
    expect(sources.join("\n")).not.toMatch(/SessionManager\s*\.\s*listAll\s*\(/u);
    expect(
      await readFile(path.join(serverDirectory, "session-history.ts"), "utf8"),
    ).toMatch(/SessionManager\s*\.\s*list\s*\(/u);
  });
});
