import { type Static, Type, type TSchema } from "@sinclair/typebox";

import { ErrorCodeSchema } from "./errors.js";

/**
 * ChatWCA's JSON wire contract.
 *
 * All protocol objects are closed (`additionalProperties: false`). This makes
 * client/server version mismatches fail visibly instead of silently ignoring
 * misspelled or unsupported fields. Binary image data is transported as base64
 * without a data-URL prefix; `mimeType` carries the declared media type.
 */

const strictObject = <T extends Record<string, TSchema>>(properties: T) =>
  Type.Object(properties, { additionalProperties: false });

const NonEmptyStringSchema = Type.String({ minLength: 1 });
const IdentifierSchema = Type.String({ minLength: 1, maxLength: 512 });
export const MAX_CONVERSATION_TITLE_LENGTH = 200;
export const RequestIdSchema = Type.String({ minLength: 1, maxLength: 128 });
export const RevisionSchema = Type.Integer({
  minimum: 0,
  maximum: Number.MAX_SAFE_INTEGER,
});

export const ImageMimeTypeSchema = Type.Union([
  Type.Literal("image/png"),
  Type.Literal("image/jpeg"),
  Type.Literal("image/webp"),
]);
export type ImageMimeType = Static<typeof ImageMimeTypeSchema>;

export const ImagePayloadSchema = strictObject({
  mimeType: ImageMimeTypeSchema,
  encoding: Type.Literal("base64"),
  data: NonEmptyStringSchema,
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
  width: Type.Optional(Type.Integer({ minimum: 1 })),
  height: Type.Optional(Type.Integer({ minimum: 1 })),
  byteSize: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ImagePayload = Static<typeof ImagePayloadSchema>;

// The command-side name is retained from the design. Serialized image blocks
// use the same shape so persisted images can be submitted again if desired.
export const UiImageSchema = ImagePayloadSchema;
export type UiImage = Static<typeof UiImageSchema>;

export const TextBlockSchema = strictObject({
  type: Type.Literal("text"),
  text: Type.String(),
});
export type TextBlock = Static<typeof TextBlockSchema>;

export const ThinkingBlockSchema = strictObject({
  type: Type.Literal("thinking"),
  text: Type.String(),
});
export type ThinkingBlock = Static<typeof ThinkingBlockSchema>;

export const ImageReferenceSchema = strictObject({
  mimeType: ImageMimeTypeSchema,
  url: Type.String({ minLength: 1, maxLength: 2048 }),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 255 })),
});
export type ImageReference = Static<typeof ImageReferenceSchema>;

export const ImageBlockSchema = Type.Union([
  strictObject({
    type: Type.Literal("image"),
    image: ImagePayloadSchema,
    alt: Type.Optional(Type.String()),
  }),
  strictObject({
    type: Type.Literal("image"),
    image: ImageReferenceSchema,
    alt: Type.Optional(Type.String()),
  }),
]);
export type ImageBlock = Static<typeof ImageBlockSchema>;

export const ToolCallBlockSchema = strictObject({
  type: Type.Literal("tool-call"),
  toolCallId: IdentifierSchema,
  toolName: NonEmptyStringSchema,
  arguments: Type.Unknown(),
  status: Type.Union([
    Type.Literal("pending"),
    Type.Literal("running"),
    Type.Literal("succeeded"),
    Type.Literal("failed"),
  ]),
});
export type ToolCallBlock = Static<typeof ToolCallBlockSchema>;

export const ToolResultBlockSchema = strictObject({
  type: Type.Literal("tool-result"),
  toolCallId: IdentifierSchema,
  toolName: Type.Optional(NonEmptyStringSchema),
  content: Type.String(),
  isError: Type.Boolean(),
  truncated: Type.Boolean(),
  originalBytes: Type.Optional(Type.Integer({ minimum: 0 })),
});
export type ToolResultBlock = Static<typeof ToolResultBlockSchema>;

export const UserContentBlockSchema = Type.Union([
  TextBlockSchema,
  ImageBlockSchema,
]);
export type UserContentBlock = Static<typeof UserContentBlockSchema>;

export const AssistantContentBlockSchema = Type.Union([
  TextBlockSchema,
  ThinkingBlockSchema,
  ImageBlockSchema,
  ToolCallBlockSchema,
  ToolResultBlockSchema,
]);
export type AssistantContentBlock = Static<typeof AssistantContentBlockSchema>;

export const UsageSchema = strictObject({
  inputTokens: Type.Integer({ minimum: 0 }),
  outputTokens: Type.Integer({ minimum: 0 }),
  cacheReadTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  cacheWriteTokens: Type.Optional(Type.Integer({ minimum: 0 })),
  totalCost: Type.Optional(Type.Number({ minimum: 0 })),
});
export type Usage = Static<typeof UsageSchema>;

export const ContextUsageSchema = strictObject({
  /** Estimated active-context tokens; unknown immediately after compaction. */
  tokens: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
  contextWindow: Type.Number({ exclusiveMinimum: 0 }),
  /** Percentage of the model context window; unknown when tokens are unknown. */
  percent: Type.Union([Type.Number({ minimum: 0 }), Type.Null()]),
});
export type ContextUsage = Static<typeof ContextUsageSchema>;

const MessageErrorSchema = strictObject({
  code: ErrorCodeSchema,
  message: NonEmptyStringSchema,
});

export const UserMessageSchema = strictObject({
  entryId: IdentifierSchema,
  role: Type.Literal("user"),
  blocks: Type.Array(UserContentBlockSchema),
  timestamp: Type.Optional(Type.Number({ minimum: 0 })),
  /** True only when the server observed a canonical Pi entry on the active branch. */
  forkEligible: Type.Boolean(),
});
export type UserMessage = Static<typeof UserMessageSchema>;

export const AssistantMessageSchema = strictObject({
  entryId: IdentifierSchema,
  role: Type.Literal("assistant"),
  blocks: Type.Array(AssistantContentBlockSchema),
  timestamp: Type.Optional(Type.Number({ minimum: 0 })),
  stopReason: Type.Optional(
    Type.Union([
      Type.Literal("stop"),
      Type.Literal("length"),
      Type.Literal("tool-use"),
      Type.Literal("aborted"),
      Type.Literal("error"),
      Type.Literal("unknown"),
    ]),
  ),
  error: Type.Optional(MessageErrorSchema),
  usage: Type.Optional(UsageSchema),
});
export type AssistantMessage = Static<typeof AssistantMessageSchema>;

export const NormalizedMessageSchema = Type.Union([
  UserMessageSchema,
  AssistantMessageSchema,
]);
export type NormalizedMessage = Static<typeof NormalizedMessageSchema>;

export const LiveConversationStatusSchema = Type.Union([
  Type.Literal("idle"),
  Type.Literal("streaming"),
  Type.Literal("aborting"),
  Type.Literal("error"),
]);
export type LiveConversationStatus = Static<
  typeof LiveConversationStatusSchema
>;

export const WorkspaceSessionStorageSchema = Type.Union([
  Type.Literal("pi-default"),
  Type.Literal("workspace"),
]);
export type WorkspaceSessionStorage = Static<
  typeof WorkspaceSessionStorageSchema
>;

export const WorkspaceSchema = strictObject({
  id: IdentifierSchema,
  name: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
  sessionStorage: WorkspaceSessionStorageSchema,
  sessionDirectory: Type.Union([NonEmptyStringSchema, Type.Null()]),
  createdAt: Type.Number({ minimum: 0 }),
  updatedAt: Type.Number({ minimum: 0 }),
});
export type Workspace = Static<typeof WorkspaceSchema>;

export const WorkspaceSummarySchema = strictObject({
  id: IdentifierSchema,
  name: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
  sessionStorage: WorkspaceSessionStorageSchema,
  sessionDirectory: Type.Union([NonEmptyStringSchema, Type.Null()]),
  createdAt: Type.Number({ minimum: 0 }),
  updatedAt: Type.Number({ minimum: 0 }),
  available: Type.Boolean(),
});
export type WorkspaceSummary = Static<typeof WorkspaceSummarySchema>;

export const ConversationSummarySchema = strictObject({
  id: IdentifierSchema,
  workspaceId: IdentifierSchema,
  sessionFile: NonEmptyStringSchema,
  title: Type.String(),
  cwd: NonEmptyStringSchema,
  createdAt: Type.Optional(Type.Number({ minimum: 0 })),
  modifiedAt: Type.Number({ minimum: 0 }),
  messageCount: Type.Integer({ minimum: 0 }),
  status: Type.Union([
    Type.Literal("closed"),
    Type.Literal("idle"),
    Type.Literal("streaming"),
    Type.Literal("error"),
  ]),
  runnable: Type.Boolean(),
});
export type ConversationSummary = Static<typeof ConversationSummarySchema>;

export const ModelInfoSchema = strictObject({
  id: NonEmptyStringSchema,
  provider: NonEmptyStringSchema,
  name: Type.Optional(NonEmptyStringSchema),
  supportsImages: Type.Boolean(),
});
export type ModelInfo = Static<typeof ModelInfoSchema>;

export const QueuedPromptSchema = strictObject({
  text: Type.String(),
  imageCount: Type.Integer({ minimum: 0 }),
});
export type QueuedPrompt = Static<typeof QueuedPromptSchema>;

export const QueueStateSchema = strictObject({
  steering: Type.Array(QueuedPromptSchema),
  followUp: Type.Array(QueuedPromptSchema),
});
export type QueueState = Static<typeof QueueStateSchema>;

export const ConversationStateSchema = strictObject({
  id: IdentifierSchema,
  workspaceId: IdentifierSchema,
  sessionFile: NonEmptyStringSchema,
  title: Type.String(),
  cwd: NonEmptyStringSchema,
  model: Type.Union([ModelInfoSchema, Type.Null()]),
  status: LiveConversationStatusSchema,
  createdAt: Type.Number({ minimum: 0 }),
  lastActiveAt: Type.Number({ minimum: 0 }),
  revision: RevisionSchema,
  durable: Type.Boolean(),
  contextUsage: Type.Union([ContextUsageSchema, Type.Null()]),
  messages: Type.Array(NormalizedMessageSchema),
  queue: QueueStateSchema,
});
export type ConversationState = Static<typeof ConversationStateSchema>;

export const WorkspaceListCommandSchema = strictObject({
  type: Type.Literal("workspace.list"),
  requestId: RequestIdSchema,
});
export const WorkspaceCreateCommandSchema = strictObject({
  type: Type.Literal("workspace.create"),
  requestId: RequestIdSchema,
  name: NonEmptyStringSchema,
  path: NonEmptyStringSchema,
  sessionStorage: WorkspaceSessionStorageSchema,
});
const WorkspaceUpdateWithNameSchema = strictObject({
  type: Type.Literal("workspace.update"),
  requestId: RequestIdSchema,
  workspaceId: IdentifierSchema,
  name: NonEmptyStringSchema,
  path: Type.Optional(NonEmptyStringSchema),
});
const WorkspaceUpdateWithPathSchema = strictObject({
  type: Type.Literal("workspace.update"),
  requestId: RequestIdSchema,
  workspaceId: IdentifierSchema,
  name: Type.Optional(NonEmptyStringSchema),
  path: NonEmptyStringSchema,
});
export const WorkspaceUpdateCommandSchema = Type.Union([
  WorkspaceUpdateWithNameSchema,
  WorkspaceUpdateWithPathSchema,
]);
export const WorkspaceDeleteCommandSchema = strictObject({
  type: Type.Literal("workspace.delete"),
  requestId: RequestIdSchema,
  workspaceId: IdentifierSchema,
});

export const HistoryListCommandSchema = strictObject({
  type: Type.Literal("history.list"),
  requestId: RequestIdSchema,
  workspaceId: IdentifierSchema,
});
export const ConversationCreateCommandSchema = strictObject({
  type: Type.Literal("conversation.create"),
  requestId: RequestIdSchema,
  workspaceId: IdentifierSchema,
});
export const ConversationOpenCommandSchema = strictObject({
  type: Type.Literal("conversation.open"),
  requestId: RequestIdSchema,
  workspaceId: IdentifierSchema,
  conversationId: IdentifierSchema,
});
export const ConversationStateCommandSchema = strictObject({
  type: Type.Literal("conversation.state"),
  requestId: RequestIdSchema,
  conversationId: IdentifierSchema,
});
export const ConversationRenameCommandSchema = strictObject({
  type: Type.Literal("conversation.rename"),
  requestId: RequestIdSchema,
  conversationId: IdentifierSchema,
  title: Type.String({ minLength: 1, maxLength: MAX_CONVERSATION_TITLE_LENGTH }),
});
export const ConversationCloseCommandSchema = strictObject({
  type: Type.Literal("conversation.close"),
  requestId: RequestIdSchema,
  conversationId: IdentifierSchema,
});
export const ConversationDeleteCommandSchema = strictObject({
  type: Type.Literal("conversation.delete"),
  requestId: RequestIdSchema,
  workspaceId: IdentifierSchema,
  conversationId: IdentifierSchema,
});
export const ConversationForkCommandSchema = strictObject({
  type: Type.Literal("conversation.fork"),
  requestId: RequestIdSchema,
  conversationId: IdentifierSchema,
  entryId: IdentifierSchema,
});

const promptCommand = <T extends "prompt.submit" | "prompt.steer" | "prompt.followUp">(
  type: T,
) =>
  strictObject({
    type: Type.Literal(type),
    requestId: RequestIdSchema,
    conversationId: IdentifierSchema,
    text: Type.String(),
    images: Type.Array(UiImageSchema),
  });

export const PromptSubmitCommandSchema = promptCommand("prompt.submit");
export const PromptSteerCommandSchema = promptCommand("prompt.steer");
export const PromptFollowUpCommandSchema = promptCommand("prompt.followUp");
export const ConversationAbortCommandSchema = strictObject({
  type: Type.Literal("conversation.abort"),
  requestId: RequestIdSchema,
  conversationId: IdentifierSchema,
});

export type WorkspaceListCommand = Static<typeof WorkspaceListCommandSchema>;
export type WorkspaceCreateCommand = Static<typeof WorkspaceCreateCommandSchema>;
export type WorkspaceUpdateCommand = Static<typeof WorkspaceUpdateCommandSchema>;
export type WorkspaceDeleteCommand = Static<typeof WorkspaceDeleteCommandSchema>;
export type HistoryListCommand = Static<typeof HistoryListCommandSchema>;
export type ConversationCreateCommand = Static<
  typeof ConversationCreateCommandSchema
>;
export type ConversationOpenCommand = Static<
  typeof ConversationOpenCommandSchema
>;
export type ConversationStateCommand = Static<
  typeof ConversationStateCommandSchema
>;
export type ConversationRenameCommand = Static<
  typeof ConversationRenameCommandSchema
>;
export type ConversationCloseCommand = Static<
  typeof ConversationCloseCommandSchema
>;
export type ConversationDeleteCommand = Static<
  typeof ConversationDeleteCommandSchema
>;
export type ConversationForkCommand = Static<
  typeof ConversationForkCommandSchema
>;
export type PromptSubmitCommand = Static<typeof PromptSubmitCommandSchema>;
export type PromptSteerCommand = Static<typeof PromptSteerCommandSchema>;
export type PromptFollowUpCommand = Static<typeof PromptFollowUpCommandSchema>;
export type ConversationAbortCommand = Static<
  typeof ConversationAbortCommandSchema
>;

export const ClientCommandSchema = Type.Union([
  WorkspaceListCommandSchema,
  WorkspaceCreateCommandSchema,
  WorkspaceUpdateCommandSchema,
  WorkspaceDeleteCommandSchema,
  HistoryListCommandSchema,
  ConversationCreateCommandSchema,
  ConversationOpenCommandSchema,
  ConversationStateCommandSchema,
  ConversationRenameCommandSchema,
  ConversationCloseCommandSchema,
  ConversationDeleteCommandSchema,
  ConversationForkCommandSchema,
  PromptSubmitCommandSchema,
  PromptSteerCommandSchema,
  PromptFollowUpCommandSchema,
  ConversationAbortCommandSchema,
]);
export type ClientCommand = Static<typeof ClientCommandSchema>;
export type ClientCommandType = ClientCommand["type"];

export const ReadyMessageSchema = strictObject({
  type: Type.Literal("ready"),
  serverVersion: NonEmptyStringSchema,
});
export type ReadyMessage = Static<typeof ReadyMessageSchema>;

/** Process-level notice sent immediately before sockets close for shutdown. */
export const ServerShutdownMessageSchema = strictObject({
  type: Type.Literal("server.shutdown"),
  gracePeriodMs: Type.Integer({ minimum: 1 }),
});
export type ServerShutdownMessage = Static<
  typeof ServerShutdownMessageSchema
>;

export const AcknowledgedCommandTypeSchema = Type.Union([
  Type.Literal("workspace.delete"),
  Type.Literal("conversation.close"),
  Type.Literal("conversation.delete"),
  Type.Literal("prompt.submit"),
  Type.Literal("prompt.steer"),
  Type.Literal("prompt.followUp"),
  Type.Literal("conversation.abort"),
]);
export type AcknowledgedCommandType = Static<
  typeof AcknowledgedCommandTypeSchema
>;

/**
 * Commands without a result payload receive an acknowledgement. Commands
 * which read or create state use their correlated history/state result as the
 * success response instead of sending a second acknowledgement.
 */
export const AcknowledgementMessageSchema = strictObject({
  type: Type.Literal("ack"),
  requestId: RequestIdSchema,
  command: AcknowledgedCommandTypeSchema,
});
export type AcknowledgementMessage = Static<
  typeof AcknowledgementMessageSchema
>;

export const ErrorMessageSchema = strictObject({
  type: Type.Literal("error"),
  requestId: Type.Optional(RequestIdSchema),
  code: ErrorCodeSchema,
  message: NonEmptyStringSchema,
});
export type ErrorMessage = Static<typeof ErrorMessageSchema>;

export const WorkspacesMessageSchema = strictObject({
  type: Type.Literal("workspaces"),
  requestId: Type.Optional(RequestIdSchema),
  workspaces: Type.Array(WorkspaceSummarySchema),
});
export type WorkspacesMessage = Static<typeof WorkspacesMessageSchema>;

export const HistoryMessageSchema = strictObject({
  type: Type.Literal("history"),
  requestId: Type.Optional(RequestIdSchema),
  workspaceId: IdentifierSchema,
  conversations: Type.Array(ConversationSummarySchema),
});
export type HistoryMessage = Static<typeof HistoryMessageSchema>;

export const StateMessageSchema = strictObject({
  type: Type.Literal("state"),
  requestId: Type.Optional(RequestIdSchema),
  conversation: ConversationStateSchema,
  editorText: Type.Optional(Type.String()),
});
export type StateMessage = Static<typeof StateMessageSchema>;

/** A correlated successful response, selected by the originating command. */
type Correlated<T extends { requestId?: string }> = Omit<T, "requestId"> & {
  requestId: string;
};
type AckFor<TCommand extends AcknowledgedCommandType> = Omit<
  AcknowledgementMessage,
  "command"
> & { command: TCommand };
type ForkStateMessage = Omit<StateMessage, "requestId" | "editorText"> & {
  requestId: string;
  editorText: string;
};

/**
 * The one success response expected for each command. Failures use a
 * correlated ErrorMessage instead. Uncorrelated history/state messages remain
 * valid server broadcasts and are not command responses.
 */
export type CommandSuccessByType = {
  "workspace.list": Correlated<WorkspacesMessage>;
  "workspace.create": Correlated<WorkspacesMessage>;
  "workspace.update": Correlated<WorkspacesMessage>;
  "workspace.delete": AckFor<"workspace.delete">;
  "history.list": Correlated<HistoryMessage>;
  "conversation.create": Correlated<StateMessage>;
  "conversation.open": Correlated<StateMessage>;
  "conversation.state": Correlated<StateMessage>;
  "conversation.rename": Correlated<StateMessage>;
  "conversation.close": AckFor<"conversation.close">;
  "conversation.delete": AckFor<"conversation.delete">;
  "conversation.fork": ForkStateMessage;
  "prompt.submit": AckFor<"prompt.submit">;
  "prompt.steer": AckFor<"prompt.steer">;
  "prompt.followUp": AckFor<"prompt.followUp">;
  "conversation.abort": AckFor<"conversation.abort">;
};
export type CommandSuccess<
  TCommand extends ClientCommandType = ClientCommandType,
> = CommandSuccessByType[TCommand];

export const MessageStartedPayloadSchema = strictObject({
  message: NormalizedMessageSchema,
});
export const MessageDeltaPayloadSchema = strictObject({
  entryId: IdentifierSchema,
  blockIndex: Type.Integer({ minimum: 0 }),
  blockType: Type.Union([Type.Literal("text"), Type.Literal("thinking")]),
  delta: Type.String(),
});
export const MessageCompletedPayloadSchema = strictObject({
  message: NormalizedMessageSchema,
  contextUsage: Type.Union([ContextUsageSchema, Type.Null()]),
});
export const ToolStartedPayloadSchema = strictObject({
  entryId: Type.Optional(IdentifierSchema),
  tool: ToolCallBlockSchema,
});
export const ToolUpdatedPayloadSchema = strictObject({
  toolCallId: IdentifierSchema,
  content: Type.String(),
  truncated: Type.Boolean(),
});
export const ToolCompletedPayloadSchema = strictObject({
  result: ToolResultBlockSchema,
});
export const StatusUpdatePayloadSchema = strictObject({
  status: LiveConversationStatusSchema,
});
export type MessageStartedPayload = Static<
  typeof MessageStartedPayloadSchema
>;
export type MessageDeltaPayload = Static<typeof MessageDeltaPayloadSchema>;
export type MessageCompletedPayload = Static<
  typeof MessageCompletedPayloadSchema
>;
export type ToolStartedPayload = Static<typeof ToolStartedPayloadSchema>;
export type ToolUpdatedPayload = Static<typeof ToolUpdatedPayloadSchema>;
export type ToolCompletedPayload = Static<typeof ToolCompletedPayloadSchema>;
export type StatusUpdatePayload = Static<typeof StatusUpdatePayloadSchema>;

export const RetryNoticeSchema = strictObject({
  kind: Type.Literal("retry"),
  phase: Type.Union([
    Type.Literal("scheduled"),
    Type.Literal("started"),
    Type.Literal("completed"),
  ]),
  message: NonEmptyStringSchema,
  attempt: Type.Optional(Type.Integer({ minimum: 1 })),
  maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })),
  delayMs: Type.Optional(Type.Integer({ minimum: 0 })),
});
export const CompactionNoticeSchema = strictObject({
  kind: Type.Literal("compaction"),
  phase: Type.Union([
    Type.Literal("started"),
    Type.Literal("completed"),
    Type.Literal("aborted"),
    Type.Literal("failed"),
  ]),
  message: NonEmptyStringSchema,
});
export const RuntimeNoticeSchema = strictObject({
  kind: Type.Literal("runtime"),
  level: Type.Union([
    Type.Literal("info"),
    Type.Literal("warning"),
    Type.Literal("error"),
  ]),
  message: NonEmptyStringSchema,
});
export const StatusNoticeSchema = Type.Union([
  RetryNoticeSchema,
  CompactionNoticeSchema,
  RuntimeNoticeSchema,
]);
export type RetryNotice = Static<typeof RetryNoticeSchema>;
export type CompactionNotice = Static<typeof CompactionNoticeSchema>;
export type RuntimeNotice = Static<typeof RuntimeNoticeSchema>;
export type StatusNotice = Static<typeof StatusNoticeSchema>;
export const NoticePayloadSchema = strictObject({ notice: StatusNoticeSchema });
export type NoticePayload = Static<typeof NoticePayloadSchema>;

export type EventEnvelope<TType extends string, TPayload> = {
  type: TType;
  workspaceId: string;
  conversationId: string;
  revision: number;
  payload: TPayload;
};

const eventEnvelope = <TType extends string, TPayload extends TSchema>(
  type: TType,
  payload: TPayload,
) =>
  strictObject({
    type: Type.Literal(type),
    workspaceId: IdentifierSchema,
    conversationId: IdentifierSchema,
    revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    payload,
  });

export const MessageStartedEventSchema = eventEnvelope(
  "message.started",
  MessageStartedPayloadSchema,
);
export const MessageDeltaEventSchema = eventEnvelope(
  "message.delta",
  MessageDeltaPayloadSchema,
);
export const MessageCompletedEventSchema = eventEnvelope(
  "message.completed",
  MessageCompletedPayloadSchema,
);
export const ToolStartedEventSchema = eventEnvelope(
  "tool.started",
  ToolStartedPayloadSchema,
);
export const ToolUpdatedEventSchema = eventEnvelope(
  "tool.updated",
  ToolUpdatedPayloadSchema,
);
export const ToolCompletedEventSchema = eventEnvelope(
  "tool.completed",
  ToolCompletedPayloadSchema,
);
export const QueueEventSchema = eventEnvelope(
  "conversation.queue",
  QueueStateSchema,
);
export const StatusEventSchema = eventEnvelope(
  "conversation.status",
  StatusUpdatePayloadSchema,
);
export const NoticeEventSchema = eventEnvelope(
  "conversation.notice",
  NoticePayloadSchema,
);

export type MessageStartedEvent = Static<typeof MessageStartedEventSchema>;
export type MessageDeltaEvent = Static<typeof MessageDeltaEventSchema>;
export type MessageCompletedEvent = Static<typeof MessageCompletedEventSchema>;
export type ToolStartedEvent = Static<typeof ToolStartedEventSchema>;
export type ToolUpdatedEvent = Static<typeof ToolUpdatedEventSchema>;
export type ToolCompletedEvent = Static<typeof ToolCompletedEventSchema>;
export type QueueEvent = Static<typeof QueueEventSchema>;
export type StatusEvent = Static<typeof StatusEventSchema>;
export type NoticeEvent = Static<typeof NoticeEventSchema>;

export const ConversationEventSchema = Type.Union([
  MessageStartedEventSchema,
  MessageDeltaEventSchema,
  MessageCompletedEventSchema,
  ToolStartedEventSchema,
  ToolUpdatedEventSchema,
  ToolCompletedEventSchema,
  QueueEventSchema,
  StatusEventSchema,
  NoticeEventSchema,
]);
export type ConversationEvent = Static<typeof ConversationEventSchema>;

export const ServerMessageSchema = Type.Union([
  ReadyMessageSchema,
  ServerShutdownMessageSchema,
  AcknowledgementMessageSchema,
  ErrorMessageSchema,
  WorkspacesMessageSchema,
  HistoryMessageSchema,
  StateMessageSchema,
  ConversationEventSchema,
]);
export type ServerMessage = Static<typeof ServerMessageSchema>;
