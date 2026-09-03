import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
} from "@earendil-works/pi-ai/providers/faux";
import {
  ModelRuntime,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import NodeWebSocket from "ws";

import { loadConfig } from "../../src/server/config.js";
import {
  ConversationRegistry,
  type ConversationRecord,
  type ConversationRegistryEvent,
} from "../../src/server/conversation-registry.js";
import {
  createChatWcaServer,
  type ChatWcaServer,
} from "../../src/server/index.js";
import {
  PiRuntimeFactory,
  type PiRuntimeFactoryPort,
} from "../../src/server/pi-runtime.js";
import type { ProtocolWorkspaceRepository } from "../../src/server/protocol.js";
import { SessionHistory } from "../../src/server/session-history.js";
import { ERROR_CODES } from "../../src/shared/errors.js";
import type {
  ConversationState,
  NormalizedMessage,
  ServerMessage,
} from "../../src/shared/protocol.js";
import { ChatSocketClient } from "../../src/web/src/api/client.js";

interface IsolatedPi {
  readonly cwd: string;
  readonly secondCwd: string;
  readonly sessionDir: string;
  readonly factory: PiRuntimeFactory;
  readonly faux: FauxProviderHandle;
}

interface RuntimeServices {
  readonly registry: ConversationRegistry;
  readonly history: SessionHistory;
}

function historyWorkspace(cwd: string) {
  return {
    id: cwd,
    path: cwd,
    workspaceId: cwd,
    cwd,
    sessionStorage: "pi-default",
    sessionDirectory: null,
    securityProfile: "unrestricted",
    effectiveSecurityProfile: "unrestricted",
    available: true,
    usable: true,
    policyIssue: null,
  } as const;
}

function fixedWorkspaceRepository(cwd: string): ProtocolWorkspaceRepository {
  const workspace = {
    ...historyWorkspace(cwd),
    name: "Integration workspace",
    createdAt: 1,
    updatedAt: 1,
    available: true,
  };
  return {
    list: () => [workspace],
    requireAvailable: (workspaceId) => {
      if (workspaceId !== workspace.id) throw new Error("Unknown test workspace");
      return workspace;
    },
    requireUsable: (workspaceId) => {
      if (workspaceId !== workspace.id) throw new Error("Unknown test workspace");
      return {
        workspaceId: workspace.id,
        cwd: workspace.path,
        sessionDirectory: null,
        securityProfile: "unrestricted",
      };
    },
    create: () => { throw new Error("Unexpected workspace create"); },
    update: () => { throw new Error("Unexpected workspace update"); },
    delete: () => { throw new Error("Unexpected workspace delete"); },
  };
}

const temporaryRoots: string[] = [];
const registries: ConversationRegistry[] = [];
const servers: ChatWcaServer[] = [];
const clients: ChatSocketClient[] = [];

async function isolatedPi(tokensPerSecond = 10_000): Promise<IsolatedPi> {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-lifecycle-integration-"));
  temporaryRoots.push(root);
  const cwd = path.join(root, "workspace-a");
  const secondCwd = path.join(root, "workspace-b");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  await Promise.all([
    mkdir(cwd),
    mkdir(secondCwd),
    mkdir(agentDir),
    mkdir(sessionDir),
  ]);

  const faux = fauxProvider({
    tokensPerSecond,
    // Fixed chunk sizes keep event counts and timing deterministic.
    tokenSize: { min: 4, max: 4 },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: path.join(root, "models-store.json"),
  });
  modelRuntime.registerNativeProvider(faux.provider);

  const factory = await PiRuntimeFactory.create({
    modelRuntime,
    agentDir,
    sessionDir,
    serviceOptions: () => ({
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    }),
    sessionOptions: () => ({ model: faux.getModel(), noTools: "all" }),
  });

  return { cwd, secondCwd, sessionDir, factory, faux };
}

function createServices(
  factory: PiRuntimeFactoryPort,
  sessionDir: string,
  options: {
    readonly maxLiveConversations?: number;
    readonly now?: () => number;
  } = {},
): RuntimeServices {
  let registry: ConversationRegistry;
  const history = new SessionHistory({
    sessionDir,
    getLiveStatus: (identity) => {
      const record =
        registry?.get(identity.id) ??
        registry?.getBySessionFile(identity.sessionFile);
      return record === undefined
        ? undefined
        : { workspaceId: record.workspaceId, status: record.status };
    },
  });
  registry = new ConversationRegistry({
    runtimeFactory: factory,
    ...(options.maxLiveConversations === undefined
      ? {}
      : { maxLiveConversations: options.maxLiveConversations }),
    ...(options.now === undefined ? {} : { now: options.now }),
    refreshHistory: (workspaceId) =>
      history.refresh(historyWorkspace(workspaceId)).then(() => undefined),
  });
  registries.push(registry);
  return { registry, history };
}

function textOf(message: NormalizedMessage): string {
  return message.blocks
    .filter(
      (block): block is Extract<(typeof message.blocks)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
}

async function waitForIdle(record: ConversationRecord): Promise<void> {
  await vi.waitFor(
    () => {
      expect(record.status).toBe("idle");
      expect(record.session.isStreaming).toBe(false);
    },
    { timeout: 5_000 },
  );
}

function nextSocketMessage(socket: NodeWebSocket): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data) => {
      try {
        resolve(JSON.parse(data.toString()) as ServerMessage);
      } catch (error) {
        reject(error);
      }
    });
    socket.once("error", reject);
  });
}

async function closeServer(server: ChatWcaServer): Promise<void> {
  await server.shutdown();
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await Promise.allSettled(servers.splice(0).map(closeServer));
  await Promise.allSettled(registries.splice(0).map((registry) => registry.dispose()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

describe("complete conversation lifecycle integration", () => {
  it("creates, prompts, persists, disposes, reopens, and guardedly deletes a Pi session", async () => {
    const { cwd, sessionDir, factory, faux } = await isolatedPi();
    faux.setResponses([fauxAssistantMessage("Persisted deterministic response")]);
    const firstServices = createServices(factory, sessionDir);

    const created = await firstServices.registry.create(historyWorkspace(cwd));
    const initial = await firstServices.registry.getState(created.id);
    expect(initial).toMatchObject({ durable: false, messages: [] });

    await firstServices.registry.prompt(created.id, "Persist this conversation", []);
    await waitForIdle(created);
    const persisted = await firstServices.registry.getState(created.id);
    expect(persisted).toMatchObject({
      durable: true,
      title: "Persist this conversation",
      messages: [
        { role: "user", forkEligible: true },
        { role: "assistant", stopReason: "stop" },
      ],
    });
    expect(persisted.messages.map(textOf)).toEqual([
      "Persist this conversation",
      "Persisted deterministic response",
    ]);
    expect(persisted.contextUsage).toEqual({
      tokens: expect.any(Number),
      contextWindow: expect.any(Number),
      percent: expect.any(Number),
    });
    expect(existsSync(persisted.sessionFile)).toBe(true);

    const renamed = await firstServices.registry.rename(
      created.id,
      "Persistent custom title",
    );
    expect(renamed.title).toBe("Persistent custom title");

    await expect(
      firstServices.history.delete(historyWorkspace(cwd), created.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.LIVE_SESSION_DELETE });

    const entryIds = persisted.messages.map(({ entryId }) => entryId);
    await firstServices.registry.dispose();
    expect(created.runtime.disposed).toBe(true);

    const secondServices = createServices(factory, sessionDir);
    const listed = await secondServices.history.list(historyWorkspace(cwd));
    expect(listed).toContainEqual(
      expect.objectContaining({
        id: created.id,
        sessionFile: persisted.sessionFile,
        title: "Persistent custom title",
        status: "closed",
        runnable: true,
        messageCount: 2,
      }),
    );

    const reopened = await secondServices.registry.open(historyWorkspace(cwd), persisted.sessionFile);
    const recovered = await secondServices.registry.getState(reopened.id);
    expect(recovered.id).toBe(created.id);
    expect(recovered.title).toBe("Persistent custom title");
    expect(recovered.messages.map(({ entryId }) => entryId)).toEqual(entryIds);
    expect(recovered.messages.map(textOf)).toEqual(persisted.messages.map(textOf));

    await expect(
      secondServices.history.delete(historyWorkspace(cwd), reopened.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.LIVE_SESSION_DELETE });
    await secondServices.registry.close(reopened.id);
    await expect(
      secondServices.history.delete(historyWorkspace(cwd), reopened.id),
    ).resolves.toEqual([]);
    expect(existsSync(persisted.sessionFile)).toBe(false);
  });

  it("isolates real Pi listing, fresh resolution, and deletion across workspaces", async () => {
    const { cwd, secondCwd, sessionDir, factory, faux } = await isolatedPi();
    faux.setResponses([
      fauxAssistantMessage("Workspace A response"),
      fauxAssistantMessage("Workspace B response"),
    ]);
    const { registry, history } = createServices(factory, sessionDir);

    const first = await registry.create(historyWorkspace(cwd));
    await registry.prompt(first.id, "Workspace A prompt", []);
    await waitForIdle(first);
    const firstFile = first.sessionFile;
    await registry.close(first.id);

    const second = await registry.create(historyWorkspace(secondCwd));
    await registry.prompt(second.id, "Workspace B prompt", []);
    await waitForIdle(second);
    const secondFile = second.sessionFile;
    await registry.close(second.id);

    await expect(history.list(historyWorkspace(cwd))).resolves.toMatchObject([
      { id: first.id, workspaceId: cwd, cwd },
    ]);
    await expect(history.list(historyWorkspace(secondCwd))).resolves.toMatchObject([
      { id: second.id, workspaceId: secondCwd, cwd: secondCwd },
    ]);
    await expect(
      history.resolve(historyWorkspace(cwd), second.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_NOT_LISTED });
    await expect(
      history.resolve(historyWorkspace(secondCwd), first.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_NOT_LISTED });
    await expect(
      history.delete(historyWorkspace(cwd), second.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_NOT_LISTED });
    expect(existsSync(firstFile)).toBe(true);
    expect(existsSync(secondFile)).toBe(true);
  });

  it("keeps a fresh conversation's WebSocket revisions contiguous while its first response streams", async () => {
    const { cwd, sessionDir, factory, faux } = await isolatedPi(40);
    faux.setResponses([
      fauxAssistantMessage("Incremental first response. ".repeat(12)),
    ]);
    const services = createServices(factory, sessionDir);
    const record = await services.registry.create(historyWorkspace(cwd));
    const config = loadConfig(
      { CHATWCA_DATA_DIR: cwd, CHATWCA_SHUTDOWN_GRACE_MS: "100" },
      cwd,
    );
    const server = createChatWcaServer(config, "first-stream-integration", {
      registry: services.registry,
      history: services.history,
      workspaces: fixedWorkspaceRepository(cwd),
      shutdown: services.registry,
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;
    const socket = new NodeWebSocket(`ws://127.0.0.1:${String(port)}/ws`);
    await expect(nextSocketMessage(socket)).resolves.toMatchObject({ type: "ready" });

    const stateResponse = nextSocketMessage(socket);
    socket.send(JSON.stringify({
      type: "conversation.state",
      requestId: "initial-state",
      conversationId: record.id,
    }));
    await expect(stateResponse).resolves.toMatchObject({
      type: "state",
      conversation: { id: record.id, revision: 0 },
    });

    const received: ServerMessage[] = [];
    const firstRun = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("Timed out waiting for the first streamed response")),
        5_000,
      );
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(data.toString()) as ServerMessage;
          received.push(message);
          if (
            message.type === "conversation.status" &&
            message.conversationId === record.id &&
            message.payload.status === "idle"
          ) {
            clearTimeout(timeout);
            resolve();
          }
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
    });
    socket.send(JSON.stringify({
      type: "prompt.submit",
      requestId: "first-prompt",
      conversationId: record.id,
      text: "First prompt title",
      images: [],
    }));
    await firstRun;

    const events = received.filter(
      (message): message is Extract<ServerMessage, { conversationId: string }> =>
        "conversationId" in message && message.conversationId === record.id,
    );
    expect(events.map(({ revision }) => revision)).toEqual(
      Array.from({ length: events.at(-1)!.revision }, (_, index) => index + 1),
    );
    const metadataIndex = events.findIndex(
      (event) => event.type === "conversation.metadata" &&
        event.payload.title === "First prompt title",
    );
    const assistantStartIndex = events.findIndex(
      (event) => event.type === "message.started" &&
        event.payload.message.role === "assistant",
    );
    const assistantCompleteIndex = events.findIndex(
      (event) => event.type === "message.completed" &&
        event.payload.message.role === "assistant",
    );
    expect(metadataIndex).toBeGreaterThanOrEqual(0);
    expect(assistantStartIndex).toBeGreaterThan(metadataIndex);
    expect(assistantCompleteIndex).toBeGreaterThan(assistantStartIndex);
    expect(events.slice(assistantStartIndex + 1, assistantCompleteIndex)).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "message.delta" })]),
    );
    socket.close();
  });

  it("runs independent conversations concurrently while switching away from a background stream", async () => {
    const { cwd, secondCwd, sessionDir, factory, faux } = await isolatedPi();
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    faux.setResponses([
      async () => {
        await firstGate;
        return fauxAssistantMessage("First background result");
      },
      async () => {
        await secondGate;
        return fauxAssistantMessage("Second foreground result");
      },
    ]);
    const { registry } = createServices(factory, sessionDir);
    const first = await registry.create(historyWorkspace(cwd));
    const second = await registry.create(historyWorkspace(secondCwd));

    await registry.prompt(first.id, "Run in the background", []);
    await vi.waitFor(() => expect(first.status).toBe("streaming"));
    await registry.prompt(second.id, "Run in the foreground", []);
    await vi.waitFor(() => expect(second.status).toBe("streaming"));

    // Equivalent to switching selection: asking for the second authoritative
    // state must not pause or replace the first conversation's writer.
    await expect(registry.getState(second.id)).resolves.toMatchObject({
      id: second.id,
      cwd: secondCwd,
      status: "streaming",
    });
    expect(first.status).toBe("streaming");
    expect(first.session).not.toBe(second.session);
    expect(first.sessionFile).not.toBe(second.sessionFile);

    releaseSecond?.();
    await waitForIdle(second);
    expect(first.status).toBe("streaming");
    const secondState = await registry.getState(second.id);
    expect(secondState.messages.map(textOf)).toEqual([
      "Run in the foreground",
      "Second foreground result",
    ]);
    expect(
      first.session.sessionManager
        .getBranch()
        .filter((entry) => entry.type === "message"),
    ).toHaveLength(1);

    releaseFirst?.();
    await waitForIdle(first);
    const firstState = await registry.getState(first.id);
    expect(firstState.messages.map(textOf)).toEqual([
      "Run in the background",
      "First background result",
    ]);
    expect(faux.state.callCount).toBe(2);
  });

  it("delivers real Pi steering and follow-up queues in deterministic order", async () => {
    const { cwd, sessionDir, factory, faux } = await isolatedPi();
    let releaseInitial: (() => void) | undefined;
    const initialGate = new Promise<void>((resolve) => {
      releaseInitial = resolve;
    });
    faux.setResponses([
      async () => {
        await initialGate;
        return fauxAssistantMessage("Initial answer");
      },
      fauxAssistantMessage("Answer after steering"),
      fauxAssistantMessage("Answer after follow-up"),
    ]);
    const { registry } = createServices(factory, sessionDir);
    const record = await registry.create(historyWorkspace(cwd));
    const queueEvents: Extract<ConversationRegistryEvent, { type: "conversation.event" }>[] = [];
    registry.subscribe((event) => {
      if (
        event.type === "conversation.event" &&
        event.event.type === "conversation.queue"
      ) {
        queueEvents.push(event);
      }
    });

    await registry.prompt(record.id, "Initial prompt", []);
    await vi.waitFor(() => expect(record.status).toBe("streaming"));
    await registry.prompt(record.id, "Steer this run", [], "steer");
    await registry.prompt(record.id, "Then follow up", [], "followUp");

    const queued = await registry.getState(record.id);
    expect(queued.queue).toEqual({
      steering: [{ text: "Steer this run", imageCount: 0 }],
      followUp: [{ text: "Then follow up", imageCount: 0 }],
    });
    expect(queueEvents.map(({ event }) => event.payload)).toContainEqual({
      steering: [{ text: "Steer this run", imageCount: 0 }],
      followUp: [{ text: "Then follow up", imageCount: 0 }],
    });

    releaseInitial?.();
    await vi.waitFor(() => expect(faux.state.callCount).toBe(3), {
      timeout: 5_000,
    });
    await waitForIdle(record);
    const completed = await registry.getState(record.id);
    expect(completed.queue).toEqual({ steering: [], followUp: [] });
    expect(completed.messages.map(textOf)).toEqual([
      "Initial prompt",
      "Initial answer",
      "Steer this run",
      "Answer after steering",
      "Then follow up",
      "Answer after follow-up",
    ]);
    expect(queueEvents.at(-1)?.event.payload).toEqual({
      steering: [],
      followUp: [],
    });
  });

  it("reconciles aborts and accepted model failures through persisted state", async () => {
    const { cwd, sessionDir, factory, faux } = await isolatedPi(40);
    faux.setResponses([
      fauxAssistantMessage("A response long enough to still be streaming. ".repeat(40)),
      fauxAssistantMessage("", {
        stopReason: "error",
        errorMessage: "private fake provider failure detail",
      }),
    ]);
    const { registry } = createServices(factory, sessionDir);
    const record = await registry.create(historyWorkspace(cwd));
    const statuses: string[] = [];
    registry.subscribe((event) => {
      if (
        event.type === "conversation.event" &&
        event.event.type === "conversation.status"
      ) {
        statuses.push(event.event.payload.status);
      }
    });

    await registry.prompt(record.id, "Abort this response", []);
    await vi.waitFor(() => {
      expect(record.status).toBe("streaming");
      expect(
        record.session.sessionManager
          .getBranch()
          .filter((entry) => entry.type === "message"),
      ).toHaveLength(1);
    });
    await registry.abort(record.id);
    await waitForIdle(record);
    const aborted = await registry.getState(record.id);
    expect(aborted.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "aborted",
    });
    expect(statuses).toContain("aborting");
    expect(statuses.at(-1)).toBe("idle");

    await registry.prompt(record.id, "Produce a model failure", []);
    await waitForIdle(record);
    const failed = await registry.getState(record.id);
    expect(failed.status).toBe("idle");
    expect(failed.messages.at(-1)).toMatchObject({
      role: "assistant",
      stopReason: "error",
      error: {
        code: ERROR_CODES.MODEL_FAILED,
        message: "The model failed while processing the prompt.",
      },
    });
    expect(JSON.stringify(failed)).not.toContain("private fake provider failure detail");
    expect(existsSync(failed.sessionFile)).toBe(true);
  });

  it("reconnects during a real background stream and replaces missed events from a snapshot", async () => {
    const { cwd, sessionDir, factory, faux } = await isolatedPi();
    faux.setResponses([fauxAssistantMessage("Baseline response")]);
    const services = createServices(factory, sessionDir);
    const record = await services.registry.create(historyWorkspace(cwd));
    await services.registry.prompt(record.id, "Baseline prompt", []);
    await waitForIdle(record);

    let releaseBackground: (() => void) | undefined;
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackground = resolve;
    });
    faux.appendResponses([
      async () => {
        await backgroundGate;
        return fauxAssistantMessage("Recovered background response");
      },
    ]);

    const config = loadConfig(
      {
        CHATWCA_DATA_DIR: cwd,
        CHATWCA_SHUTDOWN_GRACE_MS: "100",
      },
      cwd,
    );
    const server = createChatWcaServer(config, "lifecycle-integration", {
      registry: services.registry,
      history: services.history,
      workspaces: fixedWorkspaceRepository(cwd),
      shutdown: services.registry,
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;

    let request = 0;
    const client = new ChatSocketClient({
      url: `ws://127.0.0.1:${String(port)}/ws`,
      webSocketFactory: (url) => new NodeWebSocket(url) as unknown as WebSocket,
      initialReconnectDelayMs: 10,
      maxReconnectDelayMs: 20,
      requestId: () => `lifecycle-${String(++request)}`,
    });
    clients.push(client);
    const connectionStates: string[] = [];
    client.subscribe(() => {
      connectionStates.push(client.getState().connection);
    });
    client.connect();
    await vi.waitFor(() => {
      expect(client.getState().connection).toBe("connected");
    });
    await client.selectWorkspace(record.workspaceId);
    expect(client.getState().history.some(({ id }) => id === record.id)).toBe(true);
    await client.send({
      type: "conversation.state",
      conversationId: record.id,
    });
    client.selectConversation(record.id);

    await client.send({
      type: "prompt.submit",
      conversationId: record.id,
      text: "Continue while disconnected",
      images: [],
    });
    await vi.waitFor(() => expect(record.status).toBe("streaming"));

    for (const socket of server.webSocketServer.clients) socket.terminate();
    await vi.waitFor(() => expect(connectionStates).toContain("reconnecting"));
    releaseBackground?.();
    await waitForIdle(record);

    await vi.waitFor(
      () => {
        const state = client.getState();
        expect(state.connection).toBe("connected");
        const recovered = state.conversations[record.id]?.conversation;
        expect(recovered?.status).toBe("idle");
        expect(recovered?.messages.map(textOf)).toEqual([
          "Baseline prompt",
          "Baseline response",
          "Continue while disconnected",
          "Recovered background response",
        ]);
        expect(recovered?.revision).toBe(record.revision);
        expect(state.resyncConversationIds).not.toContain(record.id);
      },
      { timeout: 5_000 },
    );
  });

  it("evicts the actual idle LRU and rejects capacity when every remaining Pi runtime is active", async () => {
    const { cwd, secondCwd, sessionDir, factory, faux } = await isolatedPi();
    let clock = 1_000;
    const { registry } = createServices(factory, sessionDir, {
      maxLiveConversations: 2,
      now: () => ++clock,
    });

    const first = await registry.create(historyWorkspace(cwd));
    const second = await registry.create(historyWorkspace(secondCwd));
    await registry.getState(first.id);
    const third = await registry.create(historyWorkspace(cwd));

    expect(registry.records).toEqual([first, third]);
    expect(first.runtime.disposed).toBe(false);
    expect(second.runtime.disposed).toBe(true);
    expect(third.runtime.disposed).toBe(false);

    let releaseFirst: (() => void) | undefined;
    let releaseThird: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const thirdGate = new Promise<void>((resolve) => {
      releaseThird = resolve;
    });
    faux.setResponses([
      async () => {
        await firstGate;
        return fauxAssistantMessage("First active result");
      },
      async () => {
        await thirdGate;
        return fauxAssistantMessage("Third active result");
      },
    ]);
    await registry.prompt(first.id, "Keep first active", []);
    await registry.prompt(third.id, "Keep third active", []);
    await vi.waitFor(() => {
      expect(first.status).toBe("streaming");
      expect(third.status).toBe("streaming");
    });

    await expect(registry.create(historyWorkspace(secondCwd))).rejects.toMatchObject({
      code: ERROR_CODES.LIVE_RUNTIME_LIMIT,
    });
    expect(registry.records).toEqual([first, third]);
    expect(first.runtime.disposed).toBe(false);
    expect(third.runtime.disposed).toBe(false);

    releaseFirst?.();
    releaseThird?.();
    await Promise.all([waitForIdle(first), waitForIdle(third)]);
  });

  it("reports missing workspaces and session files using real Pi listings and open paths", async () => {
    const { cwd, secondCwd, sessionDir, factory, faux } = await isolatedPi();
    faux.setResponses([
      fauxAssistantMessage("Workspace response"),
      fauxAssistantMessage("Session response"),
    ]);
    const { registry, history } = createServices(factory, sessionDir);

    const missingWorkspace = await registry.create(historyWorkspace(cwd));
    await registry.prompt(missingWorkspace.id, "Stored in removed workspace", []);
    await waitForIdle(missingWorkspace);
    const missingWorkspaceFile = missingWorkspace.sessionFile;
    await registry.close(missingWorkspace.id);

    const missingSession = await registry.create(historyWorkspace(secondCwd));
    await registry.prompt(missingSession.id, "Session file will disappear", []);
    await waitForIdle(missingSession);
    const missingSessionFile = missingSession.sessionFile;
    await registry.close(missingSession.id);

    await rm(cwd, { recursive: true });
    await expect(history.list(historyWorkspace(cwd))).rejects.toMatchObject({
      code: ERROR_CODES.WORKSPACE_UNAVAILABLE,
    });
    await expect(registry.open(historyWorkspace(cwd), missingWorkspaceFile)).rejects.toMatchObject({
      code: ERROR_CODES.CWD_NOT_FOUND,
    });

    const beforeExternalRemoval = await history.list(historyWorkspace(secondCwd));
    expect(beforeExternalRemoval).toContainEqual(
      expect.objectContaining({
        id: missingSession.id,
        sessionFile: missingSessionFile,
      }),
    );
    await unlink(missingSessionFile);
    await expect(registry.open(historyWorkspace(secondCwd), missingSessionFile)).rejects.toMatchObject({
      code: ERROR_CODES.SESSION_FILE_MISSING,
    });
    await expect(
      history.resolve(historyWorkspace(secondCwd), missingSession.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_NOT_LISTED });
    expect(existsSync(missingWorkspaceFile)).toBe(true);
  });
});
