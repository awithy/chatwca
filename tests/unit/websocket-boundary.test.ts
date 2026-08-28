import { describe, expect, it } from "vitest";

import { hasAllowedWebSocketOrigin } from "../../src/server/websocket-boundary.js";

function request(
  origin: string | undefined,
  host: string | undefined = "chatwca.local:8787",
) {
  return {
    headers: {
      ...(origin === undefined ? {} : { origin }),
      ...(host === undefined ? {} : { host }),
    },
  };
}

describe("WebSocket upgrade origin boundary", () => {
  it("accepts direct clients that omit Origin", () => {
    expect(hasAllowedWebSocketOrigin(request(undefined))).toBe(true);
  });

  it("accepts matching browser authorities", () => {
    expect(
      hasAllowedWebSocketOrigin(
        request("http://chatwca.local:8787", "CHATWCA.LOCAL:8787"),
      ),
    ).toBe(true);
    expect(
      hasAllowedWebSocketOrigin(request("https://[::1]:8787", "[::1]:8787")),
    ).toBe(true);
  });

  it("rejects a different host or port", () => {
    expect(
      hasAllowedWebSocketOrigin(
        request("http://unrelated.local:8787", "chatwca.local:8787"),
      ),
    ).toBe(false);
    expect(
      hasAllowedWebSocketOrigin(
        request("http://chatwca.local:9999", "chatwca.local:8787"),
      ),
    ).toBe(false);
  });

  it.each([
    "null",
    "not a URL",
    "ftp://chatwca.local:8787",
    "http://user@chatwca.local:8787",
    "http://chatwca.local:8787/a-path",
    "http://chatwca.local:8787?query",
  ])("rejects malformed or non-browser Origin %j", (origin) => {
    expect(hasAllowedWebSocketOrigin(request(origin))).toBe(false);
  });

  it("rejects an Origin when Host is absent or malformed", () => {
    expect(
      hasAllowedWebSocketOrigin({
        headers: { origin: "http://chatwca.local:8787" },
      }),
    ).toBe(false);
    expect(
      hasAllowedWebSocketOrigin(
        request("http://chatwca.local:8787", "chatwca.local:8787/path"),
      ),
    ).toBe(false);
  });
});
