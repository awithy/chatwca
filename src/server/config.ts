import path from "node:path";

export const DEFAULT_HOST = "0.0.0.0";
export const DEFAULT_PORT = 8787;
export const DEFAULT_DATA_DIR = "./data";
export const DEFAULT_MAX_LIVE_CONVERSATIONS = 8;
export const DEFAULT_MAX_IMAGES = 8;
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_IMAGE_BYTES = 24 * 1024 * 1024;
export const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;
/** Prevent configuration mistakes from delaying process termination indefinitely. */
export const MAX_SHUTDOWN_GRACE_MS = 5 * 60 * 1_000;

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  /** Server-only directory containing ChatWCA's SQLite database. */
  readonly dataDir: string;
  readonly maxLiveConversations: number;
  readonly maxImages: number;
  readonly maxImageBytes: number;
  readonly maxTotalImageBytes: number;
  readonly shutdownGraceMs: number;
  /** Pi consumes this environment setting directly; it must never be sent to the browser. */
  readonly piCodingAgentDir: string | undefined;
  /** Pi 0.84.3 enables offline mode when PI_OFFLINE is present, regardless of its value. */
  readonly piOffline: boolean;
}

export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

function optionalNonEmpty(
  environment: NodeJS.ProcessEnv,
  variable: string,
): string | undefined {
  const value = environment[variable];
  if (value === undefined) {
    return undefined;
  }

  if (value.trim().length === 0) {
    throw new ConfigurationError(`${variable} must not be empty`);
  }

  return value;
}

function positiveInteger(
  environment: NodeJS.ProcessEnv,
  variable: string,
  defaultValue: number,
): number {
  const rawValue = environment[variable];
  if (rawValue === undefined) {
    return defaultValue;
  }

  const value = Number(rawValue);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(
      `${variable} must be a positive integer; received ${JSON.stringify(rawValue)}`,
    );
  }

  return value;
}

/** Parse server-only process configuration. This object is not an API response. */
export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  processCwd = process.cwd(),
): Readonly<ServerConfig> {
  const host = environment.CHATWCA_HOST ?? DEFAULT_HOST;
  if (host.trim().length === 0) {
    throw new ConfigurationError("CHATWCA_HOST must not be empty");
  }

  const port = positiveInteger(environment, "CHATWCA_PORT", DEFAULT_PORT);
  if (port > 65_535) {
    throw new ConfigurationError(
      `CHATWCA_PORT must be between 1 and 65535; received ${String(port)}`,
    );
  }

  const configuredDataDir = environment.CHATWCA_DATA_DIR ?? DEFAULT_DATA_DIR;
  if (configuredDataDir.trim().length === 0) {
    throw new ConfigurationError("CHATWCA_DATA_DIR must not be empty");
  }

  const shutdownGraceMs = positiveInteger(
    environment,
    "CHATWCA_SHUTDOWN_GRACE_MS",
    DEFAULT_SHUTDOWN_GRACE_MS,
  );
  if (shutdownGraceMs > MAX_SHUTDOWN_GRACE_MS) {
    throw new ConfigurationError(
      `CHATWCA_SHUTDOWN_GRACE_MS must not exceed ${String(MAX_SHUTDOWN_GRACE_MS)}; received ${String(shutdownGraceMs)}`,
    );
  }

  return Object.freeze({
    host,
    port,
    dataDir: path.resolve(processCwd, configuredDataDir),
    maxLiveConversations: positiveInteger(
      environment,
      "CHATWCA_MAX_LIVE_CONVERSATIONS",
      DEFAULT_MAX_LIVE_CONVERSATIONS,
    ),
    maxImages: positiveInteger(
      environment,
      "CHATWCA_MAX_IMAGES",
      DEFAULT_MAX_IMAGES,
    ),
    maxImageBytes: positiveInteger(
      environment,
      "CHATWCA_MAX_IMAGE_BYTES",
      DEFAULT_MAX_IMAGE_BYTES,
    ),
    maxTotalImageBytes: positiveInteger(
      environment,
      "CHATWCA_MAX_TOTAL_IMAGE_BYTES",
      DEFAULT_MAX_TOTAL_IMAGE_BYTES,
    ),
    shutdownGraceMs,
    piCodingAgentDir: optionalNonEmpty(environment, "PI_CODING_AGENT_DIR"),
    piOffline: environment.PI_OFFLINE !== undefined,
  });
}
