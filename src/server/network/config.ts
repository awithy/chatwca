import path from "node:path";

import {
  MAX_PUBLIC_NETWORK_POLICY_SETS,
  NETWORK_POLICY_SET_ID_MAX_LENGTH,
  NETWORK_POLICY_SET_ID_PATTERN,
  NETWORK_POLICY_SET_LABEL_MAX_LENGTH,
  type ManagedEgressMode,
  type PublicManagedEgressConfig,
  type SandboxNetworkPolicy,
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
export const DEFAULT_NETWORK_POLICY_SET_ID = "default";
export const DEFAULT_NETWORK_POLICY_SET_LABEL = "Default";

export const MANAGED_EGRESS_DISCLOSURE_WARNING =
  "Tools may transmit workspace content to configured destinations. Workspace content may also be sent to the configured model provider.";

export const MANAGED_EGRESS_SUPPORTED_PROTOCOLS = Object.freeze([
  "http",
  "https-connect",
  "websocket",
  "websocket-secure",
  "socks5-tcp",
] as const);

export interface CompiledNetworkPolicySet {
  readonly id: string;
  readonly label: string;
  readonly allowedDomainPatterns: readonly string[];
  readonly allowedPorts: readonly number[];
  /** Set-local grants compiled together with the mandatory global denials. */
  readonly destinationPolicy: CompiledDestinationPolicy;
}

class ImmutableMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;
  constructor(values: Iterable<readonly [K, V]>) { this.#values = new Map(values); }
  get size(): number { return this.#values.size; }
  has(key: K): boolean { return this.#values.has(key); }
  get(key: K): V | undefined { return this.#values.get(key); }
  entries(): MapIterator<[K, V]> { return this.#values.entries(); }
  keys(): MapIterator<K> { return this.#values.keys(); }
  values(): MapIterator<V> { return this.#values.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#values) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.#values[Symbol.iterator](); }
  readonly [Symbol.toStringTag] = "Map";
}

export interface ManagedNetworkConfig {
  readonly mode: ManagedEgressMode;
  readonly helperPath: string;
  readonly helperDirectory: string;
  /** Packaged identity manifest; configured helper overrides must match it. */
  readonly helperManifestPath: string;
  readonly allowedDomainPatterns: readonly string[];
  readonly deniedDomainPatterns: readonly string[];
  readonly allowedPorts: readonly number[];
  /** Immutable, ordered administrator-defined destination policy sets. */
  readonly policySets: ReadonlyMap<string, CompiledNetworkPolicySet>;
  readonly orderedPolicySets: readonly CompiledNetworkPolicySet[];
  /** Immutable compiled global-ceiling decision policy retained only by the server. */
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

function parsePortValues(
  values: readonly unknown[],
  variable: string,
): readonly number[] {
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

function parsePorts(environment: NodeJS.ProcessEnv): readonly number[] {
  const variable = "CHATWCA_NETWORK_ALLOWED_PORTS";
  return parsePortValues(
    parseJsonArray(environment, variable, DEFAULT_NETWORK_ALLOWED_PORTS),
    variable,
  );
}

function validPolicySetId(id: string): boolean {
  return id.length <= NETWORK_POLICY_SET_ID_MAX_LENGTH &&
    new RegExp(NETWORK_POLICY_SET_ID_PATTERN, "u").test(id);
}

function compilePolicySet(
  id: string,
  label: string,
  allowedDomainPatterns: readonly string[],
  allowedPorts: readonly number[],
  deniedDomainPatterns: readonly string[],
): CompiledNetworkPolicySet {
  return Object.freeze({
    id,
    label,
    allowedDomainPatterns: Object.freeze([...allowedDomainPatterns]),
    allowedPorts: Object.freeze([...allowedPorts]),
    destinationPolicy: compileDestinationPolicy({
      allowedDomainPatterns,
      deniedDomainPatterns,
      allowedPorts,
    }),
  });
}

function parsePolicySets(
  environment: NodeJS.ProcessEnv,
  globalDomains: readonly string[],
  globalPorts: readonly number[],
  deniedDomains: readonly string[],
): {
  readonly map: ReadonlyMap<string, CompiledNetworkPolicySet>;
  readonly ordered: readonly CompiledNetworkPolicySet[];
} {
  const variable = "CHATWCA_NETWORK_POLICY_SETS";
  const raw = environment[variable];
  if (raw === undefined) {
    const defaultSet = compilePolicySet(
      DEFAULT_NETWORK_POLICY_SET_ID,
      DEFAULT_NETWORK_POLICY_SET_LABEL,
      globalDomains,
      globalPorts,
      deniedDomains,
    );
    return Object.freeze({
      map: new ImmutableMapView([[defaultSet.id, defaultSet]]),
      ordered: Object.freeze([defaultSet]),
    });
  }
  const values = parseJsonArray(environment, variable, []);
  if (values.length === 0 || values.length > MAX_PUBLIC_NETWORK_POLICY_SETS) {
    throw new ConfigurationError(
      `${variable} must contain from 1 through ${String(MAX_PUBLIC_NETWORK_POLICY_SETS)} sets`,
    );
  }
  const globalDomainSet = new Set(globalDomains);
  const globalPortSet = new Set(globalPorts);
  const ids = new Set<string>();
  const ordered: CompiledNetworkPolicySet[] = [];
  for (const [index, value] of values.entries()) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new ConfigurationError(`${variable}[${String(index)}] must be an object`);
    }
    const object = value as Record<string, unknown>;
    const keys = Object.keys(object);
    const expected = ["allowedDomains", "allowedPorts", "id", "label"];
    if (keys.length !== expected.length || keys.some((key) => !expected.includes(key))) {
      throw new ConfigurationError(`${variable}[${String(index)}] contains unknown or missing keys`);
    }
    if (typeof object.id !== "string" || !validPolicySetId(object.id)) {
      throw new ConfigurationError(`${variable}[${String(index)}].id must be an ASCII slug of at most ${String(NETWORK_POLICY_SET_ID_MAX_LENGTH)} characters`);
    }
    if (ids.has(object.id)) throw new ConfigurationError(`${variable} contains a duplicate id`);
    ids.add(object.id);
    if (
      typeof object.label !== "string" ||
      object.label.length === 0 ||
      object.label.length > NETWORK_POLICY_SET_LABEL_MAX_LENGTH ||
      object.label.trim() !== object.label ||
      /[\u0000-\u001f\u007f]/u.test(object.label)
    ) {
      throw new ConfigurationError(`${variable}[${String(index)}].label is invalid`);
    }
    if (!Array.isArray(object.allowedDomains) || object.allowedDomains.length === 0 ||
        object.allowedDomains.some((entry) => typeof entry !== "string")) {
      throw new ConfigurationError(`${variable}[${String(index)}].allowedDomains must be a non-empty string array`);
    }
    const domains = (object.allowedDomains as string[]).map((entry) => {
      try { return normalizeConfiguredDomainPattern(entry); }
      catch { throw new ConfigurationError(`${variable}[${String(index)}].allowedDomains contains an invalid pattern`); }
    });
    if (new Set(domains).size !== domains.length) {
      throw new ConfigurationError(`${variable}[${String(index)}].allowedDomains contains a normalized duplicate`);
    }
    if (domains.some((domain) => !globalDomainSet.has(domain))) {
      throw new ConfigurationError(`${variable}[${String(index)}].allowedDomains exceeds the global ceiling`);
    }
    if (!Array.isArray(object.allowedPorts) || object.allowedPorts.length === 0) {
      throw new ConfigurationError(`${variable}[${String(index)}].allowedPorts must be a non-empty array`);
    }
    const ports = parsePortValues(object.allowedPorts, `${variable}[${String(index)}].allowedPorts`);
    if (ports.some((port) => !globalPortSet.has(port))) {
      throw new ConfigurationError(`${variable}[${String(index)}].allowedPorts exceeds the global ceiling`);
    }
    ordered.push(compilePolicySet(object.id, object.label, domains, ports, deniedDomains));
  }
  if (!ids.has(DEFAULT_NETWORK_POLICY_SET_ID) ||
      ordered.filter(({ id }) => id === DEFAULT_NETWORK_POLICY_SET_ID).length !== 1) {
    throw new ConfigurationError(`${variable} must contain exactly one default set`);
  }
  const frozen = Object.freeze(ordered);
  return Object.freeze({
    map: new ImmutableMapView(frozen.map((set) => [set.id, set] as const)),
    ordered: frozen,
  });
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
  const policySets = parsePolicySets(
    environment,
    allowedDomainPatterns,
    allowedPorts,
    deniedDomainPatterns,
  );
  const processCwd = path.resolve(options.processCwd ?? process.cwd());
  const processArch = options.processArch ?? process.arch;
  const helperPath = configuredHelperPath(
    environment,
    processCwd,
    processArch,
  );
  const helperManifestPath = path.join(
    processCwd,
    "dist",
    "native",
    processArch,
    "network-helper-manifest.json",
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
    helperManifestPath,
    allowedDomainPatterns,
    deniedDomainPatterns,
    allowedPorts,
    policySets: policySets.map,
    orderedPolicySets: policySets.ordered,
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
    policySets: config.orderedPolicySets.map((set) => ({
      id: set.id,
      label: set.label,
      allowedDomainPatterns: [...set.allowedDomainPatterns],
      allowedPorts: [...set.allowedPorts],
    })),
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
