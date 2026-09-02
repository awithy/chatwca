import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  DEFAULT_NETWORK_ALLOWED_PORTS,
  DEFAULT_NETWORK_CONNECT_TIMEOUT_MS,
  DEFAULT_NETWORK_IDLE_TIMEOUT_MS,
  DEFAULT_NETWORK_MAX_CONNECTION_BYTES,
  DEFAULT_NETWORK_MAX_CONNECTIONS,
  MANAGED_EGRESS_DISCLOSURE_WARNING,
  loadManagedNetworkConfig,
  publicManagedEgressConfig,
} from "../../src/server/network/config.js";
import { ConfigurationError } from "../../src/server/config.js";

const cwd = "/tmp/chatwca-network-config";

function optional(overrides: NodeJS.ProcessEnv = {}) {
  return loadManagedNetworkConfig({
    CHATWCA_MANAGED_EGRESS_MODE: "optional",
    CHATWCA_NETWORK_ALLOWED_DOMAINS: '["Example.COM."]',
    ...overrides,
  }, "optional", { processCwd: cwd, processArch: "x64" });
}

describe("managed-network configuration", () => {
  it("is disabled by default without inspecting the configured helper path", () => {
    const helper = "/definitely/missing/chatwca-network-helper";
    const config = loadManagedNetworkConfig({
      CHATWCA_NETWORK_HELPER_PATH: helper,
    }, "disabled", { processCwd: cwd, processArch: "x64" });

    expect(config).toMatchObject({
      mode: "disabled",
      helperPath: helper,
      helperDirectory: path.dirname(helper),
      allowedDomainPatterns: [],
      deniedDomainPatterns: [],
      allowedPorts: [...DEFAULT_NETWORK_ALLOWED_PORTS],
      maxConnections: DEFAULT_NETWORK_MAX_CONNECTIONS,
      connectTimeoutMs: DEFAULT_NETWORK_CONNECT_TIMEOUT_MS,
      idleTimeoutMs: DEFAULT_NETWORK_IDLE_TIMEOUT_MS,
      maxConnectionBytes: DEFAULT_NETWORK_MAX_CONNECTION_BYTES,
    });
    expect(config.allowedPortSet.has(443)).toBe(true);
  });

  it("rejects unknown managed-egress modes", () => {
    expect(() => loadManagedNetworkConfig({
      CHATWCA_MANAGED_EGRESS_MODE: "required",
    }, "optional", { processCwd: cwd })).toThrow(
      /must be disabled or optional/,
    );
  });

  it("normalizes complete optional-mode policy and numeric limits", () => {
    const config = optional({
      CHATWCA_NETWORK_ALLOWED_DOMAINS:
        '[" Example.COM. ","*.BÜCHER.example","**.api.example","2001:0db8::1"]',
      CHATWCA_NETWORK_DENIED_DOMAINS: '["deny.EXAMPLE."]',
      CHATWCA_NETWORK_ALLOWED_PORTS: "[443,8443]",
      CHATWCA_NETWORK_MAX_CONNECTIONS: "7",
      CHATWCA_NETWORK_CONNECT_TIMEOUT_MS: "1200",
      CHATWCA_NETWORK_IDLE_TIMEOUT_MS: "3400",
      CHATWCA_NETWORK_MAX_CONNECTION_BYTES: "5600",
      CHATWCA_NETWORK_HELPER_PATH: "/opt/chatwca/bin/network-helper",
    });

    expect(config).toMatchObject({
      mode: "optional",
      helperPath: "/opt/chatwca/bin/network-helper",
      helperDirectory: "/opt/chatwca/bin",
      allowedDomainPatterns: [
        "example.com",
        "*.xn--bcher-kva.example",
        "**.api.example",
        "2001:db8::1",
      ],
      deniedDomainPatterns: ["deny.example"],
      allowedPorts: [443, 8443],
      maxConnections: 7,
      connectTimeoutMs: 1200,
      idleTimeoutMs: 3400,
      maxConnectionBytes: 5600,
    });
  });

  it("rejects optional managed egress without a sandbox or allowlist", () => {
    expect(() => loadManagedNetworkConfig({
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["example.com"]',
    }, "disabled", { processCwd: cwd })).toThrow(/requires CHATWCA_SANDBOX_MODE/);
    expect(() => loadManagedNetworkConfig({
      CHATWCA_MANAGED_EGRESS_MODE: "optional",
    }, "optional", { processCwd: cwd })).toThrow(/must contain at least one entry/);
  });

  it.each([
    ["CHATWCA_NETWORK_ALLOWED_DOMAINS", "{}"],
    ["CHATWCA_NETWORK_ALLOWED_DOMAINS", "[1]"],
    ["CHATWCA_NETWORK_DENIED_DOMAINS", '"example.com"'],
    ["CHATWCA_NETWORK_ALLOWED_PORTS", '"443"'],
  ])("rejects malformed JSON array %s", (variable, value) => {
    expect(() => optional({ [variable]: value })).toThrow(ConfigurationError);
  });

  it.each([
    "*",
    "foo.*.example",
    "https://example.com",
    "example.com/path",
    "user@example.com",
    "example.com:443",
    "bad..example",
    "-bad.example",
    "127.1",
    "fe80::1%eth0",
  ])("rejects invalid domain pattern %s", (pattern) => {
    expect(() => optional({
      CHATWCA_NETWORK_ALLOWED_DOMAINS: JSON.stringify([pattern]),
    })).toThrow(/invalid domain pattern/);
  });

  it("rejects normalized duplicates within each list while permitting deny overlap", () => {
    expect(() => optional({
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["EXAMPLE.com","example.com."]',
    })).toThrow(/normalized duplicate/);
    expect(() => optional({
      CHATWCA_NETWORK_DENIED_DOMAINS: '["BÜCHER.example","xn--bcher-kva.example"]',
    })).toThrow(/normalized duplicate/);
    expect(optional({
      CHATWCA_NETWORK_ALLOWED_DOMAINS: '["example.com"]',
      CHATWCA_NETWORK_DENIED_DOMAINS: '["EXAMPLE.COM."]',
    })).toMatchObject({
      allowedDomainPatterns: ["example.com"],
      deniedDomainPatterns: ["example.com"],
    });
  });

  it.each([
    "[0]",
    "[65536]",
    "[1.5]",
    '["443"]',
    "[443,443]",
  ])("rejects invalid allowed ports %s", (ports) => {
    expect(() => optional({ CHATWCA_NETWORK_ALLOWED_PORTS: ports })).toThrow(
      ConfigurationError,
    );
  });

  it.each([
    "CHATWCA_NETWORK_MAX_CONNECTIONS",
    "CHATWCA_NETWORK_CONNECT_TIMEOUT_MS",
    "CHATWCA_NETWORK_IDLE_TIMEOUT_MS",
    "CHATWCA_NETWORK_MAX_CONNECTION_BYTES",
  ])("requires positive safe integer %s", (variable) => {
    for (const value of ["0", "-1", "1.5", "Infinity", "9007199254740992"]) {
      expect(() => optional({ [variable]: value })).toThrow(/positive safe integer/);
    }
  });

  it("constructs a client-safe public projection only", () => {
    const projection = publicManagedEgressConfig(optional({
      CHATWCA_NETWORK_HELPER_PATH: "/private/helper",
    }), true);

    expect(projection).toMatchObject({
      mode: "optional",
      selectablePolicies: ["isolated", "managed-egress"],
      allowedDomainPatterns: ["example.com"],
      deniedDomainPatterns: [],
      allowedPorts: [80, 443],
      denyNonPublicAddresses: true,
      tlsInterception: false,
      disclosureWarning: MANAGED_EGRESS_DISCLOSURE_WARNING,
      functionalProbeSucceeded: true,
    });
    expect(projection.supportedProtocols).toEqual([
      "http",
      "https-connect",
      "websocket",
      "websocket-secure",
      "socks5-tcp",
    ]);
    expect(JSON.stringify(projection)).not.toContain("/private/helper");
  });
});
