import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
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
  type AgentSession,
  type AgentSessionEventListener,
  type PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import NodeWebSocket from "ws";

import { loadConfig } from "../../src/server/config.js";
import { ConversationRegistry } from "../../src/server/conversation-registry.js";
import {
  createChatWcaServer,
  type ChatWcaServer,
} from "../../src/server/index.js";
import {
  PiRuntimeFactory,
  type PiConversationRuntimePort,
  type PiForkResult,
  type PiModelCapability,
  type PiRuntimeFactoryPort,
  type PiRuntimeFatalFailureListener,
  type PiRuntimeIdentity,
  type PiRuntimeNetworkBlockedListener,
  type PiRuntimeReplacementListener,
} from "../../src/server/pi-runtime.js";
import { SessionHistory } from "../../src/server/session-history.js";
import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import { ChatSocketClient } from "../../src/web/src/api/client.js";

interface IsolatedPi {
  readonly root: string;
  readonly cwd: string;
  readonly sessionDir: string;
  readonly factory: PiRuntimeFactory;
  readonly faux: FauxProviderHandle;
}

const temporaryRoots: string[] = [];
const servers: ChatWcaServer[] = [];
const registries: ConversationRegistry[] = [];
const clients: ChatSocketClient[] = [];

async function isolatedPi(tokensPerSecond = 10_000): Promise<IsolatedPi> {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-fork-integration-"));
  temporaryRoots.push(root);
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(agentDir), mkdir(sessionDir)]);

  const faux = fauxProvider({ tokensPerSecond });
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
  return { root, cwd, sessionDir, factory, faux };
}

async function closeServer(server: ChatWcaServer): Promise<void> {
  for (const socket of server.webSocketServer.clients) socket.terminate();
  await new Promise<void>((resolve) => server.webSocketServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
}

afterEach(async () => {
  for (const client of clients.splice(0)) client.disconnect();
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.allSettled(registries.splice(0).map((registry) => registry.dispose()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

function messageEntries(session: AgentSession) {
  return session.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message");
}

async function waitForIdle(record: ConversationRegistry["records"][number]) {
  await vi.waitFor(() => {
    expect(record.status).toBe("idle");
    expect(record.session.isStreaming).toBe(false);
  });
}

function policy(cwd: string) {
  return {
    workspaceId: cwd,
    cwd,
    sessionDirectory: null,
    securityProfile: "unrestricted" as const,
  };
}

class TrackingRuntime implements PiConversationRuntimePort {
  readonly eventSubscriptions = new Set<AgentSessionEventListener>();
  readonly replacementSubscriptions = new Set<PiRuntimeReplacementListener>();
  disposeCalls = 0;
  forkIdentity: PiRuntimeIdentity | undefined;

  constructor(
    readonly inner: PiConversationRuntimePort,
    readonly failAfterFork: boolean,
  ) {}

  get session(): AgentSession {
    return this.inner.session;
  }

  get securityProfile() {
    return this.inner.securityProfile;
  }

  get networkPolicy() {
    return this.inner.networkPolicy;
  }

  get networkPolicySetId() {
    return this.inner.networkPolicySetId;
  }

  get networkPolicySet() {
    return this.inner.networkPolicySet;
  }

  get identity(): PiRuntimeIdentity {
    return this.inner.identity;
  }

  get model(): PiModelCapability | undefined {
    return this.inner.model;
  }

  get supportsImages(): boolean {
    return this.inner.supportsImages;
  }

  get disposed(): boolean {
    return this.inner.disposed;
  }

  get teardownComplete(): boolean {
    return this.inner.teardownComplete;
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.eventSubscriptions.add(listener);
    const unsubscribe = this.inner.subscribe(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.eventSubscriptions.delete(listener);
      unsubscribe();
    };
  }

  onSessionReplaced(listener: PiRuntimeReplacementListener): () => void {
    this.replacementSubscriptions.add(listener);
    const unsubscribe = this.inner.onSessionReplaced(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.replacementSubscriptions.delete(listener);
      unsubscribe();
    };
  }

  onFatalFailure(listener: PiRuntimeFatalFailureListener): () => void {
    return this.inner.onFatalFailure(listener);
  }

  onNetworkBlocked(listener: PiRuntimeNetworkBlockedListener): () => void {
    return this.inner.onNetworkBlocked(listener);
  }

  prompt(text: string, options?: PromptOptions): Promise<void> {
    return this.inner.prompt(text, options);
  }

  abort(): Promise<void> {
    return this.inner.abort();
  }

  async fork(entryId: string): Promise<PiForkResult> {
    const result = await this.inner.fork(entryId);
    this.forkIdentity = this.identity;
    if (this.failAfterFork) {
      throw new AppError(ERROR_CODES.PI_RUNTIME_REPLACE_FAILED);
    }
    return result;
  }

  async dispose(): Promise<void> {
    this.disposeCalls += 1;
    await this.inner.dispose();
  }
}

class TrackingFactory implements PiRuntimeFactoryPort {
  readonly created: TrackingRuntime[] = [];
  readonly opened: TrackingRuntime[] = [];

  constructor(readonly inner: PiRuntimeFactory) {}

  get modelRuntime(): ModelRuntime {
    return this.inner.modelRuntime;
  }

  get strictModelRuntime(): ModelRuntime {
    return this.inner.strictModelRuntime;
  }

  listAvailableModels(): Promise<readonly PiModelCapability[]> {
    return this.inner.listAvailableModels();
  }

  async createPersistent(policy: Parameters<PiRuntimeFactory["createPersistent"]>[0]): Promise<TrackingRuntime> {
    const runtime = new TrackingRuntime(
      await this.inner.createPersistent(policy),
      false,
    );
    this.created.push(runtime);
    return runtime;
  }

  async openPersistent(
    policy: Parameters<PiRuntimeFactory["openPersistent"]>[0],
    sessionFile: string,
  ): Promise<TrackingRuntime> {
    const runtime = new TrackingRuntime(
      await this.inner.openPersistent(policy, sessionFile),
      true,
    );
    this.opened.push(runtime);
    return runtime;
  }
}

describe("conversation fork integration", () => {
  it("preserves the source and returns a distinct expected fork whose editor text remains editable", async () => {
    const { cwd, sessionDir, factory, faux } = await isolatedPi();
    faux.setResponses([
      fauxAssistantMessage("First response"),
      fauxAssistantMessage("Second response"),
    ]);

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
      maxLiveConversations: 2,
      refreshHistory: (workspaceId) =>
        history.refresh({ id: workspaceId, path: workspaceId }).then(() => undefined),
    });
    registries.push(registry);

    const source = await registry.create(policy(cwd));
    await registry.prompt(source.id, "Keep this earlier turn.", []);
    await vi.waitFor(() => expect(messageEntries(source.session)).toHaveLength(2));
    await waitForIdle(source);
    await registry.prompt(source.id, "Copy this prompt into the editor.", []);
    await vi.waitFor(() => expect(messageEntries(source.session)).toHaveLength(4));
    await waitForIdle(source);

    const target = messageEntries(source.session).filter(
      (entry) => entry.message.role === "user",
    )[1];
    expect(target).toBeDefined();

    const sourceRuntime = source.runtime;
    const sourceSession = source.session;
    const sourceIdentity = source.runtime.identity;
    const sourceRevision = source.revision;
    const sourceBranchIds = source.session.sessionManager
      .getBranch()
      .map((entry) => entry.id);
    const sourceBytes = await readFile(source.sessionFile);
    const sourceModifiedAt = (await stat(source.sessionFile)).mtimeMs;

    const config = loadConfig({ CHATWCA_DATA_DIR: cwd }, cwd);
    const server = createChatWcaServer(config, "fork-integration", {
      registry,
      history,
      workspaces: {
        list: () => [],
        requireAvailable: (workspaceId) => ({ id: workspaceId, path: cwd }),
        requireUsable: (workspaceId) => ({
          workspaceId,
          cwd,
          sessionDirectory: null,
          securityProfile: "unrestricted",
        }),
        create: () => { throw new Error("Unexpected workspace create"); },
        update: () => { throw new Error("Unexpected workspace update"); },
        delete: () => { throw new Error("Unexpected workspace delete"); },
      },
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.httpServer.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.httpServer.address() as AddressInfo;

    const client = new ChatSocketClient({
      url: `ws://127.0.0.1:${String(port)}/ws`,
      webSocketFactory: (url) =>
        new NodeWebSocket(url) as unknown as WebSocket,
      requestId: (() => {
        let value = 0;
        return () => `fork-integration-${String(++value)}`;
      })(),
    });
    clients.push(client);
    client.connect();
    await vi.waitFor(() => {
      expect(client.getState().connection).toBe("connected");
    });
    await client.selectWorkspace(source.workspaceId);
    expect(client.getState().history.some(({ id }) => id === source.id)).toBe(true);
    client.selectConversation(source.id);
    client.setDraft(source.id, "source-local-draft");

    const result = await client.forkConversation(source.id, target!.id);
    const fork = result.conversation;

    expect(result.editorText).toBe("Copy this prompt into the editor.");
    expect(fork).toMatchObject({
      cwd,
      status: "idle",
      durable: true,
      messages: [
        {
          role: "user",
          blocks: [{ type: "text", text: "Keep this earlier turn." }],
        },
        {
          role: "assistant",
          blocks: [{ type: "text", text: "First response" }],
        },
      ],
    });
    expect(fork.id).not.toBe(sourceIdentity.sessionId);
    expect(fork.sessionFile).not.toBe(sourceIdentity.sessionFile);
    expect(existsSync(fork.sessionFile)).toBe(true);

    expect(client.getState()).toMatchObject({
      selectedConversationId: fork.id,
      drafts: {
        [source.id]: "source-local-draft",
        [fork.id]: "Copy this prompt into the editor.",
      },
    });
    client.setDraft(fork.id, "Edited copied prompt");
    expect(client.getState().drafts[fork.id]).toBe("Edited copied prompt");
    client.setDraft(fork.id, "");
    expect(client.getState().drafts[fork.id]).toBe("");

    expect(registry.get(source.id)).toBe(source);
    expect(source.runtime).toBe(sourceRuntime);
    expect(source.session).toBe(sourceSession);
    expect(source.runtime.identity).toEqual(sourceIdentity);
    expect(source.revision).toBe(sourceRevision);
    expect(source.session.sessionManager.getBranch().map((entry) => entry.id))
      .toEqual(sourceBranchIds);
    expect(await readFile(source.sessionFile)).toEqual(sourceBytes);
    expect((await stat(source.sessionFile)).mtimeMs).toBe(sourceModifiedAt);

    const listed = await history.list({ id: cwd, path: cwd });
    expect(listed.map(({ id }) => id).sort()).toEqual(
      [source.id, fork.id].sort(),
    );
    expect(listed.find(({ id }) => id === source.id)).toMatchObject({
      messageCount: 4,
      status: "idle",
    });
    expect(listed.find(({ id }) => id === fork.id)).toMatchObject({
      messageCount: 2,
      status: "idle",
    });
  });

  it("rejects actual non-user and abandoned-branch targets before opening a fork runtime", async () => {
    const { cwd, factory, faux } = await isolatedPi();
    faux.setResponses([
      fauxAssistantMessage("First response"),
      fauxAssistantMessage("Abandoned response"),
    ]);
    const trackingFactory = new TrackingFactory(factory);
    const registry = new ConversationRegistry({
      runtimeFactory: trackingFactory,
      maxLiveConversations: 2,
    });
    registries.push(registry);

    const source = await registry.create(policy(cwd));
    await registry.prompt(source.id, "Root user prompt", []);
    await vi.waitFor(() => expect(messageEntries(source.session)).toHaveLength(2));
    await waitForIdle(source);
    await registry.prompt(source.id, "User prompt to abandon", []);
    await vi.waitFor(() => expect(messageEntries(source.session)).toHaveLength(4));
    await waitForIdle(source);

    const originalMessages = messageEntries(source.session);
    const firstAssistant = originalMessages[1];
    const abandonedUser = originalMessages[2];
    expect(firstAssistant?.message.role).toBe("assistant");
    expect(abandonedUser?.message.role).toBe("user");

    source.session.sessionManager.branch(firstAssistant!.id);
    const activeUserId = source.session.sessionManager.appendMessage({
      role: "user",
      content: "Active replacement prompt",
      timestamp: 1_700_000_000_000,
    });
    expect(source.session.sessionManager.getBranch().map(({ id }) => id)).toContain(
      activeUserId,
    );
    expect(source.session.sessionManager.getBranch().map(({ id }) => id)).not.toContain(
      abandonedUser!.id,
    );

    const sourceRuntime = source.runtime;
    const sourceIdentity = source.runtime.identity;
    const sourceBytes = await readFile(source.sessionFile);
    for (const entryId of [firstAssistant!.id, abandonedUser!.id]) {
      await expect(registry.fork(source.id, entryId, policy(cwd))).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_FORK_TARGET,
      });
    }

    expect(trackingFactory.opened).toHaveLength(0);
    expect(registry.records).toEqual([source]);
    expect(source.runtime).toBe(sourceRuntime);
    expect(source.runtime.identity).toEqual(sourceIdentity);
    expect(await readFile(source.sessionFile)).toEqual(sourceBytes);
  });

  it("rejects a fork while the source model run is streaming", async () => {
    const { cwd, factory, faux } = await isolatedPi();
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    faux.setResponses([
      async () => {
        await responseGate;
        return fauxAssistantMessage("Released response");
      },
    ]);
    const trackingFactory = new TrackingFactory(factory);
    const registry = new ConversationRegistry({
      runtimeFactory: trackingFactory,
      maxLiveConversations: 2,
    });
    registries.push(registry);

    const source = await registry.create(policy(cwd));
    await registry.prompt(source.id, "Do not fork during this run", []);
    await vi.waitFor(() => {
      expect(source.status).toBe("streaming");
      expect(messageEntries(source.session)[0]?.message.role).toBe("user");
    });
    const userEntry = messageEntries(source.session)[0];

    await expect(registry.fork(source.id, userEntry!.id, policy(cwd))).rejects.toMatchObject({
      code: ERROR_CODES.FORK_SOURCE_BUSY,
    });
    expect(trackingFactory.opened).toHaveLength(0);
    expect(registry.records).toEqual([source]);

    releaseResponse?.();
    await waitForIdle(source);
  });

  it("disposes subscriptions and removes the fork artifact when failure follows real Pi replacement", async () => {
    const { cwd, factory, faux } = await isolatedPi();
    faux.setResponses([fauxAssistantMessage("Source response")]);
    const trackingFactory = new TrackingFactory(factory);
    const registry = new ConversationRegistry({
      runtimeFactory: trackingFactory,
      maxLiveConversations: 2,
    });
    registries.push(registry);

    const source = await registry.create(policy(cwd));
    await registry.prompt(source.id, "Fork target", []);
    await vi.waitFor(() => expect(messageEntries(source.session)).toHaveLength(2));
    await waitForIdle(source);
    const userEntry = messageEntries(source.session)[0];
    const sourceTracking = trackingFactory.created[0];
    expect(sourceTracking).toBeDefined();
    expect(sourceTracking!.eventSubscriptions.size).toBe(1);
    expect(sourceTracking!.replacementSubscriptions.size).toBe(1);

    const sourceIdentity = source.runtime.identity;
    const sourceBytes = await readFile(source.sessionFile);
    await expect(registry.fork(source.id, userEntry!.id, policy(cwd))).rejects.toMatchObject({
      code: ERROR_CODES.PI_RUNTIME_REPLACE_FAILED,
    });

    expect(trackingFactory.opened).toHaveLength(1);
    const failed = trackingFactory.opened[0]!;
    expect(failed.forkIdentity).toBeDefined();
    expect(failed.forkIdentity!.sessionFile).not.toBe(source.sessionFile);
    expect(failed.disposeCalls).toBe(1);
    expect(failed.disposed).toBe(true);
    expect(failed.eventSubscriptions.size).toBe(0);
    expect(failed.replacementSubscriptions.size).toBe(0);
    expect(existsSync(failed.forkIdentity!.sessionFile)).toBe(false);

    expect(registry.records).toEqual([source]);
    expect(source.runtime.identity).toEqual(sourceIdentity);
    expect(sourceTracking!.disposeCalls).toBe(0);
    expect(sourceTracking!.eventSubscriptions.size).toBe(1);
    expect(sourceTracking!.replacementSubscriptions.size).toBe(1);
    expect(await readFile(source.sessionFile)).toEqual(sourceBytes);

    // Failure released both the source guard and the reserved capacity.
    faux.setResponses([fauxAssistantMessage("Source still runs")]);
    await expect(registry.prompt(source.id, "Still usable", [])).resolves.toBeUndefined();
    await waitForIdle(source);
  });
});
