import type { AddressInfo } from "node:net";

import { loadConfig } from "../../src/server/config.js";
import type { ConversationRegistryListener } from "../../src/server/conversation-registry.js";
import { validatePromptImages } from "../../src/server/images.js";
import {
  createChatWcaServer,
  type ChatWcaServer,
} from "../../src/server/index.js";
import type {
  ProtocolHistory,
  ProtocolRegistry,
} from "../../src/server/protocol.js";
import type {
  AssistantMessage,
  ConversationEvent,
  ConversationState,
  ConversationSummary,
  NormalizedMessage,
  UiImage,
  UserMessage,
} from "../../src/shared/protocol.js";

/**
 * A deterministic, in-memory Pi boundary for browser tests. It models the
 * protocol-visible lifecycle and asynchronous run behavior without reading or
 * writing the operator's Pi sessions. Special prompt wording only controls run
 * timing and socket interruption; the browser still uses the production HTTP,
 * WebSocket, validation, reducer, and rendering paths.
 */
const HOST = "0.0.0.0";
const PORT = 8787;
const CWD = "/tmp/chatwca-browser-workspace";
const WORKSPACE_ID = "browser-workspace";
const SESSION_ROOT = "/tmp/chatwca-browser-sessions";
const IMAGE_LIMITS = {
  maxImages: 4,
  maxImageBytes: 2 * 1024 * 1024,
  maxTotalImageBytes: 4 * 1024 * 1024,
};
const BASE_TIME = 1_700_000_000_000;

interface FixtureConversation {
  state: ConversationState;
  closed: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
}

const listeners = new Set<ConversationRegistryListener>();
const conversations = new Map<string, FixtureConversation>();
let conversationSequence = 0;
let messageSequence = 0;
let clock = BASE_TIME;
let server: ChatWcaServer;

function nextTime(): number {
  clock += 1;
  return clock;
}

function model() {
  return {
    id: "deterministic-vision",
    provider: "browser-fixture",
    name: "Deterministic vision model",
    supportsImages: true,
  } as const;
}

function emptyState(id: string, title: string, cwd = CWD): ConversationState {
  const now = nextTime();
  return {
    id,
    workspaceId: WORKSPACE_ID,
    sessionFile: `${SESSION_ROOT}/${id}.jsonl`,
    title,
    cwd,
    model: model(),
    status: "idle",
    createdAt: now,
    lastActiveAt: now,
    revision: 0,
    durable: true,
    messages: [],
    queue: { steering: [], followUp: [] },
  };
}

function addFixture(state: ConversationState, closed = false): FixtureConversation {
  const fixture = { state, closed, timers: new Set<ReturnType<typeof setTimeout>>() };
  conversations.set(state.id, fixture);
  return fixture;
}

function richState(): ConversationState {
  const state = emptyState("browser-rich-conversation", "Thinking and tools");
  return {
    ...state,
    revision: 7,
    messages: [
      {
        entryId: "rich-user-1",
        role: "user",
        forkEligible: true,
        blocks: [{ type: "text", text: "Inspect the fixture workspace" }],
        timestamp: nextTime(),
      },
      {
        entryId: "rich-assistant-1",
        role: "assistant",
        blocks: [
          { type: "thinking", text: "Private deterministic reasoning for the browser fixture." },
          {
            type: "tool-call",
            toolCallId: "rich-tool-1",
            toolName: "read",
            arguments: { path: "fixture.txt" },
            status: "succeeded",
          },
          {
            type: "tool-result",
            toolCallId: "rich-tool-1",
            toolName: "read",
            content: "deterministic tool output",
            isError: false,
            truncated: false,
          },
          { type: "text", text: "The fixture inspection is complete." },
        ],
        timestamp: nextTime(),
        stopReason: "stop",
      },
    ],
  };
}

addFixture(emptyState("browser-image-conversation", "Image behavior"));
addFixture(richState());

function fixtureById(conversationId: string): FixtureConversation {
  const fixture = conversations.get(conversationId);
  if (fixture === undefined) throw new Error("Unknown fixture conversation");
  return fixture;
}

function summary(fixture: FixtureConversation): ConversationSummary {
  const { state } = fixture;
  return {
    id: state.id,
    workspaceId: state.workspaceId,
    sessionFile: state.sessionFile,
    title: state.title,
    cwd: state.cwd,
    createdAt: state.createdAt,
    modifiedAt: state.lastActiveAt,
    messageCount: state.messages.length,
    status: fixture.closed
      ? "closed"
      : state.status === "aborting"
        ? "streaming"
        : state.status,
    runnable: true,
  };
}

function listedHistory(): ConversationSummary[] {
  return [...conversations.values()]
    .map(summary)
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function emit(fixture: FixtureConversation, event: ConversationEvent): void {
  for (const listener of listeners) {
    listener({
      type: "conversation.event",
      record: { id: fixture.state.id } as never,
      event,
    });
  }
}

function emitEvent<T extends Omit<ConversationEvent, "workspaceId" | "conversationId" | "revision">>(
  fixture: FixtureConversation,
  event: T,
): ConversationEvent {
  const revision = fixture.state.revision + 1;
  fixture.state = {
    ...fixture.state,
    revision,
    lastActiveAt: nextTime(),
  };
  const envelope = {
    ...event,
    workspaceId: fixture.state.workspaceId,
    conversationId: fixture.state.id,
    revision,
  } as ConversationEvent;
  emit(fixture, envelope);
  return envelope;
}

function userMessage(text: string, images: readonly UiImage[]): UserMessage {
  messageSequence += 1;
  return {
    entryId: `browser-user-${String(messageSequence)}`,
    role: "user",
    forkEligible: true,
    blocks: [
      ...(text.length === 0 ? [] : [{ type: "text" as const, text }]),
      ...images.map((image) => ({
        type: "image" as const,
        image,
        alt: image.name ?? "Submitted image",
      })),
    ],
    timestamp: nextTime(),
  };
}

function textOf(message: UserMessage): string {
  return message.blocks
    .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function schedule(
  fixture: FixtureConversation,
  delayMs: number,
  action: () => void,
): void {
  const timer = setTimeout(() => {
    fixture.timers.delete(timer);
    if (conversations.get(fixture.state.id) === fixture && !fixture.closed) action();
  }, delayMs);
  fixture.timers.add(timer);
}

function replaceMessage(
  messages: readonly NormalizedMessage[],
  entryId: string,
  replacement: NormalizedMessage,
): NormalizedMessage[] {
  return messages.map((message) => message.entryId === entryId ? replacement : message);
}

function beginRun(fixture: FixtureConversation, promptText: string): void {
  const streamId = `stream:${String(++messageSequence)}`;
  const assistantStart: AssistantMessage = {
    entryId: streamId,
    role: "assistant",
    blocks: [],
    timestamp: nextTime(),
  };

  fixture.state = {
    ...fixture.state,
    status: "streaming",
  };
  emitEvent(fixture, {
    type: "conversation.status",
    payload: { status: "streaming" },
  });

  fixture.state = {
    ...fixture.state,
    messages: [...fixture.state.messages, assistantStart],
  };
  emitEvent(fixture, {
    type: "message.started",
    payload: { message: assistantStart },
  });

  const response = `Deterministic response to: ${promptText || "the attached image"}`;
  const midpoint = Math.max(1, Math.floor(response.length / 2));
  const chunks = [response.slice(0, midpoint), response.slice(midpoint)];
  const slow = /background|reconnect|stream slowly/i.test(promptText);
  const firstDelay = slow ? 180 : 40;
  const secondDelay = slow ? 650 : 100;
  const completionDelay = slow ? 1_050 : 180;

  chunks.forEach((delta, index) => {
    schedule(fixture, index === 0 ? firstDelay : secondDelay, () => {
      const current = fixture.state.messages.find((message) => message.entryId === streamId);
      if (current?.role !== "assistant") return;
      const existing = current.blocks[0];
      const next: AssistantMessage = {
        ...current,
        blocks: [{
          type: "text",
          text: existing?.type === "text" ? existing.text + delta : delta,
        }],
      };
      fixture.state = {
        ...fixture.state,
        messages: replaceMessage(fixture.state.messages, streamId, next),
      };
      emitEvent(fixture, {
        type: "message.delta",
        payload: {
          entryId: streamId,
          blockIndex: 0,
          blockType: "text",
          delta,
        },
      });
    });
  });

  schedule(fixture, completionDelay, () => {
    const completed: AssistantMessage = {
      entryId: `browser-assistant-${String(++messageSequence)}`,
      role: "assistant",
      blocks: [{ type: "text", text: response }],
      timestamp: nextTime(),
      stopReason: "stop",
      usage: { inputTokens: 12, outputTokens: 8 },
    };
    fixture.state = {
      ...fixture.state,
      messages: fixture.state.messages.map((message) =>
        message.entryId === streamId ? completed : message),
      queue: { steering: [], followUp: [] },
    };
    emitEvent(fixture, {
      type: "message.completed",
      payload: { message: completed },
    });
    fixture.state = { ...fixture.state, status: "idle" };
    emitEvent(fixture, {
      type: "conversation.status",
      payload: { status: "idle" },
    });
  });

  if (/reconnect/i.test(promptText)) {
    schedule(fixture, 300, () => {
      // The runtime and timers remain alive while every current browser socket
      // is interrupted. The production client must reconnect and reconcile.
      for (const client of server.webSocketServer.clients) client.terminate();
    });
  }
}

const registry: ProtocolRegistry = {
  async create(workspaceId, cwd) {
    conversationSequence += 1;
    const id = `browser-created-${String(conversationSequence)}`;
    addFixture(emptyState(id, "Untitled conversation", cwd));
    return { id };
  },
  async open(_workspaceId, sessionFile) {
    const fixture = [...conversations.values()].find(
      (candidate) => candidate.state.sessionFile === sessionFile,
    );
    if (fixture === undefined) throw new Error("Unknown fixture session file");
    fixture.closed = false;
    fixture.state = { ...fixture.state, status: "idle", lastActiveAt: nextTime() };
    return { id: fixture.state.id };
  },
  async getState(conversationId) {
    return fixtureById(conversationId).state;
  },
  async close(conversationId) {
    const fixture = fixtureById(conversationId);
    if (fixture.state.status !== "idle" && fixture.state.status !== "error") {
      throw new Error("Active fixture conversations cannot be closed");
    }
    fixture.closed = true;
    fixture.state = { ...fixture.state, lastActiveAt: nextTime() };
  },
  async fork(conversationId, entryId) {
    const source = fixtureById(conversationId);
    if (source.closed || source.state.status !== "idle") {
      throw new Error("Only an idle fixture conversation can be forked");
    }
    const index = source.state.messages.findIndex(
      (message) => message.entryId === entryId && message.role === "user" && message.forkEligible,
    );
    const target = source.state.messages[index];
    if (index < 0 || target?.role !== "user") throw new Error("Invalid fixture fork target");

    conversationSequence += 1;
    const id = `browser-fork-${String(conversationSequence)}`;
    const fork = emptyState(id, `Fork of ${source.state.title}`, source.state.cwd);
    const forkState: ConversationState = {
      ...fork,
      messages: source.state.messages.slice(0, index),
      revision: 1,
    };
    addFixture(forkState);
    return { conversation: forkState, editorText: textOf(target) };
  },
  async prompt(conversationId, text, images, streamingBehavior) {
    const fixture = fixtureById(conversationId);
    validatePromptImages(images, { supportsImages: true, limits: IMAGE_LIMITS });

    if (streamingBehavior !== undefined) {
      if (fixture.state.status !== "streaming") throw new Error("The fixture is not streaming");
      const key = streamingBehavior === "steer" ? "steering" : "followUp";
      fixture.state = {
        ...fixture.state,
        queue: {
          ...fixture.state.queue,
          [key]: [...fixture.state.queue[key], { text, imageCount: images.length }],
        },
      };
      emitEvent(fixture, { type: "conversation.queue", payload: fixture.state.queue });
      return;
    }

    if (fixture.closed || fixture.state.status !== "idle") {
      throw new Error("The fixture conversation is not idle");
    }
    const message = userMessage(text, images);
    const firstPrompt = fixture.state.messages.every((item) => item.role !== "user");
    fixture.state = {
      ...fixture.state,
      title: firstPrompt && text.trim().length > 0 ? text.trim() : fixture.state.title,
      messages: [...fixture.state.messages, message],
    };
    emitEvent(fixture, {
      type: "message.completed",
      payload: { message },
    });
    beginRun(fixture, text);
  },
  async abort(conversationId) {
    const fixture = fixtureById(conversationId);
    if (fixture.state.status !== "streaming") return;
    for (const timer of fixture.timers) clearTimeout(timer);
    fixture.timers.clear();
    fixture.state = { ...fixture.state, status: "idle", queue: { steering: [], followUp: [] } };
    emitEvent(fixture, { type: "conversation.status", payload: { status: "idle" } });
  },
  hasLiveWorkspace(workspaceId) {
    return [...conversations.values()].some(
      (fixture) => !fixture.closed && fixture.state.workspaceId === workspaceId,
    );
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const history: ProtocolHistory = {
  async list(_workspaceId) {
    return listedHistory();
  },
  async resolve(_workspaceId, conversationId) {
    const fixture = fixtureById(conversationId);
    return { summary: { sessionFile: fixture.state.sessionFile } };
  },
  async delete(_workspaceId, conversationId) {
    const fixture = fixtureById(conversationId);
    if (!fixture.closed) throw new Error("Close the fixture conversation before deleting it");
    for (const timer of fixture.timers) clearTimeout(timer);
    conversations.delete(conversationId);
    return listedHistory();
  },
};

const config = loadConfig(
  {
    CHATWCA_HOST: HOST,
    CHATWCA_PORT: String(PORT),
    CHATWCA_DATA_DIR: CWD,
    CHATWCA_MAX_IMAGES: String(IMAGE_LIMITS.maxImages),
    CHATWCA_MAX_IMAGE_BYTES: String(IMAGE_LIMITS.maxImageBytes),
    CHATWCA_MAX_TOTAL_IMAGE_BYTES: String(IMAGE_LIMITS.maxTotalImageBytes),
  },
  CWD,
);

server = createChatWcaServer(config, "browser-fixture", {
  registry,
  history,
  onInternalError(error) {
    if (error !== null && error !== undefined) {
      console.error("Browser fixture protocol error", error);
    }
  },
});

await new Promise<void>((resolve) => server.httpServer.listen(PORT, HOST, resolve));
const address = server.httpServer.address() as AddressInfo;
console.log(`ChatWCA browser fixture listening on http://${HOST}:${String(address.port)}`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  for (const fixture of conversations.values()) {
    for (const timer of fixture.timers) clearTimeout(timer);
  }
  for (const client of server.webSocketServer.clients) client.terminate();
  await new Promise<void>((resolve) => server.webSocketServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop().then(() => process.exit(0));
  });
}
