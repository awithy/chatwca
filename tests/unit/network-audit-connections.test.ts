import net, { type Socket } from "node:net";
import { Duplex } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  NetworkDecisionAuditor,
  validateNetworkAuditEvent,
  type NetworkPolicyAuditEvent,
} from "../../src/server/network/audit.js";
import {
  ConnectionAdmission,
  StreamBudget,
  relayBidirectional,
} from "../../src/server/network/connections.js";

describe("managed-network audit", () => {
  it("validates a closed redacted record and audits every decision", () => {
    const events: NetworkPolicyAuditEvent[] = [];
    const auditor = new NetworkDecisionAuditor(
      { workspaceId: "workspace-1", conversationId: "conversation-1", policySetId: "default" },
      (event) => events.push(event),
    );
    auditor.record({ protocol: "http", host: "example.com", port: 80, decision: "allow", reason: "allowlist" });
    auditor.record({ protocol: "https-connect", host: "example.com", port: 443, decision: "deny", reason: "not_allowed" });
    expect(events).toHaveLength(2);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.keys(events[0]!).sort()).toEqual([
      "conversationId", "decision", "host", "policySetId", "port", "protocol", "reason", "timestamp", "workspaceId",
    ]);
    expect(JSON.stringify(events)).not.toMatch(/url|header|body|address|credential|path/i);
    auditor.close();
  });

  it("coalesces only browser notifications while retaining every server audit", async () => {
    vi.useFakeTimers();
    try {
      const sink = vi.fn();
      const browser = vi.fn();
      const auditor = new NetworkDecisionAuditor(
        { workspaceId: "workspace-1", conversationId: "conversation-1", policySetId: "github" }, sink, 100,
      );
      auditor.subscribe(browser);
      for (let count = 0; count < 3; count += 1) {
        auditor.record({ protocol: "socks5-tcp", host: "blocked.example", port: 443, decision: "deny", reason: "explicit_deny" });
      }
      expect(sink).toHaveBeenCalledTimes(3);
      expect(browser).toHaveBeenCalledTimes(1);
      expect(browser).toHaveBeenLastCalledWith(expect.not.objectContaining({ occurrenceCount: expect.anything() }));
      await vi.advanceTimersByTimeAsync(100);
      expect(browser).toHaveBeenCalledTimes(2);
      expect(browser).toHaveBeenLastCalledWith(expect.objectContaining({ occurrenceCount: 3 }));
      auditor.close();
    } finally { vi.useRealTimers(); }
  });

  it("rejects records containing noncanonical or invalid fields before a sink can see them", () => {
    const base: NetworkPolicyAuditEvent = {
      timestamp: Date.now(), workspaceId: "workspace", conversationId: "conversation",
      policySetId: "default", protocol: "http", host: "example.com", port: 80,
      decision: "allow", reason: "allowlist",
    };
    expect(() => validateNetworkAuditEvent({ ...base, host: "EXAMPLE.com" })).toThrow();
    expect(() => validateNetworkAuditEvent({ ...base, workspaceId: "workspace/path" })).toThrow();
    expect(() => validateNetworkAuditEvent({ ...base, policySetId: "Bad Set" })).toThrow();
    expect(() => validateNetworkAuditEvent({ ...base, decision: "deny" })).toThrow();
  });
});

class TestDuplex extends Duplex {
  readonly writes: Buffer[] = [];
  _read(): void { /* data is injected explicitly */ }
  _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.writes.push(Buffer.from(chunk));
    done();
  }
  receive(value: string): void { this.push(Buffer.from(value)); }
}

describe("shared connection controls", () => {
  it("bounds admission and makes release/stop idempotent", () => {
    const admission = new ConnectionAdmission(1);
    const release = admission.acquire();
    expect(release).not.toBeNull();
    expect(admission.acquire()).toBeNull();
    release!(); release!();
    expect(admission.active).toBe(0);
    expect(admission.acquire()).not.toBeNull();
    admission.stop();
    expect(admission.acquire()).toBeNull();
  });

  it("relays both directions, propagates half-close, and closes on aggregate byte overflow", async () => {
    const left = new TestDuplex({ allowHalfOpen: true });
    const right = new TestDuplex({ allowHalfOpen: true });
    const close = vi.fn();
    relayBidirectional(left, right, { idleTimeoutMs: 1_000, maxBytes: 5, onClose: close });
    left.receive("abc");
    await vi.waitFor(() => expect(Buffer.concat(right.writes).toString()).toBe("abc"));
    right.receive("def");
    await vi.waitFor(() => expect(left.destroyed).toBe(true));
    expect(right.destroyed).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("propagates a real socket half-close without dropping the reverse direction", async () => {
    let left: Socket | undefined;
    let right: Socket | undefined;
    const leftServer = net.createServer({ allowHalfOpen: true });
    const rightServer = net.createServer({ allowHalfOpen: true });
    const ready = new Promise<void>((resolve) => {
      const maybeRelay = () => {
        if (left === undefined || right === undefined) return;
        relayBidirectional(left, right, { idleTimeoutMs: 1_000, maxBytes: 1_000 });
        resolve();
      };
      leftServer.on("connection", (socket) => { left = socket; maybeRelay(); });
      rightServer.on("connection", (socket) => { right = socket; maybeRelay(); });
    });
    await Promise.all([
      new Promise<void>((resolve) => leftServer.listen(0, "127.0.0.1", resolve)),
      new Promise<void>((resolve) => rightServer.listen(0, "127.0.0.1", resolve)),
    ]);
    const leftClient = new net.Socket({ allowHalfOpen: true });
    const rightClient = new net.Socket({ allowHalfOpen: true });
    leftClient.connect({ port: (leftServer.address() as net.AddressInfo).port, host: "127.0.0.1" });
    rightClient.connect({ port: (rightServer.address() as net.AddressInfo).port, host: "127.0.0.1" });
    await ready;
    const leftChunks: Buffer[] = [];
    const rightChunks: Buffer[] = [];
    leftClient.on("data", (chunk) => leftChunks.push(chunk));
    rightClient.on("data", (chunk) => rightChunks.push(chunk));
    leftClient.end("request");
    await new Promise<void>((resolve) => rightClient.once("end", resolve));
    expect(Buffer.concat(rightChunks).toString()).toBe("request");
    rightClient.end("response");
    await new Promise<void>((resolve) => leftClient.once("end", resolve));
    expect(Buffer.concat(leftChunks).toString()).toBe("response");
    leftClient.destroy(); rightClient.destroy();
    await Promise.all([
      new Promise<void>((resolve) => leftServer.close(() => resolve())),
      new Promise<void>((resolve) => rightServer.close(() => resolve())),
    ]);
  });

  it("enforces aggregate HTTP stream bytes and idle deadlines", async () => {
    const closed = vi.fn();
    const budget = new StreamBudget(20, 4, closed);
    expect(budget.account(Buffer.from("1234"))).toBe(true);
    expect(budget.account(Buffer.from("5"))).toBe(false);
    expect(closed).toHaveBeenCalledOnce();

    const idle = vi.fn();
    new StreamBudget(10, 100, idle);
    await vi.waitFor(() => expect(idle).toHaveBeenCalledOnce());
  });
});
