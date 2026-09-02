import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionEventListener,
  ModelRuntime,
  PromptOptions,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppError, ERROR_CODES } from "../../src/shared/errors.js";
import {
  ConversationRegistry,
  type ConversationRegistryEvent,
} from "../../src/server/conversation-registry.js";
import type {
  PiConversationRuntimePort,
  PiForkOptions,
  PiForkResult,
  PiModelCapability,
  PiRuntimeFactoryPort,
  PiRuntimeFatalFailureListener,
  PiRuntimeIdentity,
  PiRuntimeNetworkBlockedListener,
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

interface FakeSessionOptions {
  readonly title?: string;
  readonly prompt?: string;
  readonly branch?: readonly unknown[];
  readonly sdkModel?: NonNullable<AgentSession["model"]>;
  readonly securityProfile?: "unrestricted" | "workspace-sandboxed";
  readonly networkPolicy?: "isolated" | "managed-egress" | null;
}

function fakeSession(
  identity: PiRuntimeIdentity,
  options: FakeSessionOptions = {},
): AgentSession {
  const content = options.prompt;
  let sessionName = options.title;
  return {
    isStreaming: false,
    model: options.sdkModel,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    sessionManager: {
      getHeader: () => ({
        type: "session",
        id: identity.sessionId,
        timestamp: "2025-01-01T00:00:00.000Z",
        cwd: identity.cwd,
      }),
      getSessionName: () => sessionName,
      appendSessionInfo: (name: string) => {
        sessionName = name;
      },
      getBranch: () =>
        options.branch ??
        (content === undefined
          ? []
          : [
              {
                type: "message",
                id: "entry-1",
                parentId: null,
                timestamp: "2025-01-01T00:00:01.000Z",
                message: { role: "user", content, timestamp: 1 },
              },
            ]),
    },
  } as unknown as AgentSession;
}

class FakeRuntime implements PiConversationRuntimePort {
  identity: PiRuntimeIdentity;
  session: AgentSession;
  readonly model: PiModelCapability | undefined = undefined;
  readonly securityProfile: "unrestricted" | "workspace-sandboxed";
  readonly networkPolicy: "isolated" | "managed-egress" | null;
  readonly supportsImages = false;
  disposed = false;
  teardownComplete = false;
  readonly events = new Set<AgentSessionEventListener>();
  readonly replacements = new Set<PiRuntimeReplacementListener>();
  readonly fatalFailures = new Set<PiRuntimeFatalFailureListener>();
  readonly blockedEvents = new Set<PiRuntimeNetworkBlockedListener>();
  readonly promptSpy = vi.fn(
    async (_text: string, options?: PromptOptions) => {
      options?.preflightResult?.(true);
    },
  );
  readonly abortSpy = vi.fn(async () => undefined);
  readonly forkSpy = vi.fn(
    async (_entryId: string, _options?: PiForkOptions): Promise<PiForkResult> => ({
      cancelled: true,
    }),
  );
  readonly disposeSpy = vi.fn(async () => {
    this.disposed = true;
    this.events.clear();
    this.replacements.clear();
    this.fatalFailures.clear();
    this.blockedEvents.clear();
    this.teardownComplete = true;
  });

  constructor(
    identity: PiRuntimeIdentity,
    readonly sessionOptions: FakeSessionOptions = {},
  ) {
    this.identity = identity;
    this.securityProfile = sessionOptions.securityProfile ?? "unrestricted";
    this.networkPolicy = sessionOptions.networkPolicy ??
      (this.securityProfile === "workspace-sandboxed" ? "isolated" : null);
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

  onFatalFailure(listener: PiRuntimeFatalFailureListener): () => void {
    this.fatalFailures.add(listener);
    return () => this.fatalFailures.delete(listener);
  }

  onNetworkBlocked(listener: PiRuntimeNetworkBlockedListener): () => void {
    this.blockedEvents.add(listener);
    return () => this.blockedEvents.delete(listener);
  }

  prompt(text: string, options?: PromptOptions): Promise<void> {
    return this.promptSpy(text, options);
  }

  abort(): Promise<void> {
    return this.abortSpy();
  }

  fork(entryId: string, options?: PiForkOptions): Promise<PiForkResult> {
    return this.forkSpy(entryId, options);
  }

  dispose(): Promise<void> {
    return this.disposeSpy();
  }

  emit(event: AgentSessionEvent): void {
    for (const listener of this.events) listener(event);
  }

  emitFatal(error = new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED)): void {
    for (const listener of this.fatalFailures) listener(error);
  }

  emitBlocked(event: Parameters<PiRuntimeNetworkBlockedListener>[0]): void {
    for (const listener of this.blockedEvents) listener(event);
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
  readonly strictModelRuntime = null as unknown as ModelRuntime;
  readonly createPersistent = vi.fn<PiRuntimeFactoryPort["createPersistent"]>();
  readonly openPersistent = vi.fn<PiRuntimeFactoryPort["openPersistent"]>();

  listAvailableModels(): Promise<readonly PiModelCapability[]> {
    return Promise.resolve([]);
  }
}

function identity(id: string, sessionFile: string, cwd: string): PiRuntimeIdentity {
  return { sessionId: id, sessionFile, cwd };
}

function ownership(cwd: string, id = cwd) {
  return {
    workspaceId: id,
    cwd,
    sessionDirectory: null,
    securityProfile: "unrestricted",
  } as const;
}

describe("ConversationRegistry", () => {
  it("persists trimmed conversation titles and rejects blank titles", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "rename.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("rename", sessionFile, cwd), {
      title: "Original title",
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const events: ConversationRegistryEvent[] = [];
    registry.subscribe((event) => events.push(event));
    await registry.create(ownership(cwd, "workspace-1"));

    await expect(registry.rename("rename", "  Updated title  ")).resolves.toMatchObject({
      title: "Updated title",
      revision: 1,
    });
    expect(runtime.session.sessionManager.getSessionName()).toBe("Updated title");
    expect(events.at(-1)).toMatchObject({
      type: "conversation.state-changed",
      record: { title: "Updated title", revision: 1 },
    });
    await expect(registry.rename("rename", "   ")).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_CONVERSATION_TITLE,
    });
  });

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

    const record = await registry.create(ownership(cwd, "workspace-1"));
    expect(registry.size).toBe(1);
    expect(registry.get("one")).toBe(record);
    expect(registry.getBySessionFile(sessionFile)).toBe(record);
    expect(record).toMatchObject({
      id: "one",
      workspaceId: "workspace-1",
      cwd,
      title: "First prompt title",
      status: "idle",
      revision: 0,
      createdAt: Date.parse("2025-01-01T00:00:00.000Z"),
    });
    expect(registry.hasLiveWorkspace("workspace-1")).toBe(true);
    expect(registry.hasLiveWorkspace("workspace-2")).toBe(false);
    expect(events.map(({ type }) => type)).toEqual(["conversation.registered"]);

    runtime.emit({ type: "queue_update", steering: [], followUp: [] });
    expect(events.map(({ type }) => type)).toEqual([
      "conversation.registered",
      "conversation.event",
    ]);
    expect(events[1]).toMatchObject({
      event: {
        type: "conversation.queue",
        workspaceId: "workspace-1",
        conversationId: "one",
        revision: 1,
        payload: { steering: [], followUp: [] },
      },
    });
    expect(record.revision).toBe(1);
    expect(record.lastActiveAt).toBe(clock);
    expect(onListenerError).toHaveBeenCalledWith(listenerFailure);
  });

  it("applies normalized lifecycle transitions in monotonic revision order", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "events.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("events", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const normalized: ConversationRegistryEvent[] = [];
    registry.subscribe((item) => {
      if (item.type === "conversation.event") normalized.push(item);
    });
    const record = await registry.create(ownership(cwd));

    runtime.emit({ type: "agent_start" });
    runtime.emit({ type: "queue_update", steering: ["steer"], followUp: [] });
    runtime.emit({ type: "agent_end", messages: [], willRetry: false });
    runtime.emit({ type: "agent_end", messages: [], willRetry: false });

    expect(record.status).toBe("idle");
    expect(record.revision).toBe(3);
    expect(
      normalized.map((item) =>
        item.type === "conversation.event"
          ? [item.event.type, item.event.revision]
          : [],
      ),
    ).toEqual([
      ["conversation.status", 1],
      ["conversation.queue", 2],
      ["conversation.status", 3],
    ]);
  });

  it("acknowledges prompt preflight without waiting for completion and enforces delivery modes", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "prompt.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("prompt", sessionFile, cwd));
    let finishRun: (() => void) | undefined;
    runtime.promptSpy.mockImplementation((_text, options) => {
      options?.preflightResult?.(true);
      return new Promise<void>((resolve) => {
        finishRun = resolve;
      });
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const record = await registry.create(ownership(cwd));

    await expect(registry.prompt(record.id, "hello", [])).resolves.toBeUndefined();
    expect(finishRun).toBeTypeOf("function");
    expect(runtime.promptSpy).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ preflightResult: expect.any(Function) }),
    );

    record.status = "streaming";
    await expect(registry.prompt(record.id, "normal", [])).rejects.toMatchObject({
      code: ERROR_CODES.CONVERSATION_BUSY,
    });
    await expect(
      registry.prompt(record.id, "steer", [], "steer"),
    ).resolves.toBeUndefined();
    expect(runtime.promptSpy).toHaveBeenLastCalledWith(
      "steer",
      expect.objectContaining({ streamingBehavior: "steer" }),
    );

    record.status = "idle";
    await expect(
      registry.prompt(record.id, "later", [], "followUp"),
    ).rejects.toMatchObject({ code: ERROR_CODES.CONVERSATION_BUSY });
    await expect(registry.prompt(record.id, "  ", [])).rejects.toMatchObject({
      code: ERROR_CODES.INVALID_PROMPT,
    });
    finishRun?.();
  });

  it("validates and converts images before forwarding them to Pi", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "images.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("images", sessionFile, cwd));
    Object.defineProperty(runtime, "supportsImages", { value: true });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      imageLimits: {
        maxImages: 1,
        maxImageBytes: 16,
        maxTotalImageBytes: 16,
      },
    });
    const record = await registry.create(ownership(cwd));
    const data = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]).toString("base64");

    await expect(
      registry.prompt(record.id, "describe", [
        {
          mimeType: "image/png",
          encoding: "base64",
          data,
          name: "browser-name.png",
          byteSize: 1,
        },
      ]),
    ).resolves.toBeUndefined();
    expect(runtime.promptSpy).toHaveBeenCalledWith(
      "describe",
      expect.objectContaining({
        images: [{ type: "image", mimeType: "image/png", data }],
        preflightResult: expect.any(Function),
      }),
    );
  });

  it("serves validated images from canonical tool-result entries", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "tool-image.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);
    const bytes = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
    ]);
    const runtime = new FakeRuntime(identity("tool-image", sessionFile, cwd), {
      branch: [{
        type: "message",
        id: "tool-result-entry",
        message: {
          role: "toolResult",
          toolCallId: "call-image",
          toolName: "read",
          content: [
            { type: "text", text: "Read image file [image/png]" },
            {
              type: "image",
              mimeType: "image/png",
              data: bytes.toString("base64"),
            },
          ],
          isError: false,
        },
      }],
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    await registry.create(ownership(cwd));
    const workspaceImage = path.join(cwd, "generated.png");
    const outsideImage = path.join(root, "outside.png");
    await Promise.all([
      writeFile(workspaceImage, bytes),
      writeFile(outsideImage, bytes),
    ]);
    await symlink(outsideImage, path.join(cwd, "outside-link.png"));

    const state = await registry.getState("tool-image");
    expect(state.messages[0]?.blocks[1]).toEqual({
      type: "image",
      image: {
        mimeType: "image/png",
        url: "/api/conversations/tool-image/messages/tool-result-entry/images/0",
      },
      alt: "Generated image",
    });
    expect(registry.getImage("tool-image", "tool-result-entry", 0)).toEqual({
      mimeType: "image/png",
      data: bytes,
    });
    expect(registry.getImage("tool-image", "tool-result-entry", 1)).toBeUndefined();
    expect(registry.getImage("tool-image", "missing", 0)).toBeUndefined();
    expect(await registry.getWorkspaceImage("tool-image", "generated.png")).toEqual({
      mimeType: "image/png",
      data: bytes,
    });
    expect(await registry.getWorkspaceImage("tool-image", workspaceImage)).toEqual({
      mimeType: "image/png",
      data: bytes,
    });
    expect(await registry.getWorkspaceImage("tool-image", "outside-link.png"))
      .toBeUndefined();
    expect(await registry.getWorkspaceImage("tool-image", "../outside.png"))
      .toBeUndefined();
  });

  it("routes sandboxed Markdown image paths unchanged through the worker and fails closed without it", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "sandbox-image.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const reader = { readFile: vi.fn(async () => ({ data: bytes, mimeType: "image/png" as const })) };
    const runtime = new FakeRuntime(identity("sandbox-image", sessionFile, cwd), { securityProfile: "workspace-sandboxed" });
    Object.defineProperty(runtime, "sandboxFileReader", { value: reader });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    await registry.create({ ...ownership(cwd), securityProfile: "workspace-sandboxed" });

    expect(await registry.getWorkspaceImage("sandbox-image", "../../parent-secret.png")).toEqual({
      mimeType: "image/png", data: bytes,
    });
    expect(reader.readFile).toHaveBeenCalledWith({
      path: "../../parent-secret.png", maxBytes: 8 * 1024 * 1024, detectMime: true,
    });

    const noWorker = new FakeRuntime(identity("sandbox-no-worker", path.join(root, "sessions", "none.jsonl"), cwd), { securityProfile: "workspace-sandboxed" });
    factory.createPersistent.mockResolvedValue(noWorker);
    await registry.create({ ...ownership(cwd, "other"), securityProfile: "workspace-sandboxed" });
    expect(await registry.getWorkspaceImage("sandbox-no-worker", "generated.png")).toBeUndefined();
  });

  it("rejects worker image MIME claims that do not match the returned signature", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "bad-sandbox-image.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);
    const runtime = new FakeRuntime(identity("bad-sandbox-image", sessionFile, cwd), { securityProfile: "workspace-sandboxed" });
    Object.defineProperty(runtime, "sandboxFileReader", {
      value: { readFile: vi.fn(async () => ({ data: Buffer.from("not png"), mimeType: "image/png" })) },
    });
    const factory = new FakeFactory(); factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    await registry.create({ ...ownership(cwd), securityProfile: "workspace-sandboxed" });
    expect(await registry.getWorkspaceImage("bad-sandbox-image", "anything")).toBeUndefined();
  });

  it("rejects image prompts for a text-only model with a stable error", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "text-only.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("text-only", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const record = await registry.create(ownership(cwd));

    await expect(
      registry.prompt(record.id, "describe", [
        {
          mimeType: "image/jpeg",
          encoding: "base64",
          data: "/9j/4A==",
        },
      ]),
    ).rejects.toMatchObject({ code: ERROR_CODES.IMAGE_NOT_SUPPORTED });
    expect(runtime.promptSpy).not.toHaveBeenCalled();
  });

  it("fails rejected prompt preflight but reports post-acceptance runtime failure as an event", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "preflight.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("preflight", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const onListenerError = vi.fn();
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      onListenerError,
    });
    const statuses: string[] = [];
    registry.subscribe((item) => {
      if (item.type === "conversation.event" && item.event.type === "conversation.status") {
        statuses.push(item.event.payload.status);
      }
    });
    const record = await registry.create(ownership(cwd));

    runtime.promptSpy.mockImplementationOnce(async (_text, options) => {
      options?.preflightResult?.(false);
      throw new AppError(ERROR_CODES.MODEL_UNAVAILABLE);
    });
    await expect(registry.prompt(record.id, "rejected", [])).rejects.toMatchObject({
      code: ERROR_CODES.MODEL_UNAVAILABLE,
    });
    expect(statuses).toEqual([]);

    let failRun: ((error: Error) => void) | undefined;
    runtime.promptSpy.mockImplementationOnce((_text, options) => {
      options?.preflightResult?.(true);
      return new Promise<void>((_resolve, reject) => {
        failRun = reject;
      });
    });
    await expect(registry.prompt(record.id, "accepted", [])).resolves.toBeUndefined();
    const failure = new Error("post-acceptance failure");
    failRun?.(failure);
    await vi.waitFor(() => expect(statuses).toEqual(["error"]));
    expect(onListenerError).toHaveBeenCalledWith(failure);
  });

  it("marks active runs aborting and returns to idle when abort settles", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "abort.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("abort", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const statuses: string[] = [];
    registry.subscribe((item) => {
      if (item.type === "conversation.event" && item.event.type === "conversation.status") {
        statuses.push(item.event.payload.status);
      }
    });
    const record = await registry.create(ownership(cwd));
    record.status = "streaming";

    let finishAbort: (() => void) | undefined;
    runtime.abortSpy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishAbort = resolve;
        }),
    );
    const firstAbort = registry.abort(record.id);
    const repeatedAbort = registry.abort(record.id);
    expect(runtime.abortSpy).toHaveBeenCalledOnce();
    expect(statuses).toEqual(["aborting"]);
    finishAbort?.();
    await Promise.all([firstAbort, repeatedAbort]);
    await registry.abort(record.id);

    expect(runtime.abortSpy).toHaveBeenCalledOnce();
    expect(statuses).toEqual(["aborting", "idle"]);
    expect(record).toMatchObject({ status: "idle", revision: 2 });
  });

  it("keeps a fatal runtime failure terminal after later Pi idle events", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "fatal.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("fatal", sessionFile, cwd), {
      securityProfile: "workspace-sandboxed",
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const onListenerError = vi.fn();
    const registry = new ConversationRegistry({ runtimeFactory: factory, onListenerError });
    const record = await registry.create({
      ...ownership(cwd),
      securityProfile: "workspace-sandboxed",
    });
    record.status = "streaming";

    const failure = new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED);
    runtime.emitFatal(failure);
    runtime.emit({ type: "agent_end", messages: [], willRetry: false });

    expect(record.status).toBe("error");
    expect(record.runtimeFailureTerminal).toBe(true);
    expect(onListenerError).toHaveBeenCalledWith(failure);
    await vi.waitFor(() => expect(runtime.disposeSpy).toHaveBeenCalledOnce());
    await expect(registry.prompt(record.id, "must not run", [])).rejects.toMatchObject({
      code: ERROR_CODES.CONVERSATION_BUSY,
    });
  });

  it("emits revisioned blocked events from only the immutable managed runtime", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "managed.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);
    const runtime = new FakeRuntime(identity("managed", sessionFile, cwd), {
      securityProfile: "workspace-sandboxed",
      networkPolicy: "managed-egress",
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const events: ConversationRegistryEvent[] = [];
    registry.subscribe((event) => events.push(event));
    const managedPolicy = {
      workspaceId: "managed-workspace",
      cwd,
      sessionDirectory: null,
      securityProfile: "workspace-sandboxed" as const,
      networkPolicy: "managed-egress" as const,
    };

    const record = await registry.create(managedPolicy);
    runtime.emitBlocked({
      host: "registry.example",
      port: 443,
      protocol: "https-connect",
      reason: "not_allowed",
      occurrenceCount: 3,
    });

    expect(record.revision).toBe(1);
    expect(events.at(-1)).toMatchObject({
      type: "conversation.event",
      event: {
        type: "network.blocked",
        workspaceId: "managed-workspace",
        conversationId: "managed",
        revision: 1,
        payload: {
          host: "registry.example",
          port: 443,
          protocol: "https-connect",
          reason: "not_allowed",
          occurrenceCount: 3,
        },
      },
    });
    await expect(registry.getState(record.id)).resolves.toMatchObject({
      securityProfile: "workspace-sandboxed",
      networkPolicy: "managed-egress",
    });
    await registry.close(record.id);
    expect(runtime.blockedEvents.size).toBe(0);
  });

  it("rejects and disposes a runtime with a weaker network policy", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "weaker.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);
    const runtime = new FakeRuntime(identity("weaker", sessionFile, cwd), {
      securityProfile: "workspace-sandboxed",
      networkPolicy: "isolated",
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });

    await expect(registry.create({
      workspaceId: "managed-workspace",
      cwd,
      sessionDirectory: null,
      securityProfile: "workspace-sandboxed",
      networkPolicy: "managed-egress",
    })).rejects.toMatchObject({ code: ERROR_CODES.SESSION_UNAVAILABLE });
    expect(runtime.disposeSpy).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
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

    const first = registry.open(ownership(cwd), alias);
    const second = registry.open(ownership(cwd), realFile);
    await vi.waitFor(() => expect(factory.openPersistent).toHaveBeenCalledTimes(1));
    release?.();

    const [firstRecord, secondRecord] = await Promise.all([first, second]);
    expect(firstRecord).toBe(secondRecord);
    expect(firstRecord.sessionFile).toBe(realFile);
    expect(factory.openPersistent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd, securityProfile: "unrestricted" }),
      realFile,
    );

    await expect(registry.open(ownership(cwd), alias)).resolves.toBe(firstRecord);
    expect(factory.openPersistent).toHaveBeenCalledTimes(1);
  });

  it("rejects duplicate opens requested through a different workspace owner", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "session.jsonl");
    await mkdir(cwd);
    await writeFile(sessionFile, "persisted");

    const runtime = new FakeRuntime(identity("owned", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.openPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });

    const first = await registry.open(ownership(cwd, "workspace-a"), sessionFile);
    await expect(
      registry.open(ownership(cwd, "workspace-b"), sessionFile),
    ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_UNAVAILABLE });

    expect(registry.records).toEqual([first]);
    expect(first).toMatchObject({
      workspaceId: "workspace-a",
      workspacePath: cwd,
    });
    expect(factory.openPersistent).toHaveBeenCalledOnce();
    expect(runtime.disposed).toBe(false);
  });

  it("fails closed when a factory returns a runtime for the wrong security profile", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "sessions", "wrong-profile.jsonl");
    await Promise.all([mkdir(cwd), mkdir(path.dirname(sessionFile))]);
    const runtime = new FakeRuntime(identity("wrong-profile", sessionFile, cwd));
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });

    await expect(registry.create({
      ...ownership(cwd, "workspace-owner"),
      securityProfile: "workspace-sandboxed",
    })).rejects.toMatchObject({ code: ERROR_CODES.SESSION_UNAVAILABLE });
    expect(runtime.disposeSpy).toHaveBeenCalledOnce();
    expect(runtime.teardownComplete).toBe(true);
    expect(registry.size).toBe(0);
  });

  it("rejects a factory runtime whose CWD does not match authoritative workspace ownership", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const otherCwd = path.join(root, "other");
    const sessionFile = path.join(root, "sessions", "wrong-cwd.jsonl");
    await Promise.all([mkdir(cwd), mkdir(otherCwd), mkdir(path.dirname(sessionFile))]);

    const runtime = new FakeRuntime(identity("wrong-cwd", sessionFile, otherCwd));
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });

    await expect(
      registry.create(ownership(cwd, "workspace-owner")),
    ).rejects.toMatchObject({ code: ERROR_CODES.SESSION_UNAVAILABLE });
    expect(factory.createPersistent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd, securityProfile: "unrestricted" }),
    );
    expect(runtime.disposeSpy).toHaveBeenCalledOnce();
    expect(registry.size).toBe(0);
    expect(registry.hasLiveWorkspace("workspace-owner")).toBe(false);
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
      registry.create(ownership(cwd)),
      registry.create(ownership(cwd)),
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
      securityProfile: "workspace-sandboxed",
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

    await registry.create({
      ...ownership(cwd),
      securityProfile: "workspace-sandboxed",
    });
    await expect(registry.getState("state")).resolves.toMatchObject({
      id: "state",
      securityProfile: "workspace-sandboxed",
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
    const record = await registry.create(ownership(cwd));
    record.status = "streaming";

    await expect(registry.close("close")).rejects.toMatchObject({
      code: "conversation_busy",
    });
    expect(runtime.disposed).toBe(false);

    record.status = "idle";
    await registry.close("close");
    expect(runtime.disposeSpy).toHaveBeenCalledOnce();
    expect(runtime.teardownComplete).toBe(true);
    expect(runtime.events.size).toBe(0);
    expect(runtime.replacements.size).toBe(0);
    expect(runtime.fatalFailures.size).toBe(0);
    expect(registry.size).toBe(0);
    expect(registry.get("close")).toBeUndefined();
    expect(registry.getBySessionFile(sessionFile)).toBeUndefined();
    expect(registry.hasLiveWorkspace(cwd)).toBe(false);
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
    const record = await registry.open(ownership(cwd), sessionFile);
    await rm(sessionFile);

    await expect(registry.getState("missing")).rejects.toMatchObject({
      code: "session_file_missing",
    });
    expect(record.status).toBe("error");
    expect(record.revision).toBe(1);
    expect(refreshHistory).toHaveBeenCalledTimes(2);
  });

  it("closes admission and coalesces active aborts during shutdown", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessionFile = path.join(root, "shutdown.jsonl");
    await mkdir(cwd);

    const runtime = new FakeRuntime(identity("shutdown", sessionFile, cwd), {
      prompt: "active prompt",
    });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const record = await registry.create(ownership(cwd));
    record.status = "streaming";

    registry.beginShutdown();
    const firstAbort = registry.abortActive();
    const secondAbort = registry.abortActive();
    expect(firstAbort).toBe(secondAbort);
    await firstAbort;
    expect(runtime.abortSpy).toHaveBeenCalledOnce();

    for (const operation of [
      () => registry.create(ownership(cwd)),
      () => registry.open(ownership(cwd), sessionFile),
      () => registry.prompt(record.id, "new work", []),
      () => registry.fork(record.id, "entry-1", ownership(cwd)),
    ]) {
      await expect(operation()).rejects.toMatchObject({
        code: ERROR_CODES.SHUTTING_DOWN,
      });
    }
    expect(factory.createPersistent).toHaveBeenCalledOnce();
    expect(factory.openPersistent).not.toHaveBeenCalled();

    await registry.dispose();
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
    const first = await registry.create(ownership(cwd));
    await registry.create(ownership(cwd));
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

    const first = await registry.create(ownership(cwd));
    const second = await registry.create(ownership(cwd));
    await registry.getState(first.id);
    const third = await registry.create(ownership(cwd));

    expect(secondRuntime.disposeSpy).toHaveBeenCalledOnce();
    expect(firstRuntime.disposed).toBe(false);
    expect(thirdRuntime.disposed).toBe(false);
    expect(registry.records).toEqual([first, third]);
    expect(closed).toMatchObject([
      { type: "conversation.closed", record: second, reason: "evict" },
    ]);
    expect(refreshHistory).toHaveBeenCalledTimes(4);
  });

  it("validates idle active-branch user fork targets and protects the reservation", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);

    const userEntry = {
      type: "message",
      id: "a1b2c3d4",
      message: { role: "user", content: "fork this" },
    };
    const assistantEntry = {
      type: "message",
      id: "b2c3d4e5",
      message: { role: "assistant", content: [] },
    };
    const runtime = new FakeRuntime(
      identity("source", path.join(sessions, "source.jsonl"), cwd),
      { branch: [userEntry, assistantEntry] },
    );
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 2,
    });
    const source = await registry.create(ownership(cwd));

    const reservation = await registry.reserveFork(source.id, userEntry.id);
    expect(reservation).toMatchObject({
      sourceConversationId: source.id,
      sourceSessionFile: source.sessionFile,
      sourceCwd: cwd,
    });
    await expect(registry.prompt(source.id, "race", [])).rejects.toMatchObject({
      code: ERROR_CODES.CONVERSATION_BUSY,
    });
    await expect(registry.close(source.id)).rejects.toMatchObject({
      code: ERROR_CODES.CONVERSATION_BUSY,
    });

    reservation.release();
    reservation.release();
    await expect(registry.prompt(source.id, "after release", [])).resolves.toBeUndefined();

    source.status = "streaming";
    await expect(
      registry.reserveFork(source.id, userEntry.id),
    ).rejects.toMatchObject({ code: ERROR_CODES.FORK_SOURCE_BUSY });
  });

  it("rejects a freshly resolved fork policy that differs from immutable source ownership", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    const sourceFile = path.join(sessions, "source.jsonl");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);
    await writeFile(sourceFile, "source");
    const branch = [{
      type: "message",
      id: "a1b2c3d4",
      message: { role: "user", content: "fork" },
    }];
    const runtime = new FakeRuntime(identity("source", sourceFile, cwd), { branch });
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory, maxLiveConversations: 2 });
    const source = await registry.create(ownership(cwd, "source-workspace"));

    await expect(registry.fork(source.id, "a1b2c3d4", {
      ...ownership(cwd, "source-workspace"),
      securityProfile: "workspace-sandboxed",
    })).rejects.toMatchObject({ code: ERROR_CODES.SESSION_UNAVAILABLE });
    expect(factory.openPersistent).not.toHaveBeenCalled();
    expect(runtime.disposed).toBe(false);
  });

  it("promotes a successful temporary fork without replacing its source", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    const sourceFile = path.join(sessions, "source.jsonl");
    const forkFile = path.join(sessions, "fork.jsonl");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);
    await writeFile(sourceFile, "source");

    const sourceModel = {
      provider: "faux",
      id: "faux-1",
    } as NonNullable<AgentSession["model"]>;
    const branch = [
      {
        type: "message",
        id: "a1b2c3d4",
        message: { role: "user", content: "copy this prompt" },
      },
      {
        type: "message",
        id: "b2c3d4e5",
        message: { role: "assistant", content: [] },
      },
    ];
    const sourceRuntime = new FakeRuntime(
      identity("source", sourceFile, cwd),
      { branch, sdkModel: sourceModel },
    );
    const temporary = new FakeRuntime(
      identity("source", sourceFile, cwd),
      { branch, sdkModel: sourceModel },
    );
    temporary.forkSpy.mockImplementation(async () => {
      await writeFile(forkFile, "fork");
      temporary.replace(identity("forked", forkFile, cwd));
      return { cancelled: false, editorText: "copy this prompt" };
    });

    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(sourceRuntime);
    factory.openPersistent.mockResolvedValue(temporary);
    const refreshHistory = vi.fn();
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 2,
      refreshHistory,
    });
    const registeredEvents: ConversationRegistryEvent[] = [];
    registry.subscribe((event) => {
      if (event.type === "conversation.registered") registeredEvents.push(event);
    });
    const source = await registry.create(ownership(cwd, "fork-workspace"));
    const sourceIdentity = source.runtime.identity;
    const sourceSession = source.session;
    const sourceListenerCount = sourceRuntime.events.size;

    const result = await registry.fork(
      source.id,
      "a1b2c3d4",
      ownership(cwd, "fork-workspace"),
    );

    expect(factory.openPersistent).toHaveBeenCalledWith(
      expect.objectContaining({ cwd, securityProfile: "unrestricted" }),
      sourceFile,
    );
    expect(temporary.forkSpy).toHaveBeenCalledWith("a1b2c3d4", {
      inheritModel: sourceModel,
    });
    expect(result).toMatchObject({
      editorText: "copy this prompt",
      conversation: {
        id: "forked",
        workspaceId: "fork-workspace",
        sessionFile: forkFile,
        cwd,
      },
    });
    expect(registry.size).toBe(2);
    expect(registry.get("source")).toBe(source);
    expect(source.runtime.identity).toEqual(sourceIdentity);
    expect(source.session).toBe(sourceSession);
    expect(sourceRuntime.disposed).toBe(false);
    expect(sourceRuntime.events.size).toBe(sourceListenerCount);
    expect(temporary.disposed).toBe(false);
    expect(registeredEvents.at(-1)).toMatchObject({
      type: "conversation.registered",
      source: "fork",
      record: { id: "forked" },
    });
    expect(refreshHistory).toHaveBeenCalled();
  });

  it("owns and disposes an in-flight temporary fork during shutdown", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    const sourceFile = path.join(sessions, "source.jsonl");
    const forkFile = path.join(sessions, "shutdown-fork.jsonl");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);
    await writeFile(sourceFile, "source");

    const branch = [{
      type: "message",
      id: "a1b2c3d4",
      message: { role: "user", content: "fork this" },
    }];
    const sourceRuntime = new FakeRuntime(
      identity("source", sourceFile, cwd),
      { branch },
    );
    const temporary = new FakeRuntime(
      identity("source", sourceFile, cwd),
      { branch },
    );
    let releaseFork: (() => void) | undefined;
    const forkGate = new Promise<void>((resolve) => {
      releaseFork = resolve;
    });
    temporary.forkSpy.mockImplementation(async () => {
      await forkGate;
      await writeFile(forkFile, "fork");
      temporary.replace(identity("shutdown-fork", forkFile, cwd));
      return { cancelled: false, editorText: "fork this" };
    });

    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(sourceRuntime);
    factory.openPersistent.mockResolvedValue(temporary);
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 2,
    });
    const source = await registry.create(ownership(cwd));
    const forking = registry.fork(source.id, "a1b2c3d4", ownership(cwd));
    await vi.waitFor(() => expect(temporary.forkSpy).toHaveBeenCalledOnce());

    registry.beginShutdown();
    await registry.dispose();
    expect(temporary.disposeSpy).toHaveBeenCalledOnce();
    expect(sourceRuntime.disposeSpy).toHaveBeenCalledOnce();

    releaseFork?.();
    await expect(forking).rejects.toMatchObject({
      code: ERROR_CODES.SHUTTING_DOWN,
    });
    expect(temporary.disposeSpy).toHaveBeenCalledOnce();
  });

  it("disposes and removes every failed temporary fork resource", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    const sourceFile = path.join(sessions, "source.jsonl");
    const failedForkFile = path.join(sessions, "failed-fork.jsonl");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);
    await writeFile(sourceFile, "source");

    const branch = [{
      type: "message",
      id: "a1b2c3d4",
      message: { role: "user", content: "fork this" },
    }];
    const sourceRuntime = new FakeRuntime(
      identity("source", sourceFile, cwd),
      { branch },
    );
    const temporary = new FakeRuntime(
      identity("source", sourceFile, cwd),
      { branch },
    );
    temporary.forkSpy.mockImplementation(async () => {
      await writeFile(failedForkFile, "partial fork");
      temporary.replace(identity("failed-fork", failedForkFile, cwd));
      throw new AppError(ERROR_CODES.PI_RUNTIME_REPLACE_FAILED);
    });

    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(sourceRuntime);
    factory.openPersistent.mockResolvedValue(temporary);
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 2,
    });
    const source = await registry.create(ownership(cwd));

    await expect(
      registry.fork(source.id, "a1b2c3d4", ownership(cwd)),
    ).rejects.toMatchObject({
      code: ERROR_CODES.PI_RUNTIME_REPLACE_FAILED,
    });
    expect(temporary.disposeSpy).toHaveBeenCalledOnce();
    expect(temporary.events.size).toBe(0);
    expect(temporary.replacements.size).toBe(0);
    expect(existsSync(failedForkFile)).toBe(false);
    expect(existsSync(sourceFile)).toBe(true);
    expect(registry.records).toEqual([source]);
    expect(sourceRuntime.disposed).toBe(false);

    // Both source protection and reserved capacity are released on failure.
    await expect(registry.prompt(source.id, "still usable", [])).resolves.toBeUndefined();
    const nextRuntime = new FakeRuntime(
      identity("next", path.join(sessions, "next.jsonl"), cwd),
    );
    factory.createPersistent.mockResolvedValueOnce(nextRuntime);
    await expect(registry.create(ownership(cwd))).resolves.toMatchObject({ id: "next" });
  });

  it("rejects non-user, off-branch, and malformed fork entry IDs", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);

    const runtime = new FakeRuntime(
      identity("source", path.join(sessions, "source.jsonl"), cwd),
      {
        branch: [
          {
            type: "message",
            id: "a1b2c3d4",
            message: { role: "user", content: "active" },
          },
          {
            type: "message",
            id: "b2c3d4e5",
            message: { role: "assistant", content: [] },
          },
        ],
      },
    );
    const factory = new FakeFactory();
    factory.createPersistent.mockResolvedValue(runtime);
    const registry = new ConversationRegistry({ runtimeFactory: factory });
    const source = await registry.create(ownership(cwd));

    for (const entryId of ["b2c3d4e5", "c3d4e5f6", "not-a-pi-id"]) {
      await expect(registry.reserveFork(source.id, entryId)).rejects.toMatchObject({
        code: ERROR_CODES.INVALID_FORK_TARGET,
      });
    }
    expect(runtime.disposed).toBe(false);
  });

  it("reserves fork capacity without evicting its idle source", async () => {
    const root = await temporaryRoot();
    const cwd = path.join(root, "workspace");
    const sessions = path.join(root, "sessions");
    await Promise.all([mkdir(cwd), mkdir(sessions)]);

    const branch = [{
      type: "message",
      id: "a1b2c3d4",
      message: { role: "user", content: "fork this" },
    }];
    const sourceRuntime = new FakeRuntime(
      identity("source", path.join(sessions, "source.jsonl"), cwd),
      { branch },
    );
    const otherRuntime = new FakeRuntime(
      identity("other", path.join(sessions, "other.jsonl"), cwd),
    );
    const nextRuntime = new FakeRuntime(
      identity("next", path.join(sessions, "next.jsonl"), cwd),
    );
    const factory = new FakeFactory();
    factory.createPersistent
      .mockResolvedValueOnce(sourceRuntime)
      .mockResolvedValueOnce(otherRuntime)
      .mockResolvedValueOnce(nextRuntime);
    const registry = new ConversationRegistry({
      runtimeFactory: factory,
      maxLiveConversations: 2,
    });
    const source = await registry.create(ownership(cwd));
    await registry.create(ownership(cwd));

    const reservation = await registry.reserveFork(source.id, "a1b2c3d4");
    expect(sourceRuntime.disposed).toBe(false);
    expect(otherRuntime.disposed).toBe(true);
    expect(registry.records).toEqual([source]);
    await expect(registry.create(ownership(cwd))).rejects.toMatchObject({
      code: ERROR_CODES.LIVE_RUNTIME_LIMIT,
    });
    expect(factory.createPersistent).toHaveBeenCalledTimes(2);

    reservation.release();
    await expect(registry.create(ownership(cwd))).resolves.toMatchObject({ id: "next" });
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
    const first = await registry.create(ownership(cwd));
    first.status = "streaming";

    await expect(registry.create(ownership(cwd))).rejects.toMatchObject({
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

    const first = registry.create(ownership(cwd));
    await vi.waitFor(() => expect(factory.createPersistent).toHaveBeenCalledOnce());
    await expect(registry.create(ownership(cwd))).rejects.toMatchObject({
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

    const first = await registry.open(ownership(cwd), sessionFile);
    await expect(registry.open(ownership(cwd), sessionFile)).resolves.toBe(first);
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
    const refreshHistory = vi.fn();
    const registry = new ConversationRegistry({ runtimeFactory: factory, refreshHistory });
    const eventTypes: string[] = [];
    registry.subscribe((event) => eventTypes.push(event.type));
    const record = await registry.create(ownership(cwd, "immutable-owner"));
    const oldSession = record.session;

    runtime.replace(identity("new", newFile, cwd));

    expect(registry.get("old")).toBeUndefined();
    expect(registry.getBySessionFile(oldFile)).toBeUndefined();
    expect(registry.get("new")).toBe(record);
    expect(registry.getBySessionFile(newFile)).toBe(record);
    expect(record.session).toBe(runtime.session);
    expect(record.session).not.toBe(oldSession);
    expect(record).toMatchObject({
      workspaceId: "immutable-owner",
      workspacePath: cwd,
      cwd,
    });
    expect(record.revision).toBe(1);
    expect(refreshHistory).toHaveBeenLastCalledWith("immutable-owner");

    runtime.emit({ type: "queue_update", steering: [], followUp: ["after"] });
    expect(record.revision).toBe(2);
    expect(eventTypes).toEqual([
      "conversation.registered",
      "conversation.replaced",
      "conversation.event",
    ]);
  });
});
