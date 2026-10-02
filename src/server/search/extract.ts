import { createHash } from "node:crypto";

import { SearchSourceError } from "./errors.js";

export const SEARCH_EXTRACTOR_VERSION = "conversation-extractor-v1";
export const MAX_SESSION_SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const MAX_SESSION_RECORD_BYTES = 48 * 1024 * 1024;

export interface SearchSessionHeader {
  readonly id: string;
  readonly cwd: string;
  readonly timestamp: number;
  readonly version: 3;
}
export interface ExtractedMessage {
  readonly entryId: string;
  readonly role: "user" | "assistant";
  readonly entryTimestamp: number;
  readonly timestamp: number;
  readonly ordinal: number;
  /** Only line endings are normalized. No provider signatures or other blocks. */
  readonly text: string;
}
export interface ExtractedSession {
  readonly header: SearchSessionHeader;
  readonly savedLeafId: string | null;
  readonly title: string;
  readonly modifiedAt: number;
  readonly messages: readonly ExtractedMessage[];
  readonly extractedContentHash: string;
}
interface TreeEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly message?: Omit<ExtractedMessage, "ordinal">;
}

function invalid(): never { throw new SearchSourceError("search_session_invalid"); }
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u.test(value)) return invalid();
  return value;
}
function isoTime(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return invalid();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) return invalid();
  return parsed;
}
/** In Unicode mode, valid surrogate pairs are one astral code point. */
export function isWellFormedText(text: string): boolean { return !/[\ud800-\udfff]/u.test(text); }
function readableString(value: unknown): string {
  if (typeof value !== "string" || !isWellFormedText(value)) return invalid();
  return value;
}
function requiredString(value: unknown): string {
  const text = readableString(value);
  if (!text.trim()) return invalid();
  return text;
}

/** Validate required metadata fields without retaining its unsearchable payload. */
function validateMetadata(entry: Record<string, unknown>): void {
  switch (entry.type) {
    case "model_change":
      requiredString(entry.provider); requiredString(entry.modelId); break;
    case "thinking_level_change":
      requiredString(entry.thinkingLevel); break;
    case "compaction":
      readableString(entry.summary); identifier(entry.firstKeptEntryId);
      if (typeof entry.tokensBefore !== "number" || !Number.isFinite(entry.tokensBefore) || entry.tokensBefore < 0) return invalid();
      break;
    case "branch_summary":
      readableString(entry.summary); identifier(entry.fromId); break;
    case "custom":
      requiredString(entry.customType); break;
    case "custom_message":
      requiredString(entry.customType);
      if (typeof entry.display !== "boolean" || !(typeof entry.content === "string" || Array.isArray(entry.content))) return invalid();
      break;
    case "label":
      identifier(entry.targetId);
      if (entry.label !== undefined) readableString(entry.label);
      break;
    case "context_edit":
      identifier(entry.targetId);
      if (!(entry.replacement === null || typeof entry.replacement === "string" || Array.isArray(entry.replacement))) return invalid();
      break;
    // Unknown entry types are extension/future state, but their required tree
    // identity is still validated. They never become searchable dialogue.
  }
}

export function normalizeEntryText(text: string): string { return text.replace(/\r\n?/gu, "\n"); }
export function searchHash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

export function parseSearchSessionHeader(value: unknown, expectedSessionId?: string): SearchSessionHeader {
  const header = record(value);
  if (header.type !== "session") return invalid();
  if (header.version !== 3) throw new SearchSourceError("search_session_version_unsupported");
  const id = identifier(header.id);
  const cwd = readableString(header.cwd);
  if (!cwd.trim() || cwd.includes("\0") || (expectedSessionId !== undefined && id !== expectedSessionId)) return invalid();
  return { id, cwd, timestamp: isoTime(header.timestamp), version: 3 };
}

function extractMessage(value: unknown, entryId: string, entryTimestamp: number): Omit<ExtractedMessage, "ordinal"> | undefined {
  const message = record(value);
  if (typeof message.role !== "string" || !message.role) return invalid();
  // Unknown/custom roles have no searchable browser message target.
  if (message.role !== "user" && message.role !== "assistant") return undefined;
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp) || message.timestamp < 0 || message.timestamp > 8.64e15) return invalid();
  const texts: string[] = [];
  if (typeof message.content === "string" && message.role === "user") {
    texts.push(readableString(message.content));
  } else if (Array.isArray(message.content)) {
    for (const value of message.content) {
      const block = record(value);
      if (typeof block.type !== "string" || !block.type) return invalid();
      if (block.type === "text") texts.push(readableString(block.text));
      // Never retain images, thinking, tool arguments, or provider metadata.
    }
  } else return invalid();
  const text = normalizeEntryText(texts.join("\n"));
  if (!text.trim()) return undefined;
  return { entryId, role: message.role, entryTimestamp, timestamp: message.timestamp, text };
}

/**
 * Streaming projection builder: discards image/tool/provider payloads per record,
 * retains only minimal tree identity and visible dialogue. Never uses a writable
 * SessionManager. All trees, including abandoned branches, must be well-formed.
 */
export class SessionExtractor {
  readonly #byId = new Map<string, TreeEntry>();
  #header: SearchSessionHeader | undefined;
  #leafId: string | null = null;
  #name: string | undefined;
  #lastActivityTime: number | undefined;

  constructor(readonly expectedSessionId?: string) {}

  get header(): SearchSessionHeader | undefined { return this.#header; }

  append(value: unknown): void {
    if (this.#header === undefined) {
      this.#header = parseSearchSessionHeader(value, this.expectedSessionId);
      return;
    }
    const entry = record(value);
    if (typeof entry.type !== "string" || !entry.type || entry.type === "session") return invalid();
    const id = identifier(entry.id);
    const parentId = entry.parentId === null ? null : identifier(entry.parentId);
    const timestamp = isoTime(entry.timestamp);
    if (this.#byId.has(id) || id === this.#header.id) return invalid();
    // Pi append-only parent links always point backwards. This simultaneously
    // rejects cycles, missing ancestors, self-links and forward references in O(n).
    // Multiple roots are legitimate after resetLeaf(); do not manufacture a root.
    if (parentId !== null && !this.#byId.has(parentId)) return invalid();
    validateMetadata(entry);
    const message = entry.type === "message" ? extractMessage(entry.message, id, timestamp) : undefined;
    if (entry.type === "message") {
      const raw = record(entry.message);
      if (raw.role === "user" || raw.role === "assistant") {
        // Pi listing metadata is session-wide, even across abandoned branches
        // and image-only turns; searchable evidence remains saved-branch only.
        this.#lastActivityTime = Math.max(this.#lastActivityTime ?? 0, raw.timestamp as number);
      }
    }
    if (entry.type === "session_info") {
      this.#name = entry.name === undefined ? undefined : readableString(entry.name).trim() || undefined;
    }
    this.#byId.set(id, { id, parentId, ...(message === undefined ? {} : { message }) });
    this.#leafId = id;
  }

  finish(): ExtractedSession {
    if (this.#header === undefined) return invalid();
    const branch: TreeEntry[] = [];
    let current = this.#leafId === null ? undefined : this.#byId.get(this.#leafId);
    while (current !== undefined) {
      branch.push(current);
      current = current.parentId === null ? undefined : this.#byId.get(current.parentId);
    }
    branch.reverse();
    const messages: ExtractedMessage[] = [];
    for (const entry of branch) {
      if (entry.message !== undefined) messages.push({ ...entry.message, ordinal: messages.length });
    }
    const title = this.#name ?? messages.find((message) => message.role === "user")?.text.trim() ?? "Untitled conversation";
    const modifiedAt = this.#lastActivityTime !== undefined && this.#lastActivityTime > 0 ? this.#lastActivityTime : this.#header.timestamp;
    return {
      header: this.#header, savedLeafId: this.#leafId, title, modifiedAt, messages,
      extractedContentHash: searchHash(JSON.stringify(messages)),
    };
  }
}

export function extractSession(records: Iterable<unknown>, expectedSessionId?: string): ExtractedSession {
  const extractor = new SessionExtractor(expectedSessionId);
  for (const record of records) extractor.append(record);
  return extractor.finish();
}
