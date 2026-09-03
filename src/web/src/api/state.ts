import type {
  ConversationEvent,
  ConversationState,
  ConversationSummary,
  JobRunState,
  JobRunSummary,
  JobSummary,
  NetworkBlockedEvent,
  NormalizedMessage,
  StatusNotice,
  ToolCallBlock,
  ToolResultBlock,
  WorkspaceSummary,
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

export interface WorkspaceClientErrorState extends ClientErrorState {
  readonly workspaceId: string;
}

export const MAX_NETWORK_BLOCKED_NOTICES = 50;

export interface ConversationProjection {
  readonly conversation: ConversationState;
  readonly notices: readonly StatusNotice[];
  /** Revisioned, browser-safe denials retained across authoritative reconnect snapshots. */
  readonly networkBlocked: readonly NetworkBlockedEvent[];
}

export interface JobRunPageState {
  readonly runIds: readonly string[];
  readonly nextCursor: string | null;
  readonly loading: boolean;
}

export interface ChatClientState {
  readonly connection: ConnectionStatus;
  readonly serverVersion: string | null;
  /** The latest authoritative SQLite-backed workspace list. */
  readonly workspaces: readonly WorkspaceSummary[];
  /** Latest authoritative SQLite-backed scheduled-job definitions. */
  readonly jobs: readonly JobSummary[];
  /** Latest full summary observed for each run, independent of pagination. */
  readonly jobRuns: Readonly<Record<string, JobRunSummary>>;
  /** Diagnostics are populated only by correlated explicit state responses. */
  readonly jobRunDetails: Readonly<Record<string, JobRunState>>;
  readonly jobRunPages: Readonly<Record<string, JobRunPageState>>;
  readonly resyncJobRunIds: readonly string[];
  /** Browser-local, in-memory selections. */
  readonly selectedJobId: string | null;
  readonly selectedJobRunId: string | null;
  readonly selectedWorkspaceId: string | null;
  /** Identifies the workspace which produced the current history projection. */
  readonly historyWorkspaceId: string | null;
  readonly history: readonly ConversationSummary[];
  readonly pendingHistoryWorkspaceId: string | null;
  readonly historyError: WorkspaceClientErrorState | null;
  /** Live projections are retained for selected and background workspaces. */
  readonly conversations: Readonly<Record<string, ConversationProjection>>;
  readonly selectedConversationId: string | null;
  readonly drafts: Readonly<Record<string, string>>;
  readonly resyncConversationIds: readonly string[];
  readonly lastError: ClientErrorState | null;
}

export type ChatClientAction =
  | { readonly type: "connection"; readonly status: ConnectionStatus }
  | { readonly type: "ready"; readonly serverVersion: string }
  | { readonly type: "workspaces"; readonly workspaces: readonly WorkspaceSummary[] }
  | { readonly type: "jobs"; readonly jobs: readonly JobSummary[] }
  | {
      readonly type: "job.runs";
      readonly jobId?: string;
      readonly runs: readonly JobRunSummary[];
      readonly nextCursor?: string;
      readonly append?: boolean;
    }
  | { readonly type: "job.runs.pending"; readonly jobId: string }
  | { readonly type: "job.runs.failed"; readonly jobId: string }
  | { readonly type: "job.select"; readonly jobId: string | null }
  | { readonly type: "job.run.select"; readonly runId: string | null }
  | { readonly type: "job.run.state"; readonly run: JobRunState }
  | { readonly type: "job.run.updated"; readonly run: JobRunSummary }
  | { readonly type: "workspace.select"; readonly workspaceId: string | null }
  | { readonly type: "history.pending"; readonly workspaceId: string }
  | { readonly type: "history.failed"; readonly error: WorkspaceClientErrorState }
  | {
      readonly type: "history";
      readonly workspaceId: string;
      readonly conversations: readonly ConversationSummary[];
    }
  | { readonly type: "snapshot"; readonly conversation: ConversationState }
  | { readonly type: "event"; readonly event: ConversationEvent }
  | { readonly type: "select"; readonly conversationId: string | null }
  | { readonly type: "conversation.closed"; readonly conversationId: string }
  | { readonly type: "conversation.deleted"; readonly conversationId: string }
  | { readonly type: "draft"; readonly conversationId: string; readonly text: string }
  | { readonly type: "draft.delete"; readonly conversationId: string }
  | { readonly type: "error"; readonly error: ClientErrorState | null };

export function createInitialChatClientState(): ChatClientState {
  return {
    connection: "disconnected",
    serverVersion: null,
    workspaces: [],
    jobs: [],
    jobRuns: {},
    jobRunDetails: {},
    jobRunPages: {},
    resyncJobRunIds: [],
    selectedJobId: null,
    selectedJobRunId: null,
    selectedWorkspaceId: null,
    historyWorkspaceId: null,
    history: [],
    pendingHistoryWorkspaceId: null,
    historyError: null,
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

function sameBlockedDestination(
  left: NetworkBlockedEvent,
  right: NetworkBlockedEvent,
): boolean {
  return left.payload.host === right.payload.host &&
    left.payload.port === right.payload.port &&
    left.payload.protocol === right.payload.protocol &&
    left.payload.reason === right.payload.reason;
}

function collectNetworkBlocked(
  current: readonly NetworkBlockedEvent[],
  event: NetworkBlockedEvent,
): readonly NetworkBlockedEvent[] {
  // The server first emits a denial and may later emit its coalesced count.
  // Replace that latest matching projection rather than showing both notices.
  if (event.payload.occurrenceCount !== undefined) {
    const index = current.findLastIndex((candidate) => sameBlockedDestination(candidate, event));
    if (index >= 0) {
      const next = [...current];
      next[index] = event;
      return next.slice(-MAX_NETWORK_BLOCKED_NOTICES);
    }
  }
  return [...current, event].slice(-MAX_NETWORK_BLOCKED_NOTICES);
}

function applyConversationEvent(
  conversation: ConversationState,
  event: ConversationEvent,
): ConversationState {
  let messages = [...conversation.messages];
  let queue = conversation.queue;
  let status = conversation.status;
  let title = conversation.title;
  let durable = conversation.durable;
  let contextUsage = conversation.contextUsage;

  switch (event.type) {
    case "message.started":
      messages = replaceMessage(messages, event.payload.message, false);
      break;
    case "message.completed":
      messages = replaceMessage(messages, event.payload.message, true);
      contextUsage = event.payload.contextUsage;
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
    case "conversation.metadata":
      title = event.payload.title;
      durable = event.payload.durable;
      status = event.payload.status;
      break;
    case "conversation.notice":
      if (
        event.payload.notice.kind === "compaction" &&
        event.payload.notice.phase === "completed" &&
        contextUsage !== null
      ) {
        contextUsage = {
          tokens: null,
          contextWindow: contextUsage.contextWindow,
          percent: null,
        };
      }
      break;
  }

  return {
    ...conversation,
    messages,
    queue,
    status,
    title,
    durable,
    contextUsage,
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
    case "jobs": {
      const retainedJobIds = new Set(action.jobs.map((job) => job.id));
      const jobRuns = Object.fromEntries(
        Object.entries(state.jobRuns).filter(([, run]) => retainedJobIds.has(run.jobId)),
      );
      const jobRunDetails = Object.fromEntries(
        Object.entries(state.jobRunDetails).filter(([, run]) => retainedJobIds.has(run.jobId)),
      );
      const selectedJobId = state.selectedJobId !== null && retainedJobIds.has(state.selectedJobId)
        ? state.selectedJobId
        : null;
      return {
        ...state,
        jobs: [...action.jobs],
        jobRuns,
        jobRunDetails,
        jobRunPages: Object.fromEntries(
          Object.entries(state.jobRunPages).filter(([jobId]) => retainedJobIds.has(jobId)),
        ),
        selectedJobId,
        selectedJobRunId: selectedJobId === null ? null : state.selectedJobRunId,
        resyncJobRunIds: state.resyncJobRunIds.filter((key) => {
          const separator = key.indexOf("\0");
          return separator >= 0 && retainedJobIds.has(key.slice(0, separator));
        }),
      };
    }
    case "job.runs": {
      const jobRuns = { ...state.jobRuns };
      for (const run of action.runs) {
        const current = jobRuns[run.id];
        if (current === undefined || run.revision >= current.revision) jobRuns[run.id] = run;
      }
      const jobId = action.jobId ?? action.runs[0]?.jobId;
      if (jobId === undefined) return { ...state, jobRuns };
      const prior = state.jobRunPages[jobId];
      const runIds = action.append
        ? [...new Set([...(prior?.runIds ?? []), ...action.runs.map((run) => run.id)])]
        : action.runs.map((run) => run.id);
      return {
        ...state,
        jobRuns,
        jobRunPages: {
          ...state.jobRunPages,
          [jobId]: {
            runIds,
            nextCursor: action.nextCursor ?? null,
            loading: false,
          },
        },
      };
    }
    case "job.runs.pending": {
      const current = state.jobRunPages[action.jobId];
      return {
        ...state,
        jobRunPages: {
          ...state.jobRunPages,
          [action.jobId]: {
            runIds: current?.runIds ?? [],
            nextCursor: current?.nextCursor ?? null,
            loading: true,
          },
        },
      };
    }
    case "job.runs.failed": {
      const current = state.jobRunPages[action.jobId];
      if (current === undefined || !current.loading) return state;
      return {
        ...state,
        jobRunPages: {
          ...state.jobRunPages,
          [action.jobId]: { ...current, loading: false },
        },
      };
    }
    case "job.select":
      return {
        ...state,
        selectedJobId: action.jobId,
        selectedJobRunId: action.jobId === state.selectedJobId ? state.selectedJobRunId : null,
      };
    case "job.run.select":
      return { ...state, selectedJobRunId: action.runId };
    case "job.run.state": {
      const key = `${action.run.jobId}\0${action.run.id}`;
      const current = state.jobRuns[action.run.id];
      if (current !== undefined && action.run.revision < current.revision) return state;
      return {
        ...state,
        jobRuns: { ...state.jobRuns, [action.run.id]: action.run },
        jobRunDetails: { ...state.jobRunDetails, [action.run.id]: action.run },
        resyncJobRunIds: state.resyncJobRunIds.filter((candidate) => candidate !== key),
      };
    }
    case "job.run.updated": {
      const current = state.jobRuns[action.run.id];
      if (current !== undefined && action.run.revision <= current.revision) return state;
      if (current !== undefined && action.run.revision !== current.revision + 1) {
        const key = `${action.run.jobId}\0${action.run.id}`;
        if (state.resyncJobRunIds.includes(key)) return state;
        return { ...state, resyncJobRunIds: [...state.resyncJobRunIds, key] };
      }
      const detail = state.jobRunDetails[action.run.id];
      return {
        ...state,
        jobRuns: { ...state.jobRuns, [action.run.id]: action.run },
        ...(detail === undefined
          ? {}
          : { jobRunDetails: { ...state.jobRunDetails, [action.run.id]: { ...detail, ...action.run } } }),
      };
    }
    case "workspaces": {
      const selectedStillExists = state.selectedWorkspaceId === null ||
        action.workspaces.some((workspace) => workspace.id === state.selectedWorkspaceId);
      if (!selectedStillExists) {
        return {
          ...state,
          workspaces: [...action.workspaces],
          selectedWorkspaceId: null,
          selectedConversationId: null,
          historyWorkspaceId: null,
          history: [],
          pendingHistoryWorkspaceId: null,
          historyError: null,
          lastError: state.lastError === state.historyError ? null : state.lastError,
        };
      }
      return { ...state, workspaces: [...action.workspaces] };
    }
    case "workspace.select":
      if (action.workspaceId === state.selectedWorkspaceId) return state;
      return {
        ...state,
        selectedWorkspaceId: action.workspaceId,
        selectedConversationId: null,
        historyWorkspaceId: null,
        history: [],
        pendingHistoryWorkspaceId: null,
        historyError: null,
        lastError: null,
      };
    case "history.pending":
      if (action.workspaceId !== state.selectedWorkspaceId) return state;
      return {
        ...state,
        pendingHistoryWorkspaceId: action.workspaceId,
        historyError: null,
        lastError: state.lastError === state.historyError ? null : state.lastError,
      };
    case "history.failed":
      if (action.error.workspaceId !== state.selectedWorkspaceId) return state;
      return {
        ...state,
        pendingHistoryWorkspaceId: null,
        historyError: action.error,
        lastError: action.error,
      };
    case "history": {
      if (
        action.workspaceId !== state.selectedWorkspaceId ||
        action.conversations.some((item) => item.workspaceId !== action.workspaceId)
      ) {
        return state;
      }

      const closed = new Set(
        action.conversations
          .filter((item) => item.status === "closed")
          .map((item) => item.id),
      );
      // History is authoritative for the selected workspace's persisted
      // lifecycle, but it says nothing about other workspaces or a new live
      // session which is not durable yet. Only listed closed snapshots are
      // discarded here; explicit delete acknowledgements handle deletions.
      const summaries = new Map(
        action.conversations.map((summary) => [summary.id, summary]),
      );
      const conversations = Object.fromEntries(
        Object.entries(state.conversations)
          .filter(([id, projection]) =>
            projection.conversation.workspaceId !== action.workspaceId || !closed.has(id)
          )
          .map(([id, projection]) => {
            const summary = summaries.get(id);
            return summary === undefined
              ? [id, projection]
              : [id, {
                  ...projection,
                  conversation: {
                    ...projection.conversation,
                    title: summary.title,
                  },
                }];
          }),
      );
      return {
        ...state,
        historyWorkspaceId: action.workspaceId,
        history: [...action.conversations],
        pendingHistoryWorkspaceId: null,
        historyError: null,
        lastError: state.lastError === state.historyError ? null : state.lastError,
        conversations,
        resyncConversationIds: state.resyncConversationIds.filter(
          (id) => !closed.has(id),
        ),
      };
    }
    case "snapshot": {
      const current = state.conversations[action.conversation.id];
      if (
        current?.conversation.workspaceId === action.conversation.workspaceId &&
        decideSnapshotRevision(
          current.conversation.revision,
          action.conversation.revision,
        ) === "ignore"
      ) {
        return state;
      }
      const sameWorkspace = current?.conversation.workspaceId === action.conversation.workspaceId;
      return replaceConversation(state, {
        conversation: action.conversation,
        notices: sameWorkspace ? current.notices : [],
        networkBlocked: sameWorkspace ? current.networkBlocked : [],
      });
    }
    case "event": {
      const current = state.conversations[action.event.conversationId];
      if (
        current === undefined ||
        current.conversation.workspaceId !== action.event.workspaceId
      ) {
        return requestResync(state, action.event.conversationId);
      }
      const decision = decideEventRevision(
        current.conversation.revision,
        action.event.revision,
      );
      if (decision === "ignore") return state;
      if (decision === "resync") return requestResync(state, action.event.conversationId);

      const notices = action.event.type === "conversation.notice"
        ? [...current.notices, action.event.payload.notice].slice(-100)
        : current.notices;
      const networkBlocked = action.event.type === "network.blocked"
        ? collectNetworkBlocked(current.networkBlocked, action.event)
        : current.networkBlocked;
      return replaceConversation(state, {
        conversation: applyConversationEvent(current.conversation, action.event),
        notices,
        networkBlocked,
      });
    }
    case "select":
      return { ...state, selectedConversationId: action.conversationId };
    case "conversation.closed": {
      if (state.conversations[action.conversationId] === undefined) return state;
      const { [action.conversationId]: _closed, ...conversations } = state.conversations;
      return {
        ...state,
        conversations,
        resyncConversationIds: state.resyncConversationIds.filter(
          (id) => id !== action.conversationId,
        ),
      };
    }
    case "conversation.deleted": {
      const { [action.conversationId]: _deleted, ...conversations } = state.conversations;
      const { [action.conversationId]: _draft, ...drafts } = state.drafts;
      return {
        ...state,
        conversations,
        drafts,
        history: state.history.filter((item) => item.id !== action.conversationId),
        selectedConversationId: state.selectedConversationId === action.conversationId
          ? null
          : state.selectedConversationId,
        resyncConversationIds: state.resyncConversationIds.filter(
          (id) => id !== action.conversationId,
        ),
      };
    }
    case "draft":
      return {
        ...state,
        drafts: { ...state.drafts, [action.conversationId]: action.text },
      };
    case "draft.delete": {
      if (!(action.conversationId in state.drafts)) return state;
      const { [action.conversationId]: _draft, ...drafts } = state.drafts;
      return { ...state, drafts };
    }
    case "error":
      return { ...state, lastError: action.error };
  }
}
