import { describe, expect, it } from "vitest";

import {
  DestinationPolicyError,
  compileDestinationPolicy,
  decideDestination,
  normalizeDestinationHost,
  normalizeDestinationPattern,
} from "../../src/server/network/policy.js";

function policy(
  allowedDomainPatterns: readonly string[] = ["example.com"],
  deniedDomainPatterns: readonly string[] = [],
  allowedPorts: readonly number[] = [443],
) {
  return compileDestinationPolicy({ allowedDomainPatterns, deniedDomainPatterns, allowedPorts });
}

describe("managed-network destination normalization", () => {
  it.each([
    [" Example.COM. ", "example.com", "domain"],
    ["BÜCHER.example", "xn--bcher-kva.example", "domain"],
    ["ＦＯＯ.example", "foo.example", "domain"],
    ["faß.de", "xn--fa-hia.de", "domain"],
    ["192.0.2.1", "192.0.2.1", "ip"],
    ["2001:0DB8:0:0::1", "2001:db8::1", "ip"],
    ["[2001:4860:4860::8888]", "2001:4860:4860::8888", "ip"],
  ])("normalizes %s", (input, host, kind) => {
    expect(normalizeDestinationHost(input)).toMatchObject({ host, kind });
  });

  it.each([
    "",
    ".",
    "example.com..",
    "bad..example",
    "-bad.example",
    "bad-.example",
    `${"a".repeat(64)}.example`,
    `${Array.from({ length: 128 }, () => "a").join(".")}`,
    "https://example.com",
    "example.com/path",
    "example.com?query",
    "example.com#fragment",
    "user@example.com",
    "example.com:443",
    "[example.com]",
    "[2001:db8::1]:443",
    "fe80::1%eth0",
    "127.1",
    "127.000.000.001",
    "2130706433",
    "0x7f000001",
    "0177.0.0.1",
    "bad_name.example",
    "xn--.example",
    "xn--a.example",
    "a\u200db.example",
    "\ud800.example",
    "foo\u0000.example",
    "foo\\bar.example",
  ])("rejects malformed, scoped, or ambiguous host %s", (input) => {
    expect(() => normalizeDestinationHost(input)).toThrow(DestinationPolicyError);
  });

  it("removes no more than one trailing dot", () => {
    expect(normalizeDestinationHost("example.com.").host).toBe("example.com");
    expect(() => normalizeDestinationHost("example.com..")).toThrow();
  });

  it.each([
    ["Example.com.", "example.com"],
    ["*.BÜCHER.example", "*.xn--bcher-kva.example"],
    ["**.API.example", "**.api.example"],
    ["0:0:0:0:0:ffff:8.8.8.8", "::ffff:808:808"],
  ])("normalizes configured pattern %s", (input, expected) => {
    expect(normalizeDestinationPattern(input)).toBe(expected);
  });

  it.each([
    "*",
    "***.example.com",
    "foo.*.example.com",
    "exam*ple.com",
    "*.8.8.8.8",
    "**.2001:4860::1",
    "[2001:4860::1]",
  ])("rejects invalid pattern %s", (input) => {
    expect(() => normalizeDestinationPattern(input)).toThrow(DestinationPolicyError);
  });
});

describe("managed-network destination policy", () => {
  it("implements exact, subdomain-only, and apex-plus-subdomain matching", () => {
    const exact = policy(["example.com"]);
    expect(decideDestination(exact, { host: "example.com", port: 443 }).allowed).toBe(true);
    expect(decideDestination(exact, { host: "www.example.com", port: 443 }).reason).toBe("not_allowed");

    const subdomains = policy(["*.example.com"]);
    expect(decideDestination(subdomains, { host: "example.com", port: 443 }).reason).toBe("not_allowed");
    expect(decideDestination(subdomains, { host: "www.example.com", port: 443 }).allowed).toBe(true);
    expect(decideDestination(subdomains, { host: "deep.www.example.com", port: 443 }).allowed).toBe(true);
    expect(decideDestination(subdomains, { host: "notexample.com", port: 443 }).allowed).toBe(false);

    const all = policy(["**.example.com"]);
    expect(decideDestination(all, { host: "example.com", port: 443 }).allowed).toBe(true);
    expect(decideDestination(all, { host: "deep.www.example.com", port: 443 }).allowed).toBe(true);
  });

  it("gives every matching explicit deny precedence over ports, allows, and local checks", () => {
    const compiled = policy(["**.example.com", "127.0.0.1"], ["blocked.example.com", "127.0.0.1"]);
    expect(decideDestination(compiled, { host: "BLOCKED.example.com.", port: 80 })).toMatchObject({
      allowed: false,
      reason: "explicit_deny",
      port: 80,
    });
    expect(decideDestination(compiled, { host: "127.0.0.1", port: 443 }).reason).toBe("explicit_deny");
  });

  it("evaluates port before allowlist and non-public literal checks in the specified order", () => {
    const compiled = policy(["127.0.0.1", "8.8.8.8"]);
    expect(decideDestination(compiled, { host: "8.8.8.8", port: 80 }).reason).toBe("port_not_allowed");
    expect(decideDestination(compiled, { host: "127.0.0.1", port: 443 }).reason).toBe("local_address");
    expect(decideDestination(policy(["8.8.8.8"]), { host: "127.0.0.1", port: 443 }).reason).toBe("not_allowed");
  });

  it("matches IP literals exactly and never through domain wildcards", () => {
    expect(decideDestination(policy(["**.8.8.8.example"]), { host: "8.8.8.8", port: 443 }).reason)
      .toBe("not_allowed");
    expect(decideDestination(policy(["8.8.8.8"]), { host: "8.8.8.8", port: 443 })).toMatchObject({
      allowed: true,
      reason: "allowlist",
    });
    expect(decideDestination(policy(["::ffff:8.8.8.8"]), { host: "8.8.8.8", port: 443 }).reason)
      .toBe("not_allowed");
  });

  it("exposes immutable compiled patterns and port membership", () => {
    const compiled = policy(["example.com"]);
    expect(Object.isFrozen(compiled.allowedPatterns)).toBe(true);
    expect((compiled.allowedPorts as Set<number>).add).toBeUndefined();
    expect(compiled.allowedPorts.has(443)).toBe(true);
  });

  it("rejects malformed ports and duplicate normalized policy entries", () => {
    for (const port of [0, 65536, 1.5, Number.NaN]) {
      expect(() => decideDestination(policy(), { host: "example.com", port })).toThrow(DestinationPolicyError);
    }
    expect(() => compileDestinationPolicy({
      allowedDomainPatterns: ["EXAMPLE.com", "example.com."],
      deniedDomainPatterns: [],
      allowedPorts: [443],
    })).toThrow(/duplicate/);
    expect(() => compileDestinationPolicy({
      allowedDomainPatterns: ["example.com"],
      deniedDomainPatterns: [],
      allowedPorts: [443, 443],
    })).toThrow(/duplicate/);
  });
});
