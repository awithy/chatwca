import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/server/config.js";
import { PiRuntimeFactory } from "../../src/server/pi-runtime.js";
import { validateBwrapAndToolchain } from "../../src/server/sandbox/bwrap.js";
import { loadSandboxWorkerArtifact } from "../../src/server/sandbox/probe.js";
import { SANDBOX_TOOL_NAMES } from "../../src/server/sandbox/tools.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.env.CHATWCA_SANDBOX_CAPABLE !== "1")("profile-selected strict Pi runtime", () => {
  it("runs a faux provider in the parent while its tool executes in Bubblewrap", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatwca-strict-runtime-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const agentDir = path.join(root, "agent");
    const sessionDir = path.join(root, "sessions");
    await Promise.all([mkdir(workspace), mkdir(dataDir), mkdir(agentDir), mkdir(sessionDir)]);
    await writeFile(path.join(workspace, "README.md"), "inside worker\n");

    const config = loadConfig({
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_WORKSPACE_ROOTS: JSON.stringify([workspace]),
      CHATWCA_DATA_DIR: dataDir,
      PI_CODING_AGENT_DIR: agentDir,
    }).sandbox;
    const host = validateBwrapAndToolchain(config);
    const worker = await loadSandboxWorkerArtifact();

    const faux = fauxProvider({ provider: "strict-parent-faux", tokensPerSecond: 10_000 });
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: "README.md" }), { stopReason: "toolUse" }),
      fauxAssistantMessage("provider stayed in parent"),
    ]);
    const strictModelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: path.join(root, "strict-store.json"),
    });
    strictModelRuntime.registerNativeProvider(faux.provider);
    const unrestrictedModelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: path.join(root, "unrestricted-store.json"),
    });

    const factory = await PiRuntimeFactory.create({
      agentDir,
      modelRuntime: unrestrictedModelRuntime,
      strictModelRuntime,
      sessionOptions: () => ({ model: faux.getModel() }),
      sandbox: {
        config,
        host,
        worker,
        hiddenPaths: [dataDir, agentDir, sessionDir],
      },
    });
    const runtime = await factory.createPersistent({
      workspaceId: "sandbox-workspace",
      cwd: workspace,
      sessionDirectory: sessionDir,
      securityProfile: "workspace-sandboxed",
    });

    try {
      expect(runtime.securityProfile).toBe("workspace-sandboxed");
      expect(runtime.identity.cwd).toBe(workspace);
      expect(runtime.session.sessionManager.getCwd()).toBe(workspace);
      expect(runtime.sandboxFileReader).toBeDefined();
      expect(runtime.session.agent.state.tools.map((tool) => tool.name)).toEqual(SANDBOX_TOOL_NAMES);
      expect(runtime.session.agent.state.systemPrompt).toContain("Current working directory: /workspace");
      expect(runtime.session.agent.state.systemPrompt).not.toContain(workspace);
      await runtime.prompt("Read the workspace file.");
      const toolResult = runtime.session.messages.find((message) => message.role === "toolResult");
      expect(toolResult).toMatchObject({
        toolName: "read",
        content: [{ type: "text", text: "inside worker\n" }],
      });
      expect(runtime.session.messages.at(-1)).toMatchObject({ role: "assistant" });
    } finally {
      await runtime.dispose();
    }
  }, 20_000);
});
