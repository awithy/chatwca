import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_HTTP_TOOL_MAX_RESPONSE_BYTES,
  DEFAULT_HTTP_TOOL_TIMEOUT_MS,
  loadHttpToolCatalog,
  publicHttpTools,
} from "../../src/server/http-tool-catalog.js";
import { ConfigurationError } from "../../src/server/config.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryCatalog(document: unknown): { readonly root: string; readonly file: string } {
  const root = mkdtempSync(path.join(tmpdir(), "chatwca-http-tools-"));
  roots.push(root);
  const file = path.join(root, "tools.json");
  writeFileSync(file, JSON.stringify(document));
  return { root, file };
}

function networkBrainDocument() {
  return {
    version: 1,
    tools: [{
      name: "network_brain_search",
      label: "Network Brain Search",
      description: "Search indexed networking and infrastructure documentation.",
      method: "POST",
      url: "http://127.0.0.1:53147/v1/search",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["query"],
        properties: {
          query: { type: "string", minLength: 1, maxLength: 1_000 },
          limit: { type: "integer", minimum: 1, maximum: 10 },
        },
      },
    }],
  };
}

describe("HTTP tool catalog", () => {
  it("is empty when no catalog is configured", () => {
    const catalog = loadHttpToolCatalog({}, "/tmp");

    expect(catalog).toEqual({ sourcePath: null, tools: [] });
    expect(publicHttpTools(catalog)).toEqual([]);
    expect(Object.isFrozen(catalog)).toBe(true);
  });

  it("loads definitions and exposes only safe public metadata", () => {
    const { root, file } = temporaryCatalog(networkBrainDocument());
    const catalog = loadHttpToolCatalog({ CHATWCA_TOOL_CATALOG: "tools.json" }, root);

    expect(catalog.sourcePath).toBe(file);
    expect(catalog.tools).toEqual([
      expect.objectContaining({
        name: "network_brain_search",
        method: "POST",
        url: "http://127.0.0.1:53147/v1/search",
        timeoutMs: DEFAULT_HTTP_TOOL_TIMEOUT_MS,
        maxResponseBytes: DEFAULT_HTTP_TOOL_MAX_RESPONSE_BYTES,
      }),
    ]);
    expect(publicHttpTools(catalog)).toEqual([{
      name: "network_brain_search",
      label: "Network Brain Search",
      description: "Search indexed networking and infrastructure documentation.",
      method: "POST",
      url: "http://127.0.0.1:53147/v1/search",
    }]);
    expect(JSON.stringify(publicHttpTools(catalog))).not.toContain("parameters");
    expect(Object.isFrozen(catalog.tools[0]?.parameters)).toBe(true);
  });

  it("rejects workspace grants and duplicate tool names", () => {
    const transitional = { ...networkBrainDocument(), workspaces: [] };
    expect(() => loadHttpToolCatalog({
      CHATWCA_TOOL_CATALOG: temporaryCatalog(transitional).file,
    })).toThrow(/unsupported property "workspaces"/);

    const duplicate = networkBrainDocument();
    duplicate.tools.push({ ...duplicate.tools[0]! });
    expect(() => loadHttpToolCatalog({
      CHATWCA_TOOL_CATALOG: temporaryCatalog(duplicate).file,
    })).toThrow(/tool names must be unique/);
  });

  it.each(["conversation_search", "conversation_read"])("reserves %s regardless of search mode", (name) => {
    const document = networkBrainDocument(); document.tools[0]!.name = name;
    expect(() => loadHttpToolCatalog({ CHATWCA_TOOL_CATALOG: temporaryCatalog(document).file }))
      .toThrow(/non-reserved lowercase tool name/);
  });

  it("rejects malformed tools and catalog files", () => {
    expect(() => loadHttpToolCatalog({ CHATWCA_TOOL_CATALOG: " " })).toThrow(ConfigurationError);
    expect(() => loadHttpToolCatalog({ CHATWCA_TOOL_CATALOG: "/missing/tools.json" })).toThrow(
      /Unable to read HTTP tool catalog/,
    );

    const badUrl = networkBrainDocument();
    badUrl.tools[0]!.url = "file:///etc/passwd";
    expect(() => loadHttpToolCatalog({
      CHATWCA_TOOL_CATALOG: temporaryCatalog(badUrl).file,
    })).toThrow(/HTTP or HTTPS URL/);

    const openSchema = networkBrainDocument();
    openSchema.tools[0]!.parameters.additionalProperties = true;
    expect(() => loadHttpToolCatalog({
      CHATWCA_TOOL_CATALOG: temporaryCatalog(openSchema).file,
    })).toThrow(/additionalProperties must be false/);
  });
});
