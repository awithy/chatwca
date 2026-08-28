import { type Static, Type } from "@sinclair/typebox";

/** Stable, public error codes used by command responses and message failures. */
export const ERROR_CODES = {
  INVALID_COMMAND: "invalid_command",
  MESSAGE_TOO_LARGE: "message_too_large",
  INVALID_PROMPT: "invalid_prompt",
  INVALID_CWD: "invalid_cwd",
  CWD_NOT_FOUND: "cwd_not_found",
  CWD_NOT_ACCESSIBLE: "cwd_not_accessible",
  WORKSPACE_NOT_FOUND: "workspace_not_found",
  INVALID_WORKSPACE_NAME: "invalid_workspace_name",
  INVALID_WORKSPACE_PATH: "invalid_workspace_path",
  DUPLICATE_WORKSPACE_PATH: "duplicate_workspace_path",
  WORKSPACE_UNAVAILABLE: "workspace_unavailable",
  WORKSPACE_BUSY: "workspace_busy",
  DATABASE_ERROR: "database_error",
  MODEL_UNAVAILABLE: "model_unavailable",
  MODEL_FAILED: "model_failed",
  IMAGE_NOT_SUPPORTED: "image_not_supported",
  INVALID_IMAGE: "invalid_image",
  IMAGE_TOO_LARGE: "image_too_large",
  TOO_MANY_IMAGES: "too_many_images",
  TOTAL_IMAGE_BYTES_EXCEEDED: "total_image_bytes_exceeded",
  CONVERSATION_NOT_FOUND: "conversation_not_found",
  INVALID_CONVERSATION_TITLE: "invalid_conversation_title",
  CONVERSATION_BUSY: "conversation_busy",
  INVALID_FORK_TARGET: "invalid_fork_target",
  FORK_SOURCE_BUSY: "fork_source_busy",
  LIVE_RUNTIME_LIMIT: "live_runtime_limit",
  REVISION_GAP: "revision_gap",
  SESSION_FILE_MISSING: "session_file_missing",
  SESSION_UNAVAILABLE: "session_unavailable",
  SESSION_NOT_LISTED: "session_not_listed",
  LIVE_SESSION_DELETE: "live_session_delete",
  PI_RUNTIME_CREATE_FAILED: "pi_runtime_create_failed",
  PI_RUNTIME_REPLACE_FAILED: "pi_runtime_replace_failed",
  SHUTTING_DOWN: "shutting_down",
  INTERNAL_ERROR: "internal_error",
} as const;

export const ErrorCodeSchema = Type.Union(
  Object.values(ERROR_CODES).map((code) => Type.Literal(code)),
);
export type ErrorCode = Static<typeof ErrorCodeSchema>;

const DEFAULT_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  invalid_command: "The command is invalid.",
  message_too_large: "The command payload is too large.",
  invalid_prompt: "Enter a prompt or attach an image.",
  invalid_cwd: "The working directory is invalid.",
  cwd_not_found: "The working directory does not exist.",
  cwd_not_accessible: "The working directory is not accessible.",
  workspace_not_found: "The workspace was not found.",
  invalid_workspace_name: "Enter a workspace name.",
  invalid_workspace_path: "The workspace path must be an existing accessible directory.",
  duplicate_workspace_path: "That workspace path is already registered.",
  workspace_unavailable: "The workspace directory is unavailable.",
  workspace_busy: "Close the workspace's live conversations before changing its path or removing it.",
  database_error: "The workspace database operation failed.",
  model_unavailable: "No model is configured or available.",
  model_failed: "The model failed while processing the prompt.",
  image_not_supported: "The selected model does not support images.",
  invalid_image: "An image payload is malformed or unsupported.",
  image_too_large: "An image exceeds the allowed size.",
  too_many_images: "The prompt contains too many images.",
  total_image_bytes_exceeded: "The images exceed the total allowed size.",
  conversation_not_found: "The conversation was not found.",
  invalid_conversation_title: "Enter a conversation title between 1 and 200 characters.",
  conversation_busy: "The conversation is busy.",
  invalid_fork_target: "The fork target is not a user message on the active branch.",
  fork_source_busy: "A conversation cannot be forked while it is running.",
  live_runtime_limit: "The live conversation limit has been reached and no idle conversation can be closed.",
  revision_gap: "Conversation updates were missed; reload the conversation state.",
  session_file_missing: "The session file no longer exists.",
  session_unavailable: "The session file is not accessible.",
  session_not_listed: "The session is not present in Pi session history.",
  live_session_delete: "Close the live conversation before deleting it.",
  pi_runtime_create_failed: "The conversation runtime could not be created.",
  pi_runtime_replace_failed: "The conversation runtime could not be replaced.",
  shutting_down: "The server is shutting down.",
  internal_error: "An internal server error occurred.",
};

export interface AppErrorOptions {
  /**
   * A client-safe message. Never pass an SDK/filesystem error message here;
   * those often contain local paths, credentials, or provider details.
   */
  readonly publicMessage?: string;
  /** Retained server-side for logging and diagnostics; never serialized. */
  readonly cause?: unknown;
}

/** An expected application failure with a stable public representation. */
export class AppError extends Error {
  override readonly name = "AppError";
  readonly code: ErrorCode;

  constructor(code: ErrorCode, options: AppErrorOptions = {}) {
    super(options.publicMessage ?? DEFAULT_MESSAGES[code], {
      cause: options.cause,
    });
    this.code = code;
  }
}

export type ErrorContext =
  | {
      readonly source: "validation";
      readonly issue?: "command" | "message-size" | "prompt" | "revision";
    }
  | { readonly source: "filesystem"; readonly target: "cwd" | "session" }
  | {
      readonly source: "workspace";
      readonly issue:
        | "missing"
        | "name"
        | "path"
        | "duplicate"
        | "unavailable"
        | "busy";
    }
  | { readonly source: "database" }
  | {
      readonly source: "registry";
      readonly issue:
        | "missing"
        | "title"
        | "busy"
        | "fork-target"
        | "fork-busy"
        | "capacity"
        | "delete-live"
        | "not-listed"
        | "unknown";
    }
  | {
      readonly source: "image";
      readonly issue?:
        | "malformed"
        | "unsupported"
        | "too-large"
        | "too-many"
        | "aggregate";
    }
  | {
      readonly source: "pi";
      readonly operation: "create" | "replace" | "model";
    }
  | { readonly source: "internal" };

function filesystemCode(
  error: unknown,
  target: "cwd" | "session",
): ErrorCode {
  const errno =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;

  if (target === "session") {
    return errno === "ENOENT"
      ? ERROR_CODES.SESSION_FILE_MISSING
      : ERROR_CODES.SESSION_UNAVAILABLE;
  }

  if (errno === "ENOENT") {
    return ERROR_CODES.CWD_NOT_FOUND;
  }
  if (errno === "EACCES" || errno === "EPERM") {
    return ERROR_CODES.CWD_NOT_ACCESSIBLE;
  }
  return ERROR_CODES.INVALID_CWD;
}

function contextCode(error: unknown, context: ErrorContext): ErrorCode {
  switch (context.source) {
    case "validation":
      switch (context.issue) {
        case "message-size":
          return ERROR_CODES.MESSAGE_TOO_LARGE;
        case "prompt":
          return ERROR_CODES.INVALID_PROMPT;
        case "revision":
          return ERROR_CODES.REVISION_GAP;
        case "command":
        default:
          return ERROR_CODES.INVALID_COMMAND;
      }
    case "filesystem":
      return filesystemCode(error, context.target);
    case "workspace":
      switch (context.issue) {
        case "missing":
          return ERROR_CODES.WORKSPACE_NOT_FOUND;
        case "name":
          return ERROR_CODES.INVALID_WORKSPACE_NAME;
        case "path":
          return ERROR_CODES.INVALID_WORKSPACE_PATH;
        case "duplicate":
          return ERROR_CODES.DUPLICATE_WORKSPACE_PATH;
        case "unavailable":
          return ERROR_CODES.WORKSPACE_UNAVAILABLE;
        case "busy":
          return ERROR_CODES.WORKSPACE_BUSY;
      }
    case "database":
      return ERROR_CODES.DATABASE_ERROR;
    case "registry":
      switch (context.issue) {
        case "missing":
          return ERROR_CODES.CONVERSATION_NOT_FOUND;
        case "title":
          return ERROR_CODES.INVALID_CONVERSATION_TITLE;
        case "busy":
          return ERROR_CODES.CONVERSATION_BUSY;
        case "fork-target":
          return ERROR_CODES.INVALID_FORK_TARGET;
        case "fork-busy":
          return ERROR_CODES.FORK_SOURCE_BUSY;
        case "capacity":
          return ERROR_CODES.LIVE_RUNTIME_LIMIT;
        case "delete-live":
          return ERROR_CODES.LIVE_SESSION_DELETE;
        case "not-listed":
          return ERROR_CODES.SESSION_NOT_LISTED;
        case "unknown":
          return ERROR_CODES.INTERNAL_ERROR;
      }
    case "image":
      switch (context.issue) {
        case "unsupported":
          return ERROR_CODES.IMAGE_NOT_SUPPORTED;
        case "too-large":
          return ERROR_CODES.IMAGE_TOO_LARGE;
        case "too-many":
          return ERROR_CODES.TOO_MANY_IMAGES;
        case "aggregate":
          return ERROR_CODES.TOTAL_IMAGE_BYTES_EXCEEDED;
        case "malformed":
        default:
          return ERROR_CODES.INVALID_IMAGE;
      }
    case "pi":
      switch (context.operation) {
        case "create":
          return ERROR_CODES.PI_RUNTIME_CREATE_FAILED;
        case "replace":
          return ERROR_CODES.PI_RUNTIME_REPLACE_FAILED;
        case "model":
          return ERROR_CODES.MODEL_UNAVAILABLE;
      }
    case "internal":
      return ERROR_CODES.INTERNAL_ERROR;
  }
}

/**
 * Convert an unknown boundary error without exposing its message, stack, path,
 * or SDK metadata. Expected AppErrors pass through unchanged.
 */
export function toAppError(
  error: unknown,
  context: ErrorContext = { source: "internal" },
): AppError {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError(contextCode(error, context), { cause: error });
}

export interface ErrorResponse {
  readonly type: "error";
  readonly requestId?: string;
  readonly code: ErrorCode;
  readonly message: string;
}

/** Build the only public wire representation of an error. */
export function toErrorResponse(
  error: unknown,
  context: ErrorContext = { source: "internal" },
  requestId?: string,
): ErrorResponse {
  const appError = toAppError(error, context);
  return requestId === undefined
    ? { type: "error", code: appError.code, message: appError.message }
    : {
        type: "error",
        requestId,
        code: appError.code,
        message: appError.message,
      };
}
