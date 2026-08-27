import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

function messageEntries(sessionManager) {
  return sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message");
}

function textOf(message) {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

test("a persistent Pi session streams, becomes durable, and reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "chatwca-pi-sdk-"));
  const cwd = join(root, "workspace");
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");

  await Promise.all([
    mkdir(cwd),
    mkdir(agentDir),
    mkdir(sessionDir),
  ]);

  let runtime;
  let reopenedRuntime;

  try {
    const faux = fauxProvider({ tokensPerSecond: 10_000 });
    faux.setResponses([fauxAssistantMessage("Deterministic smoke response.")]);

    const modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(root, "models-store.json"),
    });
    modelRuntime.registerNativeProvider(faux.provider);

    const createRuntime = async ({
      cwd: runtimeCwd,
      sessionManager,
      sessionStartEvent,
    }) => {
      const services = await createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir,
        modelRuntime,
        settingsManager: SettingsManager.inMemory({
          retry: { enabled: false },
        }),
      });

      return {
        ...(await createAgentSessionFromServices({
          services,
          sessionManager,
          sessionStartEvent,
          model: faux.getModel(),
          noTools: "all",
        })),
        services,
        diagnostics: services.diagnostics,
      };
    };

    runtime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: SessionManager.create(cwd, sessionDir),
    });

    const sessionFile = runtime.session.sessionFile;
    assert.ok(sessionFile, "a persistent manager should reserve a session path");
    assert.equal(existsSync(sessionFile), false, "an empty session is not durable");
    assert.deepEqual(await SessionManager.list(cwd, sessionDir), []);

    const eventTypes = [];
    const messageEndObservations = [];
    const unsubscribe = runtime.session.subscribe((event) => {
      eventTypes.push(event.type);
      if (event.type === "message_end") {
        messageEndObservations.push({
          role: event.message.role,
          fileExists: existsSync(sessionFile),
        });
      }
    });

    await runtime.session.prompt("Run the SDK smoke test.");
    unsubscribe();

    assert.ok(eventTypes.includes("agent_start"));
    assert.ok(eventTypes.includes("message_update"));
    assert.ok(eventTypes.includes("agent_end"));
    assert.deepEqual(messageEndObservations, [
      { role: "user", fileExists: false },
      { role: "assistant", fileExists: false },
    ]);
    assert.equal(
      existsSync(sessionFile),
      true,
      "the first assistant message flushes the header and accumulated entries",
    );

    const entriesBeforeDispose = messageEntries(runtime.session.sessionManager);
    assert.deepEqual(
      entriesBeforeDispose.map((entry) => entry.message.role),
      ["user", "assistant"],
    );
    assert.equal(textOf(entriesBeforeDispose[0].message), "Run the SDK smoke test.");
    assert.equal(textOf(entriesBeforeDispose[1].message), "Deterministic smoke response.");

    const listed = await SessionManager.list(cwd, sessionDir);
    assert.equal(listed.length, 1);
    assert.equal(listed[0].path, sessionFile);
    assert.equal(listed[0].id, runtime.session.sessionId);

    const originalSessionId = runtime.session.sessionId;
    const originalEntryIds = entriesBeforeDispose.map((entry) => entry.id);
    await runtime.dispose();
    runtime = undefined;

    reopenedRuntime = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir,
      sessionManager: SessionManager.open(sessionFile, sessionDir),
    });

    const reopenedEntries = messageEntries(reopenedRuntime.session.sessionManager);
    assert.equal(reopenedRuntime.session.sessionId, originalSessionId);
    assert.deepEqual(
      reopenedEntries.map((entry) => entry.id),
      originalEntryIds,
      "entry IDs survive disposal and reopening",
    );
    assert.deepEqual(
      reopenedEntries.map((entry) => textOf(entry.message)),
      ["Run the SDK smoke test.", "Deterministic smoke response."],
    );
  } finally {
    if (runtime) await runtime.dispose();
    if (reopenedRuntime) await reopenedRuntime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
