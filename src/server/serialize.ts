import type {
  SessionEntry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import { AppError, ERROR_CODES } from "../shared/errors.js";
import type {
  AssistantContentBlock,
  AssistantMessage,
  ImageBlock,
  ImageMimeType,
  NormalizedMessage,
  ToolCallBlock,
  ToolResultBlock,
  Usage,
  UserContentBlock,
  UserMessage,
} from "../shared/protocol.js";

/** Browser snapshots never include more than this many UTF-8 bytes per tool result. */
export const DEFAULT_MAX_TOOL_OUTPUT_BYTES = 64 * 1024;

export interface SerializeOptions {
  readonly maxToolOutputBytes?: number;
}

type UnknownRecord = Record<string, unknown>;
type BranchSource = Pick<SessionManager, "getBranch">;

const modelFailureMessage = new AppError(ERROR_CODES.MODEL_FAILED).message;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function timestampOf(message: UnknownRecord, entry: UnknownRecord): number | undefined {
  const messageTimestamp = nonNegativeNumber(message.timestamp);
  if (messageTimestamp !== undefined) return messageTimestamp;

  if (typeof entry.timestamp !== "string") return undefined;
  const parsed = Date.parse(entry.timestamp);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function imageMimeType(value: unknown): ImageMimeType | undefined {
  if (typeof value !== "string") return undefined;
  switch (value.toLowerCase()) {
    case "image/png":
      return "image/png";
    case "image/jpeg":
    case "image/jpg":
      return "image/jpeg";
    case "image/webp":
      return "image/webp";
    default:
      return undefined;
  }
}

function serializeImage(value: UnknownRecord): ImageBlock | undefined {
  const mimeType = imageMimeType(value.mimeType);
  const data = nonEmptyString(value.data);
  if (mimeType === undefined || data === undefined) return undefined;

  return {
    type: "image",
    image: { mimeType, encoding: "base64", data },
  };
}

function serializeUserBlocks(content: unknown): UserContentBlock[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];

  const blocks: UserContentBlock[] = [];
  for (const item of content) {
    const part = record(item);
    if (part?.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part?.type === "image") {
      const image = serializeImage(part);
      if (image !== undefined) blocks.push(image);
    }
  }
  return blocks;
}

function serializeUsage(value: unknown): Usage | undefined {
  const source = record(value);
  if (source === undefined) return undefined;
  const inputTokens = nonNegativeNumber(source.input);
  const outputTokens = nonNegativeNumber(source.output);
  if (inputTokens === undefined || outputTokens === undefined) return undefined;

  const cacheReadTokens = nonNegativeNumber(source.cacheRead);
  const cacheWriteTokens = nonNegativeNumber(source.cacheWrite);
  const totalCost = nonNegativeNumber(record(source.cost)?.total);
  return {
    inputTokens,
    outputTokens,
    ...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
    ...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
    ...(totalCost === undefined ? {} : { totalCost }),
  };
}

function stopReason(value: unknown): AssistantMessage["stopReason"] | undefined {
  switch (value) {
    case "stop":
    case "length":
    case "aborted":
    case "error":
      return value;
    case "toolUse":
      return "tool-use";
    case "pending":
    case "deferred":
      return "unknown";
    default:
      return undefined;
  }
}

interface ToolOutcome {
  readonly failed: boolean;
}

function collectToolOutcomes(entries: readonly unknown[]): Map<string, ToolOutcome> {
  const outcomes = new Map<string, ToolOutcome>();
  for (const value of entries) {
    const entry = record(value);
    const message = record(entry?.message);
    if (entry?.type !== "message" || message?.role !== "toolResult") continue;
    const toolCallId = nonEmptyString(message.toolCallId);
    if (toolCallId !== undefined) {
      outcomes.set(toolCallId, { failed: message.isError === true });
    }
  }
  return outcomes;
}

function serializeToolCall(
  value: UnknownRecord,
  outcomes: ReadonlyMap<string, ToolOutcome>,
): ToolCallBlock | undefined {
  const toolCallId = nonEmptyString(value.id);
  const toolName = nonEmptyString(value.name);
  if (toolCallId === undefined || toolName === undefined) return undefined;

  const outcome = outcomes.get(toolCallId);
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    arguments: value.arguments ?? {},
    status:
      outcome === undefined
        ? "pending"
        : outcome.failed
          ? "failed"
          : "succeeded",
  };
}

function serializeAssistantBlocks(
  content: unknown,
  outcomes: ReadonlyMap<string, ToolOutcome>,
): AssistantContentBlock[] {
  if (!Array.isArray(content)) return [];

  const blocks: AssistantContentBlock[] = [];
  for (const item of content) {
    const part = record(item);
    if (part?.type === "text" && typeof part.text === "string") {
      // Text remains an untrusted string. Rendering policy belongs to the web
      // Markdown component, which must not enable raw HTML.
      blocks.push({ type: "text", text: part.text });
    } else if (part?.type === "thinking" && typeof part.thinking === "string") {
      blocks.push({ type: "thinking", text: part.thinking });
    } else if (part?.type === "image") {
      const image = serializeImage(part);
      if (image !== undefined) blocks.push(image);
    } else if (part?.type === "toolCall") {
      const tool = serializeToolCall(part, outcomes);
      if (tool !== undefined) blocks.push(tool);
    }
  }
  return blocks;
}

export function truncateUtf8(text: string, maximumBytes: number): {
  readonly content: string;
  readonly originalBytes: number;
  readonly truncated: boolean;
} {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maximumBytes) {
    return { content: text, originalBytes: bytes.length, truncated: false };
  }

  // At most three bytes before the boundary can be an incomplete UTF-8 suffix.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = maximumBytes; end >= Math.max(0, maximumBytes - 3); end -= 1) {
    try {
      return {
        content: decoder.decode(bytes.subarray(0, end)),
        originalBytes: bytes.length,
        truncated: true,
      };
    } catch {
      // Try the preceding code-point boundary.
    }
  }

  return { content: "", originalBytes: bytes.length, truncated: true };
}

function serializeToolResult(
  message: UnknownRecord,
  maximumBytes: number,
): AssistantContentBlock[] | undefined {
  const toolCallId = nonEmptyString(message.toolCallId);
  if (toolCallId === undefined) return undefined;

  const content = Array.isArray(message.content) ? message.content : [];
  const text = content
    .map((item) => record(item))
    .filter(
      (item): item is UnknownRecord =>
        item?.type === "text" && typeof item.text === "string",
    )
    .map((item) => item.text as string)
    .join("\n");
  const bounded = truncateUtf8(text, maximumBytes);
  const toolName = nonEmptyString(message.toolName);
  const result: ToolResultBlock = {
    type: "tool-result",
    toolCallId,
    ...(toolName === undefined ? {} : { toolName }),
    content: bounded.content,
    isError: message.isError === true,
    truncated: bounded.truncated,
    ...(bounded.truncated ? { originalBytes: bounded.originalBytes } : {}),
  };

  const blocks: AssistantContentBlock[] = [result];
  for (const item of content) {
    const part = record(item);
    if (part?.type !== "image") continue;
    const image = serializeImage(part);
    if (image !== undefined) blocks.push(image);
  }
  return blocks;
}

function serializeEntry(
  value: unknown,
  outcomes: ReadonlyMap<string, ToolOutcome>,
  maximumBytes: number,
): NormalizedMessage | undefined {
  const entry = record(value);
  const entryId = nonEmptyString(entry?.id);
  const message = record(entry?.message);
  if (entry?.type !== "message" || entryId === undefined || message === undefined) {
    return undefined;
  }

  const timestamp = timestampOf(message, entry);
  if (message.role === "user") {
    const normalized: UserMessage = {
      entryId,
      role: "user",
      blocks: serializeUserBlocks(message.content),
      ...(timestamp === undefined ? {} : { timestamp }),
    };
    return normalized;
  }

  if (message.role === "assistant") {
    const normalizedStopReason = stopReason(message.stopReason);
    const usage = serializeUsage(message.usage);
    const failed =
      message.stopReason === "error" || nonEmptyString(message.errorMessage) !== undefined;
    const normalized: AssistantMessage = {
      entryId,
      role: "assistant",
      blocks: serializeAssistantBlocks(message.content, outcomes),
      ...(timestamp === undefined ? {} : { timestamp }),
      ...(normalizedStopReason === undefined
        ? {}
        : { stopReason: normalizedStopReason }),
      ...(failed
        ? {
            error: {
              code: ERROR_CODES.MODEL_FAILED,
              message: modelFailureMessage,
            },
          }
        : {}),
      ...(usage === undefined ? {} : { usage }),
    };
    return normalized;
  }

  if (message.role === "toolResult") {
    const blocks = serializeToolResult(message, maximumBytes);
    if (blocks === undefined) return undefined;
    return {
      entryId,
      role: "assistant",
      blocks,
      ...(timestamp === undefined ? {} : { timestamp }),
    };
  }

  // Pi extension/custom, bash, and summary roles have no v1 normalized message
  // representation. Their entries remain canonical in Pi's session store.
  return undefined;
}

function maximumToolBytes(options: SerializeOptions): number {
  const maximum = options.maxToolOutputBytes ?? DEFAULT_MAX_TOOL_OUTPUT_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new RangeError("maxToolOutputBytes must be a positive safe integer");
  }
  return maximum;
}

/** Normalize a live Pi message using a caller-provided stream or session ID. */
export function serializeLiveMessage(
  message: unknown,
  entryId: string,
  options: SerializeOptions = {},
): NormalizedMessage | undefined {
  return serializeEntry(
    { type: "message", id: entryId, message },
    new Map(),
    maximumToolBytes(options),
  );
}

/** Normalize the text-bearing portion of a partial/final Pi tool result. */
export function serializeLiveToolResult(
  toolCallId: string,
  toolName: string,
  result: unknown,
  isError: boolean,
  options: SerializeOptions = {},
): ToolResultBlock {
  const source = record(result);
  const content = Array.isArray(source?.content)
    ? source.content
    : typeof result === "string"
      ? [{ type: "text", text: result }]
      : [];
  const blocks = serializeToolResult(
    { role: "toolResult", toolCallId, toolName, content, isError },
    maximumToolBytes(options),
  );
  const normalized = blocks?.find(
    (block): block is ToolResultBlock => block.type === "tool-result",
  );
  return (
    normalized ?? {
      type: "tool-result",
      toolCallId,
      toolName,
      content: "",
      isError,
      truncated: false,
    }
  );
}

/**
 * Serialize only Pi's active root-to-leaf branch into the v1 linear timeline.
 * Non-message metadata and entries on abandoned branches are intentionally not
 * projected; the Pi JSONL file remains their canonical representation.
 */
export function serializeActiveBranch(
  sessionManager: BranchSource,
  options: SerializeOptions = {},
): NormalizedMessage[] {
  return serializeSessionEntries(sessionManager.getBranch(), options);
}

/** Exported separately for event normalization and fixture-driven tests. */
export function serializeSessionEntries(
  entries: readonly SessionEntry[] | readonly unknown[],
  options: SerializeOptions = {},
): NormalizedMessage[] {
  const maximumBytes = maximumToolBytes(options);
  const outcomes = collectToolOutcomes(entries);
  return entries.flatMap((entry) => {
    const message = serializeEntry(entry, outcomes, maximumBytes);
    return message === undefined ? [] : [message];
  });
}
