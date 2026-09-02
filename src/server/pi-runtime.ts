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
  SandboxResourceLoader,
  createStrictSettingsManager,
} from "./sandbox/resources.js";
import { createSandboxTools, SANDBOX_TOOL_NAMES } from "./sandbox/tools.js";
import { startSandboxWorkerClient } from "./sandbox/worker-client.js";
import { SandboxController } from "./sandbox/worker-controller.js";

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

export interface PiForkOptions {
  /** The live source model to apply to the new session after replacement. */
  readonly inheritModel?: NonNullable<AgentSession["model"]>;
}

export interface PiRuntimeReplacement {
  readonly previous: PiRuntimeIdentity;
  readonly current: PiRuntimeIdentity;
}

export type PiRuntimeReplacementListener = (
  replacement: PiRuntimeReplacement,
) => void;

export type PiRuntimeFatalFailureListener = (error: AppError) => void;

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
  readonly identity: PiRuntimeIdentity;
  readonly model: PiModelCapability | undefined;
  readonly supportsImages: boolean;
  readonly disposed: boolean;
  /** True only after Pi and worker teardown promises have both settled. */
  readonly teardownComplete: boolean;
  /** Present only when model-directed workspace reads cross a sandbox worker. */
  readonly sandboxFileReader?: SandboxWorkspaceFileReaderPort;
  subscribe(listener: AgentSessionEventListener): () => void;
  onSessionReplaced(listener: PiRuntimeReplacementListener): () => void;
  onFatalFailure(listener: PiRuntimeFatalFailureListener): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;
  fork(entryId: string, options?: PiForkOptions): Promise<PiForkResult>;
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

export interface PiSandboxRuntimeOptions {
  readonly config: Readonly<SandboxConfig>;
  readonly host: Readonly<ValidatedSandboxHost>;
  readonly worker: Readonly<SandboxWorkerArtifact>;
  readonly hiddenPaths: readonly string[];
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
  readonly #sandboxController: SandboxController | undefined;
  readonly #eventListeners = new Set<AgentSessionEventListener>();
  readonly #replacementListeners = new Set<PiRuntimeReplacementListener>();
  readonly #fatalListeners = new Set<PiRuntimeFatalFailureListener>();
  #unsubscribeSession: (() => void) | undefined;
  #unsubscribeControllerFatal: (() => void) | undefined;
  #replacementSource: PiRuntimeIdentity | undefined;
  #fatalFailure: AppError | undefined;
  #disposed = false;
  #teardownComplete = false;
  #disposePromise: Promise<void> | undefined;

  constructor(
    runtime: AgentSessionRuntime,
    securityProfile: RuntimeWorkspacePolicy["securityProfile"] = "unrestricted",
    sandboxController?: SandboxController,
  ) {
    this.#runtime = runtime;
    this.#securityProfile = securityProfile;
    this.#sandboxController = sandboxController;
    if (sandboxController !== undefined) {
      Object.defineProperty(this, "sandboxFileReader", {
        value: sandboxController,
        enumerable: true,
      });
      this.#unsubscribeControllerFatal = sandboxController.onFatalFailure(
        (failure) => this.#notifyFatalFailure(failure.error),
      );
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

  async fork(entryId: string, options?: PiForkOptions): Promise<PiForkResult> {
    this.#assertUsable();
    this.#replacementSource = this.identity;

    try {
      const inheritedModel = options?.inheritModel;
      const result = await this.#runtime.fork(
        entryId,
        inheritedModel === undefined
          ? undefined
          : {
              // Pi rebuilds the fork from entries before the selected user
              // message. A later model change on the live source may therefore
              // not be present in that branch. Apply the source's current model
              // only after replacement, so the source JSONL is never modified.
              withSession: async () => {
                const current = this.session.model;
                if (
                  current?.provider !== inheritedModel.provider ||
                  current.id !== inheritedModel.id
                ) {
                  await this.session.setModel(inheritedModel);
                }
              },
            },
      );
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
    this.#runtime.setBeforeSessionInvalidate(undefined);
    this.#runtime.setRebindSession(undefined);

    // Start both teardown paths before awaiting either one. A stalled SDK
    // disposal must never keep a Bubblewrap namespace alive past shutdown.
    let piDisposal: Promise<void>;
    let workerDisposal: Promise<void>;
    try {
      piDisposal = this.#runtime.dispose();
    } catch (error) {
      piDisposal = Promise.reject(error);
    }
    try {
      workerDisposal = this.#sandboxController?.close() ?? Promise.resolve();
    } catch (error) {
      workerDisposal = Promise.reject(error);
    }
    const [piResult, workerResult] = await Promise.allSettled([piDisposal, workerDisposal]);
    this.#teardownComplete = true;
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
    return Object.freeze({
      workspaceId: policy.workspaceId,
      cwd,
      sessionDirectory: policy.sessionDirectory === null
        ? null
        : path.resolve(policy.sessionDirectory),
      securityProfile: policy.securityProfile,
      networkPolicy,
    });
  }

  async #createRuntime(
    policy: Readonly<RuntimeWorkspacePolicy>,
    sessionManager: SessionManager,
  ): Promise<PiConversationRuntime> {
    let sandboxController: SandboxController | undefined;
    let sdkRuntime: AgentSessionRuntime | undefined;
    try {
      if (policy.networkPolicy === "managed-egress") {
        // The managed launch path is introduced only after the native helper,
        // bridge, and proxy startup gates exist. Never run it through the
        // isolated profile as a silent downgrade.
        throw new AppError(ERROR_CODES.NETWORK_HELPER_UNAVAILABLE);
      }
      if (policy.securityProfile === "workspace-sandboxed") {
        const sandbox = this.#sandbox;
        if (sandbox === undefined) {
          throw new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED);
        }
        sandboxController = await SandboxController.start({
          createWorker: (onFatal) => startSandboxWorkerClient({
            config: sandbox.config,
            host: sandbox.host,
            worker: sandbox.worker,
            workspace: policy.cwd,
            hiddenPaths: [...new Set([
              ...sandbox.hiddenPaths,
              ...(policy.sessionDirectory === null ? [] : [policy.sessionDirectory]),
            ])],
            onFatal,
          }),
          commandTimeoutMs: sandbox.config.commandTimeoutMs,
          abortActiveRun: () => sdkRuntime?.session.abort(),
          waitForPiIdle: () => sdkRuntime?.session.agent.waitForIdle(),
          // The controller retains terminal failure state; the runtime subscribes
          // immediately after SDK construction and replays any raced failure.
          onFatal: () => undefined,
        });
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
          const resourceLoader = await SandboxResourceLoader.create(policy.cwd);
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
            tools: [...SANDBOX_TOOL_NAMES],
            customTools: [...createSandboxTools(sandboxController)],
          };
        } else {
          const configurableServiceOptions = (await this.#serviceOptions?.(runtimeCwd)) ?? {};
          services = await createAgentSessionServices({
            ...configurableServiceOptions,
            cwd: runtimeCwd,
            agentDir: this.#agentDir,
            modelRuntime: this.#modelRuntime,
          });
          configurableSessionOptions = (await this.#sessionOptions?.(services)) ?? {};
        }
        const sessionCreationOptions: CreateAgentSessionFromServicesOptions = {
          ...configurableSessionOptions,
          services,
          sessionManager: runtimeSessionManager,
          ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
        };
        const created = await createAgentSessionFromServices(sessionCreationOptions);
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
      if (sandboxController !== undefined && sandboxController.state !== "healthy") {
        await sdkRuntime.dispose().catch(() => undefined);
        throw new AppError(ERROR_CODES.SANDBOX_WORKER_START_FAILED);
      }
      return new PiConversationRuntime(sdkRuntime, policy.securityProfile, sandboxController);
    } catch (error) {
      await sandboxController?.close().catch(() => undefined);
      throw error instanceof AppError
        ? error
        : toAppError(error, { source: "pi", operation: "create" });
    }
  }
}
