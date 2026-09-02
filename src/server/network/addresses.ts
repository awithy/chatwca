/** Canonical, byte-based IP parsing and classification for managed egress. */

export type IpFamily = 4 | 6;

export type NonPublicAddressCategory =
  | "unspecified"
  | "private"
  | "loopback"
  | "link_local"
  | "carrier_grade_nat"
  | "documentation"
  | "benchmark"
  | "multicast"
  | "reserved";

export interface ParsedIpAddress {
  readonly address: string;
  readonly family: IpFamily;
  readonly bytes: readonly number[];
  /** Present when the input is an IPv4-mapped IPv6 address. */
  readonly mappedIpv4: string | null;
}

export interface AddressClassification extends ParsedIpAddress {
  readonly isPublic: boolean;
  readonly category: "public" | NonPublicAddressCategory;
}

interface AddressRange {
  readonly prefix: string;
  readonly prefixLength: number;
  readonly category: NonPublicAddressCategory;
}

/*
 * These tables deliberately spell out the special-use ranges enforced by the
 * proxy. Broad reserved blocks are preferred over exception-prone string
 * checks: managed egress fails closed for protocol-assignment address space.
 */
function immutableRanges(ranges: readonly AddressRange[]): readonly AddressRange[] {
  return Object.freeze(ranges.map((range) => Object.freeze({ ...range })));
}

export const IPV4_NON_PUBLIC_RANGES: readonly AddressRange[] = immutableRanges([
  { prefix: "0.0.0.0", prefixLength: 8, category: "unspecified" },
  { prefix: "10.0.0.0", prefixLength: 8, category: "private" },
  { prefix: "100.64.0.0", prefixLength: 10, category: "carrier_grade_nat" },
  { prefix: "127.0.0.0", prefixLength: 8, category: "loopback" },
  { prefix: "169.254.0.0", prefixLength: 16, category: "link_local" },
  { prefix: "172.16.0.0", prefixLength: 12, category: "private" },
  { prefix: "192.0.0.0", prefixLength: 24, category: "reserved" },
  { prefix: "192.0.2.0", prefixLength: 24, category: "documentation" },
  { prefix: "192.88.99.0", prefixLength: 24, category: "reserved" },
  { prefix: "192.168.0.0", prefixLength: 16, category: "private" },
  { prefix: "198.18.0.0", prefixLength: 15, category: "benchmark" },
  { prefix: "198.51.100.0", prefixLength: 24, category: "documentation" },
  { prefix: "203.0.113.0", prefixLength: 24, category: "documentation" },
  { prefix: "224.0.0.0", prefixLength: 4, category: "multicast" },
  { prefix: "240.0.0.0", prefixLength: 4, category: "reserved" },
]);

export const IPV6_NON_PUBLIC_RANGES: readonly AddressRange[] = immutableRanges([
  { prefix: "::", prefixLength: 96, category: "reserved" },
  { prefix: "64:ff9b::", prefixLength: 96, category: "reserved" },
  { prefix: "64:ff9b:1::", prefixLength: 48, category: "reserved" },
  { prefix: "100::", prefixLength: 64, category: "reserved" },
  { prefix: "2001:2::", prefixLength: 48, category: "benchmark" },
  { prefix: "2001:10::", prefixLength: 28, category: "reserved" },
  { prefix: "2001:20::", prefixLength: 28, category: "reserved" },
  { prefix: "2001::", prefixLength: 23, category: "reserved" },
  { prefix: "2001:db8::", prefixLength: 32, category: "documentation" },
  { prefix: "2002::", prefixLength: 16, category: "reserved" },
  { prefix: "3fff::", prefixLength: 20, category: "documentation" },
  { prefix: "5f00::", prefixLength: 16, category: "reserved" },
  { prefix: "fc00::", prefixLength: 7, category: "private" },
  { prefix: "fe80::", prefixLength: 10, category: "link_local" },
  { prefix: "ff00::", prefixLength: 8, category: "multicast" },
]);

function parseIpv4(input: string): Uint8Array | null {
  const parts = input.split(".");
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || !/^(?:0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

function parseHextetSequence(input: string, allowIpv4: boolean): number[] | null {
  if (input.length === 0) return [];
  const parts = input.split(":");
  const words: number[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === undefined || part.length === 0) return null;
    if (part.includes(".")) {
      if (!allowIpv4 || index !== parts.length - 1) return null;
      const ipv4 = parseIpv4(part);
      if (ipv4 === null) return null;
      words.push((ipv4[0]! << 8) | ipv4[1]!, (ipv4[2]! << 8) | ipv4[3]!);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

function parseIpv6(input: string): Uint8Array | null {
  if (input.length === 0 || input.includes("%")) return null;
  const compression = input.indexOf("::");
  if (compression !== -1 && input.indexOf("::", compression + 2) !== -1) return null;

  let words: number[];
  if (compression === -1) {
    const parsed = parseHextetSequence(input, true);
    if (parsed === null || parsed.length !== 8) return null;
    words = parsed;
  } else {
    const left = parseHextetSequence(input.slice(0, compression), false);
    const right = parseHextetSequence(input.slice(compression + 2), true);
    if (left === null || right === null || left.length + right.length >= 8) return null;
    words = [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    bytes[index * 2] = word >>> 8;
    bytes[index * 2 + 1] = word & 0xff;
  }
  return bytes;
}

function formatIpv4(bytes: Uint8Array): string {
  return Array.from(bytes).join(".");
}

function formatIpv6(bytes: Uint8Array): string {
  const words = new Array<number>(8);
  for (let index = 0; index < 8; index += 1) {
    words[index] = (bytes[index * 2]! << 8) | bytes[index * 2 + 1]!;
  }

  let bestStart = -1;
  let bestLength = 0;
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) {
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < words.length && words[end] === 0) end += 1;
    const length = end - index;
    if (length >= 2 && length > bestLength) {
      bestStart = index;
      bestLength = length;
    }
    index = end;
  }

  if (bestStart === -1) return words.map((word) => word!.toString(16)).join(":");
  const left = words.slice(0, bestStart).map((word) => word!.toString(16)).join(":");
  const right = words.slice(bestStart + bestLength).map((word) => word!.toString(16)).join(":");
  if (left.length === 0 && right.length === 0) return "::";
  if (left.length === 0) return `::${right}`;
  if (right.length === 0) return `${left}::`;
  return `${left}::${right}`;
}

function mappedIpv4(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length !== 16) return null;
  for (let index = 0; index < 10; index += 1) {
    if (bytes[index] !== 0) return null;
  }
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return null;
  return bytes.slice(12);
}

/** Parse only unambiguous, complete IPv4 and IPv6 literals. */
export function parseIpAddress(input: string): ParsedIpAddress | null {
  if (input.length === 0 || input.trim() !== input || input.startsWith("[") || input.endsWith("]")) {
    return null;
  }
  const ipv4 = parseIpv4(input);
  if (ipv4 !== null) {
    return Object.freeze({
      address: formatIpv4(ipv4),
      family: 4 as const,
      bytes: Object.freeze([...ipv4]),
      mappedIpv4: null,
    });
  }
  const ipv6 = parseIpv6(input);
  if (ipv6 === null) return null;
  const mapped = mappedIpv4(ipv6);
  return Object.freeze({
    address: formatIpv6(ipv6),
    family: 6 as const,
    bytes: Object.freeze([...ipv6]),
    mappedIpv4: mapped === null ? null : formatIpv4(mapped),
  });
}

function matchesPrefix(bytes: readonly number[], rangeBytes: readonly number[], prefixLength: number): boolean {
  const wholeBytes = Math.floor(prefixLength / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== rangeBytes[index]) return false;
  }
  const remainingBits = prefixLength % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return (bytes[wholeBytes]! & mask) === (rangeBytes[wholeBytes]! & mask);
}

function categoryInRanges(
  parsed: ParsedIpAddress,
  ranges: readonly AddressRange[],
): NonPublicAddressCategory | null {
  for (const range of ranges) {
    const rangeAddress = parseIpAddress(range.prefix);
    if (rangeAddress === null || rangeAddress.family !== parsed.family) {
      throw new Error("invalid internal address range");
    }
    if (matchesPrefix(parsed.bytes, rangeAddress.bytes, range.prefixLength)) return range.category;
  }
  return null;
}

function classifyParsedIpv4(parsed: ParsedIpAddress): "public" | NonPublicAddressCategory {
  return categoryInRanges(parsed, IPV4_NON_PUBLIC_RANGES) ?? "public";
}

/** Classify a parsed literal. IPv4-mapped IPv6 follows its mapped IPv4 scope. */
export function classifyParsedAddress(parsed: ParsedIpAddress): AddressClassification {
  let category: "public" | NonPublicAddressCategory;
  if (parsed.family === 4) {
    category = classifyParsedIpv4(parsed);
  } else if (parsed.mappedIpv4 !== null) {
    const mapped = parseIpAddress(parsed.mappedIpv4);
    if (mapped === null) throw new Error("invalid internal mapped IPv4 address");
    category = classifyParsedIpv4(mapped);
  } else {
    category = categoryInRanges(parsed, IPV6_NON_PUBLIC_RANGES) ??
      (matchesPrefix(parsed.bytes, parseIpAddress("2000::")!.bytes, 3) ? "public" : "reserved");

    // Give the two singleton addresses precise classifications inside ::/96.
    if (parsed.address === "::") category = "unspecified";
    if (parsed.address === "::1") category = "loopback";
  }
  return Object.freeze({ ...parsed, isPublic: category === "public", category });
}

export function classifyIpAddress(input: string): AddressClassification | null {
  const parsed = parseIpAddress(input);
  return parsed === null ? null : classifyParsedAddress(parsed);
}
