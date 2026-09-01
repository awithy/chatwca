import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  DEFAULT_DATA_DIR,
  DEFAULT_HOST,
  DEFAULT_MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGES,
  DEFAULT_MAX_LIVE_CONVERSATIONS,
  DEFAULT_MAX_TOTAL_IMAGE_BYTES,
  DEFAULT_PORT,
  DEFAULT_SHUTDOWN_GRACE_MS,
  MAX_SHUTDOWN_GRACE_MS,
  loadConfig,
} from "../../src/server/config.js";
import { loadSandboxConfig } from "../../src/server/sandbox/config.js";

describe("loadConfig", () => {
  it("applies defaults", () => {
    const cwd = path.resolve("/tmp/chatwca-workspace");

    expect(loadConfig({}, cwd)).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      dataDir: path.resolve(cwd, DEFAULT_DATA_DIR),
      maxLiveConversations: DEFAULT_MAX_LIVE_CONVERSATIONS,
      maxImages: DEFAULT_MAX_IMAGES,
      maxImageBytes: DEFAULT_MAX_IMAGE_BYTES,
      maxTotalImageBytes: DEFAULT_MAX_TOTAL_IMAGE_BYTES,
      shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
      piCodingAgentDir: undefined,
      piOffline: false,
      sandbox: loadSandboxConfig({}),
    });
  });

  it("parses every supported override", () => {
    const cwd = path.resolve("/tmp/chatwca-base");
    const config = loadConfig(
      {
        CHATWCA_HOST: "127.0.0.1",
        CHATWCA_PORT: "9000",
        CHATWCA_DATA_DIR: "storage",
        CHATWCA_MAX_LIVE_CONVERSATIONS: "3",
        CHATWCA_MAX_IMAGES: "4",
        CHATWCA_MAX_IMAGE_BYTES: "1024",
        CHATWCA_MAX_TOTAL_IMAGE_BYTES: "4096",
        CHATWCA_SHUTDOWN_GRACE_MS: "2500",
        PI_CODING_AGENT_DIR: "/tmp/pi-agent",
        PI_OFFLINE: "1",
      },
      cwd,
    );

    expect(config).toEqual({
      host: "127.0.0.1",
      port: 9000,
      dataDir: path.join(cwd, "storage"),
      maxLiveConversations: 3,
      maxImages: 4,
      maxImageBytes: 1024,
      maxTotalImageBytes: 4096,
      shutdownGraceMs: 2500,
      piCodingAgentDir: "/tmp/pi-agent",
      piOffline: true,
      sandbox: loadSandboxConfig({}),
    });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("preserves an absolute data-directory override", () => {
    expect(
      loadConfig({ CHATWCA_DATA_DIR: "/var/lib/chatwca" }, "/tmp/base").dataDir,
    ).toBe(path.resolve("/var/lib/chatwca"));
  });

  it.each(["0", "-1", "1.5", "Infinity", "not-a-number"])(
    "rejects invalid ports (%s)",
    (port) => {
      expect(() => loadConfig({ CHATWCA_PORT: port }, "/tmp")).toThrow(
        ConfigurationError,
      );
    },
  );

  it("rejects ports above the TCP maximum", () => {
    expect(() => loadConfig({ CHATWCA_PORT: "65536" }, "/tmp")).toThrow(
      /CHATWCA_PORT must be between 1 and 65535/,
    );
  });

  it.each([
    "CHATWCA_MAX_LIVE_CONVERSATIONS",
    "CHATWCA_MAX_IMAGES",
    "CHATWCA_MAX_IMAGE_BYTES",
    "CHATWCA_MAX_TOTAL_IMAGE_BYTES",
    "CHATWCA_SHUTDOWN_GRACE_MS",
  ] as const)("rejects non-positive or non-integer %s", (variable) => {
    for (const value of ["", "0", "-2", "2.5", "invalid"]) {
      expect(() => loadConfig({ [variable]: value }, "/tmp")).toThrow(
        new RegExp(`${variable} must be a positive integer`),
      );
    }
  });

  it("caps the configurable shutdown grace period", () => {
    expect(() =>
      loadConfig(
        { CHATWCA_SHUTDOWN_GRACE_MS: String(MAX_SHUTDOWN_GRACE_MS + 1) },
        "/tmp",
      )
    ).toThrow(/CHATWCA_SHUTDOWN_GRACE_MS must not exceed/);
  });

  it("rejects empty string settings", () => {
    expect(() => loadConfig({ CHATWCA_HOST: "  " }, "/tmp")).toThrow(
      /CHATWCA_HOST must not be empty/,
    );
    expect(() => loadConfig({ CHATWCA_DATA_DIR: "" }, "/tmp")).toThrow(
      /CHATWCA_DATA_DIR must not be empty/,
    );
    expect(() => loadConfig({ PI_CODING_AGENT_DIR: " " }, "/tmp")).toThrow(
      /PI_CODING_AGENT_DIR must not be empty/,
    );
  });

  it("does not copy provider credentials into application configuration", () => {
    const config = loadConfig(
      { OPENAI_API_KEY: "secret", ANTHROPIC_API_KEY: "also-secret" },
      "/tmp",
    );

    expect(JSON.stringify(config)).not.toContain("secret");
    expect(config).not.toHaveProperty("OPENAI_API_KEY");
    expect(config).not.toHaveProperty("ANTHROPIC_API_KEY");
  });
});
