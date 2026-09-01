import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";

import { WORKER_MAX_ASSEMBLED_REQUEST_BYTES } from "./worker-protocol.js";

export type WorkerErrorCode =
  | "invalid_arguments" | "not_found" | "permission_denied" | "not_a_file"
  | "not_a_directory" | "already_exists" | "ambiguous_edit"
  | "overlapping_edits" | "content_mismatch" | "output_limit"
  | "timeout" | "cancelled" | "operation_failed" | "operation_not_implemented";

export class WorkerFileSystemError extends Error {
  override readonly name = "WorkerFileSystemError";
  constructor(readonly code: WorkerErrorCode) { super("Sandbox filesystem operation failed"); }
}

export interface WorkerCancellation { readonly cancelled: boolean }
export interface WorkerEdit { readonly oldText: string; readonly newText: string }
export interface WorkerFileMetadata {
  readonly name: string;
  readonly type: "file" | "directory" | "symlink" | "other";
  readonly size: number;
  readonly modifiedMs: number;
}

const GUEST_CWD = "/workspace";
const MAX_OPERATION_RESULT_FRAME_BYTES = 900 * 1024;
const MAX_DIRECTORY_INSPECTIONS = 100_000;
const MAX_EDIT_DISTANCE = 1_024;
const mutationQueues = new Map<string, Promise<void>>();

function checkCancelled(cancellation?: WorkerCancellation): void {
  if (cancellation?.cancelled === true) throw new WorkerFileSystemError("cancelled");
}

function hasMalformedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return true;
  }
  return false;
}

/** Resolve a model path as a path in the synthetic guest root, never as a host translation. */
export function resolveGuestPath(input: string): string {
  if (typeof input !== "string" || input.includes("\0") || hasMalformedUtf16(input)) {
    throw new WorkerFileSystemError("invalid_arguments");
  }
  const stripped = input.startsWith("@") ? input.slice(1) : input;
  return path.posix.isAbsolute(stripped)
    ? path.posix.resolve("/", stripped)
    : path.posix.resolve(GUEST_CWD, stripped || ".");
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code : undefined;
}

export function mapFileSystemError(error: unknown, directory = false): WorkerFileSystemError {
  if (error instanceof WorkerFileSystemError) return error;
  switch (errno(error)) {
    case "ENOENT": return new WorkerFileSystemError("not_found");
    case "EACCES": case "EPERM": case "EROFS": return new WorkerFileSystemError("permission_denied");
    case "EEXIST": return new WorkerFileSystemError("already_exists");
    case "ENOTDIR": return new WorkerFileSystemError(directory ? "not_a_directory" : "not_a_file");
    case "EISDIR": return new WorkerFileSystemError(directory ? "not_a_directory" : "not_a_file");
    default: return new WorkerFileSystemError("operation_failed");
  }
}

/** Existing targets collapse through realpath; new targets inherit their nearest real ancestor. */
export async function canonicalMutationTarget(input: string): Promise<string> {
  const target = resolveGuestPath(input);
  try { return await realpath(target); }
  catch (error) {
    if (errno(error) !== "ENOENT" && errno(error) !== "ENOTDIR") throw mapFileSystemError(error);
  }
  const suffix: string[] = [];
  let ancestor = target;
  while (ancestor !== "/") {
    suffix.unshift(path.posix.basename(ancestor));
    ancestor = path.posix.dirname(ancestor);
    try {
      const canonicalAncestor = await realpath(ancestor);
      return path.posix.join(canonicalAncestor, ...suffix);
    } catch (error) {
      if (errno(error) !== "ENOENT" && errno(error) !== "ENOTDIR") throw mapFileSystemError(error);
    }
  }
  return path.posix.join("/", ...suffix);
}

async function withMutationQueue<T>(target: string, operation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(target) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.catch(() => undefined).then(() => gate);
  mutationQueues.set(target, tail);
  await previous.catch(() => undefined);
  try { return await operation(); }
  finally {
    release();
    if (mutationQueues.get(target) === tail) mutationQueues.delete(target);
  }
}

export function workerMutationQueueCount(): number { return mutationQueues.size; }

function detectMimeType(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && (bytes.toString("ascii", 0, 6) === "GIF87a" || bytes.toString("ascii", 0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return "image/bmp";
  return null;
}

export async function workerReadFile(
  input: { readonly path: string; readonly maxBytes: number; readonly detectMime: boolean },
  cancellation?: WorkerCancellation,
): Promise<{ readonly data: Buffer; readonly mimeType: string | null }> {
  checkCancelled(cancellation);
  const target = resolveGuestPath(input.path);
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new WorkerFileSystemError("not_a_file");
    if (metadata.size > input.maxBytes) throw new WorkerFileSystemError("output_limit");
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      checkCancelled(cancellation);
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, input.maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > input.maxBytes) throw new WorkerFileSystemError("output_limit");
      chunks.push(chunk.subarray(0, bytesRead));
    }
    const data = Buffer.concat(chunks, total);
    return { data, mimeType: input.detectMime ? detectMimeType(data.subarray(0, 16)) : null };
  } catch (error) { throw mapFileSystemError(error); }
  finally { await handle?.close().catch(() => undefined); }
}

async function atomicWrite(target: string, data: Buffer, existingMode?: number): Promise<void> {
  const directory = path.posix.dirname(target);
  let temporary = "";
  let handle;
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      temporary = path.posix.join(directory, `.chatwca-write-${process.pid}-${randomBytes(12).toString("hex")}`);
      try {
        handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, existingMode ?? 0o666);
        break;
      } catch (error) {
        if (errno(error) !== "EEXIST") throw error;
      }
    }
    if (handle === undefined) throw new WorkerFileSystemError("operation_failed");
    let offset = 0;
    while (offset < data.length) {
      const { bytesWritten } = await handle.write(data, offset, data.length - offset, null);
      if (bytesWritten === 0) throw new WorkerFileSystemError("operation_failed");
      offset += bytesWritten;
    }
    await handle.sync();
    await handle.close(); handle = undefined;
    if (existingMode !== undefined) await chmod(temporary, existingMode);
    await rename(temporary, target);
    temporary = "";
  } finally {
    await handle?.close().catch(() => undefined);
    if (temporary !== "") await rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function existingRegularMode(target: string): Promise<number | undefined> {
  try {
    const metadata = await stat(target);
    if (!metadata.isFile()) throw new WorkerFileSystemError("not_a_file");
    return metadata.mode & 0o7777;
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    throw error;
  }
}

export async function workerWriteFile(
  input: { readonly path: string; readonly createParents: boolean },
  data: Buffer,
  cancellation?: WorkerCancellation,
): Promise<{ readonly bytesWritten: number }> {
  if (data.byteLength > WORKER_MAX_ASSEMBLED_REQUEST_BYTES) throw new WorkerFileSystemError("output_limit");
  const target = await canonicalMutationTarget(input.path);
  return withMutationQueue(target, async () => {
    try {
      checkCancelled(cancellation);
      if (input.createParents) await mkdir(path.posix.dirname(target), { recursive: true });
      checkCancelled(cancellation);
      const mode = await existingRegularMode(target);
      await atomicWrite(target, data, mode);
      checkCancelled(cancellation);
      return { bytesWritten: data.byteLength };
    } catch (error) { throw mapFileSystemError(error); }
  });
}

function detectLineEnding(content: string): "\n" | "\r\n" {
  const crlf = content.indexOf("\r\n");
  const lf = content.indexOf("\n");
  return lf !== -1 && crlf !== -1 && crlf < lf ? "\r\n" : "\n";
}
function normalizeToLF(value: string): string { return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }
function restoreLineEndings(value: string, ending: "\n" | "\r\n"): string {
  return ending === "\r\n" ? value.replace(/\n/g, "\r\n") : value;
}
function normalizeForFuzzyMatch(value: string): string {
  return value.normalize("NFKC").split("\n").map((line) => line.trimEnd()).join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}
interface MatchedEdit { readonly editIndex: number; readonly matchIndex: number; readonly matchLength: number; readonly newText: string }
function countOccurrences(content: string, text: string): number {
  const haystack = normalizeForFuzzyMatch(content);
  const needle = normalizeForFuzzyMatch(text);
  let count = 0;
  for (let at = 0; (at = haystack.indexOf(needle, at)) !== -1; at += Math.max(1, needle.length)) count += 1;
  return count;
}
function findText(content: string, oldText: string): { index: number; length: number; fuzzy: boolean } | undefined {
  const exact = content.indexOf(oldText);
  if (exact !== -1) return { index: exact, length: oldText.length, fuzzy: false };
  const normalizedContent = normalizeForFuzzyMatch(content);
  const normalizedText = normalizeForFuzzyMatch(oldText);
  const fuzzy = normalizedContent.indexOf(normalizedText);
  return fuzzy === -1 ? undefined : { index: fuzzy, length: normalizedText.length, fuzzy: true };
}
function lineSpans(content: string): readonly { start: number; end: number }[] {
  let offset = 0;
  return (content.match(/[^\n]*\n|[^\n]+/g) ?? []).map((line) => {
    const span = { start: offset, end: offset + line.length }; offset = span.end; return span;
  });
}
function applyReplacements(content: string, replacements: readonly MatchedEdit[], offset = 0): string {
  let result = content;
  for (let index = replacements.length - 1; index >= 0; index -= 1) {
    const replacement = replacements[index]!;
    const at = replacement.matchIndex - offset;
    result = result.slice(0, at) + replacement.newText + result.slice(at + replacement.matchLength);
  }
  return result;
}
function preserveUnchangedLines(original: string, normalized: string, replacements: readonly MatchedEdit[]): string {
  const originals = original.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const spans = lineSpans(normalized);
  const groups: { start: number; end: number; replacements: MatchedEdit[] }[] = [];
  for (const replacement of replacements) {
    let start = spans.findIndex((span) => replacement.matchIndex >= span.start && replacement.matchIndex < span.end);
    if (start < 0) throw new WorkerFileSystemError("content_mismatch");
    let end = start;
    const replacementEnd = replacement.matchIndex + replacement.matchLength;
    while (end < spans.length && spans[end]!.end < replacementEnd) end += 1;
    if (end >= spans.length) throw new WorkerFileSystemError("content_mismatch");
    end += 1;
    const group = groups.at(-1);
    if (group !== undefined && start < group.end) { group.end = Math.max(group.end, end); group.replacements.push(replacement); }
    else groups.push({ start, end, replacements: [replacement] });
  }
  let originalLine = 0;
  let result = "";
  for (const group of groups) {
    result += originals.slice(originalLine, group.start).join("");
    const startOffset = spans[group.start]!.start;
    const endOffset = spans[group.end - 1]!.end;
    result += applyReplacements(normalized.slice(startOffset, endOffset), group.replacements, startOffset);
    originalLine = group.end;
  }
  return result + originals.slice(originalLine).join("");
}

function applyEdits(content: string, edits: readonly WorkerEdit[]): { base: string; next: string } {
  const normalizedEdits = edits.map((edit) => ({ oldText: normalizeToLF(edit.oldText), newText: normalizeToLF(edit.newText) }));
  if (normalizedEdits.some((edit) => edit.oldText.length === 0)) throw new WorkerFileSystemError("invalid_arguments");
  const fuzzy = normalizedEdits.some((edit) => findText(content, edit.oldText)?.fuzzy === true);
  const replacementBase = fuzzy ? normalizeForFuzzyMatch(content) : content;
  const matches: MatchedEdit[] = normalizedEdits.map((edit, editIndex) => {
    const found = findText(replacementBase, edit.oldText);
    if (found === undefined) throw new WorkerFileSystemError("content_mismatch");
    if (countOccurrences(replacementBase, edit.oldText) > 1) throw new WorkerFileSystemError("ambiguous_edit");
    return { editIndex, matchIndex: found.index, matchLength: found.length, newText: edit.newText };
  }).sort((left, right) => left.matchIndex - right.matchIndex);
  for (let index = 1; index < matches.length; index += 1) {
    const previous = matches[index - 1]!; const current = matches[index]!;
    if (previous.matchIndex + previous.matchLength > current.matchIndex) throw new WorkerFileSystemError("overlapping_edits");
  }
  const next = fuzzy ? preserveUnchangedLines(content, replacementBase, matches) : applyReplacements(replacementBase, matches);
  if (next === content) throw new WorkerFileSystemError("content_mismatch");
  return { base: content, next };
}

type DiffPart = { readonly value: string; readonly added?: true; readonly removed?: true };
function splitLines(value: string): string[] { return value.match(/[^\n]*\n|[^\n]+/g) ?? []; }
function lineDiff(oldContent: string, newContent: string): DiffPart[] {
  const oldLines = splitLines(oldContent); const newLines = splitLines(newContent);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  // Do not greedily trim a common suffix: jsdiff's tie-breaking aligns an
  // earlier duplicate in the new side, which affects both display and hunks.
  const oldEnd = oldLines.length; const newEnd = newLines.length;
  const left = oldLines.slice(prefix); const right = newLines.slice(prefix);
  const operations: DiffPart[] = [];
  const append = (part: DiffPart) => {
    const prior = operations.at(-1);
    if (prior !== undefined && prior.added === part.added && prior.removed === part.removed) {
      operations[operations.length - 1] = { ...prior, value: prior.value + part.value };
    } else operations.push(part);
  };
  for (let index = 0; index < prefix; index += 1) append({ value: oldLines[index]! });
  if (left.length * right.length <= 4_000_000) {
    const width = right.length + 1;
    const table = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i -= 1) for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[i] === right[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
    let i = 0; let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { append({ value: left[i]! }); i += 1; j += 1; }
      else if (i < left.length && (j === right.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) { append({ value: left[i]!, removed: true }); i += 1; }
      else { append({ value: right[j]!, added: true }); j += 1; }
    }
  } else {
    // Large files with small targeted changes must not degrade into a giant
    // replacement. Myers keeps those cases linear in file length and bounded
    // in edit distance; a no-common-line replacement is handled directly.
    const rightValues = new Set(right);
    if (!left.some((line) => rightValues.has(line))) {
      for (const line of left) append({ value: line, removed: true });
      for (const line of right) append({ value: line, added: true });
    } else {
      const maximumDistance = Math.min(left.length + right.length, MAX_EDIT_DISTANCE);
      let frontier = new Map<number, number>([[1, 0]]);
      const trace: Map<number, number>[] = [];
      let completed = false;
      for (let distance = 0; distance <= maximumDistance && !completed; distance += 1) {
        trace.push(new Map(frontier));
        const next = new Map<number, number>();
        for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
          const down = frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
          const across = frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
          let x = diagonal === -distance || (diagonal !== distance && across < down) ? down : across + 1;
          if (!Number.isFinite(x)) x = 0;
          let y = x - diagonal;
          while (x < left.length && y < right.length && left[x] === right[y]) { x += 1; y += 1; }
          next.set(diagonal, x);
          if (x >= left.length && y >= right.length) { completed = true; break; }
        }
        frontier = next;
      }
      if (!completed) {
        // Do not return an approximate diff or mutate when exact bounded diff
        // computation would exceed the worker's edit-distance budget.
        throw new WorkerFileSystemError("output_limit");
      } else {
        const reversed: DiffPart[] = []; let x = left.length; let y = right.length;
        for (let distance = trace.length - 1; distance >= 0; distance -= 1) {
          const prior = trace[distance]!; const diagonal = x - y;
          const down = prior.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY;
          const across = prior.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY;
          const previousDiagonal = diagonal === -distance || (diagonal !== distance && across < down) ? diagonal + 1 : diagonal - 1;
          const previousX = prior.get(previousDiagonal) ?? 0; const previousY = previousX - previousDiagonal;
          while (x > previousX && y > previousY) { reversed.push({ value: left[x - 1]! }); x -= 1; y -= 1; }
          if (distance === 0) break;
          if (x === previousX) { reversed.push({ value: right[y - 1]!, added: true }); y -= 1; }
          else { reversed.push({ value: left[x - 1]!, removed: true }); x -= 1; }
        }
        for (const part of reversed.reverse()) append(part);
      }
    }
  }
  // Present every adjacent replacement as removals followed by additions,
  // matching jsdiff's line-oriented output normalization.
  const normalized: DiffPart[] = [];
  const push = (part: DiffPart) => {
    const prior = normalized.at(-1);
    if (prior !== undefined && prior.added === part.added && prior.removed === part.removed) normalized[normalized.length - 1] = { ...prior, value: prior.value + part.value };
    else normalized.push(part);
  };
  for (let index = 0; index < operations.length;) {
    if (!operations[index]!.added && !operations[index]!.removed) { push(operations[index]!); index += 1; continue; }
    let removed = ""; let added = "";
    while (index < operations.length && (operations[index]!.added || operations[index]!.removed)) {
      const part = operations[index]!; if (part.removed) removed += part.value; else added += part.value; index += 1;
    }
    if (removed !== "") push({ value: removed, removed: true });
    if (added !== "") push({ value: added, added: true });
  }
  return normalized;
}

function generateDiffString(oldContent: string, newContent: string, context = 4): { diff: string; firstChangedLine: number } {
  const parts = lineDiff(oldContent, newContent); const output: string[] = [];
  const width = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length;
  let oldLine = 1; let newLine = 1; let lastChanged = false; let firstChangedLine: number | undefined;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index]!; const lines = part.value.split("\n"); if (lines.at(-1) === "") lines.pop();
    if (part.added || part.removed) {
      firstChangedLine ??= newLine;
      for (const line of lines) {
        if (part.added) { output.push(`+${String(newLine).padStart(width, " ")} ${line}`); newLine += 1; }
        else { output.push(`-${String(oldLine).padStart(width, " ")} ${line}`); oldLine += 1; }
      }
      lastChanged = true;
    } else {
      const nextChanged = index + 1 < parts.length && (parts[index + 1]!.added || parts[index + 1]!.removed);
      let selected: number[] = [];
      if (lastChanged && nextChanged) selected = lines.length <= context * 2 ? lines.map((_, i) => i) : [...lines.slice(0, context).map((_, i) => i), ...lines.slice(-context).map((_, i) => lines.length - context + i)];
      else if (lastChanged) selected = lines.slice(0, context).map((_, i) => i);
      else if (nextChanged) selected = lines.slice(Math.max(0, lines.length - context)).map((_, i) => Math.max(0, lines.length - context) + i);
      let cursor = 0;
      for (const selectedIndex of selected) {
        if (selectedIndex > cursor && (cursor > 0 || selectedIndex - cursor > 0)) output.push(` ${"".padStart(width, " ")} ...`);
        oldLine += selectedIndex - cursor; newLine += selectedIndex - cursor;
        output.push(` ${String(oldLine).padStart(width, " ")} ${lines[selectedIndex]}`); oldLine += 1; newLine += 1; cursor = selectedIndex + 1;
      }
      if (selected.length === 0) { oldLine += lines.length; newLine += lines.length; }
      else if (cursor < lines.length) { if (lastChanged) output.push(` ${"".padStart(width, " ")} ...`); oldLine += lines.length - cursor; newLine += lines.length - cursor; }
      lastChanged = false;
    }
  }
  return { diff: output.join("\n"), firstChangedLine: firstChangedLine ?? 1 };
}

interface PatchLine { readonly prefix: " " | "+" | "-"; readonly text: string; readonly newline: boolean; readonly oldBefore: number; readonly newBefore: number }
function generateUnifiedPatch(filePath: string, oldContent: string, newContent: string, context = 4): string {
  const records: PatchLine[] = []; let oldLine = 1; let newLine = 1;
  for (const part of lineDiff(oldContent, newContent)) {
    for (const token of splitLines(part.value)) {
      const prefix = part.added ? "+" : part.removed ? "-" : " ";
      records.push({ prefix, text: token.endsWith("\n") ? token.slice(0, -1) : token, newline: token.endsWith("\n"), oldBefore: oldLine, newBefore: newLine });
      if (!part.added) oldLine += 1; if (!part.removed) newLine += 1;
    }
  }
  const changes = records.map((record, index) => record.prefix === " " ? -1 : index).filter((index) => index >= 0);
  const ranges: { start: number; end: number }[] = [];
  for (const changed of changes) {
    const start = Math.max(0, changed - context); const end = Math.min(records.length, changed + context + 1); const last = ranges.at(-1);
    if (last !== undefined && start <= last.end) last.end = Math.max(last.end, end); else ranges.push({ start, end });
  }
  let patch = `--- ${filePath}\n+++ ${filePath}\n`;
  for (const range of ranges) {
    const slice = records.slice(range.start, range.end); const first = slice[0]!;
    const oldCount = slice.filter((line) => line.prefix !== "+").length; const newCount = slice.filter((line) => line.prefix !== "-").length;
    const oldStart = oldCount === 0 ? first.oldBefore - 1 : first.oldBefore; const newStart = newCount === 0 ? first.newBefore - 1 : first.newBefore;
    patch += `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@\n`;
    for (const line of slice) { patch += `${line.prefix}${line.text}\n`; if (!line.newline) patch += "\\ No newline at end of file\n"; }
  }
  return patch;
}

export async function workerEditFile(
  input: { readonly path: string; readonly edits: readonly WorkerEdit[] },
  cancellation?: WorkerCancellation,
): Promise<{ readonly diff: string; readonly patch: string; readonly firstChangedLine: number }> {
  const target = await canonicalMutationTarget(input.path);
  return withMutationQueue(target, async () => {
    try {
      checkCancelled(cancellation);
      const metadata = await stat(target);
      if (!metadata.isFile()) throw new WorkerFileSystemError("not_a_file");
      if (metadata.size > WORKER_MAX_ASSEMBLED_REQUEST_BYTES) throw new WorkerFileSystemError("output_limit");
      const raw = await readFile(target);
      if (raw.byteLength > WORKER_MAX_ASSEMBLED_REQUEST_BYTES) throw new WorkerFileSystemError("output_limit");
      checkCancelled(cancellation);
      const text = raw.toString("utf8"); const bom = text.startsWith("\ufeff") ? "\ufeff" : ""; const withoutBom = bom === "" ? text : text.slice(1);
      const ending = detectLineEnding(withoutBom); const normalized = normalizeToLF(withoutBom);
      const { base, next } = applyEdits(normalized, input.edits);
      const generated = generateDiffString(base, next); const patch = generateUnifiedPatch(input.path, base, next);
      if (Buffer.byteLength(JSON.stringify({ diff: generated.diff, patch, firstChangedLine: generated.firstChangedLine })) > MAX_OPERATION_RESULT_FRAME_BYTES) {
        throw new WorkerFileSystemError("output_limit");
      }
      checkCancelled(cancellation);
      await atomicWrite(target, Buffer.from(bom + restoreLineEndings(next, ending), "utf8"), metadata.mode & 0o7777);
      checkCancelled(cancellation);
      return { diff: generated.diff, patch, firstChangedLine: generated.firstChangedLine };
    } catch (error) { throw mapFileSystemError(error); }
  });
}

export async function workerListDirectory(
  input: { readonly path: string; readonly includeHidden: boolean; readonly limit: number },
  cancellation?: WorkerCancellation,
): Promise<{ readonly entries: readonly WorkerFileMetadata[]; readonly truncated: boolean }> {
  checkCancelled(cancellation);
  const target = resolveGuestPath(input.path);
  const names: string[] = []; let inspected = 0; let truncated = false;
  let directory;
  try {
    const metadata = await stat(target); if (!metadata.isDirectory()) throw new WorkerFileSystemError("not_a_directory");
    directory = await opendir(target);
    for await (const entry of directory) {
      checkCancelled(cancellation); inspected += 1;
      if (inspected > MAX_DIRECTORY_INSPECTIONS) { truncated = true; break; }
      if (!input.includeHidden && entry.name.startsWith(".")) continue;
      names.push(entry.name);
    }
    names.sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()) || left.localeCompare(right));
    if (names.length > input.limit) truncated = true;
    const entries: WorkerFileMetadata[] = [];
    let resultBytes = 64;
    for (const name of names.slice(0, input.limit)) {
      checkCancelled(cancellation);
      try {
        const details = await lstat(path.posix.join(target, name));
        const entry = {
          name,
          type: details.isSymbolicLink() ? "symlink" as const : details.isFile() ? "file" as const : details.isDirectory() ? "directory" as const : "other" as const,
          size: Math.max(0, details.size),
          modifiedMs: Math.max(0, details.mtimeMs),
        };
        const entryBytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
        if (resultBytes + entryBytes > MAX_OPERATION_RESULT_FRAME_BYTES) { truncated = true; break; }
        resultBytes += entryBytes; entries.push(entry);
      } catch { /* entries removed concurrently are omitted */ }
    }
    return { entries, truncated };
  } catch (error) { throw mapFileSystemError(error, true); }
  finally { await directory?.close().catch(() => undefined); }
}
