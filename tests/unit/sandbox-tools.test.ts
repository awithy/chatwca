import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

import {
  SANDBOX_TOOL_NAMES,
  createSandboxTools,
  type SandboxToolController,
} from "../../src/server/sandbox/tools.js";

function controller(overrides: Partial<SandboxToolController> = {}): SandboxToolController {
  return {
    readFile: vi.fn(async () => ({ data: Buffer.from("one\ntwo\nthree"), mimeType: null })),
    writeFile: vi.fn(async (_path, data) => ({ bytesWritten: Buffer.byteLength(data) })),
    editFile: vi.fn(async () => ({ diff: "+1 changed", patch: "--- a\n+++ a\n", firstChangedLine: 1 })),
    listDirectory: vi.fn(async () => ({
      entries: [
        { name: ".env", type: "file", size: 1, modifiedMs: 1 },
        { name: "src", type: "directory", size: 1, modifiedMs: 1 },
      ],
      truncated: false,
    })),
    grep: vi.fn(async () => ({ text: "a.ts:1: match", matches: 1, truncated: false })),
    find: vi.fn(async () => ({ paths: ["a.ts"], text: "a.ts", truncated: false })),
    exec: vi.fn(async (_input, options) => {
      await options?.onOutput?.({ stream: "stdout", sequence: 0, data: "streamed\n" });
      return { exitCode: 0, signal: null, timedOut: false, fullOutputPath: null };
    }),
    ...overrides,
  };
}

const sources = [
  createReadToolDefinition("/workspace"),
  createWriteToolDefinition("/workspace"),
  createEditToolDefinition("/workspace"),
  createBashToolDefinition("/workspace", { exposeSessionEnvironment: false }),
  createLsToolDefinition("/workspace"),
  createGrepToolDefinition("/workspace"),
  createFindToolDefinition("/workspace"),
];

describe("sandbox Pi tools", () => {
  it("copies pinned 0.84.3 metadata and schemas but no host-probing renderers", () => {
    const tools = createSandboxTools(controller());
    expect(tools.map((tool) => tool.name)).toEqual(SANDBOX_TOOL_NAMES);
    for (const [index, tool] of tools.entries()) {
      const source = sources[index]!;
      expect(tool).toMatchObject({
        name: source.name,
        label: source.label,
        description: source.description,
        promptSnippet: source.promptSnippet,
        parameters: source.parameters,
      });
      expect(tool.promptGuidelines).toEqual(source.promptGuidelines);
      expect(tool.execute).not.toBe(source.execute);
      expect(tool).not.toHaveProperty("renderCall");
      expect(tool).not.toHaveProperty("renderResult");
      expect(tool).not.toHaveProperty("renderShell");
    }
    expect(tools.find((tool) => tool.name === "bash")?.promptGuidelines).toBeUndefined();
    expect(tools.find((tool) => tool.name === "edit")?.prepareArguments).toBe(sources[2]!.prepareArguments);
  });

  it("brokers all seven executions and preserves normalized result details", async () => {
    const port = controller();
    const tools = Object.fromEntries(createSandboxTools(port).map((tool) => [tool.name, tool]));
    const ctx = { model: { input: ["text", "image"] } } as never;

    await expect(tools.read!.execute("r", { path: "a.txt", offset: 2, limit: 1 }, undefined, undefined, ctx))
      .resolves.toMatchObject({ content: [{ type: "text", text: expect.stringContaining("two") }] });
    await expect(tools.write!.execute("w", { path: "new.txt", content: "hello" }, undefined, undefined, ctx))
      .resolves.toMatchObject({ content: [{ text: "Successfully wrote 5 bytes to new.txt" }] });
    await expect(tools.edit!.execute("e", { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] }, undefined, undefined, ctx))
      .resolves.toMatchObject({ details: { diff: "+1 changed", firstChangedLine: 1 } });

    const updates: unknown[] = [];
    await expect(tools.bash!.execute("b", { command: "printf streamed" }, undefined, (update) => updates.push(update), ctx))
      .resolves.toMatchObject({ content: [{ text: "streamed\n" }] });
    expect(updates.length).toBeGreaterThanOrEqual(2);

    await expect(tools.ls!.execute("l", {}, undefined, undefined, ctx))
      .resolves.toMatchObject({ content: [{ text: ".env\nsrc/" }] });
    await expect(tools.grep!.execute("g", { pattern: "match" }, undefined, undefined, ctx))
      .resolves.toMatchObject({ content: [{ text: "a.ts:1: match" }] });
    await expect(tools.find!.execute("f", { pattern: "*.ts" }, undefined, undefined, ctx))
      .resolves.toMatchObject({ content: [{ text: "a.ts" }] });

    expect(port.readFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: "a.txt", detectMime: true }),
      {},
    );
    expect(port.writeFile).toHaveBeenCalledWith("new.txt", "hello", { createParents: true });
    expect(port.editFile).toHaveBeenCalledWith(
      { path: "a.txt", edits: [{ oldText: "a", newText: "b" }] },
      {},
    );
    expect(port.exec).toHaveBeenCalledWith(
      { command: "printf streamed", timeoutMs: Number.MAX_SAFE_INTEGER },
      expect.objectContaining({ onOutput: expect.any(Function) }),
    );
    expect(port.listDirectory).toHaveBeenCalledWith(
      { path: ".", includeHidden: true, limit: 500 },
      {},
    );
    expect(port.grep).toHaveBeenCalledWith(
      expect.objectContaining({ path: ".", pattern: "match", includeHidden: true, limit: 100 }),
      {},
    );
    expect(port.find).toHaveBeenCalledWith(
      { path: ".", glob: "*.ts", includeHidden: true, limit: 1_000 },
      {},
    );
  });

  it("returns Pi image content from worker bytes without opening a parent path", async () => {
    const readFile = vi.fn(async () => ({
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      mimeType: "image/png",
    }));
    const read = createSandboxTools(controller({ readFile })).find((tool) => tool.name === "read")!;
    const result = await read.execute("r", { path: "image.png" }, undefined, undefined, { model: { input: ["text", "image"] } } as never);
    expect(result.content).toEqual([
      { type: "text", text: "Read image file [image/png]" },
      { type: "image", data: "iVBORw==", mimeType: "image/png" },
    ]);
    expect(readFile).toHaveBeenCalledOnce();
  });

  it("keeps every thrown error generic and strips edit legacy arguments before validation", async () => {
    const failure = controller({ readFile: vi.fn(async () => { throw new Error("/host/secret: EACCES"); }) });
    const tools = createSandboxTools(failure);
    const read = tools.find((tool) => tool.name === "read")!;
    await expect(read.execute("r", { path: "/host/secret" }, undefined, undefined, {} as never))
      .rejects.toThrow(/^Sandbox tool operation failed$/);

    const edit = tools.find((tool) => tool.name === "edit")!;
    expect(edit.prepareArguments?.({ path: "a", oldText: "x", newText: "y" })).toEqual({
      path: "a",
      edits: [{ oldText: "x", newText: "y" }],
    });
  });
});
