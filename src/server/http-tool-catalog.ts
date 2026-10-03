import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { TSchema } from "@sinclair/typebox";

import { CONVERSATION_TOOL_NAMES } from "../shared/protocol.js";
import { ConfigurationError } from "./sandbox/config.js";

export const HTTP_TOOL_CATALOG_ENV = "CHATWCA_TOOL_CATALOG";
export const MAX_HTTP_TOOL_CATALOG_BYTES = 1024 * 1024;
export const MAX_HTTP_TOOLS = 64;
export const DEFAULT_HTTP_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_HTTP_TOOL_MAX_RESPONSE_BYTES = 1024 * 1024;
export const MAX_HTTP_TOOL_TIMEOUT_MS = 5 * 60 * 1_000;
export const MAX_HTTP_TOOL_RESPONSE_BYTES = 16 * 1024 * 1024;

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const RESERVED_TOOL_NAMES = new Set([
  "bash",
  "edit",
  "find",
  "grep",
  "ls",
  "read",
  "web_search",
  "write",
  ...CONVERSATION_TOOL_NAMES,
]);

export interface HttpToolConfig {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly method: "POST";
  readonly url: string;
  readonly parameters: TSchema;
  readonly timeoutMs: number;
  readonly maxResponseBytes: number;
}

export interface HttpToolCatalog {
  readonly sourcePath: string | null;
  readonly tools: readonly Readonly<HttpToolConfig>[];
}

export interface PublicHttpTool {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly method: "POST";
  readonly url: string;
}

interface CatalogDocument {
  readonly version: 1;
  readonly tools: readonly unknown[];
}

const EMPTY_HTTP_TOOL_CATALOG: Readonly<HttpToolCatalog> = Object.freeze({
  sourcePath: null,
  tools: Object.freeze([]),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find((key) => !allowedSet.has(key));
  if (unexpected !== undefined) {
    throw new ConfigurationError(`${location} contains unsupported property ${JSON.stringify(unexpected)}`);
  }
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  location: string,
  maxLength: number,
): string {
  const candidate = value[key];
  if (
    typeof candidate !== "string" ||
    candidate.trim().length === 0 ||
    candidate !== candidate.trim() ||
    candidate.length > maxLength
  ) {
    throw new ConfigurationError(`${location}.${key} must be a non-empty trimmed string of at most ${String(maxLength)} characters`);
  }
  return candidate;
}

function boundedPositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
  location: string,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximum) {
    throw new ConfigurationError(`${location} must be a positive integer no greater than ${String(maximum)}`);
  }
  return value as number;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value)) deepFreeze(nested);
  return value;
}

function parseParameters(value: unknown, location: string): TSchema {
  if (!isRecord(value) || value.type !== "object" || !isRecord(value.properties)) {
    throw new ConfigurationError(`${location} must be a JSON Schema object with type "object" and a properties object`);
  }
  if (value.additionalProperties !== false) {
    throw new ConfigurationError(`${location}.additionalProperties must be false`);
  }
  const propertyNames = new Set(Object.keys(value.properties));
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.some((entry) => typeof entry !== "string" || !propertyNames.has(entry)) ||
      new Set(value.required).size !== value.required.length
    ) {
      throw new ConfigurationError(`${location}.required must contain unique property names declared by the schema`);
    }
  }
  return deepFreeze(structuredClone(value) as TSchema);
}

function parseTool(value: unknown, index: number): Readonly<HttpToolConfig> {
  const location = `HTTP tool catalog tools[${String(index)}]`;
  if (!isRecord(value)) throw new ConfigurationError(`${location} must be an object`);
  exactKeys(value, [
    "name",
    "label",
    "description",
    "method",
    "url",
    "parameters",
    "timeoutMs",
    "maxResponseBytes",
  ], location);

  const name = requiredString(value, "name", location, 64);
  if (!TOOL_NAME_PATTERN.test(name) || RESERVED_TOOL_NAMES.has(name)) {
    throw new ConfigurationError(`${location}.name must be a non-reserved lowercase tool name using letters, digits, and underscores`);
  }
  const method = value.method;
  if (method !== "POST") {
    throw new ConfigurationError(`${location}.method must be "POST"`);
  }
  const rawUrl = requiredString(value, "url", location, 2048);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ConfigurationError(`${location}.url must be an absolute HTTP or HTTPS URL`);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new ConfigurationError(`${location}.url must be an HTTP or HTTPS URL without credentials or a fragment`);
  }

  return Object.freeze({
    name,
    label: requiredString(value, "label", location, 128),
    description: requiredString(value, "description", location, 2_000),
    method,
    url: url.href,
    parameters: parseParameters(value.parameters, `${location}.parameters`),
    timeoutMs: boundedPositiveInteger(
      value.timeoutMs,
      DEFAULT_HTTP_TOOL_TIMEOUT_MS,
      MAX_HTTP_TOOL_TIMEOUT_MS,
      `${location}.timeoutMs`,
    ),
    maxResponseBytes: boundedPositiveInteger(
      value.maxResponseBytes,
      DEFAULT_HTTP_TOOL_MAX_RESPONSE_BYTES,
      MAX_HTTP_TOOL_RESPONSE_BYTES,
      `${location}.maxResponseBytes`,
    ),
  });
}

function parseDocument(value: unknown, sourcePath: string): Readonly<HttpToolCatalog> {
  if (!isRecord(value)) throw new ConfigurationError("HTTP tool catalog must contain a JSON object");
  exactKeys(value, ["version", "tools"], "HTTP tool catalog");
  if (value.version !== 1) throw new ConfigurationError("HTTP tool catalog version must be 1");
  if (!Array.isArray(value.tools) || value.tools.length > MAX_HTTP_TOOLS) {
    throw new ConfigurationError(`HTTP tool catalog tools must be an array with at most ${String(MAX_HTTP_TOOLS)} entries`);
  }

  const document = value as unknown as CatalogDocument;
  const tools = document.tools.map(parseTool);
  const toolNames = new Set(tools.map((tool) => tool.name));
  if (toolNames.size !== tools.length) {
    throw new ConfigurationError("HTTP tool catalog tool names must be unique");
  }

  return Object.freeze({
    sourcePath,
    tools: Object.freeze(tools),
  });
}

/** Load a startup-only HTTP tool catalog. Missing configuration disables all tools. */
export function loadHttpToolCatalog(
  environment: NodeJS.ProcessEnv = process.env,
  processCwd = process.cwd(),
): Readonly<HttpToolCatalog> {
  const configuredPath = environment[HTTP_TOOL_CATALOG_ENV];
  if (configuredPath === undefined) return EMPTY_HTTP_TOOL_CATALOG;
  if (configuredPath.trim().length === 0) {
    throw new ConfigurationError(`${HTTP_TOOL_CATALOG_ENV} must not be empty`);
  }

  const sourcePath = path.resolve(processCwd, configuredPath);
  try {
    const metadata = statSync(sourcePath);
    if (!metadata.isFile()) throw new Error("catalog path is not a regular file");
    if (metadata.size > MAX_HTTP_TOOL_CATALOG_BYTES) {
      throw new ConfigurationError(`HTTP tool catalog must not exceed ${String(MAX_HTTP_TOOL_CATALOG_BYTES)} bytes`);
    }
    const document = JSON.parse(readFileSync(sourcePath, "utf8")) as unknown;
    return parseDocument(document, sourcePath);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    if (error instanceof SyntaxError) {
      throw new ConfigurationError("HTTP tool catalog must contain valid JSON");
    }
    throw new ConfigurationError(`Unable to read HTTP tool catalog at ${sourcePath}`);
  }
}

/** Safe browser-visible metadata. JSON Schemas and execution limits remain server-only. */
export function publicHttpTools(
  catalog: Readonly<HttpToolCatalog>,
): readonly Readonly<PublicHttpTool>[] {
  return Object.freeze(catalog.tools.map((tool) => Object.freeze({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    method: tool.method,
    url: tool.url,
  })));
}
