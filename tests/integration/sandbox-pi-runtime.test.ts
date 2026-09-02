import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/server/config.js";
import {
  PiRuntimeFactory,
  type ManagedNetworkRuntimePort,
} from "../../src/server/pi-runtime.js";
import { validateNetworkHelper } from "../../src/server/network/helper.js";
import { ManagedNetworkRuntime } from "../../src/server/network/managed-runtime.js";
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

  it("owns one distinct managed proxy runtime across worker replacement and closes it", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "chatwca-managed-runtime-"));
    roots.push(root);
    const workspace = path.join(root, "workspace");
    const dataDir = path.join(root, "data");
    const networkDir = path.join(dataDir, "network");
    const agentDir = path.join(root, "agent");
    const sessionDir = path.join(root, "sessions");
    await Promise.all([mkdir(workspace), mkdir(dataDir), mkdir(agentDir), mkdir(sessionDir)]);

    const serverConfig = loadConfig({
      CHATWCA_SANDBOX_MODE: "optional",
      CHATWCA_WORKSPACE_ROOTS: JSON.stringify([workspace]),
      CHATWCA_DATA_DIR: dataDir,
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["example.com"]',
      PI_CODING_AGENT_DIR: agentDir,
    });
    const host = validateBwrapAndToolchain(serverConfig.sandbox);
    const worker = await loadSandboxWorkerArtifact();
    const helper = validateNetworkHelper({
      helperPath: serverConfig.managedNetwork.helperPath,
      manifestPath: serverConfig.managedNetwork.helperManifestPath,
      protectedPaths: [workspace, dataDir, agentDir],
    });

    const faux = fauxProvider({ provider: "managed-parent-faux", tokensPerSecond: 10_000 });
    const strictModelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: path.join(root, "strict-managed-store.json"),
    });
    strictModelRuntime.registerNativeProvider(faux.provider);
    const unrestrictedModelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: path.join(root, "unrestricted-managed-store.json"),
    });
    const proxies: ManagedNetworkRuntimePort[] = [];
    const factory = await PiRuntimeFactory.create({
      agentDir,
      modelRuntime: unrestrictedModelRuntime,
      strictModelRuntime,
      sessionOptions: () => ({ model: faux.getModel() }),
      sandbox: {
        config: serverConfig.sandbox,
        host,
        worker,
        hiddenPaths: [dataDir, agentDir, sessionDir],
        managedNetwork: {
          config: serverConfig.managedNetwork,
          helper,
          dataDir: networkDir,
          diagnosticSink: () => undefined,
          startRuntime: async (options) => {
            const proxy = await ManagedNetworkRuntime.start(options);
            proxies.push(proxy);
            return proxy;
          },
        },
      },
    });
    const managedPolicy = {
      workspaceId: "managed-workspace",
      cwd: workspace,
      sessionDirectory: sessionDir,
      securityProfile: "workspace-sandboxed" as const,
      networkPolicy: "managed-egress" as const,
    };
    const runtime = await factory.createPersistent(managedPolicy);
    const secondRuntime = await factory.createPersistent(managedPolicy);

    try {
      expect(runtime.networkPolicy).toBe("managed-egress");
      expect(runtime.session.agent.state.systemPrompt).toContain("destination-filtered proxy");
      expect(proxies).toHaveLength(2);
      expect(proxies[0]!.httpSocketPath).not.toBe(proxies[1]!.httpSocketPath);
      expect(proxies[0]!.socksSocketPath).not.toBe(proxies[1]!.socksSocketPath);
      for (const proxy of proxies) {
        expect(existsSync(proxy.httpSocketPath)).toBe(true);
        expect(existsSync(proxy.socksSocketPath)).toBe(true);
      }

      await runtime.abort();
      expect(proxies).toHaveLength(2);
      expect(existsSync(proxies[0]!.httpSocketPath)).toBe(true);
      expect(existsSync(proxies[1]!.httpSocketPath)).toBe(true);

      await runtime.dispose();
      expect(existsSync(proxies[0]!.httpSocketPath)).toBe(false);
      expect(existsSync(proxies[0]!.socksSocketPath)).toBe(false);
      expect(existsSync(proxies[1]!.httpSocketPath)).toBe(true);
      expect(existsSync(proxies[1]!.socksSocketPath)).toBe(true);
    } finally {
      await Promise.allSettled([runtime.dispose(), secondRuntime.dispose()]);
    }
    expect(existsSync(proxies[1]!.httpSocketPath)).toBe(false);
    expect(existsSync(proxies[1]!.socksSocketPath)).toBe(false);
  }, 20_000);
});
