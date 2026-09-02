import { domainToASCII, domainToUnicode } from "node:url";

import {
  classifyParsedAddress,
  parseIpAddress,
  type AddressClassification,
  type IpFamily,
} from "./addresses.js";

export type DestinationPolicyReason =
  | "allowlist"
  | "explicit_deny"
  | "not_allowed"
  | "local_address"
  | "port_not_allowed";

export interface NormalizedDestinationHost {
  readonly host: string;
  readonly kind: "domain" | "ip";
  readonly family: IpFamily | null;
  readonly address: AddressClassification | null;
}

export interface DestinationPolicyDecision {
  readonly allowed: boolean;
  readonly reason: DestinationPolicyReason;
  readonly host: NormalizedDestinationHost;
  readonly port: number;
}

export interface DestinationPolicyInput {
  readonly host: string;
  readonly port: number;
}

export interface DestinationPolicyConfig {
  readonly allowedDomainPatterns: readonly string[];
  readonly deniedDomainPatterns: readonly string[];
  readonly allowedPorts?: readonly number[];
  readonly allowedPortSet?: ReadonlySet<number>;
}

export class DestinationPolicyError extends Error {
  constructor(
    readonly code: "invalid_host" | "invalid_pattern" | "invalid_port" | "invalid_policy",
    message: string,
  ) {
    super(message);
    this.name = "DestinationPolicyError";
  }
}

class ImmutableSetView<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: T): boolean {
    return this.#values.has(value);
  }

  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  keys(): SetIterator<T> {
    return this.#values.keys();
  }

  values(): SetIterator<T> {
    return this.#values.values();
  }

  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#values) callbackfn.call(thisArg, value, value, this);
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.#values[Symbol.iterator]();
  }

  readonly [Symbol.toStringTag] = "Set";
}

interface CompiledPattern {
  readonly normalized: string;
  readonly mode: "exact" | "subdomains" | "apex_and_subdomains";
  readonly base: string;
  readonly kind: "domain" | "ip";
}

export interface CompiledDestinationPolicy {
  readonly allowedPatterns: readonly string[];
  readonly deniedPatterns: readonly string[];
  readonly allowedPorts: ReadonlySet<number>;
  /** Internal compiled forms; consumers should use decideDestination(). */
  readonly _allowed: readonly CompiledPattern[];
  readonly _denied: readonly CompiledPattern[];
}

function invalidHost(): never {
  throw new DestinationPolicyError("invalid_host", "invalid destination host");
}

function validateAsciiDomain(ascii: string): void {
  if (ascii.length === 0 || ascii.length > 253) invalidHost();
  const labels = ascii.split(".");
  for (const label of labels) {
    if (
      label.length === 0 ||
      label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)
    ) {
      invalidHost();
    }
    // Node's UTS #46 conversion leaves malformed ACE-looking labels unchanged.
    // A valid A-label must decode to a distinct Unicode label.
    if (label.startsWith("xn--") && domainToUnicode(label) === label) invalidHost();
  }
}

function isAmbiguousNumericHost(host: string): boolean {
  const labels = host.split(".");
  return labels.every((label) =>
    /^(?:[0-9]+|0[xX][0-9a-fA-F]+)$/.test(label)
  );
}

/**
 * Normalize an untrusted destination host. Brackets are accepted only around
 * a complete IPv6 literal, as produced by URI/authority parsers.
 */
export function normalizeDestinationHost(input: string): NormalizedDestinationHost {
  let host = input.trim();
  if (host.length === 0) invalidHost();

  if (host.startsWith("[") || host.endsWith("]")) {
    if (!(host.startsWith("[") && host.endsWith("]"))) invalidHost();
    const literal = host.slice(1, -1);
    if (!literal.includes(":")) invalidHost();
    const parsed = parseIpAddress(literal);
    if (parsed === null || parsed.family !== 6) invalidHost();
    const address = classifyParsedAddress(parsed);
    return Object.freeze({ host: parsed.address, kind: "ip", family: 6, address });
  }

  const parsed = parseIpAddress(host);
  if (parsed !== null) {
    const address = classifyParsedAddress(parsed);
    return Object.freeze({
      host: parsed.address,
      kind: "ip",
      family: parsed.family,
      address,
    });
  }

  // A colon can only occur in a valid unbracketed IPv6 literal. URL syntax,
  // credentials, paths, queries, fragments, and scoped literals are never DNS.
  if (
    host.includes(":") ||
    host.includes("/") ||
    host.includes("?") ||
    host.includes("#") ||
    host.includes("@") ||
    host.includes("%") ||
    host.includes("\\") ||
    /[\u0000-\u0020\u007f]/u.test(host)
  ) {
    invalidHost();
  }

  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host.length === 0 || host.endsWith(".")) invalidHost();
  if (isAmbiguousNumericHost(host)) invalidHost();

  let ascii: string;
  try {
    ascii = domainToASCII(host).toLowerCase();
  } catch {
    invalidHost();
  }
  validateAsciiDomain(ascii);
  if (isAmbiguousNumericHost(ascii)) invalidHost();

  return Object.freeze({ host: ascii, kind: "domain", family: null, address: null });
}

/** Normalize one administrator exact/scoped-wildcard pattern. */
export function normalizeDestinationPattern(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed === "*" || trimmed.includes("[") || trimmed.includes("]")) {
    throw new DestinationPolicyError("invalid_pattern", "invalid destination pattern");
  }

  let prefix = "";
  let value = trimmed;
  if (value.startsWith("**.")) {
    prefix = "**.";
    value = value.slice(3);
  } else if (value.startsWith("*.")) {
    prefix = "*.";
    value = value.slice(2);
  }
  if (value.includes("*")) {
    throw new DestinationPolicyError("invalid_pattern", "invalid destination pattern");
  }

  let normalized: NormalizedDestinationHost;
  try {
    normalized = normalizeDestinationHost(value);
  } catch (error) {
    if (error instanceof DestinationPolicyError) {
      throw new DestinationPolicyError("invalid_pattern", "invalid destination pattern");
    }
    throw error;
  }
  if (prefix !== "" && normalized.kind === "ip") {
    throw new DestinationPolicyError("invalid_pattern", "IP literals cannot use wildcard patterns");
  }
  return `${prefix}${normalized.host}`;
}

function compilePattern(normalized: string): CompiledPattern {
  let mode: CompiledPattern["mode"] = "exact";
  let base = normalized;
  if (normalized.startsWith("**.")) {
    mode = "apex_and_subdomains";
    base = normalized.slice(3);
  } else if (normalized.startsWith("*.")) {
    mode = "subdomains";
    base = normalized.slice(2);
  }
  const host = normalizeDestinationHost(base);
  return Object.freeze({ normalized, mode, base: host.host, kind: host.kind });
}

function normalizedUniquePatterns(patterns: readonly string[]): readonly CompiledPattern[] {
  const normalized = patterns.map(normalizeDestinationPattern);
  if (new Set(normalized).size !== normalized.length) {
    throw new DestinationPolicyError("invalid_policy", "duplicate normalized destination pattern");
  }
  return Object.freeze(normalized.map(compilePattern));
}

export function compileDestinationPolicy(
  config: DestinationPolicyConfig,
): CompiledDestinationPolicy {
  const configuredPorts = config.allowedPortSet === undefined
    ? [...(config.allowedPorts ?? [])]
    : [...config.allowedPortSet];
  if (config.allowedPortSet === undefined && new Set(configuredPorts).size !== configuredPorts.length) {
    throw new DestinationPolicyError("invalid_policy", "duplicate allowed destination port");
  }
  const ports = new ImmutableSetView(configuredPorts);
  for (const port of ports) {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new DestinationPolicyError("invalid_policy", "invalid allowed destination port");
    }
  }
  const allowed = normalizedUniquePatterns(config.allowedDomainPatterns);
  const denied = normalizedUniquePatterns(config.deniedDomainPatterns);
  return Object.freeze({
    allowedPatterns: Object.freeze(allowed.map((pattern) => pattern.normalized)),
    deniedPatterns: Object.freeze(denied.map((pattern) => pattern.normalized)),
    allowedPorts: ports,
    _allowed: allowed,
    _denied: denied,
  });
}

function matches(pattern: CompiledPattern, host: NormalizedDestinationHost): boolean {
  if (pattern.kind === "ip" || host.kind === "ip") {
    return pattern.mode === "exact" && pattern.kind === host.kind && pattern.base === host.host;
  }
  if (pattern.mode === "exact") return pattern.base === host.host;
  const subdomain = host.host.endsWith(`.${pattern.base}`);
  return pattern.mode === "subdomains" ? subdomain : host.host === pattern.base || subdomain;
}

/** The one policy decision path shared by HTTP, CONNECT, and SOCKS. */
export function decideDestination(
  policy: CompiledDestinationPolicy,
  input: DestinationPolicyInput,
): DestinationPolicyDecision {
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65_535) {
    throw new DestinationPolicyError("invalid_port", "invalid destination port");
  }
  const host = normalizeDestinationHost(input.host);

  let reason: DestinationPolicyReason;
  let allowed = false;
  if (policy._denied.some((pattern) => matches(pattern, host))) {
    reason = "explicit_deny";
  } else if (!policy.allowedPorts.has(input.port)) {
    reason = "port_not_allowed";
  } else if (!policy._allowed.some((pattern) => matches(pattern, host))) {
    reason = "not_allowed";
  } else if (host.address !== null && !host.address.isPublic) {
    reason = "local_address";
  } else {
    reason = "allowlist";
    allowed = true;
  }

  return Object.freeze({ allowed, reason, host, port: input.port });
}
