import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { type Static, Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const SANDBOX_MAX_FRAME_BYTES = 1024 * 1024;
export const SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES = 16 * 1024 * 1024;
export const SANDBOX_MAX_ACTIVE_OPERATIONS = 8;
export const SANDBOX_MAX_PENDING_OUTPUT_BYTES = 4 * 1024 * 1024;
export const SANDBOX_MAX_PENDING_OUTPUT_FRAMES = 1_024;
// Leave room for base64 expansion plus the closed JSON envelope under 1 MiB.
export const SANDBOX_MAX_RAW_CHUNK_BYTES = 767 * 1024;
export const SANDBOX_MAX_DIAGNOSTIC_BYTES = 16 * 1024;

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });
const IdSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" });
const PathSchema = Type.String({ minLength: 1, maxLength: 16_384 });
const Sha256Schema = Type.String({ pattern: "^[a-f0-9]{64}$" });
const BytesSchema = Type.Integer({ minimum: 0, maximum: SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES });
const SequenceSchema = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const EncodingSchema = Type.Union([Type.Literal("utf8"), Type.Literal("base64")]);

export const SandboxOperationSchema = Type.Union([
  Type.Literal("readFile"), Type.Literal("writeFile"), Type.Literal("editFile"),
  Type.Literal("listDirectory"), Type.Literal("grep"), Type.Literal("find"),
  Type.Literal("exec"), Type.Literal("health"),
]);
export type SandboxOperation = Static<typeof SandboxOperationSchema>;

export const ReadFileArgumentsSchema = strictObject({
  path: PathSchema,
  maxBytes: Type.Integer({ minimum: 1, maximum: SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES }),
  detectMime: Type.Boolean(),
});
export interface ReadFileArguments extends Static<typeof ReadFileArgumentsSchema> {}
export const WriteFileArgumentsSchema = strictObject({
  path: PathSchema,
  createParents: Type.Boolean(),
  encoding: EncodingSchema,
  bytes: BytesSchema,
  sha256: Sha256Schema,
});
export interface WriteFileArguments extends Static<typeof WriteFileArgumentsSchema> {}
const EditReplacementSchema = strictObject({ oldText: Type.String(), newText: Type.String() });
export const EditFileArgumentsSchema = strictObject({
  path: PathSchema,
  edits: Type.Array(EditReplacementSchema, { minItems: 1, maxItems: 1_000 }),
});
export interface EditFileArguments extends Static<typeof EditFileArgumentsSchema> {}
export const ListDirectoryArgumentsSchema = strictObject({
  path: PathSchema,
  includeHidden: Type.Boolean(),
  limit: Type.Integer({ minimum: 1, maximum: 100_000 }),
});
export interface ListDirectoryArguments extends Static<typeof ListDirectoryArgumentsSchema> {}
export const GrepArgumentsSchema = strictObject({
  path: PathSchema,
  pattern: Type.String({ maxLength: 65_536 }),
  literal: Type.Boolean(), caseSensitive: Type.Boolean(), includeHidden: Type.Boolean(),
  glob: Type.Optional(Type.String({ maxLength: 16_384 })),
  context: Type.Integer({ minimum: 0, maximum: 1_000 }),
  limit: Type.Integer({ minimum: 1, maximum: 100_000 }),
});
export interface GrepArguments extends Static<typeof GrepArgumentsSchema> {}
export const FindArgumentsSchema = strictObject({
  path: PathSchema,
  glob: Type.String({ maxLength: 16_384 }),
  includeHidden: Type.Boolean(),
  limit: Type.Integer({ minimum: 1, maximum: 100_000 }),
});
export interface FindArguments extends Static<typeof FindArgumentsSchema> {}
export const ExecArgumentsSchema = strictObject({
  command: Type.String({ minLength: 1, maxLength: SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES }),
  timeoutMs: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
export interface ExecArguments extends Static<typeof ExecArgumentsSchema> {}
export const HealthArgumentsSchema = strictObject({});
export interface HealthArguments extends Static<typeof HealthArgumentsSchema> {}

export const OperationArgumentsSchemas = Object.freeze({
  readFile: ReadFileArgumentsSchema, writeFile: WriteFileArgumentsSchema,
  editFile: EditFileArgumentsSchema, listDirectory: ListDirectoryArgumentsSchema,
  grep: GrepArgumentsSchema, find: FindArgumentsSchema, exec: ExecArgumentsSchema,
  health: HealthArgumentsSchema,
});

const FileMetadataSchema = strictObject({
  name: Type.String(), type: Type.Union([Type.Literal("file"), Type.Literal("directory"), Type.Literal("symlink"), Type.Literal("other")]),
  size: Type.Integer({ minimum: 0 }), modifiedMs: Type.Number({ minimum: 0 }),
});
export const ReadFileResultSchema = strictObject({ mimeType: Type.Union([Type.String(), Type.Null()]) });
export interface ReadFileResult extends Static<typeof ReadFileResultSchema> { readonly data: Buffer }
export const WriteFileResultSchema = strictObject({ bytesWritten: Type.Integer({ minimum: 0 }) });
export interface WriteFileResult extends Static<typeof WriteFileResultSchema> {}
export const EditFileResultSchema = strictObject({
  diff: Type.String(), patch: Type.String(), firstChangedLine: Type.Integer({ minimum: 1 }),
});
export interface EditFileResult extends Static<typeof EditFileResultSchema> {}
export const ListDirectoryResultSchema = strictObject({
  entries: Type.Array(FileMetadataSchema), truncated: Type.Boolean(),
});
export interface ListDirectoryResult extends Static<typeof ListDirectoryResultSchema> {}
const TruncationResultSchema = strictObject({
  truncated: Type.Boolean(), truncatedBy: Type.Union([Type.Literal("lines"), Type.Literal("bytes"), Type.Null()]),
  totalLines: Type.Integer({ minimum: 0 }), totalBytes: Type.Integer({ minimum: 0 }),
  outputLines: Type.Integer({ minimum: 0 }), outputBytes: Type.Integer({ minimum: 0 }),
  lastLinePartial: Type.Boolean(), firstLineExceedsLimit: Type.Boolean(),
  maxLines: Type.Integer({ minimum: 1 }), maxBytes: Type.Integer({ minimum: 1 }),
});
export const GrepResultSchema = strictObject({
  text: Type.String(), matches: Type.Integer({ minimum: 0 }), truncated: Type.Boolean(),
  matchLimitReached: Type.Optional(Type.Integer({ minimum: 1 })),
  linesTruncated: Type.Optional(Type.Literal(true)),
  truncation: Type.Optional(TruncationResultSchema),
});
export interface GrepResult extends Static<typeof GrepResultSchema> {}
export const FindResultSchema = strictObject({
  paths: Type.Array(Type.String()), text: Type.Optional(Type.String()), truncated: Type.Boolean(),
  resultLimitReached: Type.Optional(Type.Integer({ minimum: 1 })),
  truncation: Type.Optional(TruncationResultSchema),
});
export interface FindResult extends Static<typeof FindResultSchema> {}
export const ExecResultSchema = strictObject({
  exitCode: Type.Union([Type.Integer(), Type.Null()]), signal: Type.Union([Type.String(), Type.Null()]),
  timedOut: Type.Boolean(), fullOutputPath: Type.Union([Type.String(), Type.Null()]),
});
export interface ExecResult extends Static<typeof ExecResultSchema> {}
export const HealthResultSchema = strictObject({ healthy: Type.Literal(true) });
export interface HealthResult extends Static<typeof HealthResultSchema> {}

export const OperationResultSchemas = Object.freeze({
  readFile: ReadFileResultSchema, writeFile: WriteFileResultSchema,
  editFile: EditFileResultSchema, listDirectory: ListDirectoryResultSchema,
  grep: GrepResultSchema, find: FindResultSchema, exec: ExecResultSchema,
  health: HealthResultSchema,
});

export const WorkerErrorCodeSchema = Type.Union([
  Type.Literal("invalid_arguments"), Type.Literal("not_found"), Type.Literal("permission_denied"),
  Type.Literal("not_a_file"), Type.Literal("not_a_directory"), Type.Literal("already_exists"),
  Type.Literal("ambiguous_edit"), Type.Literal("overlapping_edits"), Type.Literal("content_mismatch"),
  Type.Literal("output_limit"), Type.Literal("timeout"), Type.Literal("cancelled"),
  Type.Literal("operation_failed"), Type.Literal("operation_not_implemented"),
]);
export type WorkerErrorCode = Static<typeof WorkerErrorCodeSchema>;

export const HelloFrameSchema = strictObject({
  type: Type.Literal("hello"), protocol: Type.Literal(1),
  nonce: Type.String({ minLength: 16, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" }), artifactSha256: Sha256Schema,
  artifactVersion: Type.String({ minLength: 1, maxLength: 64 }),
  hiddenPaths: Type.Array(Type.String(), { maxItems: 1_000 }),
  mountPaths: Type.Array(Type.String(), { maxItems: 1_000 }),
  exitAfterProbe: Type.Boolean(),
  commandTimeoutMs: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
  maxCommandOutputBytes: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
});
const requestSchema = <T extends SandboxOperation>(operation: T, argumentsSchema: (typeof OperationArgumentsSchemas)[T]) =>
  strictObject({ type: Type.Literal("request"), id: IdSchema, operation: Type.Literal(operation), arguments: argumentsSchema });
export const RequestFrameSchema = Type.Union([
  requestSchema("readFile", ReadFileArgumentsSchema), requestSchema("writeFile", WriteFileArgumentsSchema),
  requestSchema("editFile", EditFileArgumentsSchema), requestSchema("listDirectory", ListDirectoryArgumentsSchema),
  requestSchema("grep", GrepArgumentsSchema), requestSchema("find", FindArgumentsSchema),
  requestSchema("exec", ExecArgumentsSchema), requestSchema("health", HealthArgumentsSchema),
]);
export const RequestChunkFrameSchema = strictObject({
  type: Type.Literal("request.chunk"), id: IdSchema, sequence: SequenceSchema,
  encoding: EncodingSchema, data: Type.String({ maxLength: SANDBOX_MAX_FRAME_BYTES }),
});
export const RequestEndFrameSchema = strictObject({
  type: Type.Literal("request.end"), id: IdSchema, bytes: BytesSchema, sha256: Sha256Schema,
});
export const CancelFrameSchema = strictObject({ type: Type.Literal("cancel"), id: IdSchema });
export const CancelAllFrameSchema = strictObject({ type: Type.Literal("cancel.all") });
export const ShutdownFrameSchema = strictObject({ type: Type.Literal("shutdown") });
export const ParentFrameSchema = Type.Union([
  HelloFrameSchema, RequestFrameSchema, RequestChunkFrameSchema, RequestEndFrameSchema,
  CancelFrameSchema, CancelAllFrameSchema, ShutdownFrameSchema,
]);
export type ParentFrame = Static<typeof ParentFrameSchema>;

const NamespaceProbeSchema = strictObject({
  user: Type.String(), mnt: Type.String(), pid: Type.String(), ipc: Type.String(), uts: Type.String(), net: Type.String(),
});
const EnvironmentProbeSchema = Type.Record(Type.String(), Type.String());
const CommandProbeSchema = strictObject({
  status: Type.Union([Type.Integer(), Type.Null()]), signal: Type.Optional(Type.Union([Type.String(), Type.Null()])), stdout: Type.String(),
});
const ConnectProbeSchema = strictObject({
  connected: Type.Boolean(), error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const DnsProbeSchema = strictObject({
  resolved: Type.Boolean(), address: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  error: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
const ProtocolDescriptorsSchema = Type.Record(Type.String(), Type.String());
const CommonNetworkProbe = {
  ipv4: ConnectProbeSchema, ipv6: ConnectProbeSchema,
  loopback4: ConnectProbeSchema, loopback6: ConnectProbeSchema,
  dns: DnsProbeSchema, protocolDescriptors: ProtocolDescriptorsSchema,
};
const IsolatedNetworkProbeSchema = strictObject({
  profile: Type.Literal("isolated"), ...CommonNetworkProbe,
});
const ManagedNetworkProbeSchema = strictObject({
  profile: Type.Literal("managed-egress"),
  helperVersion: Type.String(),
  guestPorts: strictObject({ http: Type.Integer({ minimum: 1, maximum: 65_535 }), socks: Type.Integer({ minimum: 1, maximum: 65_535 }) }),
  ...CommonNetworkProbe,
  httpEndpoint: ConnectProbeSchema, socksEndpoint: ConnectProbeSchema,
  httpLocalDenial: strictObject({ connected: Type.Boolean(), denied: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]) }),
  socksLocalDenial: strictObject({ connected: Type.Boolean(), denied: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]) }),
  directWithoutProxy: strictObject({ blocked: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]) }),
  unixSocket: strictObject({ created: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]) }),
  unixSocketpair: strictObject({ available: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]) }),
});
export const WorkerProbeSchema = strictObject({
  namespaces: NamespaceProbeSchema, hostname: Type.String(),
  capInh: Type.String(), capPrm: Type.String(), capEff: Type.String(), capBnd: Type.String(), capAmb: Type.String(),
  noNewPrivs: Type.String(), seccomp: Type.String(),
  environment: EnvironmentProbeSchema, rootEntries: Type.Array(Type.String()), devEntries: Type.Array(Type.String()), etcEntries: Type.Array(Type.String()),
  hiddenPaths: Type.Array(Type.Boolean()),
  chatwcaMask: strictObject({ hostSessionHidden: Type.Boolean(), guestWriteVisible: Type.Boolean() }),
  workspace: strictObject({ dev: Type.String(), ino: Type.String(), marker: Type.String() }),
  mountIdentities: Type.Record(Type.String(), strictObject({ dev: Type.String(), ino: Type.String(), readOnly: Type.Boolean() })),
  artifact: strictObject({ sha256: Sha256Schema, version: Type.String({ minLength: 1, maxLength: 64 }) }),
  commands: strictObject({ node: CommandProbeSchema, bash: CommandProbeSchema, rg: CommandProbeSchema }),
  network: Type.Union([IsolatedNetworkProbeSchema, ManagedNetworkProbeSchema]),
});
export const ReadyFrameSchema = strictObject({
  type: Type.Literal("ready"), protocol: Type.Literal(1), nonce: Type.String({ minLength: 16, maxLength: 256, pattern: "^[A-Za-z0-9_-]+$" }),
  probe: WorkerProbeSchema,
});
export const OutputFrameSchema = strictObject({
  type: Type.Literal("output"), id: IdSchema, sequence: SequenceSchema,
  stream: Type.Union([Type.Literal("stdout"), Type.Literal("stderr")]), data: Type.String(),
});
export const ResponseFrameSchema = strictObject({ type: Type.Literal("response"), id: IdSchema, result: Type.Unknown() });
export const ResponseChunkFrameSchema = strictObject({
  type: Type.Literal("response.chunk"), id: IdSchema, sequence: SequenceSchema,
  encoding: EncodingSchema, data: Type.String({ maxLength: SANDBOX_MAX_FRAME_BYTES }),
});
export const ResponseEndFrameSchema = strictObject({
  type: Type.Literal("response.end"), id: IdSchema, bytes: BytesSchema, sha256: Sha256Schema,
  result: Type.Unknown(),
});
export const ErrorFrameSchema = strictObject({ type: Type.Literal("error"), id: IdSchema, code: WorkerErrorCodeSchema });
export const ShutdownCompleteFrameSchema = strictObject({ type: Type.Literal("shutdown.complete") });
export const WorkerFrameSchema = Type.Union([
  ReadyFrameSchema, OutputFrameSchema, ResponseFrameSchema, ResponseChunkFrameSchema,
  ResponseEndFrameSchema, ErrorFrameSchema, ShutdownCompleteFrameSchema,
]);
export type WorkerFrame = Static<typeof WorkerFrameSchema>;

export class SandboxProtocolError extends Error {
  override readonly name = "SandboxProtocolError";
}

export function isParentFrame(value: unknown): value is ParentFrame {
  return Value.Check(ParentFrameSchema, value);
}
export function isWorkerFrame(value: unknown): value is WorkerFrame {
  return Value.Check(WorkerFrameSchema, value);
}
export function validateOperationArguments<T extends SandboxOperation>(operation: T, value: unknown): value is Static<(typeof OperationArgumentsSchemas)[T]> {
  return Value.Check(OperationArgumentsSchemas[operation], value);
}
export function validateOperationResult<T extends SandboxOperation>(operation: T, value: unknown): value is Static<(typeof OperationResultSchemas)[T]> {
  return Value.Check(OperationResultSchemas[operation], value);
}

export function encodeSandboxFrame(value: ParentFrame | WorkerFrame): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.byteLength === 0 || payload.byteLength > SANDBOX_MAX_FRAME_BYTES) {
    throw new SandboxProtocolError("sandbox frame exceeds limit");
  }
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

/** Incremental decoder which validates the length before allocating its payload. */
export class SandboxFrameDecoder {
  readonly #validate: (value: unknown) => boolean;
  readonly #prefix = Buffer.allocUnsafe(4);
  #prefixBytes = 0;
  #payload: Buffer | undefined;
  #payloadBytes = 0;

  constructor(validate: (value: unknown) => boolean) { this.#validate = validate; }

  push(chunk: Buffer | Uint8Array): unknown[] {
    const source = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < source.byteLength) {
      if (this.#payload === undefined) {
        const take = Math.min(4 - this.#prefixBytes, source.byteLength - offset);
        source.copy(this.#prefix, this.#prefixBytes, offset, offset + take);
        this.#prefixBytes += take;
        offset += take;
        if (this.#prefixBytes < 4) continue;
        const length = this.#prefix.readUInt32BE(0);
        this.#prefixBytes = 0;
        if (length === 0 || length > SANDBOX_MAX_FRAME_BYTES) {
          throw new SandboxProtocolError("invalid sandbox frame length");
        }
        this.#payload = Buffer.allocUnsafe(length);
        this.#payloadBytes = 0;
      }
      const take = Math.min(this.#payload.byteLength - this.#payloadBytes, source.byteLength - offset);
      source.copy(this.#payload, this.#payloadBytes, offset, offset + take);
      this.#payloadBytes += take;
      offset += take;
      if (this.#payloadBytes !== this.#payload.byteLength) continue;
      const payload = this.#payload;
      this.#payload = undefined;
      this.#payloadBytes = 0;
      let value: unknown;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
        value = JSON.parse(text) as unknown;
      } catch (error) {
        throw new SandboxProtocolError(`invalid sandbox JSON/UTF-8: ${error instanceof Error ? error.message : "invalid"}`);
      }
      if (!this.#validate(value)) throw new SandboxProtocolError("sandbox frame schema mismatch");
      frames.push(value);
    }
    return frames;
  }

  end(): void {
    if (this.#prefixBytes !== 0 || this.#payload !== undefined) {
      throw new SandboxProtocolError("truncated sandbox frame");
    }
  }
}

export function decodeChunk(encoding: "utf8" | "base64", data: string): Buffer {
  if (encoding === "utf8") return Buffer.from(data, "utf8");
  if (data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
    throw new SandboxProtocolError("invalid base64 chunk");
  }
  return Buffer.from(data, "base64");
}

export class OrderedChunkAssembler {
  readonly #hash = createHash("sha256");
  readonly #chunks: Buffer[] = [];
  #sequence = 0;
  #bytes = 0;

  push(frame: { readonly sequence: number; readonly encoding: "utf8" | "base64"; readonly data: string }): void {
    if (frame.sequence !== this.#sequence) throw new SandboxProtocolError("chunk sequence gap");
    if (this.#sequence > Math.ceil(SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES / SANDBOX_MAX_RAW_CHUNK_BYTES)) {
      throw new SandboxProtocolError("too many chunks");
    }
    const chunk = decodeChunk(frame.encoding, frame.data);
    if (chunk.byteLength > SANDBOX_MAX_RAW_CHUNK_BYTES) throw new SandboxProtocolError("raw chunk exceeds limit");
    if (this.#bytes + chunk.byteLength > SANDBOX_MAX_ASSEMBLED_REQUEST_BYTES) throw new SandboxProtocolError("assembled data exceeds limit");
    this.#sequence += 1;
    this.#bytes += chunk.byteLength;
    this.#hash.update(chunk);
    this.#chunks.push(chunk);
  }

  get hasChunks(): boolean { return this.#sequence !== 0; }

  finish(bytes: number, sha256: string): Buffer {
    const actualHash = this.#hash.digest("hex");
    if (bytes !== this.#bytes || sha256 !== actualHash) throw new SandboxProtocolError("chunk byte count or hash mismatch");
    return Buffer.concat(this.#chunks, this.#bytes);
  }
}

export function chunkBuffer(data: Buffer, encoding: "utf8" | "base64" = "base64"): readonly { sequence: number; encoding: "utf8" | "base64"; data: string }[] {
  const chunks = [];
  for (let offset = 0, sequence = 0; offset < data.byteLength; offset += SANDBOX_MAX_RAW_CHUNK_BYTES, sequence += 1) {
    const chunk = data.subarray(offset, Math.min(data.byteLength, offset + SANDBOX_MAX_RAW_CHUNK_BYTES));
    chunks.push({ sequence, encoding, data: chunk.toString(encoding) });
  }
  return chunks;
}
