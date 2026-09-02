import {
  NETWORK_POLICY_SET_ID_MAX_LENGTH,
  NETWORK_POLICY_SET_ID_PATTERN,
  type NetworkPolicySetId,
} from "../../shared/protocol.js";
import { normalizeDestinationHost } from "./policy.js";

export const NETWORK_AUDIT_PROTOCOLS = ["http", "https-connect", "socks5-tcp"] as const;
export type NetworkAuditProtocol = typeof NETWORK_AUDIT_PROTOCOLS[number];
export const NETWORK_AUDIT_REASONS = [
  "allowlist", "explicit_deny", "not_allowed", "local_address",
  "port_not_allowed", "dns_failure", "limit_exceeded", "proxy_unavailable",
] as const;
export type NetworkAuditReason = typeof NETWORK_AUDIT_REASONS[number];

export interface NetworkPolicyAuditEvent {
  readonly timestamp: number;
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly policySetId: NetworkPolicySetId;
  readonly protocol: NetworkAuditProtocol;
  readonly host: string;
  readonly port: number;
  readonly decision: "allow" | "deny";
  readonly reason: NetworkAuditReason;
}

export interface NetworkBlockedNotification {
  readonly protocol: NetworkAuditProtocol;
  readonly host: string;
  readonly port: number;
  readonly reason: Exclude<NetworkAuditReason, "allowlist">;
  readonly occurrenceCount?: number;
}

export type NetworkDiagnosticSink = (event: Readonly<NetworkPolicyAuditEvent>) => void;
export type NetworkBlockedListener = (event: Readonly<NetworkBlockedNotification>) => void;

export interface NetworkAuditContext {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly policySetId: NetworkPolicySetId;
}

export interface NetworkDecision {
  readonly protocol: NetworkAuditProtocol;
  readonly host: string;
  readonly port: number;
  readonly decision: "allow" | "deny";
  readonly reason: NetworkAuditReason;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 200 &&
    /^[A-Za-z0-9._:-]+$/.test(value);
}

function validPolicySetId(value: unknown): value is NetworkPolicySetId {
  return typeof value === "string" &&
    value.length <= NETWORK_POLICY_SET_ID_MAX_LENGTH &&
    new RegExp(NETWORK_POLICY_SET_ID_PATTERN, "u").test(value);
}

/** Reconstruct, normalize, freeze, and whitelist every logged field. */
export function validateNetworkAuditEvent(value: NetworkPolicyAuditEvent): Readonly<NetworkPolicyAuditEvent> {
  if (!Number.isSafeInteger(value.timestamp) || value.timestamp < 0 ||
      !validIdentity(value.workspaceId) || !validIdentity(value.conversationId) ||
      !validPolicySetId(value.policySetId) ||
      !(NETWORK_AUDIT_PROTOCOLS as readonly string[]).includes(value.protocol) ||
      !(NETWORK_AUDIT_REASONS as readonly string[]).includes(value.reason) ||
      (value.decision !== "allow" && value.decision !== "deny") ||
      !Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw new TypeError("invalid network audit event");
  }
  const host = normalizeDestinationHost(value.host).host;
  if (host !== value.host || (value.decision === "allow") !== (value.reason === "allowlist")) {
    throw new TypeError("invalid network audit event");
  }
  return Object.freeze({
    timestamp: value.timestamp,
    workspaceId: value.workspaceId,
    conversationId: value.conversationId,
    policySetId: value.policySetId,
    protocol: value.protocol,
    host,
    port: value.port,
    decision: value.decision,
    reason: value.reason,
  });
}

interface Coalesced {
  readonly notification: Omit<NetworkBlockedNotification, "count">;
  count: number;
  timer: NodeJS.Timeout | undefined;
}

/** Audits every decision while coalescing only the lower-trust browser projection. */
export class NetworkDecisionAuditor {
  readonly #listeners = new Set<NetworkBlockedListener>();
  readonly #coalesced = new Map<string, Coalesced>();
  #closed = false;

  constructor(
    private readonly context: Readonly<NetworkAuditContext>,
    private readonly sink: NetworkDiagnosticSink,
    private readonly notificationWindowMs = 1_000,
  ) {
    if (!validIdentity(context.workspaceId) || !validIdentity(context.conversationId) ||
        !validPolicySetId(context.policySetId) ||
        !Number.isSafeInteger(notificationWindowMs) || notificationWindowMs <= 0) {
      throw new TypeError("invalid network audit context");
    }
  }

  subscribe(listener: NetworkBlockedListener): () => void {
    if (this.#closed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  record(decision: NetworkDecision): void {
    if (this.#closed) return;
    const event = validateNetworkAuditEvent({
      timestamp: Date.now(),
      workspaceId: this.context.workspaceId,
      conversationId: this.context.conversationId,
      policySetId: this.context.policySetId,
      protocol: decision.protocol,
      host: decision.host,
      port: decision.port,
      decision: decision.decision,
      reason: decision.reason,
    });
    try { this.sink(event); } catch { /* diagnostics cannot influence enforcement */ }
    if (event.decision === "allow") return;

    const reason = event.reason as Exclude<NetworkAuditReason, "allowlist">;
    const key = `${event.conversationId}\0${event.protocol}\0${event.host}\0${event.port}\0${reason}`;
    const existing = this.#coalesced.get(key);
    if (existing === undefined) {
      const notification = Object.freeze({
        protocol: event.protocol,
        host: event.host,
        port: event.port,
        reason,
      });
      const entry: Coalesced = { notification, count: 1, timer: undefined };
      this.#coalesced.set(key, entry);
      this.#notify(notification);
      entry.timer = setTimeout(() => this.#flush(key), this.notificationWindowMs);
      entry.timer.unref();
    } else {
      existing.count += 1;
    }
  }

  #flush(key: string): void {
    const entry = this.#coalesced.get(key);
    if (entry === undefined) return;
    this.#coalesced.delete(key);
    if (!this.#closed && entry.count > 1) {
      this.#notify({ ...entry.notification, occurrenceCount: entry.count });
    }
  }

  #notify(notification: NetworkBlockedNotification): void {
    const validated = Object.freeze({ ...notification });
    for (const listener of this.#listeners) {
      try { listener(validated); } catch { /* observers have no authority */ }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const entry of this.#coalesced.values()) {
      if (entry.timer !== undefined) clearTimeout(entry.timer);
    }
    this.#coalesced.clear();
    this.#listeners.clear();
  }
}
