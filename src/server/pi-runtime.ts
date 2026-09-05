import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  type AgentSession,
  type AgentSessionEventListener,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionFromServicesOptions,
  type CreateAgentSessionServicesOptions,
  type ModelRuntime,
  type PromptOptions,
  type ToolDefinition,
  SettingsManager,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  ModelRuntime as PiModelRuntime,
} from "@earendil-works/pi-coding-agent";

import {
  AppError,
  ERROR_CODES,
  toAppError,
} from "../shared/errors.js";
import { resolveConversationCwd } from "./cwd.js";
import type { RuntimeWorkspacePolicy } from "./workspace-repository.js";
import type {
  SandboxWorkerArtifact,
  ValidatedSandboxHost,
} from "./sandbox/bwrap.js";
import type { SandboxConfig } from "./sandbox/config.js";
import {
  WORKSPACE_MOUNT_NAME_PATTERN,
  WORKSPACE_MOUNT_SOURCE_MAX_LENGTH,
  type SandboxNetworkPolicy,
  type WorkspaceMount,
} from "../shared/protocol.js";
import {
  DEFAULT_NETWORK_POLICY_SET_ID,
  type CompiledNetworkPolicySet,
  type ManagedNetworkConfig,
} from "./network/config.js";
import type { NetworkBlockedNotification, NetworkDiagnosticSink } from "./network/audit.js";
import { ManagedNetworkRuntime } from "./network/managed-runtime.js";
import type { ValidatedNetworkHelper } from "./network/helper.js";
import {
  SandboxResourceLoader,
  createStrictSettingsManager,
} from "./sandbox/resources.js";
import { createSandboxTools, SANDBOX_TOOL_NAMES } from "./sandbox/tools.js";
import { startSandboxWorkerClient } from "./sandbox/worker-client.js";
import { SandboxController } from "./sandbox/worker-controller.js";
import {
  WEB_SEARCH_TOOL_NAME,
  createWebSearchTool,
  type WebSearchToolOptions,
} from "./web-search.js";

export interface PiModelCapability {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly supportsImages: boolean;
}

export interface PiRuntimeIdentity {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
}

export interface PiForkResult {
  readonly cancelled: boolean;
  /** ChatWCA's name for Pi's `selectedText` fork result. */
  readonly editorText?: string;
}

export interface PiRuntimeReplacement {
  readonly previous: PiRuntimeIdentity;
  readonly current: PiRuntimeIdentity;
}

export type PiRuntimeReplacementListener = (
  replacement: PiRuntimeReplacement,
) => void;

export type PiRuntimeFatalFailureListener = (error: AppError) => void;
export type PiRuntimeNetworkBlockedListener = (
  event: Readonly<NetworkBlockedNotification>,
) => void;

/** Parent-owned proxy boundary retained for the full conversation lifetime. */
export interface ManagedNetworkRuntimePort {
  readonly httpSocketPath: string;
  readonly socksSocketPath: string;
  readonly policySetId: string;
  readonly policySet: Readonly<CompiledNetworkPolicySet>;
  subscribeBlocked(listener: PiRuntimeNetworkBlockedListener): () => void;
  onFatal(listener: PiRuntimeFatalFailureListener): () => void;
  close(): Promise<void>;
  forceClose(): void;
}

/** Options that may vary with each CWD-bound service reconstruction. */
export type PiServiceOptions = Omit<
  CreateAgentSessionServicesOptions,
  "cwd" | "agentDir" | "modelRuntime"
>;

/** Session choices resolved after the CWD-bound services have been created. */
export type PiSessionOptions = Omit<
  CreateAgentSessionFromServicesOptions,
  "services" | "sessionManager" | "sessionStartEvent"
>;

export interface SandboxWorkspaceFileReaderPort {
  readFile(input: {
    readonly path: string;
    readonly maxBytes: number;
    readonly detectMime: boolean;
  }, options?: { readonly signal?: AbortSignal }): Promise<{
    readonly data: Buffer;
    readonly mimeType: string | null;
  }>;
}

export interface PiConversationRuntimePort {
  readonly session: AgentSession;
  readonly securityProfile: RuntimeWorkspacePolicy["securityProfile"];
  readonly networkPolicy: SandboxNetworkPolicy | null;
  /** Selected managed-egress grant; null for unrestricted/isolated runtimes. */
  readonly networkPolicySetId: string | null;
  readonly networkPolicySet: Readonly<CompiledNetworkPolicySet> | null;
  readonly identity: PiRuntimeIdentity;
  readonly model: PiModelCapability | undefined;
  readonly supportsImages: boolean;
  readonly disposed: boolean;
  /** True only after Pi, worker/bridges, and managed-network teardown have settled. */
  readonly teardownComplete: boolean;
  /** Present only when model-directed workspace reads cross a sandbox worker. */
  readonly sandboxFileReader?: SandboxWorkspaceFileReaderPort;
  subscribe(listener: AgentSessionEventListener): () => void;
  onSessionReplaced(listener: PiRuntimeReplacementListener): () => void;
  onFatalFailure(listener: PiRuntimeFatalFailureListener): () => void;
  onNetworkBlocked(listener: PiRuntimeNetworkBlockedListener): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;
  fork(entryId: string): Promise<PiForkResult>;
  dispose(): Promise<void>;
}

export interface PiRuntimeFactoryPort {
  readonly modelRuntime: ModelRuntime;
  readonly strictModelRuntime: ModelRuntime;
  listAvailableModels(securityProfile?: RuntimeWorkspacePolicy["securityProfile"]): Promise<readonly PiModelCapability[]>;
  createPersistent(policy: Readonly<RuntimeWorkspacePolicy>): Promise<PiConversationRuntimePort>;
  openPersistent(
    policy: Readonly<RuntimeWorkspacePolicy>,
    sessionFile: string,
  ): Promise<PiConversationRuntimePort>;
}

export interface PiManagedNetworkOptions {
  readonly config: Readonly<ManagedNetworkConfig>;
  readonly helper: Readonly<ValidatedNetworkHelper>;
  readonly dataDir: string;
  readonly diagnosticSink?: NetworkDiagnosticSink;
  /** Deterministic lifecycle boundary used only by tests. */
  readonly startRuntime?: (
    options: Parameters<typeof ManagedNetworkRuntime.start>[0],
  ) => Promise<ManagedNetworkRuntimePort>;
}

export interface PiSandboxRuntimeOptions {
  readonly config: Readonly<SandboxConfig>;
  readonly host: Readonly<ValidatedSandboxHost>;
  readonly worker: Readonly<SandboxWorkerArtifact>;
  readonly hiddenPaths: readonly string[];
  readonly managedNetwork?: Readonly<PiManagedNetworkOptions>;
}

export interface PiRuntimeFactoryOptions {
  /** Defaults to the process-wide unrestricted ModelRuntime. Primarily injectable for tests. */
  readonly modelRuntime?: ModelRuntime;
  /** A distinct runtime for strict sessions. It must never be extension-mutated. */
  readonly strictModelRuntime?: ModelRuntime;
  readonly agentDir?: string;
  readonly sandbox?: Readonly<PiSandboxRuntimeOptions>;
  /** Optional Pi session directory override, useful for isolated deployments/tests. */
  readonly sessionDir?: string;
  readonly serviceOptions?: (
    cwd: string,
  ) => PiServiceOptions | Promise<PiServiceOptions>;
  readonly sessionOptions?: (
    services: AgentSessionServices,
  ) => PiSessionOptions | Promise<PiSessionOptions>;
  /** Optional parent-owned Brave Search integration shared by every profile. */
  readonly webSearch?: Readonly<WebSearchToolOptions>;
}

let sharedModelRuntimePromise: Promise<ModelRuntime> | undefined;

/**
 * Return ChatWCA's process-wide model/auth runtime.
 *
 * ModelRuntime has no dispose operation in the pinned SDK and is intentionally
 * retained until process exit. Tests inject an isolated runtime into
 * `PiRuntimeFactory.create()` instead of resetting this singleton.
 */
export function getSharedModelRuntime(): Promise<ModelRuntime> {
  sharedModelRuntimePromise ??= PiModelRuntime.create();
  return sharedModelRuntimePromise;
}

function modelCapability(
  model: AgentSession["model"],
): PiModelCapability | undefined {
  if (model === undefined) return undefined;
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    supportsImages: model.input.includes("image"),
  };
}

function identityOf(runtime: AgentSessionRuntime): PiRuntimeIdentity {
  const sessionFile = runtime.session.sessionFile;
  if (sessionFile === undefined) {
    // ChatWCA only creates persistent conversations. Treat an unexpected
    // in-memory runtime as an SDK construction failure at this boundary.
    throw toAppError(new Error("Persistent Pi session has no file"), {
      source: "pi",
      operation: "create",
    });
  }

  return {
    sessionId: runtime.session.sessionId,
    sessionFile: path.resolve(sessionFile),
    cwd: path.resolve(runtime.cwd),
  };
}

async function resolveSessionFile(sessionFile: string): Promise<string> {
  try {
    const canonicalFile = await realpath(path.resolve(sessionFile));
    const details = await stat(canonicalFile);
    if (!details.isFile()) {
      throw new Error("Pi session target is not a file");
    }
    await access(canonicalFile, fsConstants.R_OK | fsConstants.W_OK);
    return canonicalFile;
  } catch (error) {
    throw toAppError(error, { source: "filesystem", target: "session" });
  }
}

/**
 * Persistent conversation adapter around Pi's replaceable AgentSessionRuntime.
 *
 * Consumers subscribe through this wrapper, not directly to the current SDK
 * session. A replacement detaches the old SDK subscription synchronously and
 * reattaches it to the new session before replacement listeners are notified.
 */
export class PiConversationRuntime implements PiConversationRuntimePort {
  readonly #runtime: AgentSessionRuntime;
  readonly #securityProfile: RuntimeWorkspacePolicy["securityProfile"];
  readonly #networkPolicy: SandboxNetworkPolicy | null;
  readonly #networkPolicySetId: string | null;
  readonly #networkPolicySet: Readonly<CompiledNetworkPolicySet> | null;
  readonly #sandboxController: SandboxController | undefined;
  readonly #managedNetwork: ManagedNetworkRuntimePort | undefined;
  readonly #eventListeners = new Set<AgentSessionEventListener>();
  readonly #replacementListeners = new Set<PiRuntimeReplacementListener>();
  readonly #fatalListeners = new Set<PiRuntimeFatalFailureListener>();
  #unsubscribeSession: (() => void) | undefined;
  #unsubscribeControllerFatal: (() => void) | undefined;
  #unsubscribeNetworkFatal: (() => void) | undefined;
  #replacementSource: PiRuntimeIdentity | undefined;
  #fatalFailure: AppError | undefined;
  #disposed = false;
  #teardownComplete = false;
  #disposePromise: Promise<void> | undefined;

  constructor(
    runtime: AgentSessionRuntime,
    securityProfile: RuntimeWorkspacePolicy["securityProfile"] = "unrestricted",
    sandboxController?: SandboxController,
    networkPolicy: SandboxNetworkPolicy | null =
      securityProfile === "workspace-sandboxed" ? "isolated" : null,
    managedNetwork?: ManagedNetworkRuntimePort,
    networkPolicySetId: string | null = null,
    networkPolicySet: Readonly<CompiledNetworkPolicySet> | null = null,
  ) {
    const managedIdentityMatches =
      networkPolicy === "managed-egress" &&
      managedNetwork !== undefined &&
      networkPolicySet !== null &&
      networkPolicySetId !== null &&
      networkPolicySet.id === networkPolicySetId &&
      managedNetwork.policySetId === networkPolicySetId &&
      managedNetwork.policySet === networkPolicySet;
    if (
      (securityProfile === "unrestricted" &&
        (networkPolicy !== null || sandboxController !== undefined || managedNetwork !== undefined ||
          networkPolicySetId !== null || networkPolicySet !== null)) ||
      (securityProfile === "workspace-sandboxed" &&
        (sandboxController === undefined ||
          (networkPolicy !== "isolated" && networkPolicy !== "managed-egress") ||
          (networkPolicy === "managed-egress"
            ? !managedIdentityMatches
            : managedNetwork !== undefined || networkPolicySetId !== null || networkPolicySet !== null)))
    ) {
      throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    }
    this.#runtime = runtime;
    this.#securityProfile = securityProfile;
    this.#networkPolicy = networkPolicy;
    this.#networkPolicySetId = networkPolicySetId;
    this.#networkPolicySet = networkPolicySet;
    this.#sandboxController = sandboxController;
    this.#managedNetwork = managedNetwork;
    if (sandboxController !== undefined) {
      Object.defineProperty(this, "sandboxFileReader", {
        value: sandboxController,
        enumerable: true,
      });
      this.#unsubscribeControllerFatal = sandboxController.onFatalFailure(
        (failure) => this.#notifyFatalFailure(failure.error),
      );
    }
    if (managedNetwork !== undefined) {
      this.#unsubscribeNetworkFatal = managedNetwork.onFatal((error) => {
        sandboxController?.failTerminal(error);
      });
    }

    runtime.setBeforeSessionInvalidate(() => {
      this.#detachSession();
    });
    runtime.setRebindSession(() => {
      this.#attachSession();
      const previous = this.#replacementSource;
      if (previous !== undefined) {
        const replacement = { previous, current: this.identity };
        for (const listener of this.#replacementListeners) {
          listener(replacement);
        }
      }
      this.#replacementSource = undefined;
      return Promise.resolve();
    });
  }

  get session(): AgentSession {
    return this.#runtime.session;
  }

  get securityProfile(): RuntimeWorkspacePolicy["securityProfile"] {
    return this.#securityProfile;
  }

  get networkPolicy(): SandboxNetworkPolicy | null {
    return this.#networkPolicy;
  }

  get networkPolicySetId(): string | null {
    return this.#networkPolicySetId;
  }

  get networkPolicySet(): Readonly<CompiledNetworkPolicySet> | null {
    return this.#networkPolicySet;
  }

  declare readonly sandboxFileReader?: SandboxWorkspaceFileReaderPort;

  get identity(): PiRuntimeIdentity {
    return identityOf(this.#runtime);
  }

  get model(): PiModelCapability | undefined {
    return modelCapability(this.session.model);
  }

  get supportsImages(): boolean {
    return this.model?.supportsImages ?? false;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  get teardownComplete(): boolean {
    return this.#teardownComplete;
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.#assertUsable();
    this.#eventListeners.add(listener);
    this.#attachSession();

    return () => {
      this.#eventListeners.delete(listener);
      if (this.#eventListeners.size === 0) this.#detachSession();
    };
  }

  onSessionReplaced(listener: PiRuntimeReplacementListener): () => void {
    this.#assertUsable();
    this.#replacementListeners.add(listener);
    return () => {
      this.#replacementListeners.delete(listener);
    };
  }

  onFatalFailure(listener: PiRuntimeFatalFailureListener): () => void {
    if (this.#disposed) throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    this.#fatalListeners.add(listener);
    if (this.#fatalFailure !== undefined) listener(this.#fatalFailure);
    return () => this.#fatalListeners.delete(listener);
  }

  onNetworkBlocked(listener: PiRuntimeNetworkBlockedListener): () => void {
    if (this.#disposed) throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    return this.#managedNetwork?.subscribeBlocked(listener) ?? (() => undefined);
  }

  async prompt(text: string, options?: PromptOptions): Promise<void> {
    this.#assertUsable();
    try {
      await (options === undefined
        ? this.session.prompt(text)
        : this.session.prompt(text, options));
    } catch (error) {
      // Post-acceptance provider failures are represented by Pi messages/events;
      // a rejection here is a model/prompt preflight failure.
      throw toAppError(error, { source: "pi", operation: "model" });
    }
  }

  async abort(): Promise<void> {
    if (this.#disposed) throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    try {
      if (this.#sandboxController !== undefined) {
        // Controller aborts coalesce while replacement is pending.
        await this.#sandboxController.abort();
      } else {
        await this.session.abort();
      }
    } catch (error) {
      throw toAppError(error, { source: "internal" });
    }
  }

  async fork(entryId: string): Promise<PiForkResult> {
    this.#assertUsable();
    this.#replacementSource = this.identity;

    try {
      // The replacement factory selects the global default again; neither the
      // copied branch nor the source's live model overrides that choice.
      const result = await this.#runtime.fork(entryId);
      if (result.cancelled) this.#replacementSource = undefined;
      return result.selectedText === undefined
        ? { cancelled: result.cancelled }
        : { cancelled: result.cancelled, editorText: result.selectedText };
    } catch (error) {
      this.#replacementSource = undefined;
      throw toAppError(error, { source: "pi", operation: "replace" });
    }
  }

  dispose(): Promise<void> {
    this.#disposePromise ??= this.#disposeOnce();
    return this.#disposePromise;
  }

  async #disposeOnce(): Promise<void> {
    this.#disposed = true;
    this.#detachSession();
    this.#eventListeners.clear();
    this.#replacementListeners.clear();
    this.#fatalListeners.clear();
    this.#unsubscribeControllerFatal?.();
    this.#unsubscribeControllerFatal = undefined;
    this.#unsubscribeNetworkFatal?.();
    this.#unsubscribeNetworkFatal = undefined;
    this.#runtime.setBeforeSessionInvalidate(undefined);
    this.#runtime.setRebindSession(undefined);

    // Start all teardown paths before awaiting any one of them. A stalled Pi,
    // helper/worker, or proxy path must never retain either of the others past
    // the process-wide grace deadline.
    const start = (operation: () => Promise<void>): Promise<void> => {
      try { return operation(); } catch (error) { return Promise.reject(error); }
    };
    const piDisposal = start(() => this.#runtime.dispose());
    const workerDisposal = start(() => this.#sandboxController?.close() ?? Promise.resolve());
    const networkDisposal = start(() => this.#managedNetwork?.close() ?? Promise.resolve());
    const [piResult, workerResult, networkResult] = await Promise.allSettled([
      piDisposal,
      workerDisposal,
      networkDisposal,
    ]);
    this.#teardownComplete = true;
    if (networkResult.status === "rejected") throw networkResult.reason;
    if (workerResult.status === "rejected") throw workerResult.reason;
    if (piResult.status === "rejected") throw piResult.reason;
  }

  #attachSession(): void {
    if (
      this.#disposed ||
      this.#unsubscribeSession !== undefined ||
      this.#eventListeners.size === 0
    ) {
      return;
    }

    this.#unsubscribeSession = this.session.subscribe((event) => {
      const controller = this.#sandboxController;
      if (
        controller !== undefined &&
        controller.state !== "healthy" &&
        event.type === "agent_end"
      ) {
        // Pi settles before a replacement worker can handshake. Do not expose
        // idle to the registry during that fail-closed gap; fatal transitions
        // deliberately drop this normalizer event and publish terminal error.
        void controller.waitUntilReady().then(
          () => this.#dispatchSessionEvent(event),
          () => undefined,
        );
        return;
      }
      this.#dispatchSessionEvent(event);
    });
  }

  #dispatchSessionEvent(event: Parameters<AgentSessionEventListener>[0]): void {
    if (this.#disposed) return;
    for (const listener of this.#eventListeners) listener(event);
  }

  #detachSession(): void {
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = undefined;
  }

  #notifyFatalFailure(error: AppError): void {
    if (this.#fatalFailure !== undefined || this.#disposed) return;
    this.#fatalFailure = error;
    for (const listener of this.#fatalListeners) listener(error);
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    }
    if (
      this.#sandboxController !== undefined &&
      this.#sandboxController.state !== "healthy"
    ) {
      throw new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED);
    }
  }
}

/** Creates profile-selected Pi runtimes with isolated process-global model state. */
export class PiRuntimeFactory implements PiRuntimeFactoryPort {
  readonly #modelRuntime: ModelRuntime;
  readonly #strictModelRuntime: ModelRuntime;
  readonly #agentDir: string;
  readonly #sessionDir: string | undefined;
  readonly #serviceOptions: PiRuntimeFactoryOptions["serviceOptions"];
  readonly #sessionOptions: PiRuntimeFactoryOptions["sessionOptions"];
  readonly #sandbox: Readonly<PiSandboxRuntimeOptions> | undefined;
  readonly #webSearchTool: ToolDefinition<any, any> | undefined;
  readonly #globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>;

  private constructor(
    modelRuntime: ModelRuntime,
    strictModelRuntime: ModelRuntime,
    globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
    options: PiRuntimeFactoryOptions,
  ) {
    this.#modelRuntime = modelRuntime;
    this.#strictModelRuntime = strictModelRuntime;
    this.#agentDir = path.resolve(options.agentDir ?? getAgentDir());
    this.#sessionDir = options.sessionDir;
    this.#serviceOptions = options.serviceOptions;
    this.#sessionOptions = options.sessionOptions;
    this.#sandbox = options.sandbox;
    this.#webSearchTool = options.webSearch?.apiKey == null
      ? undefined
      : createWebSearchTool(options.webSearch);
    this.#globalSettings = structuredClone(globalSettings);
  }

  static async create(
    options: PiRuntimeFactoryOptions = {},
  ): Promise<PiRuntimeFactory> {
    try {
      const agentDir = path.resolve(options.agentDir ?? getAgentDir());
      const modelRuntime = options.modelRuntime ?? (await getSharedModelRuntime());
      const strictModelRuntime = options.strictModelRuntime ?? await PiModelRuntime.create({
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
        modelsStorePath: path.join(agentDir, "models-store.json"),
      });
      // Only the global half of SettingsManager's merged state is retained.
      // The strict in-memory snapshot never observes project settings again.
      const globalSettings = SettingsManager.create(path.parse(agentDir).root, agentDir).getGlobalSettings();
      return new PiRuntimeFactory(modelRuntime, strictModelRuntime, globalSettings, options);
    } catch (error) {
      throw toAppError(error, { source: "pi", operation: "create" });
    }
  }

  get modelRuntime(): ModelRuntime {
    return this.#modelRuntime;
  }

  get strictModelRuntime(): ModelRuntime {
    return this.#strictModelRuntime;
  }

  async listAvailableModels(
    securityProfile: RuntimeWorkspacePolicy["securityProfile"] = "unrestricted",
  ): Promise<readonly PiModelCapability[]> {
    try {
      const selectedRuntime = securityProfile === "workspace-sandboxed"
        ? this.#strictModelRuntime
        : this.#modelRuntime;
      const models = await selectedRuntime.getAvailable();
      return models.map((model) => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        supportsImages: model.input.includes("image"),
      }));
    } catch (error) {
      throw toAppError(error, { source: "pi", operation: "model" });
    }
  }

  async createPersistent(policy: Readonly<RuntimeWorkspacePolicy>): Promise<PiConversationRuntime> {
    const canonicalPolicy = await this.#canonicalPolicy(policy);
    const sessionManager = SessionManager.create(
      canonicalPolicy.cwd,
      canonicalPolicy.sessionDirectory ?? this.#sessionDir,
    );
    return this.#createRuntime(canonicalPolicy, sessionManager);
  }

  async openPersistent(
    policy: Readonly<RuntimeWorkspacePolicy>,
    sessionFile: string,
  ): Promise<PiConversationRuntime> {
    const canonicalPolicy = await this.#canonicalPolicy(policy);
    const canonicalFile = await resolveSessionFile(sessionFile);

    let storedSession: SessionManager;
    try {
      storedSession = SessionManager.open(canonicalFile);
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }
    const storedCwd = await resolveConversationCwd(storedSession.getCwd());
    if (storedCwd !== canonicalPolicy.cwd) {
      throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    }

    let sessionManager: SessionManager;
    try {
      sessionManager = SessionManager.open(
        canonicalFile,
        storedSession.getSessionDir(),
        canonicalPolicy.cwd,
      );
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }

    return this.#createRuntime(canonicalPolicy, sessionManager);
  }

  async #canonicalPolicy(policy: Readonly<RuntimeWorkspacePolicy>): Promise<RuntimeWorkspacePolicy> {
    const cwd = await resolveConversationCwd(policy.cwd);
    const networkPolicy = policy.networkPolicy ??
      (policy.securityProfile === "workspace-sandboxed" ? "isolated" : null);
    if (
      cwd !== path.resolve(policy.cwd) ||
      !policy.workspaceId ||
      (policy.securityProfile === "unrestricted"
        ? networkPolicy !== null
        : networkPolicy !== "isolated" &&
          networkPolicy !== "managed-egress")
    ) {
      throw new AppError(ERROR_CODES.WORKSPACE_UNAVAILABLE);
    }
    const mounts: readonly WorkspaceMount[] = policy.securityProfile === "workspace-sandboxed"
      ? Object.freeze(await Promise.all((policy.mounts ?? []).map(async (mount) => {
          if (
            !new RegExp(WORKSPACE_MOUNT_NAME_PATTERN, "u").test(mount.name) ||
            !path.isAbsolute(mount.source) ||
            mount.source.length > WORKSPACE_MOUNT_SOURCE_MAX_LENGTH ||
            (mount.access !== "read-only" && mount.access !== "read-write")
          ) {
            throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED);
          }
          const source = await realpath(mount.source);
          const metadata = await stat(source);
          await access(
            source,
            fsConstants.R_OK | fsConstants.X_OK |
              (mount.access === "read-write" ? fsConstants.W_OK : 0),
          );
          if (source !== mount.source || !metadata.isDirectory()) {
            throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED);
          }
          return Object.freeze({ ...mount, source });
        })))
      : Object.freeze([]);
    if (policy.securityProfile === "unrestricted" && (policy.mounts?.length ?? 0) > 0) {
      throw new AppError(ERROR_CODES.SANDBOX_WORKSPACE_REJECTED);
    }
    const networkPolicySetId = policy.networkPolicySetId ?? DEFAULT_NETWORK_POLICY_SET_ID;
    const effectiveNetworkPolicySetId = networkPolicy === "managed-egress"
      ? policy.effectiveNetworkPolicySetId
      : null;
    const networkPolicySet = networkPolicy === "managed-egress"
      ? policy.networkPolicySet
      : null;
    if (
      (networkPolicy === "managed-egress" &&
        (policy.networkPolicySetId === undefined ||
          effectiveNetworkPolicySetId !== networkPolicySetId ||
          networkPolicySet === null || networkPolicySet === undefined ||
          networkPolicySet.id !== effectiveNetworkPolicySetId ||
          !Object.isFrozen(networkPolicySet) ||
          !Object.isFrozen(networkPolicySet.allowedDomainPatterns) ||
          !Object.isFrozen(networkPolicySet.allowedPorts) ||
          !Object.isFrozen(networkPolicySet.destinationPolicy))) ||
      (networkPolicy !== "managed-egress" &&
        ((policy.effectiveNetworkPolicySetId ?? null) !== null ||
          (policy.networkPolicySet ?? null) !== null))
    ) {
      throw new AppError(ERROR_CODES.NETWORK_POLICY_INVALID);
    }
    return Object.freeze({
      workspaceId: policy.workspaceId,
      cwd,
      sessionDirectory: policy.sessionDirectory === null
        ? null
        : path.resolve(policy.sessionDirectory),
      securityProfile: policy.securityProfile,
      mounts,
      networkPolicy,
      networkPolicySetId,
      effectiveNetworkPolicySetId,
      networkPolicySet,
    });
  }

  async #createRuntime(
    policy: Readonly<RuntimeWorkspacePolicy>,
    sessionManager: SessionManager,
  ): Promise<PiConversationRuntime> {
    let sandboxController: SandboxController | undefined;
    let managedNetwork: ManagedNetworkRuntimePort | undefined;
    let sdkRuntime: AgentSessionRuntime | undefined;
    let conversationRuntime: PiConversationRuntime | undefined;
    let proxyFailure: AppError | undefined;
    let unsubscribeStartupProxyFatal: (() => void) | undefined;
    try {
      const sandbox = policy.securityProfile === "workspace-sandboxed"
        ? this.#sandbox
        : undefined;
      if (policy.securityProfile === "workspace-sandboxed" && sandbox === undefined) {
        throw new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED);
      }
      if (policy.networkPolicy === "managed-egress") {
        const managed = sandbox?.managedNetwork;
        if (managed === undefined || managed.config.mode !== "optional") {
          // A managed policy is never launched through isolated Bubblewrap or
          // unrestricted tools when its parent-owned runtime is unavailable.
          throw new AppError(ERROR_CODES.NETWORK_HELPER_UNAVAILABLE);
        }
        const selectedPolicySet = policy.networkPolicySet;
        const selectedPolicySetId = policy.effectiveNetworkPolicySetId;
        if (
          selectedPolicySet === null ||
          selectedPolicySetId === null ||
          selectedPolicySet.id !== selectedPolicySetId ||
          managed.config.policySets.get(selectedPolicySetId) !== selectedPolicySet
        ) {
          throw new AppError(ERROR_CODES.NETWORK_POLICY_INVALID);
        }
        const startRuntime = managed.startRuntime ??
          ((options) => ManagedNetworkRuntime.start(options));
        managedNetwork = await startRuntime({
          dataDir: managed.dataDir,
          workspaceId: policy.workspaceId,
          conversationId: sessionManager.getSessionId(),
          policySetId: selectedPolicySetId,
          policySet: selectedPolicySet,
          config: managed.config,
          ...(managed.diagnosticSink === undefined
            ? {}
            : { diagnosticSink: managed.diagnosticSink }),
        });
        if (
          managedNetwork.policySetId !== selectedPolicySetId ||
          managedNetwork.policySet !== selectedPolicySet
        ) {
          throw new AppError(ERROR_CODES.NETWORK_POLICY_INVALID);
        }
        unsubscribeStartupProxyFatal = managedNetwork.onFatal((error) => {
          proxyFailure ??= error;
          sandboxController?.failTerminal(error);
        });
      }
      if (sandbox !== undefined) {
        const hiddenPaths = [...new Set([
          ...sandbox.hiddenPaths,
          ...(policy.sessionDirectory === null ? [] : [policy.sessionDirectory]),
        ])];
        sandboxController = await SandboxController.start({
          createWorker: (onFatal) => {
            if (proxyFailure !== undefined) throw proxyFailure;
            return startSandboxWorkerClient({
              config: sandbox.config,
              host: sandbox.host,
              worker: sandbox.worker,
              workspace: policy.cwd,
              mounts: policy.mounts ?? [],
              hiddenPaths,
              onFatal,
              ...(managedNetwork === undefined
                ? { networkProfile: { kind: "isolated" as const } }
                : {
                    networkProfile: {
                      kind: "managed-egress" as const,
                      helper: sandbox.managedNetwork!.helper,
                      httpSocketPath: managedNetwork.httpSocketPath,
                      socksSocketPath: managedNetwork.socksSocketPath,
                    },
                  }),
            });
          },
          commandTimeoutMs: sandbox.config.commandTimeoutMs,
          abortActiveRun: () => sdkRuntime?.session.abort(),
          waitForPiIdle: () => sdkRuntime?.session.agent.waitForIdle(),
          // The controller retains terminal failure state; the runtime subscribes
          // immediately after SDK construction and replays any raced failure.
          onFatal: () => undefined,
        });
        if (proxyFailure !== undefined) {
          sandboxController.failTerminal(proxyFailure);
          throw proxyFailure;
        }
      }

      const createRuntime = async ({
        cwd: runtimeCwd,
        sessionManager: runtimeSessionManager,
        sessionStartEvent,
      }: Parameters<Parameters<typeof createAgentSessionRuntime>[0]>[0]) => {
        let services: AgentSessionServices;
        let configurableSessionOptions: PiSessionOptions;
        if (policy.securityProfile === "workspace-sandboxed") {
          if (sandboxController === undefined) throw new AppError(ERROR_CODES.SANDBOX_WORKER_FAILED);
          const resourceLoader = await SandboxResourceLoader.create(
            policy.cwd,
            policy.networkPolicy ?? "isolated",
            policy.mounts,
            this.#webSearchTool !== undefined,
          );
          services = {
            cwd: "/workspace",
            agentDir: this.#agentDir,
            modelRuntime: this.#strictModelRuntime,
            settingsManager: createStrictSettingsManager(this.#globalSettings),
            resourceLoader,
            diagnostics: [],
          };
          const requested = (await this.#sessionOptions?.(services)) ?? {};
          configurableSessionOptions = {
            ...(requested.model === undefined ? {} : { model: requested.model }),
            ...(requested.thinkingLevel === undefined ? {} : { thinkingLevel: requested.thinkingLevel }),
            ...(requested.scopedModels === undefined ? {} : { scopedModels: requested.scopedModels }),
            tools: [
              ...SANDBOX_TOOL_NAMES,
              ...(this.#webSearchTool === undefined ? [] : [WEB_SEARCH_TOOL_NAME]),
            ],
            customTools: [
              ...createSandboxTools(sandboxController),
              ...(this.#webSearchTool === undefined ? [] : [this.#webSearchTool]),
            ],
          };
        } else {
          const configurableServiceOptions = (await this.#serviceOptions?.(runtimeCwd)) ?? {};
          services = await createAgentSessionServices({
            ...configurableServiceOptions,
            cwd: runtimeCwd,
            agentDir: this.#agentDir,
            modelRuntime: this.#modelRuntime,
          });
          const requested = (await this.#sessionOptions?.(services)) ?? {};
          configurableSessionOptions = this.#webSearchTool === undefined
            ? requested
            : {
                ...requested,
                customTools: [
                  ...(requested.customTools ?? []),
                  this.#webSearchTool,
                ],
              };
        }
        // An explicit SDK model takes precedence over saved session models and
        // project settings, including during fork/runtime reconstruction. Resolve
        // only against this profile's catalog; never cross the strict boundary.
        const { defaultProvider, defaultModel } = this.#globalSettings;
        if (defaultProvider !== undefined || defaultModel !== undefined) {
          const model = defaultProvider && defaultModel
            ? services.modelRuntime.getModel(defaultProvider, defaultModel)
            : undefined;
          if (model === undefined || !services.modelRuntime.hasConfiguredAuth(model.provider)) {
            throw new AppError(ERROR_CODES.MODEL_UNAVAILABLE);
          }
          configurableSessionOptions = { ...configurableSessionOptions, model };
        }
        const sessionCreationOptions: CreateAgentSessionFromServicesOptions = {
          ...configurableSessionOptions,
          services,
          sessionManager: runtimeSessionManager,
          ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        };
        const created = await createAgentSessionFromServices(sessionCreationOptions);
        if (
          policy.securityProfile === "unrestricted" &&
          this.#webSearchTool !== undefined &&
          configurableSessionOptions.noTools !== "all" &&
          !configurableSessionOptions.excludeTools?.includes(WEB_SEARCH_TOOL_NAME)
        ) {
          created.session.setActiveToolsByName([
            ...new Set([
              ...created.session.getActiveToolNames(),
              WEB_SEARCH_TOOL_NAME,
            ]),
          ]);
        }
        // A sandboxed AgentSession must see only the guest CWD so Pi appends
        // `/workspace` to the model-facing system prompt. AgentSessionRuntime,
        // however, owns host-side session replacement and must retain the
        // canonical host CWD; otherwise registry ownership checks reject a new
        // session and Pi creates first-message forks with `/workspace` in their
        // persisted session header.
        const runtimeServices = policy.securityProfile === "workspace-sandboxed"
          ? { ...services, cwd: runtimeCwd }
          : services;
        return {
          ...created,
          services: runtimeServices,
          diagnostics: services.diagnostics,
        };
      };

      sdkRuntime = await createAgentSessionRuntime(createRuntime, {
        cwd: policy.cwd,
        agentDir: this.#agentDir,
        sessionManager,
      });
      if (proxyFailure !== undefined ||
          (sandboxController !== undefined && sandboxController.state !== "healthy")) {
        throw proxyFailure ?? new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED);
      }
      conversationRuntime = new PiConversationRuntime(
        sdkRuntime,
        policy.securityProfile,
        sandboxController,
        policy.networkPolicy,
        managedNetwork,
        policy.effectiveNetworkPolicySetId,
        policy.networkPolicySet,
      );
      // Keep the startup observer until the fully owning wrapper has installed
      // its replayable fatal subscription; there is no unobserved proxy gap.
      unsubscribeStartupProxyFatal?.();
      unsubscribeStartupProxyFatal = undefined;
      if (proxyFailure !== undefined || sandboxController?.state === "error") {
        throw proxyFailure ?? new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED);
      }
      return conversationRuntime;
    } catch (error) {
      unsubscribeStartupProxyFatal?.();
      const disposals: Promise<unknown>[] = [];
      if (conversationRuntime !== undefined) {
        try { disposals.push(conversationRuntime.dispose()); } catch { /* continue teardown */ }
      } else {
        try { if (sdkRuntime !== undefined) disposals.push(sdkRuntime.dispose()); } catch { /* continue teardown */ }
        try { if (sandboxController !== undefined) disposals.push(sandboxController.close()); } catch { /* continue teardown */ }
        try { if (managedNetwork !== undefined) disposals.push(managedNetwork.close()); } catch { /* continue teardown */ }
      }
      await Promise.allSettled(disposals);
      throw error instanceof AppError
        ? error
        : toAppError(error, { source: "pi", operation: "create" });
    }
  }
}
