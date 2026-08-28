import * as React from "react";

import type {
  ToolCallBlock,
  ToolResultBlock,
} from "../../../shared/protocol.js";

export interface ToolCallCardProps {
  readonly call: ToolCallBlock | undefined;
  readonly result: ToolResultBlock | undefined;
}

type DisplayStatus = "pending" | "running" | "succeeded" | "failed";

const statusLabels: Record<DisplayStatus, string> = {
  pending: "Pending",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

function displayStatus(
  call: ToolCallBlock | undefined,
  result: ToolResultBlock | undefined,
): DisplayStatus {
  if (call?.status === "pending" || call?.status === "running") {
    return call.status;
  }
  if (result !== undefined) return result.isError ? "failed" : "succeeded";
  return call?.status ?? "pending";
}

function formatArguments(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatBytes(bytes: number): string {
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(bytes);
}

/** A live tool call and its eventual result, joined by their normalized ID. */
export function ToolCallCard({ call, result }: ToolCallCardProps) {
  const status = displayStatus(call, result);
  const toolName = call?.toolName ?? result?.toolName ?? "Tool";
  const label = statusLabels[status];

  return (
    <details
      className={`tool-call-card tool-status-${status}`}
      aria-label={`${toolName} tool call: ${label}`}
    >
      <summary>
        <span className="tool-name">{toolName}</span>
        <span className="tool-state">
          <i aria-hidden="true" />
          {label}
        </span>
      </summary>
      <div className="tool-card-body">
        {call !== undefined && (
          <section className="tool-section">
            <h4>Arguments</h4>
            <pre className="tool-arguments"><code>{formatArguments(call.arguments)}</code></pre>
          </section>
        )}
        {result !== undefined && (
          <section className="tool-section">
            <h4>Output</h4>
            <pre className="tool-output"><code>{result.content || "(No textual output)"}</code></pre>
            {result.truncated && (
              <p className="tool-truncation" role="note">
                Output truncated for browser display
                {result.originalBytes === undefined
                  ? "."
                  : ` (original size ${formatBytes(result.originalBytes)} bytes).`}
              </p>
            )}
          </section>
        )}
      </div>
    </details>
  );
}
