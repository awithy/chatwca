import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  formatSize,
  truncateHead,
  truncateTail,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import { SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES } from "./protocol.js";
import type { SandboxController } from "./worker-controller.js";

export const SANDBOX_TOOL_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "bash",
  "ls",
  "grep",
  "find",
] as const);
export type SandboxToolName = (typeof SANDBOX_TOOL_NAMES)[number];

export type SandboxToolController = Pick<
  SandboxController,
  "readFile" | "writeFile" | "editFile" | "listDirectory" | "grep" | "find" | "exec"
>;

const GUEST_CWD = "/workspace";
const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1_000;
const DEFAULT_LS_LIMIT = 500;
const MAX_TIMEOUT_MS = 2_147_483_647;
const BASH_TAIL_RETAIN_BYTES = DEFAULT_MAX_BYTES * 2;
const TOOL_FAILURE_MESSAGE = "Sandbox tool operation failed";

function withoutHostRenderers<T extends object>(definition: T): Omit<T, "execute" | "renderCall" | "renderResult" | "renderShell"> {
  const metadata = { ...definition } as T & Record<string, unknown>;
  delete metadata.execute;
  delete metadata.renderCall;
  delete metadata.renderResult;
  delete metadata.renderShell;
  return metadata;
}

function stableToolFailure(): Error {
  return new Error(TOOL_FAILURE_MESSAGE);
}

function callOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function piTruncation<T extends { readonly truncated: boolean }>(value: T, text: string): T & { readonly content: string } {
  const notice = text.lastIndexOf("\n\n[");
  const content = notice === -1 ? text : text.slice(0, notice);
  return { ...value, content };
}

async function brokered<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    // Tool exceptions are model-visible. Worker codes, OS messages, command
    // output, paths, diagnostics, and stacks must not cross this boundary.
    throw stableToolFailure();
  }
}

function imageNote(model: { readonly input: readonly string[] } | undefined): string | undefined {
  return model === undefined || model.input.includes("image")
    ? undefined
    : "[Current model does not support images. The image will be omitted from this request.]";
}

function readTextResult(
  textContent: string,
  input: { readonly path: string; readonly offset?: number; readonly limit?: number },
): { content: [{ type: "text"; text: string }]; details: { truncation: ReturnType<typeof truncateHead> } | undefined } {
  const allLines = textContent.split("\n");
  const startLine = input.offset ? Math.max(0, input.offset - 1) : 0;
  if (startLine >= allLines.length) throw stableToolFailure();
  const startLineDisplay = startLine + 1;
  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (input.limit !== undefined) {
    const endLine = Math.min(startLine + input.limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }

  const truncation = truncateHead(selectedContent);
  let outputText: string;
  let details: { truncation: typeof truncation } | undefined;
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf8"));
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${input.path} | head -c ${DEFAULT_MAX_BYTES}]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    outputText += truncation.truncatedBy === "lines"
      ? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}. Use offset=${nextOffset} to continue.]`
      : `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${startLine + userLimitedLines + 1} to continue.]`;
  } else {
    outputText = truncation.content;
  }
  return {
    content: [{ type: "text", text: outputText }],
    details,
  };
}

class BashTailAccumulator {
  #tail = Buffer.alloc(0);
  #totalBytes = 0;
  #newlineCount = 0;
  #lastByte: number | undefined;

  append(text: string): void {
    const chunk = Buffer.from(text, "utf8");
    this.#totalBytes += chunk.byteLength;
    for (const byte of chunk) if (byte === 10) this.#newlineCount += 1;
    if (chunk.byteLength > 0) this.#lastByte = chunk[chunk.byteLength - 1];
    let combined = Buffer.concat([this.#tail, chunk]);
    if (combined.byteLength > BASH_TAIL_RETAIN_BYTES) {
      let start = combined.byteLength - BASH_TAIL_RETAIN_BYTES;
      while (start < combined.byteLength && (combined[start]! & 0xc0) === 0x80) start += 1;
      combined = combined.subarray(start);
    }
    this.#tail = combined;
  }

  snapshot(): ReturnType<typeof truncateTail> {
    const local = truncateTail(this.#tail.toString("utf8"));
    const totalLines = this.#totalBytes === 0
      ? 0
      : this.#newlineCount + (this.#lastByte === 10 ? 0 : 1);
    const dropped = this.#totalBytes > this.#tail.byteLength;
    if (!dropped && local.totalBytes === this.#totalBytes && local.totalLines === totalLines) return local;
    return {
      ...local,
      truncated: true,
      truncatedBy: local.truncated ? local.truncatedBy : "bytes",
      totalBytes: this.#totalBytes,
      totalLines,
    };
  }
}

function bashOutput(
  snapshot: ReturnType<typeof truncateTail>,
  fullOutputPath?: string | null,
): { readonly text: string; readonly details?: { readonly truncation: typeof snapshot; readonly fullOutputPath?: string } } {
  let text = snapshot.content || "(no output)";
  if (!snapshot.truncated) return { text };
  const startLine = snapshot.totalLines - snapshot.outputLines + 1;
  const endLine = snapshot.totalLines;
  const location = fullOutputPath === null || fullOutputPath === undefined ? "" : ` Full output: ${fullOutputPath}`;
  if (snapshot.lastLinePartial) {
    text += `\n\n[Showing last ${formatSize(snapshot.outputBytes)} of line ${endLine}.${location}]`;
  } else if (snapshot.truncatedBy === "lines") {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${snapshot.totalLines}.${location}]`;
  } else {
    text += `\n\n[Showing lines ${startLine}-${endLine} of ${snapshot.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).${location}]`;
  }
  return {
    text,
    details: {
      truncation: snapshot,
      ...(fullOutputPath === null || fullOutputPath === undefined ? {} : { fullOutputPath }),
    },
  };
}

/**
 * Build the complete sandbox tool set. Pi factories provide pinned 0.84.3
 * metadata and schemas only; every execute function below is application-owned.
 */
export function createSandboxTools(controller: SandboxToolController): readonly ToolDefinition[] {
  const readSource = createReadToolDefinition(GUEST_CWD);
  const read: typeof readSource = {
    ...withoutHostRenderers(readSource),
    async execute(_toolCallId, input, signal, _onUpdate, ctx) {
      return brokered(async () => {
        const result = await controller.readFile({
          path: input.path,
          maxBytes: SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES,
          detectMime: true,
        }, callOptions(signal));
        if (result.mimeType !== null) {
          let text = `Read image file [${result.mimeType}]`;
          const note = imageNote(ctx?.model);
          if (note !== undefined) text += `\n${note}`;
          return {
            content: [
              { type: "text" as const, text },
              { type: "image" as const, data: result.data.toString("base64"), mimeType: result.mimeType },
            ],
            details: undefined,
          };
        }
        return readTextResult(result.data.toString("utf8"), input);
      });
    },
  };

  const writeSource = createWriteToolDefinition(GUEST_CWD);
  const write: typeof writeSource = {
    ...withoutHostRenderers(writeSource),
    async execute(_toolCallId, input, signal) {
      return brokered(async () => {
        await controller.writeFile(input.path, input.content, { ...callOptions(signal), createParents: true });
        return {
          content: [{ type: "text", text: `Successfully wrote ${input.content.length} bytes to ${input.path}` }],
          details: undefined,
        };
      });
    },
  };

  const editSource = createEditToolDefinition(GUEST_CWD);
  const edit: typeof editSource = {
    ...withoutHostRenderers(editSource),
    ...(editSource.prepareArguments === undefined ? {} : { prepareArguments: editSource.prepareArguments }),
    async execute(_toolCallId, input, signal) {
      return brokered(async () => {
        if (!Array.isArray(input.edits) || input.edits.length === 0) throw stableToolFailure();
        const result = await controller.editFile({ path: input.path, edits: input.edits }, callOptions(signal));
        return {
          content: [{ type: "text", text: `Successfully replaced ${input.edits.length} block(s) in ${input.path}.` }],
          details: result,
        };
      });
    },
  };

  const bashSource = createBashToolDefinition(GUEST_CWD, { exposeSessionEnvironment: false });
  const bash: typeof bashSource = {
    ...withoutHostRenderers(bashSource),
    async execute(_toolCallId, input, signal, onUpdate) {
      return brokered(async () => {
        let timeoutMs = Number.MAX_SAFE_INTEGER;
        if (input.timeout !== undefined) {
          if (!Number.isFinite(input.timeout) || input.timeout <= 0 || input.timeout * 1_000 > MAX_TIMEOUT_MS) {
            throw stableToolFailure();
          }
          timeoutMs = input.timeout * 1_000;
        }
        const output = new BashTailAccumulator();
        onUpdate?.({ content: [], details: undefined });
        const result = await controller.exec(
          { command: input.command, timeoutMs },
          {
            ...callOptions(signal),
            onOutput: (event) => {
              output.append(event.data);
              const partial = bashOutput(output.snapshot());
              onUpdate?.({
                content: [{ type: "text", text: partial.text }],
                details: partial.details,
              });
            },
          },
        );
        if (result.exitCode !== 0 || result.signal !== null || result.timedOut) throw stableToolFailure();
        const formatted = bashOutput(output.snapshot(), result.fullOutputPath);
        return {
          content: [{ type: "text", text: formatted.text }],
          details: formatted.details,
        };
      });
    },
  };

  const lsSource = createLsToolDefinition(GUEST_CWD);
  const ls: typeof lsSource = {
    ...withoutHostRenderers(lsSource),
    async execute(_toolCallId, input, signal) {
      return brokered(async () => {
        const effectiveLimit = Math.max(1, input.limit ?? DEFAULT_LS_LIMIT);
        const result = await controller.listDirectory({
          path: input.path || ".",
          includeHidden: true,
          limit: effectiveLimit,
        }, callOptions(signal));
        if (result.entries.length === 0) {
          return { content: [{ type: "text", text: "(empty directory)" }], details: undefined };
        }
        const raw = result.entries.map((entry) => `${entry.name}${entry.type === "directory" ? "/" : ""}`).join("\n");
        const truncation = truncateHead(raw, { maxLines: Number.MAX_SAFE_INTEGER });
        const notices: string[] = [];
        const details: { truncation?: typeof truncation; entryLimitReached?: number } = {};
        if (result.truncated) {
          notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
          details.entryLimitReached = effectiveLimit;
        }
        if (truncation.truncated) {
          notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
          details.truncation = truncation;
        }
        const text = notices.length === 0 ? truncation.content : `${truncation.content}\n\n[${notices.join(". ")}]`;
        return { content: [{ type: "text", text }], details: Object.keys(details).length === 0 ? undefined : details };
      });
    },
  };

  const grepSource = createGrepToolDefinition(GUEST_CWD);
  const grep: typeof grepSource = {
    ...withoutHostRenderers(grepSource),
    async execute(_toolCallId, input, signal) {
      return brokered(async () => {
        const result = await controller.grep({
          path: input.path || ".",
          pattern: input.pattern,
          literal: input.literal ?? false,
          caseSensitive: !(input.ignoreCase ?? false),
          includeHidden: true,
          ...(input.glob === undefined ? {} : { glob: input.glob }),
          context: input.context && input.context > 0 ? input.context : 0,
          limit: Math.max(1, input.limit ?? DEFAULT_GREP_LIMIT),
        }, callOptions(signal));
        const details = {
          ...(result.truncation === undefined ? {} : { truncation: piTruncation(result.truncation, result.text) }),
          ...(result.matchLimitReached === undefined ? {} : { matchLimitReached: result.matchLimitReached }),
          ...(result.linesTruncated === undefined ? {} : { linesTruncated: result.linesTruncated }),
        };
        return {
          content: [{ type: "text", text: result.text }],
          details: Object.keys(details).length === 0 ? undefined : details,
        };
      });
    },
  };

  const findSource = createFindToolDefinition(GUEST_CWD);
  const find: typeof findSource = {
    ...withoutHostRenderers(findSource),
    async execute(_toolCallId, input, signal) {
      return brokered(async () => {
        const result = await controller.find({
          path: input.path || ".",
          glob: input.pattern,
          includeHidden: true,
          limit: Math.max(1, input.limit ?? DEFAULT_FIND_LIMIT),
        }, callOptions(signal));
        const resultText = result.text ?? (result.paths.length === 0 ? "No files found matching pattern" : result.paths.join("\n"));
        const details = {
          ...(result.truncation === undefined ? {} : { truncation: piTruncation(result.truncation, resultText) }),
          ...(result.resultLimitReached === undefined ? {} : { resultLimitReached: result.resultLimitReached }),
        };
        return {
          content: [{ type: "text", text: resultText }],
          details: Object.keys(details).length === 0 ? undefined : details,
        };
      });
    },
  };

  return Object.freeze([read, write, edit, bash, ls, grep, find]) as readonly ToolDefinition<any, any>[];
}
