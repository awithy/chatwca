import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  ModelRuntime,
  SessionManager,
  createAgentSessionFromServices,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SandboxResourceLoader,
  createStrictSettingsManager,
} from "../../src/server/sandbox/resources.js";
import {
  SANDBOX_TOOL_NAMES,
  createSandboxTools,
  type SandboxToolController,
} from "../../src/server/sandbox/tools.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function fakeController(): SandboxToolController {
  return {
    readFile: vi.fn(async () => ({ data: Buffer.from("sandbox read"), mimeType: null })),
    writeFile: vi.fn(async () => ({ bytesWritten: 1 })),
    editFile: vi.fn(async () => ({ diff: "+x", patch: "--- a\n+++ a\n", firstChangedLine: 1 })),
    listDirectory: vi.fn(async () => ({ entries: [], truncated: false })),
    grep: vi.fn(async () => ({ text: "No matches found", matches: 0, truncated: false })),
    find: vi.fn(async () => ({ paths: [], text: "No files found matching pattern", truncated: false })),
    exec: vi.fn(async () => ({ exitCode: 0, signal: null, timedOut: false, fullOutputPath: null })),
  };
}

describe("strict Pi sandbox contract", () => {
  it("constructs an exact app-owned allowlist with a host-path-free system prompt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatwca-strict-pi-"));
    roots.push(root);
    const workspace = path.join(root, "canonical-host-workspace");
    const agentDir = path.join(root, "private-agent");
    const dataDir = path.join(root, "private-data");
    const sessionFile = path.join(root, "private-sessions", "session.jsonl");
    await Promise.all([mkdir(workspace), mkdir(agentDir), mkdir(dataDir), mkdir(path.dirname(sessionFile))]);
    await writeFile(path.join(workspace, "AGENTS.md"), "Only use guest paths.");
    await mkdir(path.join(workspace, ".pi", "extensions"), { recursive: true });
    await writeFile(path.join(workspace, ".pi", "extensions", "leak.ts"), "export default pi => pi.registerTool({name:'leak'})");

    const faux = fauxProvider({ provider: "normal-faux", tokensPerSecond: 10_000 });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("read", { path: "README.md" }),
        fauxToolCall("write", { path: "new.txt", content: "new" }),
        fauxToolCall("edit", { path: "old.txt", edits: [{ oldText: "old", newText: "new" }] }),
        fauxToolCall("bash", { command: "printf ok" }),
        fauxToolCall("ls", {}),
        fauxToolCall("grep", { pattern: "needle" }),
        fauxToolCall("find", { pattern: "*.ts" }),
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("parent provider response"),
    ]);
    const strictRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: path.join(root, "strict-models-store.json"),
    });
    strictRuntime.registerNativeProvider(faux.provider);
    const loader = await SandboxResourceLoader.create(workspace);
    const controller = fakeController();
    const customTools = createSandboxTools(controller);
    const settingsManager = createStrictSettingsManager({ retry: { enabled: false } });
    const services = {
      cwd: "/workspace",
      agentDir,
      modelRuntime: strictRuntime,
      settingsManager,
      resourceLoader: loader,
      diagnostics: [],
    };
    const { session, extensionsResult } = await createAgentSessionFromServices({
      services,
      sessionManager: SessionManager.inMemory(workspace),
      model: faux.getModel(),
      tools: [...SANDBOX_TOOL_NAMES],
      customTools: [...customTools],
    });

    try {
      expect(session.agent.state.tools.map((tool) => tool.name)).toEqual(SANDBOX_TOOL_NAMES);
      expect(new Set(session.agent.state.tools.map((tool) => tool.execute)).size).toBe(7);
      expect(extensionsResult.extensions).toEqual([]);
      expect(extensionsResult.runtime.pendingProviderRegistrations).toEqual([]);
      expect(extensionsResult.runtime.pendingNativeProviderRegistrations).toEqual([]);
      expect(loader.getPrompts().prompts).toEqual([]);
      expect(loader.getSkills().skills).toEqual([]);

      const prompt = session.agent.state.systemPrompt;
      expect(prompt).toContain("Current working directory: /workspace");
      expect(prompt).toContain("network-isolated workspace sandbox");
      expect(prompt).toContain("/workspace/.chatwca is ephemeral");
      expect(prompt).toContain("Package downloads");
      expect(prompt).toContain('<project_instructions path="/workspace/AGENTS.md">');
      for (const privatePath of [workspace, agentDir, dataDir, sessionFile]) {
        expect(prompt).not.toContain(privatePath);
      }

      const read = session.agent.state.tools.find((tool) => tool.name === "read")!;
      await expect(read.execute("call", { path: "README.md" })).resolves.toMatchObject({
        content: [{ type: "text", text: "sandbox read" }],
      });
      expect(controller.readFile).toHaveBeenCalledOnce();

      await session.prompt("Exercise every approved tool, then reply.");
      expect(session.messages.at(-1)).toMatchObject({ role: "assistant" });
      for (const operation of ["readFile", "writeFile", "editFile", "listDirectory", "grep", "find", "exec"] as const) {
        expect(controller[operation]).toHaveBeenCalled();
      }
    } finally {
      session.dispose();
    }
  });

  it("keeps extension-only provider mutation out of the strict model runtime", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatwca-model-isolation-"));
    roots.push(root);
    const createRuntime = (name: string) => ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: path.join(root, `${name}.json`),
    });
    const [unrestricted, strict] = await Promise.all([
      createRuntime("unrestricted"),
      createRuntime("strict"),
    ]);
    const extensionOnly = fauxProvider({ provider: "extension-only" });
    const normal = fauxProvider({ provider: "normal-faux" });
    unrestricted.registerNativeProvider(extensionOnly.provider);
    unrestricted.registerNativeProvider(normal.provider);
    strict.registerNativeProvider(normal.provider);

    expect(unrestricted.getProvider("extension-only")).toBeDefined();
    expect(strict.getProvider("extension-only")).toBeUndefined();
    expect(strict.getProvider("normal-faux")).toBeDefined();
    expect(strict.getModel("normal-faux", normal.getModel().id)).toBeDefined();
    expect(unrestricted).not.toBe(strict);
  });
});
