import { constants as fsConstants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

import {
  SettingsManager,
  createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import type { SandboxNetworkPolicy } from "../../shared/protocol.js";

const CONTEXT_FILE_NAMES = Object.freeze([
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const);

const SANDBOX_PROMPT_HEADER = `You are an expert coding assistant operating in a workspace sandbox.

Available tools:
- read: Read file contents
- write: Create or overwrite files
- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call
- bash: Execute bash commands
- ls: List directory contents
- grep: Search file contents for patterns (respects .gitignore)
- find: Find files by glob pattern (respects .gitignore)

Guidelines:
- Use only read, write, edit, bash, ls, grep, and find for filesystem and process work.
- Use read to examine files instead of cat or sed.
- Use write only for new files or complete rewrites.
- Use edit for precise changes; every edits[].oldText must be unique in the original file and edits must not overlap.
- Use one edit call for multiple disjoint changes to the same file.
- Tools operate from /workspace in a workspace sandbox.
- Host absolute paths and files outside the synthetic guest filesystem are unavailable.
- /workspace/.chatwca is ephemeral and must not be used for persistent state.`;

const SANDBOX_PROMPT_FOOTER = `- Temporary command, home, and /tmp state disappears after abort, close, or eviction.
- The workspace, including .git, is writable; make only changes requested by the user.
- /usr and any administrator-provided runtime mounts are read-only.
- Be concise and show guest file paths clearly.`;

export const ISOLATED_SANDBOX_SYSTEM_PROMPT = `${SANDBOX_PROMPT_HEADER.replace(
  "- Tools operate from /workspace in a workspace sandbox.",
  "- Tools operate from /workspace in a network-isolated workspace sandbox.",
)}
- Package downloads, external services, DNS, IPv4, IPv6, and loopback services are unavailable.
${SANDBOX_PROMPT_FOOTER}`;

export const MANAGED_EGRESS_SANDBOX_SYSTEM_PROMPT = `${SANDBOX_PROMPT_HEADER}
- Network access is available only through a destination-filtered proxy for administrator-configured domains and TCP ports.
- Local and host services, LANs, metadata services, UDP, inbound connections, and unconfigured destinations are unavailable.
- Allowed destinations may receive any workspace content readable by tools.
- Do not work around blocked access with tunnels, alternate endpoints, or proxy bypasses.
- Removing or changing proxy environment variables does not provide direct network access.
${SANDBOX_PROMPT_FOOTER}`;

/** Backward-compatible name for the default isolated profile. */
export const SANDBOX_SYSTEM_PROMPT = ISOLATED_SANDBOX_SYSTEM_PROMPT;

type PiSettings = ReturnType<SettingsManager["getGlobalSettings"]>;

function cloneObject<T extends object>(value: T): T {
  return structuredClone(value);
}

/**
 * Copy only administrator-controlled settings which affect model selection,
 * thinking, provider transport/retries, compaction, queues, or image handling.
 * Resource, package, tool, shell, session-path, proxy, and UI execution fields
 * are deliberately absent.
 */
export function strictSettingsSnapshot(globalSettings: Readonly<PiSettings>): Partial<PiSettings> {
  return {
    ...(globalSettings.defaultProvider === undefined ? {} : { defaultProvider: globalSettings.defaultProvider }),
    ...(globalSettings.defaultModel === undefined ? {} : { defaultModel: globalSettings.defaultModel }),
    ...(globalSettings.defaultThinkingLevel === undefined ? {} : { defaultThinkingLevel: globalSettings.defaultThinkingLevel }),
    ...(globalSettings.modelThinkingLevels === undefined ? {} : { modelThinkingLevels: { ...globalSettings.modelThinkingLevels } }),
    ...(globalSettings.transport === undefined ? {} : { transport: globalSettings.transport }),
    ...(globalSettings.steeringMode === undefined ? {} : { steeringMode: globalSettings.steeringMode }),
    ...(globalSettings.followUpMode === undefined ? {} : { followUpMode: globalSettings.followUpMode }),
    ...(globalSettings.compaction === undefined ? {} : { compaction: cloneObject(globalSettings.compaction) }),
    ...(globalSettings.branchSummary === undefined ? {} : { branchSummary: cloneObject(globalSettings.branchSummary) }),
    ...(globalSettings.retry === undefined ? {} : { retry: cloneObject(globalSettings.retry) }),
    ...(globalSettings.thinkingBudgets === undefined ? {} : { thinkingBudgets: cloneObject(globalSettings.thinkingBudgets) }),
    ...(globalSettings.enabledModels === undefined ? {} : { enabledModels: [...globalSettings.enabledModels] }),
    ...(globalSettings.hideThinkingBlock === undefined ? {} : { hideThinkingBlock: globalSettings.hideThinkingBlock }),
    ...(globalSettings.images === undefined ? {} : { images: cloneObject(globalSettings.images) }),
    ...(globalSettings.httpIdleTimeoutMs === undefined ? {} : { httpIdleTimeoutMs: globalSettings.httpIdleTimeoutMs }),
    ...(globalSettings.websocketConnectTimeoutMs === undefined ? {} : { websocketConnectTimeoutMs: globalSettings.websocketConnectTimeoutMs }),
  };
}

export function createStrictSettingsManager(globalSettings: Readonly<PiSettings>): SettingsManager {
  return SettingsManager.inMemory(strictSettingsSnapshot(globalSettings));
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Load at most one Pi-compatible context file at the workspace root. */
export async function scanSandboxContextFiles(canonicalWorkspace: string): Promise<readonly { readonly path: string; readonly content: string }[]> {
  const workspace = await realpath(path.resolve(canonicalWorkspace));
  if (workspace !== path.resolve(canonicalWorkspace)) {
    throw new Error("Sandbox workspace is not canonical");
  }

  for (const name of CONTEXT_FILE_NAMES) {
    const candidate = path.join(workspace, name);
    let handle;
    try {
      handle = await open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      const metadata = await handle.stat();
      if (!metadata.isFile()) continue;
      // Resolve the opened descriptor, not the pathname, so a concurrent rename
      // or symlink replacement cannot redirect the parent read after validation.
      const canonical = await realpath(`/proc/self/fd/${handle.fd}`);
      if (canonical !== candidate || !isContained(workspace, canonical)) continue;
      const content = (await handle.readFile("utf8")).replace(/^\ufeff/, "");
      return Object.freeze([{ path: `/workspace/${name}`, content }]);
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code === "ENOENT" || code === "ELOOP") continue;
      throw new Error("Sandbox context loading failed", { cause: error });
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
  return Object.freeze([]);
}

/** Strict, discovery-free Pi resource loader for one sandboxed workspace. */
export class SandboxResourceLoader implements ResourceLoader {
  readonly #canonicalWorkspace: string;
  readonly #extensions = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  #agentsFiles: readonly { readonly path: string; readonly content: string }[] = Object.freeze([]);

  private constructor(
    canonicalWorkspace: string,
    private readonly networkPolicy: SandboxNetworkPolicy,
  ) {
    this.#canonicalWorkspace = canonicalWorkspace;
  }

  static async create(
    canonicalWorkspace: string,
    networkPolicy: SandboxNetworkPolicy = "isolated",
  ): Promise<SandboxResourceLoader> {
    const loader = new SandboxResourceLoader(canonicalWorkspace, networkPolicy);
    await loader.reload();
    return loader;
  }

  getExtensions() { return this.#extensions; }
  getSkills() { return { skills: [], diagnostics: [] }; }
  getPrompts() { return { prompts: [], diagnostics: [] }; }
  getThemes() { return { themes: [], diagnostics: [] }; }
  getAgentsFiles() { return { agentsFiles: [...this.#agentsFiles] }; }
  getSystemPrompt(): string {
    return this.networkPolicy === "managed-egress"
      ? MANAGED_EGRESS_SANDBOX_SYSTEM_PROMPT
      : ISOLATED_SANDBOX_SYSTEM_PROMPT;
  }
  getSystemPromptSource(): undefined { return undefined; }
  getAppendSystemPrompt(): string[] { return []; }
  getAppendSystemPromptSources(): [] { return []; }
  extendResources(): void {
    // Extensions cannot add paths because the strict runtime has no extensions.
  }
  async reload(): Promise<void> {
    this.#agentsFiles = await scanSandboxContextFiles(this.#canonicalWorkspace);
  }
}
