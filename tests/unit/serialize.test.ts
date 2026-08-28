import { readFile } from "node:fs/promises";

import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { Value } from "@sinclair/typebox/value";
import { beforeAll, describe, expect, it } from "vitest";

import {
  serializeActiveBranch,
  serializeSessionEntries,
} from "../../src/server/serialize.js";
import {
  NormalizedMessageSchema,
  type AssistantMessage,
} from "../../src/shared/protocol.js";

interface SerializationFixture {
  readonly activeBranch: unknown[];
  readonly offBranch: unknown[];
}

let fixture: SerializationFixture;

beforeAll(async () => {
  fixture = JSON.parse(
    await readFile(
      new URL("../fixtures/session-serialization.json", import.meta.url),
      "utf8",
    ),
  ) as SerializationFixture;
});

describe("session serialization", () => {
  it("projects the active branch with entry IDs, content, tool links, and failures", () => {
    let branchReads = 0;
    const messages = serializeActiveBranch(
      {
        getBranch: () => {
          branchReads += 1;
          return fixture.activeBranch as SessionEntry[];
        },
      },
      { maxToolOutputBytes: 1024 },
    );

    expect(branchReads).toBe(1);
    expect(messages.map(({ entryId }) => entryId)).toEqual([
      "user-1",
      "assistant-1",
      "tool-result-ok",
      "assistant-failed-call",
      "tool-result-failed",
      "assistant-model-error",
      "malformed-user",
    ]);
    expect(messages.every((message) => Value.Check(NormalizedMessageSchema, message))).toBe(
      true,
    );

    expect(messages[0]).toEqual({
      entryId: "user-1",
      role: "user",
      timestamp: 1000,
      forkEligible: false,
      blocks: [
        {
          type: "text",
          text: "Describe <script>alert('untrusted')</script>",
        },
        {
          type: "image",
          image: {
            mimeType: "image/jpeg",
            encoding: "base64",
            data: "/9j/fixture",
          },
        },
      ],
    });

    const assistant = messages[1] as AssistantMessage;
    expect(assistant).toMatchObject({
      entryId: "assistant-1",
      stopReason: "tool-use",
      usage: {
        inputTokens: 12,
        outputTokens: 7,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        totalCost: 0.03,
      },
    });
    expect(assistant.blocks).toEqual([
      { type: "thinking", text: "Inspect the fixture." },
      { type: "text", text: "Calling <b>read</b>." },
      {
        type: "tool-call",
        toolCallId: "call-ok",
        toolName: "read",
        arguments: { path: "README.md" },
        status: "succeeded",
      },
    ]);

    expect(messages[2]?.blocks).toEqual([
      {
        type: "tool-result",
        toolCallId: "call-ok",
        toolName: "read",
        content: "<b>raw tool output</b>\nπ🙂tail",
        isError: false,
        truncated: false,
      },
      {
        type: "image",
        image: {
          mimeType: "image/png",
          encoding: "base64",
          data: "iVBORfixture",
        },
      },
    ]);
    expect((messages[3] as AssistantMessage).blocks[0]).toMatchObject({
      type: "tool-call",
      status: "failed",
    });
    expect(messages[4]?.blocks[0]).toMatchObject({
      type: "tool-result",
      isError: true,
    });

    const failed = messages[5] as AssistantMessage;
    expect(failed).toMatchObject({
      stopReason: "error",
      timestamp: Date.parse("2025-01-01T00:00:08.000Z"),
      error: {
        code: "model_failed",
        message: "The model failed while processing the prompt.",
      },
    });
    expect(failed).not.toHaveProperty("usage");
    expect(JSON.stringify(failed)).not.toContain("/home/operator");

    expect(messages[6]).toEqual({
      entryId: "malformed-user",
      role: "user",
      blocks: [],
      forkEligible: false,
    });
    expect(messages.some(({ entryId }) => entryId === "off-branch-user")).toBe(
      false,
    );
  });

  it("exposes fork eligibility only for canonical Pi user entry IDs", () => {
    const messages = serializeSessionEntries([
      {
        type: "message",
        id: "a1b2c3d4",
        message: { role: "user", content: "eligible" },
      },
      {
        type: "message",
        id: "stream:session:1",
        message: { role: "user", content: "synthetic" },
      },
      {
        type: "message",
        id: "deadbeef",
        message: { role: "assistant", content: [] },
      },
    ]);

    expect(messages).toMatchObject([
      { entryId: "a1b2c3d4", role: "user", forkEligible: true },
      { entryId: "stream:session:1", role: "user", forkEligible: false },
      { entryId: "deadbeef", role: "assistant" },
    ]);
    expect(messages[2]).not.toHaveProperty("forkEligible");
  });

  it("truncates tool text on a valid UTF-8 boundary and retains byte metadata", () => {
    const prefix = "<b>raw tool output</b>\nπ";
    const messages = serializeSessionEntries(
      fixture.activeBranch,
      { maxToolOutputBytes: Buffer.byteLength(prefix) },
    );
    const result = messages[2]?.blocks[0];

    expect(result).toEqual({
      type: "tool-result",
      toolCallId: "call-ok",
      toolName: "read",
      content: prefix,
      isError: false,
      truncated: true,
      originalBytes:
        Buffer.byteLength("<b>raw tool output</b>\nπ🙂tail") +
        Buffer.byteLength("iVBORfixture"),
    });
  });

  it("bounds combined tool text and image output", () => {
    const messages = serializeSessionEntries(
      [{
        type: "message",
        id: "tool-large-image",
        message: {
          role: "toolResult",
          toolCallId: "call-image",
          toolName: "capture",
          content: [
            { type: "text", text: "ok" },
            { type: "image", mimeType: "image/png", data: "x".repeat(32) },
          ],
          isError: false,
        },
      }],
      { maxToolOutputBytes: 16 },
    );

    expect(messages[0]?.blocks).toEqual([{
      type: "tool-result",
      toolCallId: "call-image",
      toolName: "capture",
      content: "ok",
      isError: false,
      truncated: true,
      originalBytes: 34,
    }]);
  });

  it("replaces large tool-result image data with a browser image reference", () => {
    const messages = serializeSessionEntries(
      [{
        type: "message",
        id: "tool-image-entry",
        message: {
          role: "toolResult",
          toolCallId: "call-image",
          toolName: "read",
          content: [
            { type: "text", text: "Read image file [image/png]" },
            {
              type: "image",
              mimeType: "image/png",
              data: "x".repeat(250_000),
            },
          ],
          isError: false,
        },
      }],
      {
        maxToolOutputBytes: 64 * 1024,
        toolImageUrl: (entryId, imageIndex) =>
          `/api/test/${entryId}/${String(imageIndex)}`,
      },
    );

    expect(messages[0]?.blocks).toEqual([
      {
        type: "tool-result",
        toolCallId: "call-image",
        toolName: "read",
        content: "Read image file [image/png]",
        isError: false,
        truncated: false,
      },
      {
        type: "image",
        image: {
          mimeType: "image/png",
          url: "/api/test/tool-image-entry/0",
        },
        alt: "Generated image",
      },
    ]);
  });

  it("omits usage when the SDK does not provide reliable integer token counts", () => {
    const messages = serializeSessionEntries([{
      type: "message",
      id: "assistant-fractional-usage",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        stopReason: "stop",
        usage: {
          input: 1.5,
          output: 2,
          cacheRead: 1,
          cacheWrite: 0,
          cost: { total: 0.001 },
        },
      },
    }]);

    expect(messages[0]).not.toHaveProperty("usage");
  });

  it("rejects invalid serializer bounds", () => {
    expect(() =>
      serializeSessionEntries(fixture.activeBranch, { maxToolOutputBytes: 0 }),
    ).toThrow(RangeError);
  });
});
