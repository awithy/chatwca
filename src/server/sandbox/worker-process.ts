import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, openSync, readdirSync, unlinkSync, writeSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { TextDecoder } from "node:util";

import { WorkerFileSystemError, mapFileSystemError, resolveGuestPath, type WorkerCancellation } from "./worker-fs.js";

const PI_MAX_BYTES = 50 * 1024;
const PI_MAX_LINES = 2_000;
const GREP_MAX_LINE_LENGTH = 500;
const PRIVATE_STDERR_LIMIT = 16 * 1024;
const RG_MAX_JSON_COLUMN = 4_096;
const SEARCH_COLLECTION_LIMIT = 1024 * 1024;
const CONTEXT_READ_LIMIT = 16 * 1024 * 1024;

export interface WorkerTruncation {
  readonly truncated: boolean;
  readonly truncatedBy: "lines" | "bytes" | null;
  readonly totalLines: number;
  readonly totalBytes: number;
  readonly outputLines: number;
  readonly outputBytes: number;
  readonly lastLinePartial: boolean;
  readonly firstLineExceedsLimit: boolean;
  readonly maxLines: number;
  readonly maxBytes: number;
}
export interface WorkerGrepResult {
  readonly text: string;
  readonly matches: number;
  readonly truncated: boolean;
  readonly matchLimitReached?: number;
  readonly linesTruncated?: boolean;
  readonly truncation?: WorkerTruncation;
}
export interface WorkerFindResult {
  readonly paths: readonly string[];
  readonly text?: string;
  readonly truncated: boolean;
  readonly resultLimitReached?: number;
  readonly truncation?: WorkerTruncation;
}
export interface WorkerExecResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: false;
  readonly fullOutputPath: string | null;
}

export class FatalWorkerProcessError extends Error {
  override readonly name = "FatalWorkerProcessError";
}

function checkCancelled(cancellation?: WorkerCancellation): void {
  if (cancellation?.cancelled === true) throw new WorkerFileSystemError("cancelled");
}
function splitLines(content: string): string[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}
function truncateHead(content: string, maxLines = PI_MAX_LINES, maxBytes = PI_MAX_BYTES): { content: string; details: WorkerTruncation } {
  const lines = splitLines(content); const totalBytes = Buffer.byteLength(content); const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) return { content, details: {
    truncated: false, truncatedBy: null, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes,
    lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes,
  } };
  if (lines.length !== 0 && Buffer.byteLength(lines[0]!) > maxBytes) return { content: "", details: {
    truncated: true, truncatedBy: "bytes", totalLines, totalBytes, outputLines: 0, outputBytes: 0,
    lastLinePartial: false, firstLineExceedsLimit: true, maxLines, maxBytes,
  } };
  const selected: string[] = []; let measured = 0; let truncatedBy: "lines" | "bytes" = "lines";
  for (let index = 0; index < lines.length && index < maxLines; index += 1) {
    const bytes = Buffer.byteLength(lines[index]!) + (index > 0 ? 1 : 0);
    if (measured + bytes > maxBytes) { truncatedBy = "bytes"; break; }
    selected.push(lines[index]!); measured += bytes;
  }
  if (selected.length >= maxLines && measured <= maxBytes) truncatedBy = "lines";
  const output = selected.join("\n");
  return { content: output, details: {
    truncated: true, truncatedBy, totalLines, totalBytes, outputLines: selected.length, outputBytes: Buffer.byteLength(output),
    lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes,
  } };
}
function size(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
function truncateLine(line: string): { text: string; truncated: boolean } {
  return line.length <= GREP_MAX_LINE_LENGTH
    ? { text: line, truncated: false }
    : { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}... [truncated]`, truncated: true };
}
function appendBounded(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString();
  return next.length <= PRIVATE_STDERR_LIMIT ? next : next.slice(-PRIVATE_STDERR_LIMIT);
}
function stop(child: ChildProcess): void {
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
}

async function runRg(
  args: readonly string[],
  cwd: string,
  cancellation: WorkerCancellation | undefined,
  onLine: (line: string, child: ChildProcess) => void,
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }> {
  checkCancelled(cancellation);
  return new Promise((resolve, reject) => {
    const child = spawn("rg", args, { cwd, env: process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = ""; let settled = false;
    const lines = createInterface({ input: child.stdout! });
    const cancellationPoll = setInterval(() => { if (cancellation?.cancelled === true) stop(child); }, 10);
    lines.on("line", (line) => {
      if (cancellation?.cancelled === true) { stop(child); return; }
      try { onLine(line, child); } catch (error) { stop(child); reject(error); }
    });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (error) => { if (!settled) { settled = true; clearInterval(cancellationPoll); lines.close(); reject(error); } });
    child.once("close", (code, signal) => {
      if (settled) return; settled = true; clearInterval(cancellationPoll); lines.close();
      if (cancellation?.cancelled === true) { reject(new WorkerFileSystemError("cancelled")); return; }
      resolve({ code, signal, stderr });
    });
  });
}

function rgText(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("text" in value)) return undefined;
  return typeof (value as { text?: unknown }).text === "string" ? (value as { text: string }).text : undefined;
}
function matchesGuestGlob(candidate: string, pattern: string): boolean {
  if (pattern === "") return true;
  const negated = pattern.startsWith("!"); const effective = negated ? pattern.slice(1) : pattern;
  const normalized = candidate.replaceAll("\\", "/");
  const subject = effective.includes("/") ? normalized : path.posix.basename(normalized);
  // rg's --hidden plus positive globs allow '*' to match a leading dot.
  const withoutHiddenDots = subject.split("/").map((segment) => segment.startsWith(".") ? segment.slice(1) : segment).join("/");
  const matched = path.posix.matchesGlob(subject, effective) || path.posix.matchesGlob(withoutHiddenDots, effective);
  return negated ? !matched : matched;
}

export async function workerGrep(
  input: { readonly path: string; readonly pattern: string; readonly literal: boolean; readonly caseSensitive: boolean; readonly includeHidden: boolean; readonly glob?: string; readonly context: number; readonly limit: number },
  cancellation?: WorkerCancellation,
): Promise<WorkerGrepResult> {
  const target = resolveGuestPath(input.path);
  try {
    const metadata = await stat(target);
    if (!metadata.isFile() && !metadata.isDirectory()) throw new WorkerFileSystemError("not_a_file");
  } catch (error) { throw mapFileSystemError(error); }
  const args = ["--json", "--line-number", "--color=never", `--max-columns=${RG_MAX_JSON_COLUMN}`, "--max-columns-preview"];
  if (!input.caseSensitive) args.push("--ignore-case");
  if (input.literal) args.push("--fixed-strings");
  if (input.includeHidden) args.push("--hidden");
  // Positive rg globs override .gitignore. Filter JSON matches ourselves so
  // model globs can never accidentally re-include ignored files.
  args.push("--", input.pattern, target);
  const found: { filePath: string; lineNumber: number; lineText?: string }[] = [];
  let reached = false; let collectionTruncated = false; let collectedBytes = 0;
  let result;
  try {
    result = await runRg(args, "/workspace", cancellation, (line, child) => {
      if (found.length >= input.limit) return;
      let event: unknown;
      try { event = JSON.parse(line) as unknown; } catch { throw new WorkerFileSystemError("operation_failed"); }
      if (typeof event !== "object" || event === null || (event as { type?: unknown }).type !== "match") return;
      const data = (event as { data?: unknown }).data;
      if (typeof data !== "object" || data === null) throw new WorkerFileSystemError("operation_failed");
      const filePath = rgText((data as { path?: unknown }).path);
      const lineText = rgText((data as { lines?: unknown }).lines);
      const lineNumber = (data as { line_number?: unknown }).line_number;
      if (filePath === undefined || typeof lineNumber !== "number" || !Number.isSafeInteger(lineNumber)) throw new WorkerFileSystemError("operation_failed");
      const relativeFile = path.posix.relative(target, filePath) || path.posix.basename(filePath);
      if (input.glob !== undefined && !matchesGuestGlob(relativeFile, input.glob)) return;
      found.push({ filePath, lineNumber, ...(lineText === undefined ? {} : { lineText }) });
      collectedBytes += Buffer.byteLength(filePath) + Buffer.byteLength(lineText ?? "") + 32;
      if (collectedBytes > SEARCH_COLLECTION_LIMIT) { collectionTruncated = true; stop(child); }
      else if (found.length >= input.limit) { reached = true; stop(child); }
    });
  } catch (error) { throw mapFileSystemError(error); }
  if (!reached && result.code !== 0 && result.code !== 1) throw new WorkerFileSystemError("operation_failed");
  if (found.length === 0) return { text: "No matches found", matches: 0, truncated: false };

  let linesTruncated = false; let contextBytes = 0; let formattedBytes = 0;
  const outputLines: string[] = []; const cache = new Map<string, string[]>();
  const appendOutput = (line: string): boolean => {
    formattedBytes += Buffer.byteLength(line) + (outputLines.length === 0 ? 0 : 1);
    if (formattedBytes > SEARCH_COLLECTION_LIMIT) { collectionTruncated = true; return false; }
    outputLines.push(line); return true;
  };
  const formatPath = (candidate: string): string => {
    const relative = path.posix.relative(target, candidate);
    return relative !== "" && !relative.startsWith("..") ? relative : path.posix.basename(candidate);
  };
  matches: for (const match of found) {
    checkCancelled(cancellation);
    const displayPath = formatPath(match.filePath);
    if (input.context === 0 && match.lineText !== undefined) {
      const line = truncateLine(match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, ""));
      linesTruncated ||= line.truncated;
      if (!appendOutput(`${displayPath}:${match.lineNumber}: ${line.text}`)) break;
      continue;
    }
    let fileLines = cache.get(match.filePath);
    if (fileLines === undefined) {
      try {
        const metadata = await stat(match.filePath);
        if (metadata.size > CONTEXT_READ_LIMIT || contextBytes + metadata.size > CONTEXT_READ_LIMIT) throw new Error("context bound");
        const content = await readFile(match.filePath, "utf8"); contextBytes += Buffer.byteLength(content);
        fileLines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
      } catch { fileLines = []; }
      cache.set(match.filePath, fileLines);
    }
    if (fileLines.length === 0) {
      if (!appendOutput(`${displayPath}:${match.lineNumber}: (unable to read file)`)) break;
      continue;
    }
    const start = Math.max(1, match.lineNumber - input.context); const end = Math.min(fileLines.length, match.lineNumber + input.context);
    for (let current = start; current <= end; current += 1) {
      const line = truncateLine((fileLines[current - 1] ?? "").replace(/\r/g, "")); linesTruncated ||= line.truncated;
      if (!appendOutput(current === match.lineNumber ? `${displayPath}:${current}: ${line.text}` : `${displayPath}-${current}- ${line.text}`)) break matches;
    }
  }
  const truncated = truncateHead(outputLines.join("\n"), Number.MAX_SAFE_INTEGER);
  let text = truncated.content; const notices: string[] = [];
  if (reached) notices.push(`${input.limit} matches limit reached. Use limit=${input.limit * 2} for more, or refine pattern`);
  if (truncated.details.truncated || collectionTruncated) notices.push(`${size(PI_MAX_BYTES)} limit reached`);
  if (linesTruncated) notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
  if (notices.length !== 0) text += `\n\n[${notices.join(". ")}]`;
  return {
    text, matches: found.length, truncated: reached || truncated.details.truncated || collectionTruncated || linesTruncated,
    ...(reached ? { matchLimitReached: input.limit } : {}),
    ...(linesTruncated ? { linesTruncated: true } : {}),
    ...(truncated.details.truncated || collectionTruncated ? { truncation: { ...truncated.details, truncated: true, truncatedBy: "bytes" as const } } : {}),
  };
}

export async function workerFind(
  input: { readonly path: string; readonly glob: string; readonly includeHidden: boolean; readonly limit: number },
  cancellation?: WorkerCancellation,
): Promise<WorkerFindResult> {
  const target = resolveGuestPath(input.path);
  try { if (!(await stat(target)).isDirectory()) throw new WorkerFileSystemError("not_a_directory"); }
  catch (error) { throw mapFileSystemError(error, true); }
  const args = ["--files", "--color=never", "--glob", "!node_modules/**", "--glob", "!.git/**"];
  if (input.includeHidden) args.push("--hidden");
  const paths: string[] = []; let reached = false; let collectionTruncated = false; let collectedBytes = 0;
  let result;
  try {
    result = await runRg(args, target, cancellation, (line, child) => {
      const normalized = line.replace(/\r$/, "").replaceAll("\\", "/");
      if (normalized === "") return;
      const relative = normalized.startsWith("./") ? normalized.slice(2) : normalized;
      if (!matchesGuestGlob(relative, input.glob)) return;
      collectedBytes += Buffer.byteLength(relative) + (paths.length === 0 ? 0 : 1);
      if (collectedBytes > SEARCH_COLLECTION_LIMIT) { collectionTruncated = true; stop(child); return; }
      paths.push(relative);
      if (paths.length >= input.limit) { reached = true; stop(child); }
    });
  } catch (error) { throw mapFileSystemError(error, true); }
  if (!reached && result.code !== 0 && result.code !== 1) throw new WorkerFileSystemError("operation_failed");
  if (paths.length === 0) return { paths: [], text: "No files found matching pattern", truncated: false };
  const truncation = truncateHead(paths.join("\n"), Number.MAX_SAFE_INTEGER);
  const selected = truncation.content === "" ? [] : truncation.content.split("\n");
  const notices: string[] = [];
  if (reached) notices.push(`${input.limit} results limit reached. Use limit=${input.limit * 2} for more, or refine pattern`);
  if (truncation.details.truncated || collectionTruncated) notices.push(`${size(PI_MAX_BYTES)} limit reached`);
  let text = truncation.content; if (notices.length !== 0) text += `\n\n[${notices.join(". ")}]`;
  return {
    paths: selected, text, truncated: reached || truncation.details.truncated || collectionTruncated,
    ...(reached ? { resultLimitReached: input.limit } : {}),
    ...(truncation.details.truncated || collectionTruncated ? { truncation: { ...truncation.details, truncated: true, truncatedBy: "bytes" as const } } : {}),
  };
}

function namespacePids(): number[] {
  return readdirSync("/proc", { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((pid) => pid !== 1 && pid !== process.pid);
}
function signalNamespacePids(signal: NodeJS.Signals): void {
  for (const pid of namespacePids()) { try { process.kill(pid, signal); } catch { /* raced exit */ } }
}
async function waitForCleanNamespace(milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (namespacePids().length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return namespacePids().length === 0;
}
export async function cleanCommandDescendants(): Promise<void> {
  signalNamespacePids("SIGTERM");
  if (await waitForCleanNamespace(150)) return;
  signalNamespacePids("SIGKILL");
  if (!(await waitForCleanNamespace(500))) throw new FatalWorkerProcessError("command descendants survived cleanup");
}

export async function workerExec(
  input: { readonly command: string; readonly timeoutMs: number },
  limits: { readonly commandTimeoutMs: number; readonly maxCommandOutputBytes: number },
  emit: (stream: "stdout" | "stderr", data: string) => void,
  cancellation?: WorkerCancellation,
): Promise<WorkerExecResult> {
  checkCancelled(cancellation);
  const timeoutMs = Math.min(input.timeoutMs, limits.commandTimeoutMs);
  const logPath = `/tmp/chatwca-command-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`;
  const descriptor = openSync(logPath, "wx", 0o600);
  let total = 0; let lines = 0; let openLine = false; let timeout: NodeJS.Timeout | undefined; let cancellationPoll: NodeJS.Timeout | undefined;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  try {
    const child = spawn("/bin/bash", ["-lc", input.command], {
      cwd: "/workspace", env: process.env, shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      let exited = false;
      const consume = (stream: "stdout" | "stderr", chunk: Buffer) => {
        if (total + chunk.byteLength > limits.maxCommandOutputBytes) {
          // Exiting the worker forces the parent to tear down the entire PID namespace.
          process.exit(74);
        }
        total += chunk.byteLength; writeSync(descriptor, chunk);
        for (const byte of chunk) { if (byte === 10) { lines += 1; openLine = false; } else openLine = true; }
        const text = decoders[stream].decode(chunk, { stream: true }); if (text !== "") emit(stream, text);
      };
      child.stdout?.on("data", (chunk: Buffer) => consume("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => consume("stderr", chunk));
      child.once("error", reject);
      // Use exit rather than close: descendants may inherit pipes and are removed below.
      child.once("exit", (code, signal) => { exited = true; resolve({ code, signal }); });
      timeout = setTimeout(() => { if (!exited) process.exit(75); }, timeoutMs + 100);
      cancellationPoll = setInterval(() => { if (cancellation?.cancelled === true) process.exit(76); }, 10);
    });
    const result = await completion;
    if (timeout !== undefined) clearTimeout(timeout); if (cancellationPoll !== undefined) clearInterval(cancellationPoll);
    await cleanCommandDescendants();
    for (const stream of ["stdout", "stderr"] as const) { const tail = decoders[stream].decode(); if (tail !== "") emit(stream, tail); }
    const truncated = total > PI_MAX_BYTES || lines + (openLine ? 1 : 0) > PI_MAX_LINES;
    if (!truncated) unlinkSync(logPath);
    return { exitCode: result.code, signal: result.signal, timedOut: false, fullOutputPath: truncated ? logPath : null };
  } catch (error) {
    throw error instanceof FatalWorkerProcessError ? error : mapFileSystemError(error);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout); if (cancellationPoll !== undefined) clearInterval(cancellationPoll);
    closeSync(descriptor);
  }
}
