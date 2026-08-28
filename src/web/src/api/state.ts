import type {
  ConversationEvent,
  ConversationState,
  ConversationSummary,
  NormalizedMessage,
  StatusNotice,
  ToolCallBlock,
  ToolResultBlock,
} from "../../../shared/protocol.js";
import {
  decideEventRevision,
  decideSnapshotRevision,
} from "../../../shared/revisions.js";

export type ConnectionStatus =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

export interface ClientErrorState {
  readonly code: string;
  readonly message: string;
}

export interface ConversationProjection {
  readonly conversation: ConversationState;
  readonly notices: readonly StatusNotice[];
}

export interface ChatClientState {
  readonly connection: ConnectionStatus;
  readonly serverVersion: string | null;
  readonly history: readonly ConversationSummary[];
  readonly conversations: Readonly<Record<string, ConversationProjection>>;
  readonly selectedConversationId: string | null;
  readonly drafts: Readonly<Record<string, string>>;
  readonly resyncConversationIds: readonly string[];
  readonly lastError: ClientErrorState | null;
}

export type ChatClientAction =
  | { readonly type: "connection"; readonly status: ConnectionStatus }
  | { readonly type: "ready"; readonly serverVersion: string }
  | { readonly type: "history"; readonly conversations: readonly ConversationSummary[] }
  | { readonly type: "snapshot"; readonly conversation: ConversationState }
  | { readonly type: "event"; readonly event: ConversationEvent }
  | { readonly type: "select"; readonly conversationId: string | null }
  | { readonly type: "draft"; readonly conversationId: string; readonly text: string }
  | { readonly type: "error"; readonly error: ClientErrorState | null };

export function createInitialChatClientState(): ChatClientState {
  return {
    connection: "disconnected",
    serverVersion: null,
    history: [],
    conversations: {},
    selectedConversationId: null,
    drafts: {},
    resyncConversationIds: [],
    lastError: null,
  };
}

function replaceConversation(
  state: ChatClientState,
  projection: ConversationProjection,
): ChatClientState {
  return {
    ...state,
    conversations: {
      ...state.conversations,
      [projection.conversation.id]: projection,
    },
    resyncConversationIds: state.resyncConversationIds.filter(
      (id) => id !== projection.conversation.id,
    ),
  };
}

function requestResync(state: ChatClientState, conversationId: string): ChatClientState {
  if (state.resyncConversationIds.includes(conversationId)) return state;
  return {
    ...state,
    resyncConversationIds: [...state.resyncConversationIds, conversationId],
  };
}

function replaceMessage(
  messages: readonly NormalizedMessage[],
  message: NormalizedMessage,
  completed: boolean,
): NormalizedMessage[] {
  const exactIndex = messages.findIndex((item) => item.entryId === message.entryId);
  let index = exactIndex;
  if (index < 0 && completed) {
    // Pi start events use a temporary stream ID; completion carries the durable
    // entry ID. The matching in-progress message is always the latest same-role
    // stream entry in this conversation.
    for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
      const item = messages[candidate];
      if (item?.role === message.role && item.entryId.startsWith("stream:")) {
        index = candidate;
        break;
      }
    }
  }

  if (index < 0) return [...messages, message];
  const next = [...messages];
  next[index] = message;
  return next;
}

function updateAssistant(
  messages: readonly NormalizedMessage[],
  entryId: string | undefined,
  update: (message: Extract<NormalizedMessage, { role: "assistant" }>) => NormalizedMessage,
  toolCallId?: string,
): NormalizedMessage[] {
  let index = entryId === undefined
    ? -1
    : messages.findIndex((message) => message.entryId === entryId);
  if (index < 0 && toolCallId !== undefined) {
    index = messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        message.blocks.some(
          (block) =>
            (block.type === "tool-call" || block.type === "tool-result") &&
            block.toolCallId === toolCallId,
        ),
    );
  }
  if (index < 0) {
    for (let candidate = messages.length - 1; candidate >= 0; candidate -= 1) {
      if (messages[candidate]?.role === "assistant") {
        index = candidate;
        break;
      }
    }
  }
  const message = messages[index];
  if (index < 0 || message?.role !== "assistant") return [...messages];
  const next = [...messages];
  next[index] = update(message);
  return next;
}

function updateToolCallStatus(
  blocks: Extract<NormalizedMessage, { role: "assistant" }>["blocks"],
  toolCallId: string,
  status: ToolCallBlock["status"],
): Extract<NormalizedMessage, { role: "assistant" }>["blocks"] {
  return blocks.map((block) =>
    block.type === "tool-call" && block.toolCallId === toolCallId
      ? { ...block, status }
      : block,
  );
}

function applyConversationEvent(
  conversation: ConversationState,
  event: ConversationEvent,
): ConversationState {
  let messages = [...conversation.messages];
  let queue = conversation.queue;
  let status = conversation.status;

  switch (event.type) {
    case "message.started":
      messages = replaceMessage(messages, event.payload.message, false);
      break;
    case "message.completed":
      messages = replaceMessage(messages, event.payload.message, true);
      break;
    case "message.delta":
      messages = messages.map((message) => {
        if (message.entryId !== event.payload.entryId || message.role !== "assistant") {
          return message;
        }
        const blocks = [...message.blocks];
        const block = blocks[event.payload.blockIndex];
        if (block === undefined && event.payload.blockIndex === blocks.length) {
          // Pi can emit the first text/thinking delta after message_start sent
          // an empty content array. Materialize that normalized block here.
          blocks.push({
            type: event.payload.blockType,
            text: event.payload.delta,
          });
          return { ...message, blocks };
        }
        if (block?.type !== event.payload.blockType) return message;
        blocks[event.payload.blockIndex] = {
          ...block,
          text: block.text + event.payload.delta,
        };
        return { ...message, blocks };
      });
      break;
    case "tool.started":
      messages = updateAssistant(messages, event.payload.entryId, (message) => {
        const existing = message.blocks.findIndex(
          (block) =>
            block.type === "tool-call" &&
            block.toolCallId === event.payload.tool.toolCallId,
        );
        const blocks = [...message.blocks];
        if (existing < 0) blocks.push(event.payload.tool);
        else blocks[existing] = event.payload.tool;
        return { ...message, blocks };
      });
      break;
    case "tool.updated":
      messages = updateAssistant(messages, undefined, (message) => {
        const partial: ToolResultBlock = {
          type: "tool-result",
          toolCallId: event.payload.toolCallId,
          content: event.payload.content,
          isError: false,
          truncated: event.payload.truncated,
        };
        const existing = message.blocks.findIndex(
          (block) =>
            block.type === "tool-result" &&
            block.toolCallId === event.payload.toolCallId,
        );
        let blocks = updateToolCallStatus(
          message.blocks,
          event.payload.toolCallId,
          "running",
        );
        blocks = [...blocks];
        if (existing < 0) blocks.push(partial);
        else blocks[existing] = partial;
        return { ...message, blocks };
      }, event.payload.toolCallId);
      break;
    case "tool.completed":
      messages = updateAssistant(messages, undefined, (message) => {
        const result = event.payload.result;
        let blocks = updateToolCallStatus(
          message.blocks,
          result.toolCallId,
          result.isError ? "failed" : "succeeded",
        );
        const existing = blocks.findIndex(
          (block) =>
            block.type === "tool-result" && block.toolCallId === result.toolCallId,
        );
        blocks = [...blocks];
        if (existing < 0) blocks.push(result);
        else blocks[existing] = result;
        return { ...message, blocks };
      }, event.payload.result.toolCallId);
      break;
    case "conversation.queue":
      queue = event.payload;
      break;
    case "conversation.status":
      status = event.payload.status;
      break;
    case "conversation.notice":
      break;
  }

  return {
    ...conversation,
    messages,
    queue,
    status,
    revision: event.revision,
  };
}

export function reduceChatClientState(
  state: ChatClientState,
  action: ChatClientAction,
): ChatClientState {
  switch (action.type) {
    case "connection":
      return { ...state, connection: action.status };
    case "ready":
      return {
        ...state,
        connection: "connected",
        serverVersion: action.serverVersion,
        lastError: null,
      };
    case "history": {
      const listed = new Set(action.conversations.map((item) => item.id));
      const conversations = Object.fromEntries(
        Object.entries(state.conversations).filter(([id]) => listed.has(id)),
      );
      return { ...state, history: [...action.conversations], conversations };
    }
    case "snapshot": {
      const current = state.conversations[action.conversation.id];
      if (
        decideSnapshotRevision(
          current?.conversation.revision,
          action.conversation.revision,
        ) === "ignore"
      ) {
        return state;
      }
      return replaceConversation(state, {
        conversation: action.conversation,
        notices: current?.notices ?? [],
      });
    }
    case "event": {
      const current = state.conversations[action.event.conversationId];
      if (current === undefined) return requestResync(state, action.event.conversationId);
      const decision = decideEventRevision(
        current.conversation.revision,
        action.event.revision,
      );
      if (decision === "ignore") return state;
      if (decision === "resync") return requestResync(state, action.event.conversationId);

      const notices = action.event.type === "conversation.notice"
        ? [...current.notices, action.event.payload.notice].slice(-100)
        : current.notices;
      return replaceConversation(state, {
        conversation: applyConversationEvent(current.conversation, action.event),
        notices,
      });
    }
    case "select":
      return { ...state, selectedConversationId: action.conversationId };
    case "draft":
      return {
        ...state,
        drafts: { ...state.drafts, [action.conversationId]: action.text },
      };
    case "error":
      return { ...state, lastError: action.error };
  }
}
