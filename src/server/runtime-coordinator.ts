import type { JobRunState } from "../shared/jobs.js";
import type { ShutdownRuntimeOwner } from "./shutdown.js";

export interface RuntimeCoordinatorSchedulerPort {
  beginShutdown(): void;
  dispose(): Promise<void>;
}

export interface RuntimeCoordinatorJobRunnerPort {
  beginShutdown(): void;
  sealPersistence(interrupted: readonly JobRunState[]): void;
  dispose(): Promise<void>;
}

export interface RuntimeCoordinatorHookRunnerPort {
  beginShutdown(): void;
  dispose(): Promise<void>;
}

export interface RuntimeCoordinatorRegistryPort extends ShutdownRuntimeOwner {}

export interface RuntimeCoordinatorRepositoryPort {
  markAllInterrupted(at?: number): readonly JobRunState[];
}

export interface RuntimeCoordinatorOptions {
  readonly scheduler: RuntimeCoordinatorSchedulerPort;
  readonly jobRunner: RuntimeCoordinatorJobRunnerPort;
  readonly hookRunner: RuntimeCoordinatorHookRunnerPort;
  readonly registry: RuntimeCoordinatorRegistryPort;
  readonly repository: RuntimeCoordinatorRepositoryPort;
  readonly clock?: () => number;
  readonly onInternalError?: (error: unknown) => void;
}

/**
 * One shutdown owner for scheduler, hooks, job runs, and interactive runtimes.
 * The SQLite interruption boundary is synchronous: after it returns, the job
 * runner is sealed and no continuation is permitted to issue another query.
 */
export class RuntimeCoordinator implements ShutdownRuntimeOwner {
  readonly #scheduler: RuntimeCoordinatorSchedulerPort;
  readonly #jobRunner: RuntimeCoordinatorJobRunnerPort;
  readonly #hookRunner: RuntimeCoordinatorHookRunnerPort;
  readonly #registry: RuntimeCoordinatorRegistryPort;
  readonly #repository: RuntimeCoordinatorRepositoryPort;
  readonly #clock: () => number;
  readonly #onInternalError: (error: unknown) => void;
  #started = false;
  #abortPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(options: Readonly<RuntimeCoordinatorOptions>) {
    this.#scheduler = options.scheduler;
    this.#jobRunner = options.jobRunner;
    this.#hookRunner = options.hookRunner;
    this.#registry = options.registry;
    this.#repository = options.repository;
    this.#clock = options.clock ?? Date.now;
    this.#onInternalError = options.onInternalError ?? (() => undefined);
  }

  get shuttingDown(): boolean {
    return this.#started;
  }

  beginShutdown(): void {
    if (this.#started) return;
    this.#started = true;

    // Close all admission and signal host work before touching durable state.
    this.#scheduler.beginShutdown();
    this.#jobRunner.beginShutdown();
    this.#hookRunner.beginShutdown();
    this.#registry.beginShutdown();
    this.#abortPromise = this.#registry.abortActive().catch((error) => {
      this.#onInternalError(error);
    });

    let interrupted: readonly JobRunState[] = [];
    let persistenceError: unknown;
    try {
      interrupted = this.#repository.markAllInterrupted(this.#clock());
    } catch (error) {
      persistenceError = error;
    } finally {
      // Even a failed interruption transaction must not permit late SQLite use
      // after the process storage owner proceeds to its bounded close.
      this.#jobRunner.sealPersistence(interrupted);
    }
    if (persistenceError !== undefined) throw persistenceError;
  }

  abortActive(): Promise<void> {
    if (!this.#started) {
      try { this.beginShutdown(); } catch (error) { this.#onInternalError(error); }
    }
    return this.#abortPromise ?? Promise.resolve();
  }

  dispose(): Promise<void> {
    if (!this.#started) {
      try { this.beginShutdown(); } catch (error) { this.#onInternalError(error); }
    }
    this.#disposePromise ??= Promise.allSettled([
      this.#scheduler.dispose(),
      this.#hookRunner.dispose(),
      this.#jobRunner.dispose(),
      this.#registry.dispose(),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") this.#onInternalError(result.reason);
      }
    });
    return this.#disposePromise;
  }
}
