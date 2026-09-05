import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationRegistry } from "../../src/server/conversation-registry.js";
import { PiRuntimeFactory, type PiConversationRuntimePort } from "../../src/server/pi-runtime.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-default-model-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  await Promise.all([mkdir(path.join(cwd, ".pi"), { recursive: true }), mkdir(agentDir), mkdir(sessionDir)]);
  const faux = fauxProvider({
    provider: "default-model-faux",
    tokensPerSecond: 10_000,
    models: [{ id: "old", name: "Old model" }, { id: "current", name: "Current default" }],
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const strictModelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "strict-models-store.json"),
  });
  const setDefault = (settings: Record<string, string>) =>
    writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings));
  const makeFactory = () => PiRuntimeFactory.create({
    modelRuntime,
    strictModelRuntime,
    agentDir,
    sessionDir,
    serviceOptions: () => ({ settingsManager: SettingsManager.create(cwd, agentDir) }),
    sessionOptions: () => ({ noTools: "all" }),
  });
  const policy = { workspaceId: cwd, cwd, sessionDirectory: sessionDir, securityProfile: "unrestricted" as const };
  return { cwd, faux, modelRuntime, setDefault, makeFactory, policy };
}

describe("global default model selection", () => {
  it("overrides project and saved models without rewriting history, and remains fixed until restart", async () => {
    const { cwd, faux, setDefault, makeFactory, policy } = await fixture();
    const provider = faux.provider.id;
    await setDefault({ defaultProvider: provider, defaultModel: "old" });
    const oldFactory = await makeFactory();
    const old = await oldFactory.createPersistent(policy);
    let reopened: PiConversationRuntimePort | undefined;
    let fresh: PiConversationRuntimePort | undefined;
    let afterRestart: PiConversationRuntimePort | undefined;
    try {
      faux.setResponses([fauxAssistantMessage("Historical response")]);
      await old.prompt("Keep this history");
      const file = old.identity.sessionFile;
      const oldMessages = old.session.messages;
      await old.dispose();
      const originalBytes = await readFile(file);
      await writeFile(path.join(cwd, ".pi", "settings.json"), JSON.stringify({
        defaultProvider: provider, defaultModel: "old",
      }));
      await setDefault({ defaultProvider: provider, defaultModel: "current" });
      const factory = await makeFactory();
      reopened = await factory.openPersistent(policy, file);
      expect(reopened.model).toMatchObject({ provider, id: "current", name: "Current default" });
      expect(reopened.session.messages).toEqual(oldMessages);
      expect(await readFile(file)).toEqual(originalBytes);

      // The model used for actual inference, not just the header projection.
      faux.setResponses([(_context, _options, _state, model) => {
        expect(model.id).toBe("current");
        return fauxAssistantMessage("Response from current default");
      }]);
      await reopened.prompt("Continue using the default");
      expect(SessionManager.open(file).buildSessionContext().model?.modelId).toBe("current");

      await setDefault({ defaultProvider: provider, defaultModel: "old" });
      fresh = await factory.createPersistent(policy);
      expect(fresh.model?.id).toBe("current");
      afterRestart = await (await makeFactory()).createPersistent(policy);
      expect(afterRestart.model?.id).toBe("old");
    } finally {
      await Promise.all([old.dispose(), reopened?.dispose(), fresh?.dispose(), afterRestart?.dispose()]);
    }
  });

  it("uses the default for forks even when the source's live model differs", async () => {
    const { faux, setDefault, makeFactory, policy } = await fixture();
    await setDefault({ defaultProvider: faux.provider.id, defaultModel: "current" });
    const registry = new ConversationRegistry({ runtimeFactory: await makeFactory(), maxLiveConversations: 4 });
    try {
      const source = await registry.create(policy);
      // Simulate a model change by an unrestricted extension or an older live source.
      await source.session.setModel(faux.getModel("old")!);
      faux.setResponses([fauxAssistantMessage("First"), fauxAssistantMessage("Second")]);
      for (const text of ["First turn", "Fork target"]) {
        await registry.prompt(source.id, text, []);
        await vi.waitFor(() => {
          expect(source.status).toBe("idle");
          expect(source.session.isStreaming).toBe(false);
        });
      }
      const target = source.session.sessionManager.getBranch()
        .filter((entry) => entry.type === "message" && entry.message.role === "user")[1]!;
      const sourceBytes = await readFile(source.sessionFile);
      const result = await registry.fork(source.id, target.id, policy);
      expect(result.conversation.model).toMatchObject({ id: "current", name: "Current default" });
      expect(source.runtime.model?.id).toBe("old");
      expect(await readFile(source.sessionFile)).toEqual(sourceBytes);

    } finally {
      await registry.dispose();
    }
  });

  it("rejects a configured default without authentication rather than restoring a saved model", async () => {
    const { faux, modelRuntime, setDefault, makeFactory, policy } = await fixture();
    const oldFactory = await makeFactory();
    const old = await oldFactory.createPersistent(policy);
    try {
      faux.setResponses([fauxAssistantMessage("Saved response")]);
      await old.prompt("Save this conversation");
      const file = old.identity.sessionFile;
      await old.dispose();
      await setDefault({ defaultProvider: faux.provider.id, defaultModel: "current" });
      const factory = await makeFactory();
      const auth = vi.spyOn(modelRuntime, "hasConfiguredAuth").mockReturnValue(false);
      try {
        await expect(factory.openPersistent(policy, file)).rejects.toMatchObject({ code: "model_unavailable" });
      } finally {
        auth.mockRestore();
      }
    } finally {
      await old.dispose();
    }
  });

  it.each([
    { defaultProvider: "default-model-faux", defaultModel: "missing" },
    { defaultProvider: "missing-provider", defaultModel: "current" },
    { defaultProvider: "default-model-faux" },
    { defaultModel: "current" },
  ])("rejects unavailable/incomplete defaults instead of silently using a different model: %j", async (settings) => {
    const { setDefault, makeFactory, policy } = await fixture();
    await setDefault(settings);
    const factory = await makeFactory();
    await expect(factory.createPersistent(policy)).rejects.toMatchObject({ code: "model_unavailable" });
  });
});
