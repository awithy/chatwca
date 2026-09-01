import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConversationRegistry } from "../../src/server/conversation-registry.js";
import {
  PiRuntimeFactory,
  type PiConversationRuntime,
  type PiRuntimeReplacement,
} from "../../src/server/pi-runtime.js";

const temporaryRoots: string[] = [];

function policy(cwd: string, sessionDirectory: string | null = null) {
  return { workspaceId: cwd, cwd, sessionDirectory, securityProfile: "unrestricted" as const };
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function isolatedFactory() {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-runtime-"));
  temporaryRoots.push(root);
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);

  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const strictFaux = fauxProvider({ provider: "strict-faux", tokensPerSecond: 10_000 });
  const strictModelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "strict-models-store.json"),
  });
  strictModelRuntime.registerNativeProvider(strictFaux.provider);

  const serviceCwds: string[] = [];
  const factory = await PiRuntimeFactory.create({
    modelRuntime,
    strictModelRuntime,
    agentDir,
    sessionDir,
    serviceOptions: (runtimeCwd) => {
      serviceCwds.push(runtimeCwd);
      return {
        settingsManager: SettingsManager.inMemory({
          retry: { enabled: false },
        }),
      };
    },
    sessionOptions: () => ({ model: faux.getModel(), noTools: "all" }),
  });

  return { cwd, factory, faux, strictFaux, serviceCwds };
}

describe("PiRuntimeFactory", () => {
  it("creates and reopens persistent sessions with model capability metadata", async () => {
    const { cwd, factory, faux } = await isolatedFactory();
    faux.setResponses([fauxAssistantMessage("Persisted response")]);

    let runtime: PiConversationRuntime | undefined;
    let reopened: PiConversationRuntime | undefined;
    try {
      runtime = await factory.createPersistent(policy(cwd));
      const initialIdentity = runtime.identity;

      expect(initialIdentity.cwd).toBe(cwd);
      expect(initialIdentity.sessionFile).toContain("sessions");
      expect(existsSync(initialIdentity.sessionFile)).toBe(false);
      expect(runtime.model).toMatchObject({
        provider: "faux",
        id: "faux-1",
        supportsImages: true,
      });
      expect(runtime.supportsImages).toBe(true);
      await expect(factory.listAvailableModels()).resolves.toContainEqual(
        expect.objectContaining({ id: "faux-1", supportsImages: true }),
      );

      await runtime.prompt("Make this session durable.");
      expect(existsSync(initialIdentity.sessionFile)).toBe(true);
      await runtime.dispose();
      runtime = undefined;

      reopened = await factory.openPersistent(policy(cwd), initialIdentity.sessionFile);
      expect(reopened.identity).toEqual(initialIdentity);
      expect(
        reopened.session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "message"),
      ).toHaveLength(2);
    } finally {
      await runtime?.dispose();
      await reopened?.dispose();
    }
  });

  it("selects the isolated model catalog by effective profile", async () => {
    const { factory } = await isolatedFactory();
    await expect(factory.listAvailableModels("unrestricted")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: "faux" })]),
    );
    await expect(factory.listAvailableModels("workspace-sandboxed")).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ provider: "strict-faux" })]),
    );
    expect((await factory.listAvailableModels("workspace-sandboxed")).some((model) => model.provider === "faux")).toBe(false);
    expect(factory.modelRuntime).not.toBe(factory.strictModelRuntime);
  });

  it("uses a workspace-local session directory without creating ignore files", async () => {
    const { cwd, factory } = await isolatedFactory();
    const localSessionDirectory = path.join(cwd, ".chatwca", "sessions");
    const runtime = await factory.createPersistent(policy(cwd, localSessionDirectory));

    try {
      expect(path.dirname(runtime.identity.sessionFile)).toBe(localSessionDirectory);
      expect(existsSync(localSessionDirectory)).toBe(true);
      expect(existsSync(path.join(cwd, ".gitignore"))).toBe(false);
      expect(existsSync(path.join(cwd, ".chatwca", ".gitignore"))).toBe(false);
      expect(existsSync(path.join(localSessionDirectory, ".gitignore"))).toBe(false);
    } finally {
      await runtime.dispose();
    }
  });

  it("validates image prompts and persists Pi image content for reopening", async () => {
    const { cwd, factory, faux } = await isolatedFactory();
    faux.setResponses([fauxAssistantMessage("I received the image")]);
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      imageLimits: {
        maxImages: 1,
        maxImageBytes: 32,
        maxTotalImageBytes: 32,
      },
    });
    let reopened: PiConversationRuntime | undefined;

    try {
      const record = await registry.create(policy(cwd));
      const identity = record.runtime.identity;
      const data = Buffer.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]).toString("base64");
      await registry.prompt(record.id, "Describe this image", [
        { mimeType: "image/png", encoding: "base64", data },
      ]);
      await vi.waitFor(() => {
        expect(record.status).toBe("idle");
        expect(record.durable).toBe(true);
      });

      await registry.dispose();
      reopened = await factory.openPersistent(policy(cwd), identity.sessionFile);
      const userEntry = reopened.session.sessionManager
        .getBranch()
        .find(
          (entry) => entry.type === "message" && entry.message.role === "user",
        );
      expect(userEntry).toMatchObject({
        message: {
          content: [
            { type: "text", text: "Describe this image" },
            { type: "image", mimeType: "image/png", data },
          ],
        },
      });
    } finally {
      await registry.dispose();
      await reopened?.dispose();
    }
  });

  it("creates and promotes a fork without mutating the live source", async () => {
    const { cwd, factory, faux } = await isolatedFactory();
    faux.setResponses([
      fauxAssistantMessage("First response"),
      fauxAssistantMessage("Second response"),
    ]);
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 2,
    });

    try {
      const source = await registry.create(policy(cwd));
      await registry.prompt(source.id, "Keep this earlier turn.", []);
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
        expect(source.session.isStreaming).toBe(false);
      });
      await registry.prompt(source.id, "Copy this prompt into the editor.", []);
      await vi.waitFor(() => {
        expect(source.status).toBe("idle");
        expect(source.session.isStreaming).toBe(false);
        expect(
          source.session.sessionManager
            .getBranch()
            .filter((entry) => entry.type === "message"),
        ).toHaveLength(4);
      });

      const sourceRuntime = source.runtime;
      const sourceSession = source.session;
      const sourceIdentity = source.runtime.identity;
      const sourceRevision = source.revision;
      const sourceBranchIds = source.session.sessionManager
        .getBranch()
        .map((entry) => entry.id);
      const sourceBytes = await readFile(sourceIdentity.sessionFile);
      const target = source.session.sessionManager
        .getBranch()
        .filter(
          (entry) => entry.type === "message" && entry.message.role === "user",
        )[1];
      expect(target).toBeDefined();

      const result = await registry.fork(source.id, target!.id, policy(cwd));

      expect(result.editorText).toBe("Copy this prompt into the editor.");
      expect(result.conversation).toMatchObject({
        cwd,
        status: "idle",
        durable: true,
        model: {
          id: sourceRuntime.model?.id,
          provider: sourceRuntime.model?.provider,
        },
      });
      expect(result.conversation.id).not.toBe(sourceIdentity.sessionId);
      expect(result.conversation.sessionFile).not.toBe(sourceIdentity.sessionFile);
      expect(result.conversation.messages).toHaveLength(2);
      expect(result.conversation.messages[0]).toMatchObject({
        role: "user",
        blocks: [{ type: "text", text: "Keep this earlier turn." }],
      });

      expect(registry.get(source.id)).toBe(source);
      expect(source.runtime).toBe(sourceRuntime);
      expect(source.session).toBe(sourceSession);
      expect(source.runtime.identity).toEqual(sourceIdentity);
      expect(source.revision).toBe(sourceRevision);
      expect(source.session.sessionManager.getBranch().map((entry) => entry.id))
        .toEqual(sourceBranchIds);
      expect(await readFile(sourceIdentity.sessionFile)).toEqual(sourceBytes);
    } finally {
      await registry.dispose();
    }
  });

  it("rebinds its single event bridge and refreshes identity after a fork", async () => {
    const { cwd, factory, faux, serviceCwds } = await isolatedFactory();
    faux.setResponses([
      fauxAssistantMessage("Original response"),
      fauxAssistantMessage("Fork response"),
    ]);

    const runtime = await factory.createPersistent(policy(cwd));
    const eventTypes: string[] = [];
    const replacements: PiRuntimeReplacement[] = [];
    const unsubscribe = runtime.subscribe((event) => {
      eventTypes.push(event.type);
    });
    const unsubscribeReplacement = runtime.onSessionReplaced((replacement) => {
      replacements.push(replacement);
    });

    try {
      await runtime.prompt("Prompt copied into the fork editor.");
      const sourceIdentity = runtime.identity;
      const userEntry = runtime.session.sessionManager
        .getBranch()
        .find(
          (entry) =>
            entry.type === "message" && entry.message.role === "user",
        );
      expect(userEntry).toBeDefined();

      const result = await runtime.fork(userEntry!.id);
      expect(result).toEqual({
        cancelled: false,
        editorText: "Prompt copied into the fork editor.",
      });
      expect(runtime.identity.sessionId).not.toBe(sourceIdentity.sessionId);
      expect(runtime.identity.sessionFile).not.toBe(sourceIdentity.sessionFile);
      expect(replacements).toEqual([
        { previous: sourceIdentity, current: runtime.identity },
      ]);
      expect(serviceCwds).toEqual([cwd, cwd]);

      await runtime.prompt("Continue in the fork.");
      expect(eventTypes.filter((type) => type === "agent_start")).toHaveLength(2);
      expect(existsSync(sourceIdentity.sessionFile)).toBe(true);
    } finally {
      unsubscribe();
      unsubscribeReplacement();
      await runtime.dispose();
    }
  });
});
