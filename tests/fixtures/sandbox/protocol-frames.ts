export const validParentFrames: readonly unknown[] = [
  { type: "hello", protocol: 1, nonce: "n".repeat(16), artifactSha256: "a".repeat(64), artifactVersion: "1", hiddenPaths: [], mountPaths: [], exitAfterProbe: false },
  { type: "request", id: "id_1", operation: "readFile", arguments: { path: "file", maxBytes: 1024, detectMime: true } },
  { type: "request", id: "id_2", operation: "writeFile", arguments: { path: "file", createParents: true, encoding: "utf8", bytes: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" } },
  { type: "request", id: "id_3", operation: "editFile", arguments: { path: "file", edits: [{ oldText: "a", newText: "b" }] } },
  { type: "request", id: "id_4", operation: "listDirectory", arguments: { path: ".", includeHidden: false, limit: 100 } },
  { type: "request", id: "id_5", operation: "grep", arguments: { path: ".", pattern: "x", literal: false, caseSensitive: true, includeHidden: false, context: 0, limit: 100 } },
  { type: "request", id: "id_6", operation: "find", arguments: { path: ".", glob: "*.ts", includeHidden: false, limit: 100 } },
  { type: "request", id: "id_7", operation: "exec", arguments: { command: "true", timeoutMs: 1000 } },
  { type: "request", id: "id_8", operation: "health", arguments: {} },
  { type: "request.chunk", id: "id_2", sequence: 0, encoding: "base64", data: "" },
  { type: "request.end", id: "id_2", bytes: 0, sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" },
  { type: "cancel", id: "id_1" }, { type: "cancel.all" }, { type: "shutdown" },
];

export const invalidParentFrames: readonly unknown[] = [
  null, [], {}, { type: "shutdown", extra: true }, { type: "request", id: "hostile", operation: "host.read", arguments: {} },
  { type: "request", id: "bad id", operation: "health", arguments: {} },
  { type: "request", id: "id", operation: "readFile", arguments: { path: "x", maxBytes: 0, detectMime: true } },
  { type: "request", id: "id", operation: "health", arguments: { smuggled: true } },
  { type: "request.chunk", id: "id", sequence: -1, encoding: "base64", data: "" },
  { type: "request.end", id: "id", bytes: -1, sha256: "x" },
  { type: "hello", protocol: 2, nonce: "n".repeat(16), artifactSha256: "a".repeat(64), artifactVersion: "1", hiddenPaths: [], mountPaths: [], exitAfterProbe: false },
];
