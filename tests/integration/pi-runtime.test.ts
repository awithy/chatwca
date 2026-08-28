import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

  const serviceCwds: string[] = [];
  const factory = await PiRuntimeFactory.create({
    modelRuntime,
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

  return { cwd, factory, faux, serviceCwds };
}

describe("PiRuntimeFactory", () => {
  it("creates and reopens persistent sessions with model capability metadata", async () => {
    const { cwd, factory, faux } = await isolatedFactory();
    faux.setResponses([fauxAssistantMessage("Persisted response")]);

    let runtime: PiConversationRuntime | undefined;
    let reopened: PiConversationRuntime | undefined;
    try {
      runtime = await factory.createPersistent(cwd);
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

      reopened = await factory.openPersistent(initialIdentity.sessionFile);
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
      const record = await registry.create(cwd);
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
      reopened = await factory.openPersistent(identity.sessionFile);
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

  it("rebinds its single event bridge and refreshes identity after a fork", async () => {
    const { cwd, factory, faux, serviceCwds } = await isolatedFactory();
    faux.setResponses([
      fauxAssistantMessage("Original response"),
      fauxAssistantMessage("Fork response"),
    ]);

    const runtime = await factory.createPersistent(cwd);
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
