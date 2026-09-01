import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  OrderedChunkAssembler,
  SANDBOX_MAX_FRAME_BYTES,
  SandboxFrameDecoder,
  SandboxProtocolError,
  chunkBuffer,
  encodeSandboxFrame,
  isParentFrame,
  isWorkerFrame,
} from "../../src/server/sandbox/protocol.js";
import { workerIsParentFrame } from "../../src/server/sandbox/worker-protocol.js";
import { invalidParentFrames, validParentFrames } from "../fixtures/sandbox/protocol-frames.js";

describe("sandbox framed protocol", () => {
  it("keeps dependency-free worker validation in lockstep with TypeBox", () => {
    for (const frame of validParentFrames) {
      expect(isParentFrame(frame), JSON.stringify(frame)).toBe(true);
      expect(workerIsParentFrame(frame), JSON.stringify(frame)).toBe(true);
    }
    for (const frame of invalidParentFrames) {
      expect(isParentFrame(frame), JSON.stringify(frame)).toBe(false);
      expect(workerIsParentFrame(frame), JSON.stringify(frame)).toBe(false);
    }
  });

  it("decodes partial prefixes/payloads and coalesced frames incrementally", () => {
    const frames = [
      { type: "shutdown.complete" as const },
      { type: "error" as const, id: "request_1", code: "not_found" as const },
    ];
    const wire = Buffer.concat(frames.map(encodeSandboxFrame));
    const decoder = new SandboxFrameDecoder(isWorkerFrame);
    const decoded: unknown[] = [];
    for (const byte of wire) decoded.push(...decoder.push(Buffer.from([byte])));
    decoder.end();
    expect(decoded).toEqual(frames);

    const coalesced = new SandboxFrameDecoder(isWorkerFrame);
    expect(coalesced.push(wire)).toEqual(frames);
    coalesced.end();
  });

  it.each([0, SANDBOX_MAX_FRAME_BYTES + 1, 0xffff_ffff])("rejects invalid frame length %s before payload allocation", (length) => {
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(length);
    expect(() => new SandboxFrameDecoder(isWorkerFrame).push(prefix)).toThrow(SandboxProtocolError);
  });

  it("rejects malformed UTF-8, JSON, closed-schema additions, and truncated input", () => {
    const framed = (payload: Buffer) => {
      const prefix = Buffer.alloc(4); prefix.writeUInt32BE(payload.byteLength);
      return Buffer.concat([prefix, payload]);
    };
    expect(() => new SandboxFrameDecoder(isWorkerFrame).push(framed(Buffer.from([0xc3, 0x28])))).toThrow();
    expect(() => new SandboxFrameDecoder(isWorkerFrame).push(framed(Buffer.from("{")))).toThrow();
    expect(() => new SandboxFrameDecoder(isWorkerFrame).push(framed(Buffer.from('{"type":"shutdown.complete","extra":1}')))).toThrow();
    const decoder = new SandboxFrameDecoder(isWorkerFrame);
    decoder.push(Buffer.from([0, 0]));
    expect(() => decoder.end()).toThrow();
  });

  it("assembles ordered bounded chunks and verifies byte counts and hashes", () => {
    const data = Buffer.alloc(2 * 768 * 1024 + 17, 0x5a);
    const chunks = chunkBuffer(data);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(encodeSandboxFrame({ type: "request.chunk", id: "i".repeat(128), ...chunk }).byteLength)
        .toBeLessThanOrEqual(SANDBOX_MAX_FRAME_BYTES + 4);
    }
    const assembler = new OrderedChunkAssembler();
    for (const chunk of chunks) assembler.push(chunk);
    expect(assembler.finish(data.byteLength, createHash("sha256").update(data).digest("hex"))).toEqual(data);

    const gap = new OrderedChunkAssembler();
    expect(() => gap.push({ sequence: 1, encoding: "base64", data: "" })).toThrow(/sequence/);
    const mismatch = new OrderedChunkAssembler();
    mismatch.push({ sequence: 0, encoding: "utf8", data: "hello" });
    expect(() => mismatch.finish(5, "0".repeat(64))).toThrow(/hash/);

    const zeroFlood = new OrderedChunkAssembler();
    expect(() => {
      for (let sequence = 0; sequence < 100; sequence += 1) {
        zeroFlood.push({ sequence, encoding: "base64", data: "" });
      }
    }).toThrow(/too many/);
  });
});
