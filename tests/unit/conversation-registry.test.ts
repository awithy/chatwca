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
    expect(firstRuntime.disposed).toBe(false);
    expect(secondRuntime.disposeSpy).toHaveBeenCalledOnce();
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
