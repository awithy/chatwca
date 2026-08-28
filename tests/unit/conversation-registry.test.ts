import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationRegistry,
  type ConversationRegistryEvent,
} from "../../src/server/conversation-registry.js";
import type {
  PiConversationRuntimePort,
  PiModelCapability,
  PiRuntimeFactoryPort,
  PiRuntimeIdentity,
  PiRuntimeReplacementListener,
} from "../../src/server/pi-runtime.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }),
    ),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-registry-"));
  temporaryRoots.push(root);
  return root;
}

function fakeSession(
  identity: PiRuntimeIdentity,
  options: { readonly title?: string; readonly prompt?: string } = {},
): AgentSession {
  const content = options.prompt;
  return {
    isStreaming: false,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    sessionManager: {
      getHeader: () => ({
        type: "session",
        id: identity.sessionId,
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: identity.cwd,
      }),
      getSessionName: () => options.title,
      getBranch: () =>
        content === undefined
          ? []
          : [
              {
                type: "message",
                id: "entry-1",
                parentId: null,
                timestamp: "2025-01-01T00:00:01.000Z",
                message: { role: "user", content, timestamp: 1 },
              },
            ],
    },
  } as unknown as AgentSession;
}

class FakeRuntime implements PiConversationRuntimePort {
  identity: PiRuntimeIdentity;
  session: AgentSession;
  readonly model: PiModelCapability | undefined = undefined;
  readonly supportsImages = false;
  disposed = false;
  readonly events = new Set<AgentSessionEventListener>();
  readonly replacements = new Set<PiRuntimeReplacementListener>();
  readonly disposeSpy = vi.fn(async () => {
    this.disposed = true;
    this.events.clear();
    this.replacements.clear();
  });

  constructor(
    identity: PiRuntimeIdentity,
    readonly sessionOptions: { readonly title?: string; readonly prompt?: string } = {},
  ) {
    this.identity = identity;
    this.session = fakeSession(identity, sessionOptions);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.events.add(listener);
    return () => this.events.delete(listener);
  }

  onSessionReplaced(listener: PiRuntimeReplacementListener): () => void {
    this.replacements.add(listener);
    return () => this.replacements.delete(listener);
  }

  prompt(): Promise<void> {
    return Promise.resolve();
  }

  abort(): Promise<void> {
    return Promise.resolve();
  }

  fork(): Promise<{ cancelled: boolean }> {
    return Promise.resolve({ cancelled: true });
  }

  dispose(): Promise<void> {
    return this.disposeSpy();
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.events) listener(event);
  }

  replace(identity: PiRuntimeIdentity): void {
    const previous = this.identity;
    this.identity = identity;
    this.session = fakeSession(identity, this.sessionOptions);
    for (const listener of this.replacements) {
      listener({ previous, current: identity });
    }
  }
}

class FakeFactory implements PiRuntimeFactoryPort {
  readonly modelRuntime = null as unknown as ModelRuntime;
  readonly createPersistent = vi.fn<(cwd: string) => Promise<PiConversationRuntimePort>>();
  readonly openPersistent = vi.fn<(file: string) => Promise<PiConversationRuntimePort>>();

  listAvailableModels(): Promise<readonly PiModelCapability[]> {
    return Promise.resolve([]);
  }
}

function identity(id: string, sessionFile: string, cwd: string): PiRuntimeIdentity {
  return { sessionId: id, sessionFile, cwd };
}

describe("ConversationRegistry", () => {
  it("owns indexed records and emits lifecycle/Pi events without a socket", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "one.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("one", sessionFile, cwd), {
      prompt: "First prompt title",
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    let clock = 2_000;
    const listenerFailure = new Error("observer failed");
    const onListenerError = vi.fn();
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      now: () => ++clock,
      onListenerError,
    });
    const events: ConversationRegistryEvent[] = [];
    registry.subscribe((event) => events.push(event));
    registry.subscribe(() => {
      throw listenerFailure;
    });

    const record = await registry.create(cwd);
    expect(registry.size).toBe(1);
    expect(registry.get("one")).toBe(record);
    expect(registry.getBySessionFile(sessionFile)).toBe(record);
    expect(record).toMatchObject({
      id: "one",
      cwd,
      title: "First prompt title",
      status: "idle",
      revision: 0,
      createdAt: Date.parse("2025-01-01T00:00:00.000Z"),
    });
    expect(events.map(({ type }) => type)).toEqual(["conversation.registered"]);

    runtime.emit({ type: "queue_update", steering: [], followUp: [] });
    expect(events.map(({ type }) => type)).toEqual([
      "conversation.registered",
      "conversation.session-event",
    ]);
    expect(record.lastActiveAt).toBe(clock);
    expect(onListenerError).toHaveBeenCalledWith(listenerFailure);
  });

  it("canonicalizes aliases and shares one in-flight open", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const realFile = path.join(root, "session.jsonl");
    const alias = path.join(root, "alias.jsonl");
    await mkdir(cwd);
    await writeFile(realFile, "listed session");
    await symlink(realFile, alias);

    const runtime = new FakeRuntime(identity("open-id", realFile, cwd));
    const factory = new FakeFactory();
    let release: (() => void) | undefined;
    factory.openPersistent.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(runtime);
        }),
    );
    const registry = new ConversationRegistry({ runtimeFactory: factory });

    const first = registry.open(alias);
    const second = registry.open(realFile);
    await vi.waitFor(() => expect(factory.openPersistent).toHaveBeenCalledTimes(1));
    release?.();

    const [firstRecord, secondRecord] = await Promise.all([first, second]);
    expect(firstRecord).toBe(secondRecord);
    expect(firstRecord.sessionFile).toBe(realFile);
    expect(factory.openPersistent).toHaveBeenCalledWith(realFile);

    await expect(registry.open(alias)).resolves.toBe(firstRecord);
    expect(factory.openPersistent).toHaveBeenCalledTimes(1);
  });

  it("suppresses duplicate create identities and disposes the extra runtime", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "same.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const firstRuntime = new FakeRuntime(identity("same", sessionFile, cwd));
    const secondRuntime = new FakeRuntime(identity("same", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.createPersistent
      .mockResolvedValueOnce(firstRuntime)
      .mockResolvedValueOnce(secondRuntime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });

    const [first, second] = await Promise.all([
      registry.create(cwd),
      registry.create(cwd),
    ]);

    expect(first).toBe(second);
    expect(registry.records).toEqual([first]);
    expect([firstRuntime.disposed, secondRuntime.disposed].sort()).toEqual([
      false,
      true,
    ]);
    expect((first.runtime as FakeRuntime).disposed).toBe(false);
  });

  it("returns authoritative snapshots and detects when a new session becomes durable", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "state.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("state", sessionFile, cwd), {
      prompt: "Snapshot prompt",
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const refreshHistory = vi.fn();
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      refreshHistory,
    });
    const eventTypes: string[] = [];
    registry.subscribe((event) => eventTypes.push(event.type));

    await registry.create(cwd);
    await expect(registry.getState("state")).resolves.toMatchObject({
      id: "state",
      title: "Snapshot prompt",
      durable: false,
      revision: 0,
      messages: [
        { entryId: "entry-1", role: "user", blocks: [{ type: "text" }] },
      ],
      queue: { steering: [], followUp: [] },
    });

    await writeFile(sessionFile, "persisted");
    await expect(registry.getState("state")).resolves.toMatchObject({
      durable: true,
      revision: 1,
    });
    expect(eventTypes).toEqual([
      "conversation.registered",
      "conversation.state-changed",
    ]);
    expect(refreshHistory).toHaveBeenCalledTimes(2);
  });

  it("refuses to close active runs and fully removes an idle runtime", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "close.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("close", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const refreshHistory = vi.fn();
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      refreshHistory,
    });
    const record = await registry.create(cwd);
    record.status = "streaming";

    await expect(registry.close("close")).rejects.toMatchObject({
      code: "conversation_busy",
    });
    expect(runtime.disposed).toBe(false);

    record.status = "idle";
    await registry.close("close");
    expect(runtime.disposeSpy).toHaveBeenCalledOnce();
    expect(runtime.events.size).toBe(0);
    expect(runtime.replacements.size).toBe(0);
    expect(registry.size).toBe(0);
    expect(registry.get("close")).toBeUndefined();
    expect(registry.getBySessionFile(sessionFile)).toBeUndefined();
    expect(refreshHistory).toHaveBeenCalledTimes(2);
  });

  it("reports externally removed live session files and refreshes history", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "missing.jsonl");
    await mkdir(cwd);
    await writeFile(sessionFile, "persisted");

    const runtime = new FakeRuntime(identity("missing", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.openPersistent.mockResolvedValue(runtime);
    const refreshHistory = vi.fn();
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      refreshHistory,
    });
    const record = await registry.open(sessionFile);
    await rm(sessionFile);

    await expect(registry.getState("missing")).rejects.toMatchObject({
      code: "session_file_missing",
    });
    expect(record.status).toBe("error");
    expect(record.revision).toBe(1);
    expect(refreshHistory).toHaveBeenCalledTimes(2);
  });

  it("disposes all records, including active ones, without leaked listeners", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);

    const firstRuntime = new FakeRuntime(
      identity("first", path.join(sessions, "first.jsonl"), cwd),
    );
    const secondRuntime = new FakeRuntime(
      identity("second", path.join(sessions, "second.jsonl"), cwd),
    );
    const factory = new FakeFactory();
    factory.createPersistent
      .mockResolvedValueOnce(firstRuntime)
      .mockResolvedValueOnce(secondRuntime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const first = await registry.create(cwd);
    await registry.create(cwd);
    first.status = "streaming";

    await registry.dispose();
    await registry.dispose();

    expect(registry.size).toBe(0);
    expect(firstRuntime.disposeSpy).toHaveBeenCalledOnce();
    expect(secondRuntime.disposeSpy).toHaveBeenCalledOnce();
    expect(firstRuntime.events.size).toBe(0);
    expect(secondRuntime.events.size).toBe(0);
  });

  it("evicts the least-recently-used idle runtime before creating another", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);

    const firstRuntime = new FakeRuntime(
      identity("first", path.join(sessions, "first.jsonl"), cwd),
    );
    const secondRuntime = new FakeRuntime(
      identity("second", path.join(sessions, "second.jsonl"), cwd),
    );
    const thirdRuntime = new FakeRuntime(
      identity("third", path.join(sessions, "third.jsonl"), cwd),
    );
    const factory = new FakeFactory();
    factory.createPersistent
      .mockResolvedValueOnce(firstRuntime)
      .mockResolvedValueOnce(secondRuntime)
      .mockResolvedValueOnce(thirdRuntime);
    let clock = 100;
    const refreshHistory = vi.fn();
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 2,
      now: () => ++clock,
      refreshHistory,
    });
    const closed: ConversationRegistryEvent[] = [];
    registry.subscribe((event) => {
      if (event.type === "conversation.closed") closed.push(event);
    });

    const first = await registry.create(cwd);
    const second = await registry.create(cwd);
    await registry.getState(first.id);
    const third = await registry.create(cwd);

    expect(secondRuntime.disposeSpy).toHaveBeenCalledOnce();
    expect(firstRuntime.disposed).toBe(false);
    expect(thirdRuntime.disposed).toBe(false);
    expect(registry.records).toEqual([first, third]);
    expect(closed).toMatchObject([
      { type: "conversation.closed", record: second, reason: "evict" },
    ]);
    expect(refreshHistory).toHaveBeenCalledTimes(4);
  });

  it("returns a stable capacity error when all runtime slots are active", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);

    const firstRuntime = new FakeRuntime(
      identity("first", path.join(sessions, "first.jsonl"), cwd),
    );
    const secondRuntime = new FakeRuntime(
      identity("second", path.join(sessions, "second.jsonl"), cwd),
    );
    const factory = new FakeFactory();
    factory.createPersistent
      .mockResolvedValueOnce(firstRuntime)
      .mockResolvedValueOnce(secondRuntime);
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 1,
    });
    const first = await registry.create(cwd);
    first.status = "streaming";

    await expect(registry.create(cwd)).rejects.toMatchObject({
      code: "live_runtime_limit",
    });
    expect(factory.createPersistent).toHaveBeenCalledTimes(1);
    expect(firstRuntime.disposed).toBe(false);
  });

  it("counts in-flight runtime construction against capacity", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);

    const runtime = new FakeRuntime(
      identity("first", path.join(sessions, "first.jsonl"), cwd),
    );
    const factory = new FakeFactory();
    let release: (() => void) | undefined;
    factory.createPersistent.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve(runtime);
        }),
    );
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 1,
    });

    const first = registry.create(cwd);
    await vi.waitFor(() => expect(factory.createPersistent).toHaveBeenCalledOnce());
    await expect(registry.create(cwd)).rejects.toMatchObject({
      code: "live_runtime_limit",
    });
    expect(factory.createPersistent).toHaveBeenCalledOnce();
    release?.();
    await expect(first).resolves.toMatchObject({ id: "first" });
  });

  it("opens an already-live session at capacity without eviction", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "session.jsonl");
    await mkdir(cwd);
    await writeFile(sessionFile, "persisted");

    const runtime = new FakeRuntime(identity("open", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.openPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 1,
    });

    const first = await registry.open(sessionFile);
    await expect(registry.open(sessionFile)).resolves.toBe(first);
    expect(runtime.disposed).toBe(false);
    expect(factory.openPersistent).toHaveBeenCalledOnce();
  });

  it("validates the configured live-runtime limit", () => {
    const factory = new FakeFactory();
    expect(
      () =>
        new ConversationRegistry({
          runtimeFactory: factory,
          maxLiveConversations: 0,
        }),
    ).toThrow("maxLiveConversations must be a positive integer");
  });

  it("refreshes both indexes and the active session reference after replacement", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const oldFile = path.join(root, "sessions", "old.jsonl");
    const newFile = path.join(root, "sessions", "new.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(oldFile))]);

    const runtime = new FakeRuntime(identity("old", oldFile, cwd), {
      title: "Named session",
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const eventTypes: string[] = [];
    registry.subscribe((event) => eventTypes.push(event.type));
    const record = await registry.create(cwd);
    const oldSession = record.session;

    runtime.replace(identity("new", newFile, cwd));

    expect(registry.get("old")).toBeUndefined();
    expect(registry.getBySessionFile(oldFile)).toBeUndefined();
    expect(registry.get("new")).toBe(record);
    expect(registry.getBySessionFile(newFile)).toBe(record);
    expect(record.session).toBe(runtime.session);
    expect(record.session).not.toBe(oldSession);
    expect(record.revision).toBe(1);
    expect(eventTypes).toEqual([
      "conversation.registered",
      "conversation.replaced",
    ]);
  });
});
