import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  truncateHead,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { HttpToolConfig } from "./http-tool-catalog.js";

interface HttpToolDetails {
  readonly status: number;
  readonly truncation?: ReturnType<typeof truncateHead>;
}

export interface CreateHttpToolOptions {
  readonly fetch?: typeof globalThis.fetch;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("HTTP tool response exceeded its size limit");
  }
  if (response.body === null) throw new Error("HTTP tool response had no body");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("HTTP tool response exceeded its size limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}

function jsonContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  return contentType === "application/json" || contentType?.endsWith("+json") === true;
}

/** Create one fixed-destination, parent-owned JSON-over-HTTP Pi tool. */
export function createHttpTool(
  config: Readonly<HttpToolConfig>,
  options: Readonly<CreateHttpToolOptions> = {},
): ToolDefinition<any, any> {
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  return defineTool({
    name: config.name,
    label: config.label,
    description: config.description,
    promptSnippet: config.description,
    parameters: config.parameters,
    executionMode: "parallel",
    async execute(_toolCallId, input, signal) {
      const timeoutController = new AbortController();
      const timeout = setTimeout(() => timeoutController.abort(), config.timeoutMs);
      const combinedSignal = signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([signal, timeoutController.signal]);
      try {
        const response = await fetchImplementation(config.url, {
          method: config.method,
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(input),
          redirect: "error",
          signal: combinedSignal,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error(`HTTP tool request failed with HTTP ${String(response.status)}`);
        }
        if (!jsonContentType(response)) {
          await response.body?.cancel().catch(() => undefined);
          throw new Error("HTTP tool returned an unsupported content type");
        }

        const rawBody = await readBoundedResponse(response, config.maxResponseBytes);
        let payload: unknown;
        try {
          payload = JSON.parse(rawBody) as unknown;
        } catch {
          throw new Error("HTTP tool returned invalid JSON");
        }
        const formatted = JSON.stringify(payload, null, 2);
        const truncation = truncateHead(formatted, {
          maxBytes: DEFAULT_MAX_BYTES,
          maxLines: DEFAULT_MAX_LINES,
        });
        return {
          content: [{
            type: "text",
            text: truncation.truncated
              ? `${truncation.content}\n\n[HTTP tool output truncated to ${String(truncation.outputLines)} of ${String(truncation.totalLines)} lines.]`
              : truncation.content,
          }],
          details: {
            status: response.status,
            ...(truncation.truncated ? { truncation } : {}),
          },
        };
      } catch (error) {
        if (signal?.aborted === true) throw new Error(`${config.label} cancelled`);
        if (timeoutController.signal.aborted) throw new Error(`${config.label} timed out`);
        if (error instanceof Error && (
          /^HTTP tool request failed with HTTP \d+$/.test(error.message) ||
          error.message === "HTTP tool response exceeded its size limit" ||
          error.message === "HTTP tool returned an unsupported content type" ||
          error.message === "HTTP tool returned invalid JSON"
        )) {
          throw error;
        }
        throw new Error(`${config.label} failed`);
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
