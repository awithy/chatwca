import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  AppError,
  ERROR_CODES,
  ErrorCodeSchema,
  redactedErrorDiagnostic,
  toAppError,
  toErrorResponse,
} from "../../src/shared/errors.js";

function filesystemError(code: string, sensitivePath: string): NodeJS.ErrnoException {
  const error = new Error(`failure at ${sensitivePath}`) as NodeJS.ErrnoException;
  error.code = code;
  error.path = sensitivePath;
  return error;
}

describe("stable error codes", () => {
  it("defines schema-valid, unique codes", () => {
    const codes = Object.values(ERROR_CODES);

    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) {
      expect(Value.Check(ErrorCodeSchema, code)).toBe(true);
    }
    expect(Value.Check(ErrorCodeSchema, "sdk_exploded")).toBe(false);
  });

  it("preserves expected application errors", () => {
    const expected = new AppError(ERROR_CODES.CONVERSATION_BUSY);
    expect(toAppError(expected, { source: "internal" })).toBe(expected);
  });
});

describe("safe error conversion", () => {
  it.each([
    ["ENOENT", "cwd_not_found"],
    ["EACCES", "cwd_not_accessible"],
    ["EPERM", "cwd_not_accessible"],
    ["ENOTDIR", "invalid_cwd"],
  ])("maps CWD filesystem error %s to %s", (errno, code) => {
    const error = filesystemError(errno, "/secret/operator/workspace");
    const converted = toAppError(error, {
      source: "filesystem",
      target: "cwd",
    });

    expect(converted.code).toBe(code);
    expect(converted.cause).toBe(error);
    expect(converted.message).not.toContain("/secret");
  });

  it("distinguishes a removed session from another session I/O failure", () => {
    expect(
      toAppError(filesystemError("ENOENT", "/secret/session.jsonl"), {
        source: "filesystem",
        target: "session",
      }).code,
    ).toBe(ERROR_CODES.SESSION_FILE_MISSING);
    expect(
      toAppError(filesystemError("EACCES", "/secret/session.jsonl"), {
        source: "filesystem",
        target: "session",
      }).code,
    ).toBe(ERROR_CODES.SESSION_UNAVAILABLE);
  });

  it.each([
    [{ source: "validation", issue: "command" } as const, "invalid_command"],
    [{ source: "validation", issue: "revision" } as const, "revision_gap"],
    [{ source: "workspace", issue: "missing" } as const, "workspace_not_found"],
    [{ source: "workspace", issue: "name" } as const, "invalid_workspace_name"],
    [{ source: "workspace", issue: "path" } as const, "invalid_workspace_path"],
    [{ source: "workspace", issue: "duplicate" } as const, "duplicate_workspace_path"],
    [{ source: "workspace", issue: "unavailable" } as const, "workspace_unavailable"],
    [{ source: "workspace", issue: "busy" } as const, "workspace_busy"],
    [{ source: "database" } as const, "database_error"],
    [{ source: "sandbox", phase: "configuration" } as const, "sandbox_configuration_error"],
    [{ source: "sandbox", phase: "startup" } as const, "sandbox_unavailable"],
    [{ source: "sandbox", phase: "workspace-admission" } as const, "sandbox_workspace_rejected"],
    [{ source: "sandbox", phase: "worker-startup" } as const, "sandbox_worker_start_failed"],
    [{ source: "sandbox", phase: "fatal-worker" } as const, "sandbox_worker_failed"],
    [{ source: "sandbox", phase: "operation" } as const, "sandbox_operation_failed"],
    [{ source: "network", phase: "configuration" } as const, "network_policy_invalid"],
    [{ source: "network", phase: "helper" } as const, "network_helper_unavailable"],
    [{ source: "network", phase: "bridge" } as const, "network_bridge_start_failed"],
    [{ source: "network", phase: "proxy-startup" } as const, "network_proxy_start_failed"],
    [{ source: "network", phase: "active-proxy" } as const, "network_proxy_failed"],
    [{ source: "network", phase: "destination-denial" } as const, "network_destination_blocked"],
    [{ source: "registry", issue: "capacity" } as const, "live_runtime_limit"],
    [{ source: "registry", issue: "fork-target" } as const, "invalid_fork_target"],
    [{ source: "image", issue: "malformed" } as const, "invalid_image"],
    [{ source: "image", issue: "aggregate" } as const, "total_image_bytes_exceeded"],
    [{ source: "pi", operation: "create" } as const, "pi_runtime_create_failed"],
    [{ source: "pi", operation: "replace" } as const, "pi_runtime_replace_failed"],
  ])("maps a boundary context to $1", (context, code) => {
    const converted = toAppError(new Error("private SDK details"), context);
    expect(converted.code).toBe(code);
    expect(converted.message).not.toContain("private SDK details");
  });

  it("does not expose filesystem or SQLite details in workspace errors", () => {
    const pathFailure = toErrorResponse(
      filesystemError("ENOENT", "/secret/operator/workspace"),
      { source: "workspace", issue: "path" },
      "request-1",
    );
    const databaseFailure = toErrorResponse(
      new Error("SQLITE_BUSY at /secret/data/chatwca.sqlite"),
      { source: "database" },
      "request-2",
    );

    expect(pathFailure).toMatchObject({
      code: ERROR_CODES.INVALID_WORKSPACE_PATH,
      message: "The workspace path must be an existing accessible directory.",
    });
    expect(databaseFailure).toMatchObject({
      code: ERROR_CODES.DATABASE_ERROR,
      message: "The workspace database operation failed.",
    });
    expect(JSON.stringify([pathFailure, databaseFailure])).not.toContain(
      "/secret",
    );
  });

  it("defaults unknown failures to generic redacted wire and log diagnostics", () => {
    const error = new Error("token=secret at /home/operator/session.jsonl");
    error.stack = "private stack";
    const response = toErrorResponse(error);
    const diagnostic = redactedErrorDiagnostic(error);

    expect(response).toEqual({
      type: "error",
      code: ERROR_CODES.INTERNAL_ERROR,
      message: "An internal server error occurred.",
    });
    expect(diagnostic).toBe('code=internal_error message="An internal server error occurred."');
    expect(JSON.stringify({ response, diagnostic })).not.toContain("secret");
    expect(JSON.stringify({ response, diagnostic })).not.toContain("/home/operator");
  });

  it("includes a request ID without serializing the retained cause", () => {
    const response = toErrorResponse(
      new Error("provider key and stack"),
      { source: "pi", operation: "create" },
      "request-1",
    );

    expect(response).toEqual({
      type: "error",
      requestId: "request-1",
      code: ERROR_CODES.PI_RUNTIME_CREATE_FAILED,
      message: "The conversation runtime could not be created.",
    });
    expect(JSON.stringify(response)).not.toContain("provider key");
  });
});
