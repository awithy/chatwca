import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createEditToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import {
  WorkerFileSystemError,
  canonicalMutationTarget,
  resolveGuestPath,
  workerEditFile,
  workerListDirectory,
  workerMutationQueueCount,
  workerReadFile,
  workerWriteFile,
} from "../../src/server/sandbox/worker-fs.js";

const temporaryDirectories: string[] = [];
async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "chatwca-worker-fs-"));
  temporaryDirectories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function expectCode(promise: Promise<unknown>, code: WorkerFileSystemError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ name: "WorkerFileSystemError", code });
}

describe("sandbox worker guest paths", () => {
  it("uses synthetic-root semantics, strips exactly one @, and never translates to a host workspace", () => {
    expect(resolveGuestPath("file.txt")).toBe("/workspace/file.txt");
    expect(resolveGuestPath("@dir/file.txt")).toBe("/workspace/dir/file.txt");
    expect(resolveGuestPath("@@dir/file.txt")).toBe("/workspace/@dir/file.txt");
    expect(resolveGuestPath("../etc/passwd")).toBe("/etc/passwd");
    expect(resolveGuestPath("/home/sandbox/file")).toBe("/home/sandbox/file");
    expect(resolveGuestPath("/workspace/../../etc/passwd")).toBe("/etc/passwd");
    expect(() => resolveGuestPath("bad\0path")).toThrow(WorkerFileSystemError);
    expect(() => resolveGuestPath("\ud800")).toThrow(WorkerFileSystemError);
  });

  it("canonicalizes existing symlink aliases and a new target's nearest existing ancestor", async () => {
    const directory = await temporaryDirectory();
    const real = path.join(directory, "real");
    await mkdir(real);
    await writeFile(path.join(real, "file"), "x");
    await symlink(real, path.join(directory, "alias"));
    expect(await canonicalMutationTarget(path.join(directory, "alias", "file"))).toBe(path.join(real, "file"));
    expect(await canonicalMutationTarget(path.join(directory, "alias", "new", "file"))).toBe(path.join(real, "new", "file"));
  });
});

describe("bounded sandbox worker file operations", () => {
  it("reads bounded regular files and detects image MIME types from signatures, not names", async () => {
    const directory = await temporaryDirectory();
    const image = path.join(directory, "not-an-image.txt");
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("payload")]);
    await writeFile(image, png);
    const result = await workerReadFile({ path: image, maxBytes: png.length, detectMime: true });
    expect(result).toEqual({ data: png, mimeType: "image/png" });
    await expectCode(workerReadFile({ path: image, maxBytes: png.length - 1, detectMime: true }), "output_limit");
    await expectCode(workerReadFile({ path: directory, maxBytes: 100, detectMime: false }), "not_a_file");
  });

  it("rejects non-regular inputs without blocking on a FIFO", async () => {
    if (process.platform !== "linux") return;
    const directory = await temporaryDirectory();
    const fifo = path.join(directory, "fifo");
    const { spawnSync } = await import("node:child_process");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    await expectCode(workerReadFile({ path: fifo, maxBytes: 100, detectMime: false }), "not_a_file");
  });

  it("writes atomically, creates parents, preserves modes, and leaves no temporary files", async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, "nested", "file.txt");
    await workerWriteFile({ path: target, createParents: true }, Buffer.from("first"));
    await chmod(target, 0o640);
    await workerWriteFile({ path: target, createParents: true }, Buffer.from("second"));
    expect(await readFile(target, "utf8")).toBe("second");
    expect((await lstat(target)).mode & 0o777).toBe(0o640);
    expect((await workerListDirectory({ path: path.dirname(target), includeHidden: true, limit: 100 })).entries.map((entry) => entry.name)).toEqual(["file.txt"]);
  });

  it("lists sorted, bounded metadata without following entry symlinks", async () => {
    const directory = await temporaryDirectory();
    await writeFile(path.join(directory, "b"), "bb");
    await writeFile(path.join(directory, "A"), "a");
    await writeFile(path.join(directory, ".hidden"), "h");
    await mkdir(path.join(directory, "dir"));
    await symlink("b", path.join(directory, "link"));
    const visible = await workerListDirectory({ path: directory, includeHidden: false, limit: 3 });
    expect(visible.truncated).toBe(true);
    expect(visible.entries.map(({ name, type }) => [name, type])).toEqual([
      ["A", "file"], ["b", "file"], ["dir", "directory"],
    ]);
    const all = await workerListDirectory({ path: directory, includeHidden: true, limit: 10 });
    expect(all.entries.find((entry) => entry.name === "link")?.type).toBe("symlink");
  });
});

describe("Pi-compatible sandbox edits", () => {
  it("matches Pi 0.84.3 diff, patch, first line, BOM, CRLF, fuzzy matching, and permissions", async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, "fixture.txt");
    const original = "\ufeffone  \r\ntwo\r\nthree\r\n";
    const edits = [{ oldText: "one\ntwo", newText: "ONE\nTWO" }];
    await writeFile(target, original);
    await chmod(target, 0o604);

    const piTarget = path.join(directory, "pi.txt");
    await writeFile(piTarget, original);
    const pi = createEditToolDefinition(directory);
    const piResult = await pi.execute("call", { path: "pi.txt", edits }, undefined, undefined, undefined);
    const result = await workerEditFile({ path: target, edits });

    // Patch labels are intentionally the guest path supplied to each operation.
    expect(result.diff).toBe(piResult.details?.diff);
    expect(result.patch.replaceAll(target, "pi.txt")).toBe(piResult.details?.patch);
    expect(result.firstChangedLine).toBe(piResult.details?.firstChangedLine);
    expect(await readFile(target, "utf8")).toBe("\ufeffONE\r\nTWO\r\nthree\r\n");
    expect((await lstat(target)).mode & 0o777).toBe(0o604);
  });

  it("matches Pi's duplicate-line alignment in diff and unified patch output", async () => {
    const directory = await temporaryDirectory();
    const original = "start\nduplicate\ntarget\nduplicate\nend\n";
    const edits = [{ oldText: "target", newText: "changed\nduplicate" }];
    const piPath = path.join(directory, "pi.txt"); const workerPath = path.join(directory, "worker.txt");
    await Promise.all([writeFile(piPath, original), writeFile(workerPath, original)]);
    const piResult = await createEditToolDefinition(directory).execute("call", { path: "pi.txt", edits }, undefined, undefined, undefined);
    const workerResult = await workerEditFile({ path: workerPath, edits });
    expect(workerResult.diff).toBe(piResult.details?.diff);
    expect(workerResult.patch.replaceAll(workerPath, "pi.txt")).toBe(piResult.details?.patch);
  });

  it("keeps Pi-compatible output for a small edit in a large file", async () => {
    const directory = await temporaryDirectory();
    const original = Array.from({ length: 3_500 }, (_, index) => `line-${String(index).padStart(5, "0")}`).join("\n") + "\n";
    const edits = [{ oldText: "line-00001", newText: "changed" }];
    const piPath = path.join(directory, "pi-large.txt"); const workerPath = path.join(directory, "worker-large.txt");
    await Promise.all([writeFile(piPath, original), writeFile(workerPath, original)]);
    const piResult = await createEditToolDefinition(directory).execute("call", { path: "pi-large.txt", edits }, undefined, undefined, undefined);
    const workerResult = await workerEditFile({ path: workerPath, edits });
    expect(workerResult.diff).toBe(piResult.details?.diff);
    expect(workerResult.patch.replaceAll(workerPath, "pi-large.txt")).toBe(piResult.details?.patch);
  });

  it("validates every edit against original content and never partially writes", async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, "file.txt");
    const original = "alpha\nbeta\ngamma\n";
    await writeFile(target, original);
    await expectCode(workerEditFile({ path: target, edits: [
      { oldText: "alpha", newText: "ALPHA" },
      { oldText: "missing", newText: "MISSING" },
    ] }), "content_mismatch");
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it.each([
    ["empty oldText", [{ oldText: "", newText: "x" }], "invalid_arguments"],
    ["ambiguous match", [{ oldText: "same", newText: "x" }], "ambiguous_edit"],
    ["overlap", [{ oldText: "same middle", newText: "x" }, { oldText: "middle", newText: "y" }], "overlapping_edits"],
    ["identical output", [{ oldText: "middle", newText: "middle" }], "content_mismatch"],
  ] as const)("rejects %s without writing", async (_name, edits, code) => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, "file.txt");
    const original = "same middle same";
    await writeFile(target, original);
    await expectCode(workerEditFile({ path: target, edits }), code);
    expect(await readFile(target, "utf8")).toBe(original);
  });

  it("serializes direct and symlink-alias mutations by one canonical target and removes idle queues", async () => {
    const directory = await temporaryDirectory();
    const target = path.join(directory, "file.txt");
    const alias = path.join(directory, "alias.txt");
    await writeFile(target, "one\n");
    await symlink(target, alias);
    const first = workerEditFile({ path: alias, edits: [{ oldText: "one", newText: "two" }] });
    // Preserve call order while canonicalization of the first alias is in flight.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = workerEditFile({ path: target, edits: [{ oldText: "two", newText: "three" }] });
    await Promise.all([first, second]);
    expect(await readFile(target, "utf8")).toBe("three\n");
    expect(workerMutationQueueCount()).toBe(0);
  });
});
