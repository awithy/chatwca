import { Socket } from "node:net";

import { describe, expect, it, vi } from "vitest";

import { normalizeDestinationHost } from "../../src/server/network/policy.js";
import {
  BoundedPinnedResolver,
  NodeNumericAddressDialer,
  PinnedConnectionError,
  PinnedDestinationConnector,
  createSetupDeadline,
  type AddressLookup,
  type NumericAddressDialer,
  type PinnedAddress,
} from "../../src/server/network/resolver.js";

function lookup(implementation: AddressLookup["lookup"]): AddressLookup {
  return { lookup: implementation };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toMatchObject({
    name: "PinnedConnectionError",
    code,
  });
}

describe("bounded pinned destination resolver", () => {
  it("skips DNS for an allowed public numeric literal", async () => {
    const resolverLookup = vi.fn(async () => [{ address: "1.1.1.1", family: 4 as const }]);
    const resolver = new BoundedPinnedResolver(lookup(resolverLookup));
    await expect(resolver.resolve(
      normalizeDestinationHost("2001:4860:4860::8888"),
      createSetupDeadline(1_000),
    )).resolves.toEqual({ address: "2001:4860:4860::8888", family: 6 });
    expect(resolverLookup).not.toHaveBeenCalled();
  });

  it("rejects a non-public literal even if called after a faulty policy path", async () => {
    const resolver = new BoundedPinnedResolver(lookup(vi.fn()));
    await expectCode(resolver.resolve(
      normalizeDestinationHost("169.254.169.254"),
      createSetupDeadline(1_000),
    ), "non_public_address");
  });

  it("resolves once with all answers, canonicalizes, deduplicates, and selects deterministically", async () => {
    const resolverLookup = vi.fn(async () => [
      { address: "2606:4700:4700:0:0:0:0:1111", family: 6 as const },
      { address: "8.8.4.4", family: 4 as const },
      { address: "8.8.8.8", family: 4 as const },
      { address: "8.8.4.4", family: 4 as const },
    ]);
    const resolver = new BoundedPinnedResolver(lookup(resolverLookup));
    await expect(resolver.resolve(
      normalizeDestinationHost("dns.example"),
      createSetupDeadline(1_000),
    )).resolves.toEqual({ address: "8.8.4.4", family: 4 });
    expect(resolverLookup).toHaveBeenCalledOnce();
    expect(resolverLookup).toHaveBeenCalledWith("dns.example");
  });

  it.each([
    [[{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]],
    [[{ address: "10.0.0.1", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }]],
    [[{ address: "8.8.8.8", family: 4 }, { address: "::ffff:192.168.1.1", family: 6 }]],
    [[{ address: "2001:4860:4860::8888", family: 6 }, { address: "fe80::1", family: 6 }]],
  ])("rejects the entire mixed public/non-public answer set %#", async (answers) => {
    const resolver = new BoundedPinnedResolver(lookup(async () => answers));
    await expectCode(resolver.resolve(
      normalizeDestinationHost("mixed.example"),
      createSetupDeadline(1_000),
    ), "non_public_address");
  });

  it("does not cache across connections and fails closed on a rebinding answer", async () => {
    const resolverLookup = vi.fn()
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    const resolver = new BoundedPinnedResolver(lookup(resolverLookup));
    const host = normalizeDestinationHost("rebind.example");
    await expect(resolver.resolve(host, createSetupDeadline(1_000)))
      .resolves.toEqual({ address: "8.8.8.8", family: 4 });
    await expectCode(resolver.resolve(host, createSetupDeadline(1_000)), "non_public_address");
    expect(resolverLookup).toHaveBeenCalledTimes(2);
  });

  it("distinguishes failure, empty, malformed, and timeout results", async () => {
    const host = normalizeDestinationHost("failure.example");
    await expectCode(new BoundedPinnedResolver(lookup(async () => {
      throw new Error("resolver details must not escape");
    })).resolve(host, createSetupDeadline(1_000)), "dns_failure");
    await expectCode(new BoundedPinnedResolver(lookup(async () => [])).resolve(
      host,
      createSetupDeadline(1_000),
    ), "dns_empty");
    await expectCode(new BoundedPinnedResolver(lookup(async () => [
      { address: "8.8.8.8", family: 6 },
    ])).resolve(host, createSetupDeadline(1_000)), "dns_failure");
    await expectCode(new BoundedPinnedResolver(lookup(() => new Promise(() => {}))).resolve(
      host,
      createSetupDeadline(20),
    ), "dns_timeout");
  });
});

describe("pinned destination connector", () => {
  it("makes the production dialer reject hostnames, family confusion, and non-public numbers", async () => {
    const dialer = new NodeNumericAddressDialer();
    await expectCode(dialer.dial(
      { address: "origin.example", family: 4 },
      443,
      createSetupDeadline(1_000),
    ), "connect_failure");
    await expectCode(dialer.dial(
      { address: "8.8.8.8", family: 6 },
      443,
      createSetupDeadline(1_000),
    ), "connect_failure");
    await expectCode(dialer.dial(
      { address: "127.0.0.1", family: 4 },
      443,
      createSetupDeadline(1_000),
    ), "connect_failure");
  });

  it("passes only the selected canonical numeric address and family to the dialer", async () => {
    const resolver = new BoundedPinnedResolver(lookup(async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "1.1.1.1", family: 4 },
    ]));
    const calls: Array<{ address: PinnedAddress; port: number; wasNumeric: boolean }> = [];
    const dialer: NumericAddressDialer = {
      dial: async (address, port) => {
        calls.push({
          address,
          port,
          wasNumeric: normalizeDestinationHost(address.address).kind === "ip",
        });
        return new Socket();
      },
    };
    const connector = new PinnedDestinationConnector(resolver, dialer);
    const connection = await connector.connect(
      normalizeDestinationHost("origin.example"),
      443,
      createSetupDeadline(1_000),
    );

    expect(calls).toEqual([{
      address: { address: "1.1.1.1", family: 4 },
      port: 443,
      wasNumeric: true,
    }]);
    expect(connection.address).toEqual({ address: "1.1.1.1", family: 4 });
    connection.socket.destroy();
  });

  it("uses one aggregate deadline across resolution and numeric connection", async () => {
    const resolver = new BoundedPinnedResolver(lookup(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return [{ address: "8.8.8.8", family: 4 }];
    }));
    let remainingAtDial = Number.POSITIVE_INFINITY;
    const dialer: NumericAddressDialer = {
      dial: async (_address, _port, deadline) => {
        remainingAtDial = deadline.remainingMs();
        throw new PinnedConnectionError("connect_timeout");
      },
    };
    const connector = new PinnedDestinationConnector(resolver, dialer);
    await expectCode(connector.connect(
      normalizeDestinationHost("slow.example"),
      443,
      createSetupDeadline(100),
    ), "connect_timeout");
    expect(remainingAtDial).toBeGreaterThan(0);
    expect(remainingAtDial).toBeLessThan(90);
  });
});
