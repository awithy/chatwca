import type { LookupAddress } from "node:dns";
import { lookup as dnsLookup } from "node:dns/promises";
import net, { type Socket } from "node:net";
import { performance } from "node:perf_hooks";

import {
  classifyParsedAddress,
  parseIpAddress,
  type IpFamily,
} from "./addresses.js";
import type { NormalizedDestinationHost } from "./policy.js";

export type ResolutionFailureCode =
  | "dns_timeout"
  | "dns_failure"
  | "dns_empty"
  | "non_public_address"
  | "connect_timeout"
  | "connect_failure";

export class PinnedConnectionError extends Error {
  constructor(readonly code: ResolutionFailureCode) {
    super(code);
    this.name = "PinnedConnectionError";
  }
}

export interface SetupDeadline {
  readonly expiresAt: number;
  remainingMs(): number;
}

export interface PinnedAddress {
  readonly address: string;
  readonly family: IpFamily;
}

export interface AddressLookup {
  lookup(hostname: string): Promise<readonly LookupAddress[]>;
}

export interface PinnedAddressResolver {
  resolve(host: NormalizedDestinationHost, deadline: SetupDeadline): Promise<PinnedAddress>;
}

export interface NumericAddressDialer {
  dial(address: PinnedAddress, port: number, deadline: SetupDeadline): Promise<Socket>;
}

export interface PinnedConnection {
  readonly socket: Socket;
  readonly address: PinnedAddress;
}

function now(): number {
  return performance.now();
}

export function createSetupDeadline(timeoutMs: number): SetupDeadline {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("setup timeout must be a positive safe integer");
  }
  const expiresAt = now() + timeoutMs;
  return Object.freeze({
    expiresAt,
    remainingMs: () => Math.max(0, expiresAt - now()),
  });
}

function timeoutPromise<T>(
  operation: Promise<T>,
  deadline: SetupDeadline,
  code: "dns_timeout" | "connect_timeout",
): Promise<T> {
  const remaining = deadline.remainingMs();
  if (remaining <= 0) return Promise.reject(new PinnedConnectionError(code));
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new PinnedConnectionError(code)), Math.max(1, remaining));
    timer.unref();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const systemLookup: AddressLookup = Object.freeze({
  lookup: async (hostname: string) => dnsLookup(hostname, {
    all: true,
    order: "verbatim",
  }),
});

function compareAddresses(left: PinnedAddress, right: PinnedAddress): number {
  if (left.family !== right.family) return left.family - right.family;
  const leftBytes = parseIpAddress(left.address)!.bytes;
  const rightBytes = parseIpAddress(right.address)!.bytes;
  for (let index = 0; index < leftBytes.length; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Resolves exactly once, validates the complete answer set, and selects a numeric address. */
export class BoundedPinnedResolver implements PinnedAddressResolver {
  constructor(private readonly addressLookup: AddressLookup = systemLookup) {}

  async resolve(
    host: NormalizedDestinationHost,
    deadline: SetupDeadline,
  ): Promise<PinnedAddress> {
    if (host.kind === "ip") {
      const parsed = parseIpAddress(host.host);
      if (parsed === null || host.family === null || parsed.family !== host.family) {
        throw new PinnedConnectionError("dns_failure");
      }
      const classified = classifyParsedAddress(parsed);
      if (!classified.isPublic) throw new PinnedConnectionError("non_public_address");
      return Object.freeze({ address: classified.address, family: classified.family });
    }

    let answers: readonly LookupAddress[];
    try {
      answers = await timeoutPromise(
        Promise.resolve().then(() => this.addressLookup.lookup(host.host)),
        deadline,
        "dns_timeout",
      );
    } catch (error) {
      if (error instanceof PinnedConnectionError) throw error;
      throw new PinnedConnectionError("dns_failure");
    }
    if (answers.length === 0) throw new PinnedConnectionError("dns_empty");

    const deduplicated = new Map<string, PinnedAddress>();
    for (const answer of answers) {
      const parsed = parseIpAddress(answer.address);
      if (parsed === null || parsed.family !== answer.family) {
        throw new PinnedConnectionError("dns_failure");
      }
      const classified = classifyParsedAddress(parsed);
      if (!classified.isPublic) throw new PinnedConnectionError("non_public_address");
      const pinned = Object.freeze({ address: classified.address, family: classified.family });
      deduplicated.set(`${pinned.family}:${pinned.address}`, pinned);
    }
    if (deduplicated.size === 0) throw new PinnedConnectionError("dns_empty");
    return [...deduplicated.values()].sort(compareAddresses)[0]!;
  }
}

export class NodeNumericAddressDialer implements NumericAddressDialer {
  async dial(address: PinnedAddress, port: number, deadline: SetupDeadline): Promise<Socket> {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new PinnedConnectionError("connect_failure");
    }
    const parsed = parseIpAddress(address.address);
    if (parsed === null || parsed.family !== address.family) {
      throw new PinnedConnectionError("connect_failure");
    }
    const classified = classifyParsedAddress(parsed);
    if (!classified.isPublic) throw new PinnedConnectionError("connect_failure");

    // Supplying family and a canonical numeric host prevents any hostname
    // lookup in Node's connection path.
    const socket = net.createConnection({
      host: classified.address,
      port,
      family: classified.family,
    });
    const operation = new Promise<Socket>((resolve, reject) => {
      socket.once("connect", () => resolve(socket));
      socket.once("error", reject);
    });
    try {
      return await timeoutPromise(operation, deadline, "connect_timeout");
    } catch (error) {
      socket.destroy();
      if (error instanceof PinnedConnectionError) throw error;
      throw new PinnedConnectionError("connect_failure");
    }
  }
}

/** Couples resolution and numeric dialing under one aggregate setup deadline. */
export class PinnedDestinationConnector {
  constructor(
    private readonly resolver: PinnedAddressResolver,
    private readonly dialer: NumericAddressDialer,
  ) {}

  async connect(
    host: NormalizedDestinationHost,
    port: number,
    deadline: SetupDeadline,
  ): Promise<PinnedConnection> {
    const address = await this.resolver.resolve(host, deadline);
    const socket = await this.dialer.dial(address, port, deadline);
    return Object.freeze({ socket, address });
  }
}

/** Production construction always uses system DNS and pinned numeric TCP dialing. */
export function createProductionPinnedConnector(): PinnedDestinationConnector {
  return new PinnedDestinationConnector(
    new BoundedPinnedResolver(),
    new NodeNumericAddressDialer(),
  );
}
