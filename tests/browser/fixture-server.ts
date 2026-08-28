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
  ConversationEvent,
  ConversationState,
  ConversationSummary,
  NormalizedMessage,
  UiImage,
} from "../../src/shared/protocol.js";

const HOST = "127.0.0.1";
const PORT = 8787;
const CWD = "/tmp/chatwca-browser-workspace";
const IMAGE_LIMITS = {
  maxImages: 4,
  maxImageBytes: 2 * 1024 * 1024,
  maxTotalImageBytes: 4 * 1024 * 1024,
};

let state: ConversationState = {
  id: "browser-image-conversation",
  sessionFile: "/tmp/chatwca-browser-sessions/image-test.jsonl",
  title: "Image behavior",
  cwd: CWD,
  model: {
    id: "deterministic-vision",
    provider: "browser-fixture",
    name: "Deterministic vision model",
    supportsImages: true,
  },
  status: "idle",
  createdAt: 1_700_000_000_000,
  lastActiveAt: 1_700_000_000_000,
  revision: 0,
  durable: true,
  messages: [],
  queue: { steering: [], followUp: [] },
};

const listeners = new Set<ConversationRegistryListener>();
let messageId = 0;

function summary(): ConversationSummary {
  return {
    id: state.id,
    sessionFile: state.sessionFile,
    title: state.title,
    cwd: state.cwd,
    createdAt: state.createdAt,
    modifiedAt: state.lastActiveAt,
    messageCount: state.messages.length,
    status: state.status === "aborting" ? "streaming" : state.status,
    runnable: true,
  };
}

function emit(event: ConversationEvent): void {
  for (const listener of listeners) {
    listener({
      type: "conversation.event",
      record: { id: state.id } as never,
      event,
    });
  }
}

function userMessage(text: string, images: readonly UiImage[]): NormalizedMessage {
  messageId += 1;
  return {
    entryId: `browser-user-${String(messageId)}`,
    role: "user",
    forkEligible: false,
    blocks: [
      ...(text.length === 0 ? [] : [{ type: "text" as const, text }]),
      ...images.map((image) => ({
        type: "image" as const,
        image,
        alt: image.name ?? "Submitted image",
      })),
    ],
    timestamp: 1_700_000_000_000 + messageId,
  };
}

const registry: ProtocolRegistry = {
  async create() {
    return { id: state.id };
  },
  async open() {
    return { id: state.id };
  },
  async getState(conversationId) {
    if (conversationId !== state.id) throw new Error("Unknown fixture conversation");
    return state;
  },
  async close() {
    return undefined;
  },
  async fork() {
    return { conversation: state, editorText: "" };
  },
  async prompt(conversationId, text, images) {
    if (conversationId !== state.id) throw new Error("Unknown fixture conversation");

    // Exercise the production image boundary as part of the successful browser
    // path. No Pi state or operator session directory is touched by this fixture.
    validatePromptImages(images, {
      supportsImages: true,
      limits: IMAGE_LIMITS,
    });

    const message = userMessage(text, images);
    const revision = state.revision + 1;
    state = {
      ...state,
      revision,
      lastActiveAt: state.lastActiveAt + 1,
      messages: [...state.messages, message],
    };
    emit({
      type: "message.completed",
      conversationId: state.id,
      revision,
      payload: { message },
    });
  },
  async abort() {
    return undefined;
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

const history: ProtocolHistory = {
  async list() {
    return [summary()];
  },
  async resolve(conversationId) {
    if (conversationId !== state.id) throw new Error("Unknown fixture conversation");
    return { summary: { sessionFile: state.sessionFile } };
  },
  async delete() {
    return [];
  },
};

const config = loadConfig(
  {
    CHATWCA_HOST: HOST,
    CHATWCA_PORT: String(PORT),
    CHATWCA_DEFAULT_CWD: CWD,
    CHATWCA_MAX_IMAGES: String(IMAGE_LIMITS.maxImages),
    CHATWCA_MAX_IMAGE_BYTES: String(IMAGE_LIMITS.maxImageBytes),
    CHATWCA_MAX_TOTAL_IMAGE_BYTES: String(IMAGE_LIMITS.maxTotalImageBytes),
  },
  CWD,
);

const server: ChatWcaServer = createChatWcaServer(config, "browser-image-test", {
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
  for (const client of server.webSocketServer.clients) client.terminate();
  await new Promise<void>((resolve) => server.webSocketServer.close(() => resolve()));
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void stop().then(() => process.exit(0));
  });
}
