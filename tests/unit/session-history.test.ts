import { existsSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/shared/errors.js";
import { SessionHistory } from "../../src/server/session-history.js";

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
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  return { root, cwd };
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
  it("normalizes Pi listings, titles, CWD availability, paths, and live states", async () => {
    const { root, cwd } = await temporaryHistoryRoot();
    const olderFile = path.join(root, "older.jsonl");
    const newerFile = path.join(root, "newer.jsonl");
    const missingCwdFile = path.join(root, "missing-cwd.jsonl");
    const alias = path.join(root, "newer-alias.jsonl");
    await Promise.all([
      writeFile(olderFile, "listed by Pi"),
      writeFile(newerFile, "listed by Pi"),
      writeFile(missingCwdFile, "listed by Pi"),
    ]);
    await symlink(newerFile, alias);

    const infos = [
      sessionInfo(olderFile, cwd, {
        id: "older",
        firstMessage: "  fallback prompt  ",
        modified: new Date("2025-01-02T00:00:00.000Z"),
      }),
      sessionInfo(alias, cwd, {
        id: "newer",
        name: "  Explicit Pi name  ",
        modified: new Date("2025-01-03T00:00:00.000Z"),
      }),
      sessionInfo(missingCwdFile, path.join(root, "gone"), {
        id: "missing-cwd",
        firstMessage: "(no messages)",
        modified: new Date("2025-01-01T00:00:00.000Z"),
        messageCount: 0,
      }),
    ];
    const history = new SessionHistory({
      listSessions: () => Promise.resolve(infos),
      getLiveStatus: ({ id }) =>
        id === "newer" ? "aborting" : id === "older" ? "idle" : undefined,
    });

    const snapshot = await history.refresh();

    expect(snapshot.conversations.map(({ id }) => id)).toEqual([
      "newer",
      "older",
      "missing-cwd",
    ]);
    expect(snapshot.conversations[0]).toMatchObject({
      sessionFile: newerFile,
      title: "Explicit Pi name",
      status: "streaming",
      runnable: true,
    });
    expect(snapshot.conversations[1]).toMatchObject({
      title: "fallback prompt",
      status: "idle",
    });
    expect(snapshot.conversations[2]).toMatchObject({
      title: "Untitled conversation",
      status: "closed",
      runnable: false,
    });
    expect(snapshot.allowedSessionFiles).toEqual(
      new Set([olderFile, newerFile, missingCwdFile]),
    );
  });

  it("resolves only IDs and canonical files admitted by a fresh listing", async () => {
    const { root, cwd } = await temporaryHistoryRoot();
    const sessionFile = path.join(root, "session.jsonl");
    await writeFile(sessionFile, "listed by Pi");
    let listed = true;
    let listingCount = 0;
    const history = new SessionHistory({
      listSessions: () => {
        listingCount += 1;
        return Promise.resolve(
          listed ? [sessionInfo(sessionFile, cwd, { id: "session-id" })] : [],
        );
      },
    });

    await expect(history.resolve("session-id")).resolves.toMatchObject({
      summary: { id: "session-id", sessionFile },
    });
    listed = false;
    await expect(history.resolve("session-id")).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_LISTED,
    });
    expect(listingCount).toBe(2);
  });

  it("rejects live deletion and refreshes history after guarded deletion", async () => {
    const { root, cwd } = await temporaryHistoryRoot();
    const sessionFile = path.join(root, "session.jsonl");
    await writeFile(sessionFile, "listed by Pi");
    let live = true;
    let listingCount = 0;
    const info = sessionInfo(sessionFile, cwd, { id: "session-id" });
    const history = new SessionHistory({
      listSessions: () => {
        listingCount += 1;
        return Promise.resolve(existsSync(sessionFile) ? [info] : []);
      },
      getLiveStatus: () => (live ? "idle" : undefined),
    });

    await expect(history.delete("session-id")).rejects.toMatchObject({
      code: ERROR_CODES.LIVE_SESSION_DELETE,
    });
    expect(existsSync(sessionFile)).toBe(true);

    live = false;
    await expect(history.delete("session-id")).resolves.toEqual([]);
    expect(existsSync(sessionFile)).toBe(false);
    // One listing for the rejected attempt, then authorization + post-delete refresh.
    expect(listingCount).toBe(3);
    expect(history.latest.allowedSessionFiles.size).toBe(0);
  });

  it("drops files that disappear during listing and maps deletion races safely", async () => {
    const { root, cwd } = await temporaryHistoryRoot();
    const vanishedBeforeRefresh = path.join(root, "vanished.jsonl");
    const deletionRace = path.join(root, "race.jsonl");
    await writeFile(deletionRace, "listed by Pi");

    let liveChecks = 0;
    const history = new SessionHistory({
      listSessions: () =>
        Promise.resolve([
          sessionInfo(vanishedBeforeRefresh, cwd, { id: "vanished" }),
          sessionInfo(deletionRace, cwd, { id: "race" }),
        ]),
      getLiveStatus: ({ id }) => {
        if (id === "race" && ++liveChecks === 2) {
          // realpath admitted the file, then it disappeared before unlink.
          unlinkSync(deletionRace);
        }
        return undefined;
      },
    });

    await expect(history.resolve("vanished")).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_NOT_LISTED,
    });
    await expect(history.delete("race")).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_FILE_MISSING,
    });
  });
});
