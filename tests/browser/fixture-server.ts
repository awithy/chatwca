import type { AddressInfo } from "node:net";

import { loadConfig } from "../../src/server/config.js";
import type { ConversationRegistryListener } from "../../src/server/conversation-registry.js";
import type { ConversationImageOwner } from "../../src/server/conversation-images.js";
import { validatePromptImages } from "../../src/server/images.js";
import {
  createChatWcaServer,
  type ChatWcaServer,
} from "../../src/server/index.js";
import type {
  ProtocolHistory,
  ProtocolRegistry,
  ProtocolWorkspaceRepository,
} from "../../src/server/protocol.js";
import type {
  AssistantMessage,
  ConversationEvent,
  ConversationState,
  ConversationSummary,
  NormalizedMessage,
  UiImage,
  UserMessage,
  WorkspaceSummary,
} from "../../src/shared/protocol.js";

/**
 * A deterministic, in-memory Pi boundary for browser tests. It models the
 * protocol-visible lifecycle and asynchronous run behavior without reading or
 * writing the operator's Pi sessions. Special prompt wording only controls run
 * timing and socket interruption; the browser still uses the production HTTP,
 * WebSocket, validation, reducer, and rendering paths.
 */
const HOST = "0.0.0.0";
const PORT = Number(process.env.CHATWCA_BROWSER_TEST_PORT ?? 28787);
const CWD = "/tmp/chatwca-browser-workspace";
const WORKSPACE_ID = "browser-workspace";
const SESSION_ROOT = "/tmp/chatwca-browser-sessions";
const WORKSPACE: WorkspaceSummary = {
  id: WORKSPACE_ID,
  name: "Browser workspace",
  path: CWD,
  sessionStorage: "pi-default",
  sessionDirectory: null,
  securityProfile: "unrestricted",
  networkPolicy: "isolated",
  effectiveSecurityProfile: "unrestricted",
  effectiveNetworkPolicy: null,
  networkPolicySetId: "default",
  effectiveNetworkPolicySetId: null,
  networkPolicyIssue: null,
  createdAt: 1,
  updatedAt: 1,
  available: true,
  usable: true,
  policyIssue: null,
};
let workspaceSequence = 0;
let workspaceRows: WorkspaceSummary[] = [WORKSPACE];
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

function emptyState(
  id: string,
  title: string,
  workspace: Pick<WorkspaceSummary, "id" | "path"> & {
    readonly securityProfile?: ConversationState["securityProfile"];
    readonly effectiveNetworkPolicy?: ConversationState["networkPolicy"];
    readonly networkPolicySetId?: ConversationState["networkPolicySetId"];
    readonly effectiveNetworkPolicySetId?: ConversationState["effectiveNetworkPolicySetId"];
  } = WORKSPACE,
): ConversationState {
  const now = nextTime();
  return {
    id,
    workspaceId: workspace.id,
    sessionFile: `${SESSION_ROOT}/${id}.jsonl`,
    title,
    cwd: workspace.path,
    model: model(),
    status: "idle",
    createdAt: now,
    lastActiveAt: now,
    revision: 0,
    durable: true,
    contextUsage: { tokens: 14_144, contextWindow: 272_000, percent: 5.2 },
    messages: [],
    queue: { steering: [], followUp: [] },
    securityProfile: workspace.securityProfile ?? "unrestricted",
    networkPolicy: workspace.effectiveNetworkPolicy ?? null,
    networkPolicySetId: "networkPolicySetId" in workspace
      ? workspace.networkPolicySetId
      : "default",
    effectiveNetworkPolicySetId: workspace.effectiveNetworkPolicySetId ?? null,
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
          {
            type: "text",
            text: "The fixture inspection is complete.\n\n![Generated fixture](generated.png)",
          },
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

function summary(
  fixture: FixtureConversation,
  workspace: Pick<WorkspaceSummary, "id" | "path">,
): ConversationSummary {
  const { state } = fixture;
  return {
    id: state.id,
    workspaceId: workspace.id,
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

function listedHistory(
  workspace: Pick<WorkspaceSummary, "id" | "path">,
): ConversationSummary[] {
  return [...conversations.values()]
    .filter((fixture) => fixture.state.cwd === workspace.path)
    .map((fixture) => summary(fixture, workspace))
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

function scheduleOutOfOrderHistory(workspace: Pick<WorkspaceSummary, "id" | "path">): void {
  if (!workspace.path.includes("out-of-order-target")) return;
  const staleWorkspace = workspaceRows.find((candidate) =>
    candidate.path.includes("out-of-order-source"),
  );
  if (staleWorkspace === undefined) return;
  setTimeout(() => {
    const message = JSON.stringify({
      type: "history",
      workspaceId: staleWorkspace.id,
      conversations: listedHistory(staleWorkspace),
    });
    for (const client of server.webSocketServer.clients) {
      if (client.readyState === client.OPEN) client.send(message);
    }
  }, 150);
}

function emit(fixture: FixtureConversation, event: ConversationEvent): void {
  for (const listener of listeners) {
    listener({
      type: "conversation.event",
      record: {
        id: fixture.state.id,
        workspaceId: fixture.state.workspaceId,
      } as never,
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

  if (/blocked network/i.test(promptText)) {
    schedule(fixture, 20, () => {
      emitEvent(fixture, {
        type: "network.blocked",
        payload: {
          host: "blocked.example.com",
          port: 443,
          protocol: "https-connect",
          reason: "not_allowed",
          occurrenceCount: 3,
        },
      });
    });
  }

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
      contextUsage: { tokens: 14_144, contextWindow: 272_000, percent: 5.2 },
    };
    emitEvent(fixture, {
      type: "message.completed",
      payload: { message: completed, contextUsage: fixture.state.contextUsage },
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
  async create(workspace) {
    conversationSequence += 1;
    const id = `browser-created-${String(conversationSequence)}`;
    addFixture(emptyState(id, "Untitled conversation", {
      id: workspace.workspaceId,
      path: workspace.cwd,
      securityProfile: workspace.securityProfile,
      effectiveNetworkPolicy: workspace.networkPolicy,
    }));
    return { id };
  },
  async open(workspace, sessionFile) {
    const fixture = [...conversations.values()].find(
      (candidate) => candidate.state.sessionFile === sessionFile,
    );
    if (fixture === undefined || fixture.state.cwd !== workspace.cwd) {
      throw new Error("Unknown fixture session file");
    }
    fixture.closed = false;
    fixture.state = {
      ...fixture.state,
      workspaceId: workspace.workspaceId,
      securityProfile: workspace.securityProfile,
      networkPolicy: workspace.networkPolicy,
      status: "idle",
      lastActiveAt: nextTime(),
    };
    return { id: fixture.state.id };
  },
  async getState(conversationId) {
    return fixtureById(conversationId).state;
  },
  async rename(conversationId, title) {
    const fixture = fixtureById(conversationId);
    fixture.state = {
      ...fixture.state,
      title: title.trim(),
      revision: fixture.state.revision + 1,
      lastActiveAt: nextTime(),
    };
    for (const listener of listeners) {
      listener({
        type: "conversation.state-changed",
        record: fixture.state as never,
      });
    }
    return fixture.state;
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
    const workspace = workspaceRows.find((candidate) => candidate.id === source.state.workspaceId);
    if (workspace?.effectiveSecurityProfile === null || workspace === undefined) {
      throw new Error("The fixture workspace policy is unavailable");
    }
    const fork = emptyState(id, `Fork of ${source.state.title}`, {
      id: workspace.id,
      path: workspace.path,
      securityProfile: workspace.effectiveSecurityProfile,
      effectiveNetworkPolicy: workspace.effectiveNetworkPolicy,
    });
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
      payload: { message, contextUsage: fixture.state.contextUsage },
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
  async list(workspace) {
    scheduleOutOfOrderHistory(workspace);
    return listedHistory(workspace);
  },
  async resolve(workspace, conversationId) {
    const fixture = fixtureById(conversationId);
    if (fixture.state.cwd !== workspace.path) throw new Error("Wrong fixture workspace");
    return { summary: { sessionFile: fixture.state.sessionFile } };
  },
  async delete(workspace, conversationId) {
    const fixture = fixtureById(conversationId);
    if (fixture.state.cwd !== workspace.path) throw new Error("Wrong fixture workspace");
    if (!fixture.closed) throw new Error("Close the fixture conversation before deleting it");
    for (const timer of fixture.timers) clearTimeout(timer);
    conversations.delete(conversationId);
    return listedHistory(workspace);
  },
};

const workspaces: ProtocolWorkspaceRepository = {
  list: () => [...workspaceRows],
  requireAvailable: (workspaceId) => {
    const workspace = workspaceRows.find((item) => item.id === workspaceId);
    if (workspace === undefined || !workspace.available) throw new Error("Unknown fixture workspace");
    return workspace;
  },
  requireUsable: (workspaceId) => {
    const workspace = workspaceRows.find((item) => item.id === workspaceId);
    if (workspace === undefined || !workspace.usable || workspace.effectiveSecurityProfile === null) {
      throw new Error("Unusable fixture workspace");
    }
    return {
      workspaceId: workspace.id,
      cwd: workspace.path,
      sessionDirectory: workspace.sessionDirectory,
      securityProfile: workspace.effectiveSecurityProfile,
      networkPolicy: workspace.effectiveNetworkPolicy,
      networkPolicySetId: workspace.networkPolicySetId,
      effectiveNetworkPolicySetId: workspace.effectiveNetworkPolicySetId,
      networkPolicySet: null,
    };
  },
  create: (input) => {
    if (input.path.includes("fixture-slow-submit")) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
    }
    workspaceSequence += 1;
    const unavailableSet = input.path.includes("fixture-policy-set-unavailable");
    const selectedSetId = unavailableSet ? "retired-policy" : input.networkPolicySetId ?? "default";
    const workspace: WorkspaceSummary = {
      id: `browser-workspace-${String(workspaceSequence)}`,
      name: input.name.trim(),
      path: input.path.trim(),
      sessionStorage: input.sessionStorage,
      sessionDirectory:
        input.sessionStorage === "workspace"
          ? `${input.path.trim()}/.chatwca/sessions`
          : null,
      securityProfile: input.securityProfile,
      networkPolicy: input.networkPolicy ?? "isolated",
      networkPolicySetId: selectedSetId,
      effectiveSecurityProfile: input.securityProfile,
      effectiveNetworkPolicy: input.securityProfile === "workspace-sandboxed"
        ? input.networkPolicy ?? "isolated"
        : null,
      effectiveNetworkPolicySetId:
        !unavailableSet && input.securityProfile === "workspace-sandboxed" &&
          (input.networkPolicy ?? "isolated") === "managed-egress"
          ? selectedSetId
          : null,
      networkPolicyIssue: unavailableSet ? "managed_egress_policy_set_unavailable" : null,
      createdAt: nextTime(),
      updatedAt: nextTime(),
      available: !input.path.includes("fixture-unavailable"),
      usable: !unavailableSet && !input.path.includes("fixture-unavailable") &&
        !input.path.includes("fixture-policy-blocked"),
      policyIssue: input.path.includes("fixture-policy-blocked")
        ? "outside_workspace_roots"
        : null,
    };
    workspaceRows = [...workspaceRows, workspace];
    return workspace;
  },
  update: (workspaceId, changes) => {
    const current = workspaceRows.find((item) => item.id === workspaceId);
    if (current === undefined) throw new Error("Unknown fixture workspace");
    const updated: WorkspaceSummary = {
      ...current,
      ...(changes.name === undefined ? {} : { name: changes.name.trim() }),
      ...(changes.path === undefined
        ? {}
        : {
            path: changes.path.trim(),
            sessionDirectory:
              current.sessionStorage === "workspace"
                ? `${changes.path.trim()}/.chatwca/sessions`
                : null,
          }),
      ...(changes.securityProfile === undefined
        ? {}
        : {
            securityProfile: changes.securityProfile,
            effectiveSecurityProfile: changes.securityProfile,
            effectiveNetworkPolicy: changes.securityProfile === "workspace-sandboxed"
              ? changes.networkPolicy ?? current.networkPolicy
              : null,
          }),
      ...(changes.networkPolicy === undefined
        ? {}
        : {
            networkPolicy: changes.networkPolicy,
            effectiveNetworkPolicy:
              (changes.securityProfile ?? current.effectiveSecurityProfile) === "workspace-sandboxed"
                ? changes.networkPolicy
                : null,
          }),
      ...(changes.networkPolicySetId === undefined
        ? {}
        : {
            networkPolicySetId: changes.networkPolicySetId,
            effectiveNetworkPolicySetId:
              (changes.securityProfile ?? current.securityProfile) === "workspace-sandboxed" &&
                (changes.networkPolicy ?? current.networkPolicy) === "managed-egress"
                ? changes.networkPolicySetId
                : null,
            networkPolicyIssue: null,
          }),
      available: changes.path === undefined
        ? current.available
        : !changes.path.includes("fixture-unavailable"),
      usable: changes.path === undefined
        ? changes.networkPolicySetId !== undefined && current.networkPolicyIssue === "managed_egress_policy_set_unavailable"
          ? true
          : current.usable
        : !changes.path.includes("fixture-unavailable") &&
          !changes.path.includes("fixture-policy-blocked"),
      policyIssue: changes.path === undefined
        ? current.policyIssue
        : changes.path.includes("fixture-policy-blocked")
          ? "outside_workspace_roots"
          : null,
      updatedAt: nextTime(),
    };
    workspaceRows = workspaceRows.map((item) => item.id === workspaceId ? updated : item);
    return updated;
  },
  delete: (workspaceId) => {
    if (!workspaceRows.some((item) => item.id === workspaceId)) throw new Error("Unknown fixture workspace");
    workspaceRows = workspaceRows.filter((item) => item.id !== workspaceId);
  },
};

const fixtureImage = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const images: ConversationImageOwner = {
  getImage: () => undefined,
  getWorkspaceImage: async (conversationId, filePath) =>
    conversationId === "browser-rich-conversation" && filePath === "generated.png"
      ? { mimeType: "image/png", data: fixtureImage }
      : undefined,
};

const config = loadConfig(
  {
    CHATWCA_HOST: HOST,
    CHATWCA_PORT: String(PORT),
    CHATWCA_DATA_DIR: CWD,
    CHATWCA_MAX_IMAGES: String(IMAGE_LIMITS.maxImages),
    CHATWCA_MAX_IMAGE_BYTES: String(IMAGE_LIMITS.maxImageBytes),
    CHATWCA_MAX_TOTAL_IMAGE_BYTES: String(IMAGE_LIMITS.maxTotalImageBytes),
    CHATWCA_SANDBOX_MODE: "optional",
    CHATWCA_MANAGED_EGRESS_MODE: "optional",
    CHATWCA_NETWORK_ALLOWED_DOMAINS: '["**.example.com","registry.npmjs.org"]',
    CHATWCA_NETWORK_DENIED_DOMAINS: '["blocked.example.com"]',
    CHATWCA_NETWORK_ALLOWED_PORTS: "[80,443]",
    CHATWCA_NETWORK_POLICY_SETS: '[{"id":"default","label":"Package registries","allowedDomains":["registry.npmjs.org"],"allowedPorts":[443]},{"id":"web","label":"Example web","allowedDomains":["**.example.com"],"allowedPorts":[80,443]}]',
  },
  CWD,
);

server = createChatWcaServer(config, "browser-fixture", {
  registry,
  history,
  images,
  workspaces,
  sandboxFunctionalProbeSucceeded: true,
  managedNetworkFunctionalProbeSucceeded: true,
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
