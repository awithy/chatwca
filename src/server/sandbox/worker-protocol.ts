/* Dependency-free structural validators mirrored from protocol.ts. */
export const WORKER_MAX_FRAME_BYTES = 1024 * 1024;
export const WORKER_MAX_ASSEMBLED_REQUEST_BYTES = 16 * 1024 * 1024;
export const WORKER_MAX_ACTIVE_OPERATIONS = 8;
export const WORKER_MAX_RAW_CHUNK_BYTES = 767 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length && keys.every((key) => key in value);
}
function string(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is string {
  return typeof value === "string" && value.length >= min && value.length <= max;
}
function integer(value: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}
function id(value: unknown): value is string { return string(value, 1, 128) && /^[A-Za-z0-9_-]+$/.test(value); }
function path(value: unknown): value is string { return string(value, 1, 16_384); }
function sha(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function encoding(value: unknown): value is "utf8" | "base64" { return value === "utf8" || value === "base64"; }
function bool(value: unknown): value is boolean { return typeof value === "boolean"; }
function optionalString(value: unknown, max: number): boolean { return value === undefined || string(value, 0, max); }

export const WORKER_OPERATIONS = Object.freeze([
  "readFile", "writeFile", "editFile", "listDirectory", "grep", "find", "exec", "health",
] as const);
export type WorkerOperation = (typeof WORKER_OPERATIONS)[number];

export function workerValidateOperationArguments(operation: WorkerOperation, value: unknown): boolean {
  switch (operation) {
    case "readFile": return exact(value, ["path", "maxBytes", "detectMime"]) && path(value.path) &&
      integer(value.maxBytes, 1, WORKER_MAX_ASSEMBLED_REQUEST_BYTES) && bool(value.detectMime);
    case "writeFile": return exact(value, ["path", "createParents", "encoding", "bytes", "sha256"]) &&
      path(value.path) && bool(value.createParents) && encoding(value.encoding) &&
      integer(value.bytes, 0, WORKER_MAX_ASSEMBLED_REQUEST_BYTES) && sha(value.sha256);
    case "editFile": return exact(value, ["path", "edits"]) && path(value.path) && Array.isArray(value.edits) &&
      value.edits.length >= 1 && value.edits.length <= 1_000 && value.edits.every((edit) =>
        exact(edit, ["oldText", "newText"]) && typeof edit.oldText === "string" && typeof edit.newText === "string");
    case "listDirectory": return exact(value, ["path", "includeHidden", "limit"]) && path(value.path) &&
      bool(value.includeHidden) && integer(value.limit, 1, 100_000);
    case "grep": return exact(value, ["path", "pattern", "literal", "caseSensitive", "includeHidden", "context", "limit"]) ||
      exact(value, ["path", "pattern", "literal", "caseSensitive", "includeHidden", "glob", "context", "limit"])
      ? path(value.path) && string(value.pattern, 0, 65_536) && bool(value.literal) && bool(value.caseSensitive) &&
        bool(value.includeHidden) && optionalString(value.glob, 16_384) && integer(value.context, 0, 1_000) && integer(value.limit, 1, 100_000)
      : false;
    case "find": return exact(value, ["path", "glob", "includeHidden", "limit"]) && path(value.path) &&
      string(value.glob, 0, 16_384) && bool(value.includeHidden) && integer(value.limit, 1, 100_000);
    case "exec": return exact(value, ["command", "timeoutMs"]) && string(value.command, 1, WORKER_MAX_ASSEMBLED_REQUEST_BYTES) &&
      integer(value.timeoutMs, 1);
    case "health": return exact(value, []);
  }
}

export function workerIsParentFrame(value: unknown): boolean {
  if (!record(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "hello": return exact(value, ["type", "protocol", "nonce", "artifactSha256", "artifactVersion", "hiddenPaths", "mountPaths", "exitAfterProbe", "commandTimeoutMs", "maxCommandOutputBytes"]) &&
      value.protocol === 1 && string(value.nonce, 16, 256) && /^[A-Za-z0-9_-]+$/.test(value.nonce) && sha(value.artifactSha256) && string(value.artifactVersion, 1, 64) &&
      Array.isArray(value.hiddenPaths) && value.hiddenPaths.length <= 1_000 && value.hiddenPaths.every((item) => typeof item === "string") &&
      Array.isArray(value.mountPaths) && value.mountPaths.length <= 1_000 && value.mountPaths.every((item) => typeof item === "string") && bool(value.exitAfterProbe) &&
      integer(value.commandTimeoutMs, 1) && integer(value.maxCommandOutputBytes, 1);
    case "request": return exact(value, ["type", "id", "operation", "arguments"]) && id(value.id) &&
      WORKER_OPERATIONS.includes(value.operation as WorkerOperation) && workerValidateOperationArguments(value.operation as WorkerOperation, value.arguments);
    case "request.chunk": return exact(value, ["type", "id", "sequence", "encoding", "data"]) && id(value.id) &&
      integer(value.sequence) && encoding(value.encoding) && string(value.data, 0, WORKER_MAX_FRAME_BYTES);
    case "request.end": return exact(value, ["type", "id", "bytes", "sha256"]) && id(value.id) &&
      integer(value.bytes, 0, WORKER_MAX_ASSEMBLED_REQUEST_BYTES) && sha(value.sha256);
    case "cancel": return exact(value, ["type", "id"]) && id(value.id);
    case "cancel.all": return exact(value, ["type"]);
    case "shutdown": return exact(value, ["type"]);
    default: return false;
  }
}
