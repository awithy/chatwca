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
  INVALID_WORKSPACE_MOUNT: "invalid_workspace_mount",
  DUPLICATE_WORKSPACE_PATH: "duplicate_workspace_path",
  WORKSPACE_UNAVAILABLE: "workspace_unavailable",
  WORKSPACE_BUSY: "workspace_busy",
  SANDBOX_DISABLED: "sandbox_disabled",
  SANDBOX_CONFIGURATION_ERROR: "sandbox_configuration_error",
  SANDBOX_UNAVAILABLE: "sandbox_unavailable",
  SANDBOX_WORKSPACE_REJECTED: "sandbox_workspace_rejected",
  SANDBOX_WORKER_START_FAILED: "sandbox_worker_start_failed",
  SANDBOX_WORKER_FAILED: "sandbox_worker_failed",
  SANDBOX_OPERATION_FAILED: "sandbox_operation_failed",
  MANAGED_EGRESS_DISABLED: "managed_egress_disabled",
  NETWORK_POLICY_INVALID: "network_policy_invalid",
  NETWORK_HELPER_UNAVAILABLE: "network_helper_unavailable",
  NETWORK_PROXY_START_FAILED: "network_proxy_start_failed",
  NETWORK_BRIDGE_START_FAILED: "network_bridge_start_failed",
  NETWORK_PROXY_FAILED: "network_proxy_failed",
  NETWORK_DESTINATION_BLOCKED: "network_destination_blocked",
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
  JOB_NOT_FOUND: "job_not_found",
  JOB_INVALID: "job_invalid",
  JOB_BUSY: "job_busy",
  JOB_DISABLED: "job_disabled",
  JOB_ALREADY_RUNNING: "job_already_running",
  JOB_SCRIPT_ROOTS_UNAVAILABLE: "job_script_roots_unavailable",
  JOB_SCRIPT_INVALID: "job_script_invalid",
  JOB_SCRIPT_UNAVAILABLE: "job_script_unavailable",
  JOB_PRE_RUN_FAILED: "job_pre_run_failed",
  JOB_POST_RUN_FAILED: "job_post_run_failed",
  JOB_HOOK_TIMEOUT: "job_hook_timeout",
  JOB_HOOK_OUTPUT_LIMIT: "job_hook_output_limit",
  JOB_PROMPT_FAILED: "job_prompt_failed",
  JOB_ABORTED: "job_aborted",
  JOB_INTERRUPTED: "job_interrupted",
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
  invalid_workspace_mount: "Each mount must name an existing accessible server directory and a unique /mounts destination.",
  duplicate_workspace_path: "That workspace path is already registered.",
  workspace_unavailable: "The workspace directory is unavailable.",
  workspace_busy: "Close the workspace's live conversations before changing its path, mounts, security profile, network policy, destination policy, or removing it.",
  sandbox_disabled: "Workspace sandboxing is disabled by the server.",
  sandbox_configuration_error: "The server sandbox configuration is invalid.",
  sandbox_unavailable: "Workspace sandboxing is unavailable.",
  sandbox_workspace_rejected: "The workspace does not satisfy the sandbox policy.",
  sandbox_worker_start_failed: "The workspace sandbox could not be started.",
  sandbox_worker_failed: "The workspace sandbox failed.",
  sandbox_operation_failed: "The sandboxed operation failed.",
  managed_egress_disabled: "Managed egress is disabled by the server.",
  network_policy_invalid: "The server managed-egress policy is invalid.",
  network_helper_unavailable: "The managed-egress network helper is unavailable.",
  network_proxy_start_failed: "The managed-egress proxy could not be started.",
  network_bridge_start_failed: "The managed-egress bridge could not be started.",
  network_proxy_failed: "The managed-egress proxy failed.",
  network_destination_blocked: "The network destination was blocked by policy.",
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
  job_not_found: "The scheduled job was not found.",
  job_invalid: "The scheduled job configuration is invalid.",
  job_busy: "The scheduled job cannot be changed while it is running.",
  job_disabled: "Enable the scheduled job before running it.",
  job_already_running: "The scheduled job already has an active run.",
  job_script_roots_unavailable: "Trusted job-script roots are not available.",
  job_script_invalid: "The job script path is invalid or outside the accepted roots.",
  job_script_unavailable: "A configured job script is no longer available.",
  job_pre_run_failed: "The pre-run script failed.",
  job_post_run_failed: "The post-run script failed.",
  job_hook_timeout: "The job script exceeded its time limit.",
  job_hook_output_limit: "The job script exceeded its output limit.",
  job_prompt_failed: "The scheduled prompt failed.",
  job_aborted: "The job run was aborted.",
  job_interrupted: "The job run was interrupted by server shutdown or restart.",
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
      readonly source: "job";
      readonly issue:
        | "missing"
        | "invalid"
        | "busy"
        | "disabled"
        | "already-running"
        | "script-roots"
        | "script-invalid"
        | "script-unavailable"
        | "pre-run"
        | "post-run"
        | "hook-timeout"
        | "hook-output"
        | "prompt"
        | "aborted"
        | "interrupted";
    }
  | {
      readonly source: "sandbox";
      readonly phase:
        | "configuration"
        | "startup"
        | "workspace-admission"
        | "worker-startup"
        | "fatal-worker"
        | "operation";
    }
  | {
      readonly source: "network";
      readonly phase:
        | "configuration"
        | "helper"
        | "bridge"
        | "proxy-startup"
        | "active-proxy"
        | "destination-denial";
    }
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
    case "job":
      switch (context.issue) {
        case "missing":
          return ERROR_CODES.JOB_NOT_FOUND;
        case "invalid":
          return ERROR_CODES.JOB_INVALID;
        case "busy":
          return ERROR_CODES.JOB_BUSY;
        case "disabled":
          return ERROR_CODES.JOB_DISABLED;
        case "already-running":
          return ERROR_CODES.JOB_ALREADY_RUNNING;
        case "script-roots":
          return ERROR_CODES.JOB_SCRIPT_ROOTS_UNAVAILABLE;
        case "script-invalid":
          return ERROR_CODES.JOB_SCRIPT_INVALID;
        case "script-unavailable":
          return ERROR_CODES.JOB_SCRIPT_UNAVAILABLE;
        case "pre-run":
          return ERROR_CODES.JOB_PRE_RUN_FAILED;
        case "post-run":
          return ERROR_CODES.JOB_POST_RUN_FAILED;
        case "hook-timeout":
          return ERROR_CODES.JOB_HOOK_TIMEOUT;
        case "hook-output":
          return ERROR_CODES.JOB_HOOK_OUTPUT_LIMIT;
        case "prompt":
          return ERROR_CODES.JOB_PROMPT_FAILED;
        case "aborted":
          return ERROR_CODES.JOB_ABORTED;
        case "interrupted":
          return ERROR_CODES.JOB_INTERRUPTED;
      }
    case "sandbox":
      switch (context.phase) {
        case "configuration":
          return ERROR_CODES.SANDBOX_CONFIGURATION_ERROR;
        case "startup":
          return ERROR_CODES.SANDBOX_UNAVAILABLE;
        case "workspace-admission":
          return ERROR_CODES.SANDBOX_WORKSPACE_REJECTED;
        case "worker-startup":
          return ERROR_CODES.SANDBOX_WORKER_START_FAILED;
        case "fatal-worker":
          return ERROR_CODES.SANDBOX_WORKER_FAILED;
        case "operation":
          return ERROR_CODES.SANDBOX_OPERATION_FAILED;
      }
    case "network":
      switch (context.phase) {
        case "configuration":
          return ERROR_CODES.NETWORK_POLICY_INVALID;
        case "helper":
          return ERROR_CODES.NETWORK_HELPER_UNAVAILABLE;
        case "bridge":
          return ERROR_CODES.NETWORK_BRIDGE_START_FAILED;
        case "proxy-startup":
          return ERROR_CODES.NETWORK_PROXY_START_FAILED;
        case "active-proxy":
          return ERROR_CODES.NETWORK_PROXY_FAILED;
        case "destination-denial":
          return ERROR_CODES.NETWORK_DESTINATION_BLOCKED;
      }
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

/** A log-safe diagnostic that never includes causes, paths, output, or stacks. */
export function redactedErrorDiagnostic(
  error: unknown,
  context: ErrorContext = { source: "internal" },
): string {
  const appError = toAppError(error, context);
  return `code=${appError.code} message=${JSON.stringify(appError.message)}`;
}
