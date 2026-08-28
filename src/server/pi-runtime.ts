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

export interface PiConversationRuntimePort {
  readonly session: AgentSession;
  readonly identity: PiRuntimeIdentity;
  readonly model: PiModelCapability | undefined;
  readonly supportsImages: boolean;
  readonly disposed: boolean;
  subscribe(listener: AgentSessionEventListener): () => void;
  onSessionReplaced(listener: PiRuntimeReplacementListener): () => void;
  prompt(text: string, options?: PromptOptions): Promise<void>;
  abort(): Promise<void>;
  fork(entryId: string, options?: PiForkOptions): Promise<PiForkResult>;
  dispose(): Promise<void>;
}

export interface PiRuntimeFactoryPort {
  readonly modelRuntime: ModelRuntime;
  listAvailableModels(): Promise<readonly PiModelCapability[]>;
  createPersistent(cwd: string): Promise<PiConversationRuntimePort>;
  openPersistent(sessionFile: string): Promise<PiConversationRuntimePort>;
}

export interface PiRuntimeFactoryOptions {
  /** Defaults to the one process-wide ModelRuntime. Primarily injectable for tests. */
  readonly modelRuntime?: ModelRuntime;
  readonly agentDir?: string;
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
  readonly #eventListeners = new Set<AgentSessionEventListener>();
  readonly #replacementListeners = new Set<PiRuntimeReplacementListener>();
  #unsubscribeSession: (() => void) | undefined;
  #replacementSource: PiRuntimeIdentity | undefined;
  #disposed = false;

  constructor(runtime: AgentSessionRuntime) {
    this.#runtime = runtime;

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
    this.#assertUsable();
    try {
      await this.session.abort();
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

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#detachSession();
    this.#eventListeners.clear();
    this.#replacementListeners.clear();
    this.#runtime.setBeforeSessionInvalidate(undefined);
    this.#runtime.setRebindSession(undefined);
    await this.#runtime.dispose();
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
      for (const listener of this.#eventListeners) listener(event);
    });
  }

  #detachSession(): void {
    this.#unsubscribeSession?.();
    this.#unsubscribeSession = undefined;
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new AppError(ERROR_CODES.SESSION_UNAVAILABLE);
    }
  }
}

/** Creates persistent Pi runtimes while sharing only process-global model state. */
export class PiRuntimeFactory implements PiRuntimeFactoryPort {
  readonly #modelRuntime: ModelRuntime;
  readonly #agentDir: string;
  readonly #sessionDir: string | undefined;
  readonly #serviceOptions: PiRuntimeFactoryOptions["serviceOptions"];
  readonly #sessionOptions: PiRuntimeFactoryOptions["sessionOptions"];

  private constructor(
    modelRuntime: ModelRuntime,
    options: PiRuntimeFactoryOptions,
  ) {
    this.#modelRuntime = modelRuntime;
    this.#agentDir = path.resolve(options.agentDir ?? getAgentDir());
    this.#sessionDir = options.sessionDir;
    this.#serviceOptions = options.serviceOptions;
    this.#sessionOptions = options.sessionOptions;
  }

  static async create(
    options: PiRuntimeFactoryOptions = {},
  ): Promise<PiRuntimeFactory> {
    try {
      const modelRuntime =
        options.modelRuntime ?? (await getSharedModelRuntime());
      return new PiRuntimeFactory(modelRuntime, options);
    } catch (error) {
      throw toAppError(error, { source: "pi", operation: "create" });
    }
  }

  get modelRuntime(): ModelRuntime {
    return this.#modelRuntime;
  }

  async listAvailableModels(): Promise<readonly PiModelCapability[]> {
    try {
      const models = await this.#modelRuntime.getAvailable();
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

  async createPersistent(cwd: string): Promise<PiConversationRuntime> {
    const canonicalCwd = await resolveConversationCwd(cwd);
    const sessionManager = SessionManager.create(
      canonicalCwd,
      this.#sessionDir,
    );
    return this.#createRuntime(canonicalCwd, sessionManager);
  }

  async openPersistent(sessionFile: string): Promise<PiConversationRuntime> {
    const canonicalFile = await resolveSessionFile(sessionFile);

    let storedSession: SessionManager;
    try {
      storedSession = SessionManager.open(canonicalFile);
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }

    const canonicalCwd = await resolveConversationCwd(storedSession.getCwd());
    let sessionManager: SessionManager;
    try {
      // Preserve the stored workspace's meaning while using its canonical path
      // for CWD-bound resources and registry identity.
      sessionManager = SessionManager.open(
        canonicalFile,
        storedSession.getSessionDir(),
        canonicalCwd,
      );
    } catch (error) {
      throw toAppError(error, { source: "filesystem", target: "session" });
    }

    return this.#createRuntime(canonicalCwd, sessionManager);
  }

  async #createRuntime(
    cwd: string,
    sessionManager: SessionManager,
  ): Promise<PiConversationRuntime> {
    const createRuntime = async ({
      cwd: runtimeCwd,
      sessionManager: runtimeSessionManager,
      sessionStartEvent,
    }: Parameters<
      Parameters<typeof createAgentSessionRuntime>[0]
    >[0]) => {
      const configurableServiceOptions =
        (await this.#serviceOptions?.(runtimeCwd)) ?? {};
      const services = await createAgentSessionServices({
        ...configurableServiceOptions,
        cwd: runtimeCwd,
        agentDir: this.#agentDir,
        modelRuntime: this.#modelRuntime,
      });
      const configurableSessionOptions =
        (await this.#sessionOptions?.(services)) ?? {};
      const sessionCreationOptions: CreateAgentSessionFromServicesOptions = {
        ...configurableSessionOptions,
        services,
        sessionManager: runtimeSessionManager,
        ...(sessionStartEvent === undefined ? {} : { sessionStartEvent }),
      };

      return {
        ...(await createAgentSessionFromServices(sessionCreationOptions)),
        services,
        diagnostics: services.diagnostics,
      };
    };

    try {
      const runtime = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir: this.#agentDir,
        sessionManager,
      });
      return new PiConversationRuntime(runtime);
    } catch (error) {
      throw toAppError(error, { source: "pi", operation: "create" });
    }
  }
}
