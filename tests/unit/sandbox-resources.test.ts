import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";

import {
  MANAGED_EGRESS_SANDBOX_SYSTEM_PROMPT,
  SANDBOX_SYSTEM_PROMPT,
  SandboxResourceLoader,
  createStrictSettingsManager,
  scanSandboxContextFiles,
  strictSettingsSnapshot,
} from "../../src/server/sandbox/resources.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function workspace(): Promise<{ root: string; cwd: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "chatwca-strict-resources-"));
  roots.push(root);
  const cwd = path.join(root, "workspace");
  await mkdir(cwd);
  return { root, cwd };
}

describe("SandboxResourceLoader", () => {
  it("exposes an empty extension/resource runtime and only canonical root context", async () => {
    const { root, cwd } = await workspace();
    await writeFile(path.join(root, "AGENTS.md"), "ancestor secret");
    await writeFile(path.join(cwd, "AGENTS.md"), "\ufeffworkspace rules");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(path.join(cwd, ".pi", "extensions", "leak.ts"), "throw new Error('loaded')");

    const loader = await SandboxResourceLoader.create(cwd);
    expect(loader.getExtensions().extensions).toEqual([]);
    expect(loader.getExtensions().errors).toEqual([]);
    expect(loader.getExtensions().runtime.pendingProviderRegistrations).toEqual([]);
    expect(loader.getExtensions().runtime.pendingNativeProviderRegistrations).toEqual([]);
    expect(loader.getSkills()).toEqual({ skills: [], diagnostics: [] });
    expect(loader.getPrompts()).toEqual({ prompts: [], diagnostics: [] });
    expect(loader.getThemes()).toEqual({ themes: [], diagnostics: [] });
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getSystemPromptSource()).toBeUndefined();
    expect(loader.getAgentsFiles()).toEqual({
      agentsFiles: [{ path: "/workspace/AGENTS.md", content: "workspace rules" }],
    });
    expect(loader.getSystemPrompt()).toBe(SANDBOX_SYSTEM_PROMPT);
    expect(loader.getSystemPrompt()).not.toContain(root);
  });

  it("selects an explanatory managed-egress prompt without weakening enforcement", async () => {
    const { cwd } = await workspace();
    const isolated = await SandboxResourceLoader.create(cwd, "isolated");
    const managed = await SandboxResourceLoader.create(cwd, "managed-egress");

    expect(isolated.getSystemPrompt()).toBe(SANDBOX_SYSTEM_PROMPT);
    expect(managed.getSystemPrompt()).toBe(MANAGED_EGRESS_SANDBOX_SYSTEM_PROMPT);
    expect(managed.getSystemPrompt()).toContain("destination-filtered proxy");
    expect(managed.getSystemPrompt()).toContain("LANs");
    expect(managed.getSystemPrompt()).toContain("metadata services");
    expect(managed.getSystemPrompt()).toContain("UDP");
    expect(managed.getSystemPrompt()).toContain("workspace content");
    expect(managed.getSystemPrompt()).toContain("Do not work around blocked access");
  });

  it("rejects a noncanonical workspace and ignores symlink context files", async () => {
    const { root, cwd } = await workspace();
    const outside = path.join(root, "outside.md");
    await writeFile(outside, "outside secret");
    await symlink(outside, path.join(cwd, "AGENTS.md"));
    expect(await scanSandboxContextFiles(cwd)).toEqual([]);

    const alias = path.join(root, "alias");
    await symlink(cwd, alias);
    await expect(scanSandboxContextFiles(alias)).rejects.toThrow("Sandbox workspace is not canonical");
  });

  it("copies only safe administrator settings into immutable in-memory state", () => {
    const global = SettingsManager.inMemory({
      defaultProvider: "faux",
      defaultModel: "faux-1",
      defaultThinkingLevel: "high",
      retry: { enabled: false, maxRetries: 7 },
      compaction: { enabled: true, reserveTokens: 1234 },
      packages: ["npm:host-package"],
      extensions: ["/host/extension.ts"],
      skills: ["/host/skills"],
      prompts: ["/host/prompts"],
      themes: ["/host/themes"],
      defaultTools: ["powershell"],
      shellPath: "/host/shell",
      shellCommandPrefix: "source /host/profile",
      npmCommand: ["/host/npm"],
      sessionDir: "/host/sessions",
      httpProxy: "http://host-proxy.invalid",
    }).getGlobalSettings();

    const snapshot = strictSettingsSnapshot(global);
    expect(snapshot).toMatchObject({
      defaultProvider: "faux",
      defaultModel: "faux-1",
      defaultThinkingLevel: "high",
      retry: { enabled: false, maxRetries: 7 },
      compaction: { enabled: true, reserveTokens: 1234 },
    });
    for (const forbidden of [
      "packages", "extensions", "skills", "prompts", "themes", "defaultTools",
      "shellPath", "shellCommandPrefix", "npmCommand", "sessionDir", "httpProxy",
    ]) {
      expect(snapshot).not.toHaveProperty(forbidden);
    }

    const strict = createStrictSettingsManager(global);
    expect(strict.getDefaultProvider()).toBe("faux");
    expect(strict.getDefaultModel()).toBe("faux-1");
    expect(strict.getRetrySettings()).toMatchObject({ enabled: false, maxRetries: 7 });
    expect(strict.getPackages()).toEqual([]);
    expect(strict.getExtensionPaths()).toEqual([]);
    expect(strict.getDefaultTools()).toBeUndefined();
    expect(strict.getShellPath()).toBeUndefined();
    expect(strict.getShellCommandPrefix()).toBeUndefined();
    expect(strict.getNpmCommand()).toBeUndefined();
    expect(strict.getSessionDir()).toBeUndefined();
  });
});
