import path from "node:path";

import type {
  ManagedEgressMode,
  PublicManagedEgressConfig,
  SandboxNetworkPolicy,
} from "../../shared/protocol.js";
import { ConfigurationError } from "../sandbox/config.js";
import {
  DestinationPolicyError,
  compileDestinationPolicy,
  normalizeDestinationPattern,
  type CompiledDestinationPolicy,
} from "./policy.js";

export const DEFAULT_MANAGED_EGRESS_MODE: ManagedEgressMode = "disabled";
export const DEFAULT_NETWORK_ALLOWED_PORTS = Object.freeze([80, 443] as const);
export const DEFAULT_NETWORK_MAX_CONNECTIONS = 32;
export const DEFAULT_NETWORK_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_NETWORK_IDLE_TIMEOUT_MS = 300_000;
export const DEFAULT_NETWORK_MAX_CONNECTION_BYTES = 1_073_741_824;

export const MANAGED_EGRESS_DISCLOSURE_WARNING =
  "Tools may transmit workspace content to configured destinations. Workspace content may also be sent to the configured model provider.";

export const MANAGED_EGRESS_SUPPORTED_PROTOCOLS = Object.freeze([
  "http",
  "https-connect",
  "websocket",
  "websocket-secure",
  "socks5-tcp",
] as const);

export interface ManagedNetworkConfig {
  readonly mode: ManagedEgressMode;
  readonly helperPath: string;
  readonly helperDirectory: string;
  readonly allowedDomainPatterns: readonly string[];
  readonly deniedDomainPatterns: readonly string[];
  readonly allowedPorts: readonly number[];
  /** Immutable compiled decision policy retained only by the server. */
  readonly destinationPolicy: CompiledDestinationPolicy;
  /** Pre-built immutable membership set retained only by the server. */
  readonly allowedPortSet: ReadonlySet<number>;
  readonly maxConnections: number;
  readonly connectTimeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly maxConnectionBytes: number;
}

export interface ManagedNetworkConfigOptions {
  readonly processCwd?: string;
  readonly processArch?: NodeJS.Architecture;
}

function parseMode(environment: NodeJS.ProcessEnv): ManagedEgressMode {
  const value = environment.CHATWCA_MANAGED_EGRESS_MODE;
  if (value === undefined) return DEFAULT_MANAGED_EGRESS_MODE;
  if (value === "disabled" || value === "optional") return value;
  throw new ConfigurationError(
    "CHATWCA_MANAGED_EGRESS_MODE must be disabled or optional",
  );
}

function parseJsonArray(
  environment: NodeJS.ProcessEnv,
  variable: string,
  fallback: readonly unknown[],
): unknown[] {
  const raw = environment[variable];
  if (raw === undefined) return [...fallback];
  if (raw.trim().length === 0) {
    throw new ConfigurationError(`${variable} must not be empty`);
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) throw new Error("not an array");
    return parsed;
  } catch {
    throw new ConfigurationError(`${variable} must be a JSON array`);
  }
}

function positiveSafeInteger(
  environment: NodeJS.ProcessEnv,
  variable: string,
  fallback: number,
): number {
  const raw = environment[variable];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ConfigurationError(`${variable} must be a positive safe integer`);
  }
  return value;
}

/** Normalize and validate the deliberately narrow administrator pattern syntax. */
export function normalizeConfiguredDomainPattern(input: string): string {
  try {
    return normalizeDestinationPattern(input);
  } catch (error) {
    if (error instanceof DestinationPolicyError) {
      throw new ConfigurationError(`invalid domain pattern ${JSON.stringify(input)}`);
    }
    throw error;
  }
}

function parseDomainPatterns(
  environment: NodeJS.ProcessEnv,
  variable: string,
): readonly string[] {
  const values = parseJsonArray(environment, variable, []);
  if (values.some((value) => typeof value !== "string")) {
    throw new ConfigurationError(`${variable} must be a JSON string array`);
  }
  const normalized = (values as string[]).map((value) => {
    try {
      return normalizeConfiguredDomainPattern(value);
    } catch (error) {
      if (error instanceof ConfigurationError) {
        throw new ConfigurationError(`${variable} contains an invalid domain pattern`);
      }
      throw error;
    }
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new ConfigurationError(`${variable} contains a normalized duplicate`);
  }
  return Object.freeze(normalized);
}

function parsePorts(environment: NodeJS.ProcessEnv): readonly number[] {
  const variable = "CHATWCA_NETWORK_ALLOWED_PORTS";
  const values = parseJsonArray(environment, variable, DEFAULT_NETWORK_ALLOWED_PORTS);
  if (values.some((value) =>
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > 65_535
  )) {
    throw new ConfigurationError(
      `${variable} entries must be integers from 1 through 65535`,
    );
  }
  const ports = values as number[];
  if (new Set(ports).size !== ports.length) {
    throw new ConfigurationError(`${variable} contains a duplicate`);
  }
  return Object.freeze([...ports]);
}

function configuredHelperPath(
  environment: NodeJS.ProcessEnv,
  processCwd: string,
  processArch: NodeJS.Architecture,
): string {
  const configured = environment.CHATWCA_NETWORK_HELPER_PATH ?? path.join(
    processCwd,
    "dist",
    "native",
    processArch,
    "chatwca-network-helper",
  );
  if (configured.trim().length === 0 || !path.isAbsolute(configured)) {
    throw new ConfigurationError(
      "CHATWCA_NETWORK_HELPER_PATH must be a non-empty absolute path",
    );
  }
  // Artifact identity/canonical-file inspection belongs to helper validation.
  // In particular, disabled mode must not touch this filesystem path.
  return path.normalize(configured);
}

export function loadManagedNetworkConfig(
  environment: NodeJS.ProcessEnv,
  sandboxMode: "disabled" | "optional" | "required",
  options: ManagedNetworkConfigOptions = {},
): Readonly<ManagedNetworkConfig> {
  const mode = parseMode(environment);
  if (mode === "optional" && sandboxMode === "disabled") {
    throw new ConfigurationError(
      "CHATWCA_MANAGED_EGRESS_MODE=optional requires CHATWCA_SANDBOX_MODE to be optional or required",
    );
  }

  const allowedDomainPatterns = parseDomainPatterns(
    environment,
    "CHATWCA_NETWORK_ALLOWED_DOMAINS",
  );
  const deniedDomainPatterns = parseDomainPatterns(
    environment,
    "CHATWCA_NETWORK_DENIED_DOMAINS",
  );
  if (mode === "optional" && allowedDomainPatterns.length === 0) {
    throw new ConfigurationError(
      "CHATWCA_NETWORK_ALLOWED_DOMAINS must contain at least one entry in optional mode",
    );
  }
  const allowedPorts = parsePorts(environment);
  const helperPath = configuredHelperPath(
    environment,
    path.resolve(options.processCwd ?? process.cwd()),
    options.processArch ?? process.arch,
  );
  const destinationPolicy = compileDestinationPolicy({
    allowedDomainPatterns,
    deniedDomainPatterns,
    allowedPorts,
  });

  return Object.freeze({
    mode,
    helperPath,
    helperDirectory: path.dirname(helperPath),
    allowedDomainPatterns,
    deniedDomainPatterns,
    allowedPorts,
    destinationPolicy,
    allowedPortSet: destinationPolicy.allowedPorts,
    maxConnections: positiveSafeInteger(
      environment,
      "CHATWCA_NETWORK_MAX_CONNECTIONS",
      DEFAULT_NETWORK_MAX_CONNECTIONS,
    ),
    connectTimeoutMs: positiveSafeInteger(
      environment,
      "CHATWCA_NETWORK_CONNECT_TIMEOUT_MS",
      DEFAULT_NETWORK_CONNECT_TIMEOUT_MS,
    ),
    idleTimeoutMs: positiveSafeInteger(
      environment,
      "CHATWCA_NETWORK_IDLE_TIMEOUT_MS",
      DEFAULT_NETWORK_IDLE_TIMEOUT_MS,
    ),
    maxConnectionBytes: positiveSafeInteger(
      environment,
      "CHATWCA_NETWORK_MAX_CONNECTION_BYTES",
      DEFAULT_NETWORK_MAX_CONNECTION_BYTES,
    ),
  });
}

export function publicManagedEgressConfig(
  config: Readonly<ManagedNetworkConfig>,
  functionalProbeSucceeded = false,
): PublicManagedEgressConfig {
  const selectablePolicies: readonly SandboxNetworkPolicy[] = config.mode === "optional"
    ? ["isolated", "managed-egress"]
    : ["isolated"];
  return {
    mode: config.mode,
    selectablePolicies: [...selectablePolicies],
    allowedDomainPatterns: [...config.allowedDomainPatterns],
    deniedDomainPatterns: [...config.deniedDomainPatterns],
    allowedPorts: [...config.allowedPorts],
    supportedProtocols: [...MANAGED_EGRESS_SUPPORTED_PROTOCOLS],
    denyNonPublicAddresses: true,
    tlsInterception: false,
    disclosureWarning: MANAGED_EGRESS_DISCLOSURE_WARNING,
    functionalProbeSucceeded,
  };
}
