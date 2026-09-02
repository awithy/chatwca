import { describe, expect, it } from "vitest";

import {
  IPV4_NON_PUBLIC_RANGES,
  IPV6_NON_PUBLIC_RANGES,
  classifyIpAddress,
  parseIpAddress,
} from "../../src/server/network/addresses.js";

function toBigInt(address: string): bigint {
  const parsed = parseIpAddress(address)!;
  return [...parsed.bytes].reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

function fromBigInt(value: bigint, family: 4 | 6): string {
  const length = family === 4 ? 4 : 16;
  const bytes = new Uint8Array(length);
  let remaining = value;
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  if (family === 4) return [...bytes].join(".");
  const raw = Array.from({ length: 8 }, (_, index) =>
    ((bytes[index * 2]! << 8) | bytes[index * 2 + 1]!).toString(16)
  ).join(":");
  return parseIpAddress(raw)!.address;
}

function rangeBounds(prefix: string, prefixLength: number) {
  const parsed = parseIpAddress(prefix)!;
  const bits = BigInt(parsed.bytes.length * 8);
  const hostBits = bits - BigInt(prefixLength);
  const start = (toBigInt(prefix) >> hostBits) << hostBits;
  const end = start + (1n << hostBits) - 1n;
  return { family: parsed.family, start, end, maximum: (1n << bits) - 1n };
}

describe("managed-network IP address parsing", () => {
  it.each([
    ["192.168.001.1", null],
    ["127.1", null],
    ["2130706433", null],
    ["0x7f000001", null],
    ["1.2.3.256", null],
    [" 1.2.3.4", null],
    ["2001::db8::1", null],
    ["2001:db8:0:0:0:0:0", null],
    ["2001:db8:0:0:0:0:0:0:1", null],
    ["fe80::1%eth0", null],
    ["[2001:db8::1]", null],
  ])("rejects malformed or ambiguous literal %s", (input, expected) => {
    expect(parseIpAddress(input)).toBe(expected);
  });

  it.each([
    ["192.000.2.1", null],
    ["192.0.2.1", "192.0.2.1"],
    ["2001:0DB8:0000:0000:0001:0000:0000:0001", "2001:db8::1:0:0:1"],
    ["2001:db8:0:1:0:0:0:1", "2001:db8:0:1::1"],
    ["0:0:0:0:0:ffff:8.8.8.8", "::ffff:808:808"],
  ])("canonically parses %s", (input, expected) => {
    expect(parseIpAddress(input)?.address ?? null).toBe(expected);
  });

  it("does not expose mutable parsed address bytes", () => {
    const parsed = parseIpAddress("8.8.8.8")!;
    expect(Object.isFrozen(parsed.bytes)).toBe(true);
    expect(() => ((parsed.bytes as number[])[0] = 127)).toThrow();
    expect(parsed.address).toBe("8.8.8.8");
  });

  it("classifies mapped IPv4 according to the embedded IPv4", () => {
    expect(classifyIpAddress("::ffff:127.0.0.1")).toMatchObject({
      address: "::ffff:7f00:1",
      family: 6,
      mappedIpv4: "127.0.0.1",
      isPublic: false,
      category: "loopback",
    });
    expect(classifyIpAddress("::ffff:8.8.8.8")).toMatchObject({
      mappedIpv4: "8.8.8.8",
      isPublic: true,
      category: "public",
    });
  });
});

describe("managed-network special address classification", () => {
  it("rejects every IPv4 range at its immediate lower, start, end, and upper boundaries", () => {
    for (const range of IPV4_NON_PUBLIC_RANGES) {
      const { family, start, end, maximum } = rangeBounds(range.prefix, range.prefixLength);
      expect(family).toBe(4);
      const candidates = [
        ...(start > 0n ? [start - 1n] : []),
        start,
        end,
        ...(end < maximum ? [end + 1n] : []),
      ];
      for (const candidate of candidates) {
        const address = fromBigInt(candidate, 4);
        const expectedPublic = !IPV4_NON_PUBLIC_RANGES.some((other) => {
          const bounds = rangeBounds(other.prefix, other.prefixLength);
          return candidate >= bounds.start && candidate <= bounds.end;
        });
        expect(classifyIpAddress(address)?.isPublic, `${range.prefix}/${range.prefixLength}: ${address}`)
          .toBe(expectedPublic);
      }
    }
  });

  it("rejects every IPv6 range at its immediate lower, start, end, and upper boundaries", () => {
    for (const range of IPV6_NON_PUBLIC_RANGES) {
      const { family, start, end, maximum } = rangeBounds(range.prefix, range.prefixLength);
      expect(family).toBe(6);
      const candidates = [
        ...(start > 0n ? [start - 1n] : []),
        start,
        end,
        ...(end < maximum ? [end + 1n] : []),
      ];
      for (const candidate of candidates) {
        const address = fromBigInt(candidate, 6);
        const inSpecialRange = IPV6_NON_PUBLIC_RANGES.some((other) => {
          const bounds = rangeBounds(other.prefix, other.prefixLength);
          return candidate >= bounds.start && candidate <= bounds.end;
        });
        const inGlobalUnicast = candidate >= toBigInt("2000::") && candidate <= toBigInt("3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff");
        expect(classifyIpAddress(address)?.isPublic, `${range.prefix}/${range.prefixLength}: ${address}`)
          .toBe(inGlobalUnicast && !inSpecialRange);
      }
    }
  });

  it.each([
    ["0.0.0.0", "unspecified"],
    ["10.255.255.255", "private"],
    ["100.127.255.255", "carrier_grade_nat"],
    ["127.255.255.255", "loopback"],
    ["169.254.169.254", "link_local"],
    ["198.19.255.255", "benchmark"],
    ["192.0.2.255", "documentation"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fc00::1", "private"],
    ["fe80::1", "link_local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["2001:2::1", "benchmark"],
  ])("classifies %s as %s", (address, category) => {
    expect(classifyIpAddress(address)).toMatchObject({ isPublic: false, category });
  });

  it.each(["1.0.0.0", "8.8.8.8", "100.63.255.255", "100.128.0.0", "172.15.255.255", "172.32.0.0", "2001:4860:4860::8888", "2606:4700:4700::1111"])(
    "allows global address %s",
    (address) => expect(classifyIpAddress(address)).toMatchObject({ isPublic: true, category: "public" }),
  );
});
