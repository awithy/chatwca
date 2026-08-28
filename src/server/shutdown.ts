export const WEBSOCKET_RESTART_CLOSE_CODE = 1012;
export const WEBSOCKET_RESTART_CLOSE_REASON = "Server is shutting down";

export interface ShutdownRuntimeOwner {
  /** Synchronously prevents new runtime work from being accepted. */
  beginShutdown(): void;
  /** Requests cancellation for all runs active at shutdown time. */
  abortActive(): Promise<void>;
  /** Unsubscribes and asks every owned runtime to dispose. */
  dispose(): Promise<void>;
}

export interface GracefulShutdownOptions {
  readonly gracePeriodMs: number;
  readonly beginShutdown: () => void;
  readonly stopAccepting: () => void;
  readonly notifyAndCloseClients: () => void;
  readonly closeTransports: () => Promise<void>;
  readonly abortActive: () => Promise<void>;
  readonly disposeRuntimes: () => Promise<void>;
  readonly disposeListeners: () => void;
  readonly forceClose: () => void;
  /** Injectable deadline for deterministic tests. */
  readonly wait?: (milliseconds: number) => Promise<void>;
  readonly onError?: (error: unknown) => void;
}

function validateGracePeriod(milliseconds: number): number {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new RangeError("gracePeriodMs must be a positive safe integer");
  }
  return milliseconds;
}

/**
 * Coordinates the process shutdown boundary without trusting any SDK/network
 * promise to settle. Once the grace deadline wins, all force-close operations
 * are invoked synchronously and the returned promise resolves.
 */
export class GracefulShutdown {
  readonly #gracePeriodMs: number;
  readonly #options: GracefulShutdownOptions;
  readonly #wait: ((milliseconds: number) => Promise<void>) | undefined;
  readonly #onError: (error: unknown) => void;
  #shutdownPromise: Promise<void> | undefined;
  #disposePromise: Promise<void> | undefined;

  constructor(options: GracefulShutdownOptions) {
    this.#options = options;
    this.#gracePeriodMs = validateGracePeriod(options.gracePeriodMs);
    this.#wait = options.wait;
    this.#onError = options.onError ?? (() => undefined);
  }

  get started(): boolean {
    return this.#shutdownPromise !== undefined;
  }

  /** Every caller receives the same idempotent shutdown operation. */
  shutdown(): Promise<void> {
    this.#shutdownPromise ??= this.#run();
    return this.#shutdownPromise;
  }

  #disposeRuntimes(): Promise<void> {
    if (this.#disposePromise !== undefined) return this.#disposePromise;
    try {
      this.#disposePromise = Promise.resolve(this.#options.disposeRuntimes()).catch(
        (error: unknown) => {
          this.#onError(error);
        },
      );
    } catch (error) {
      this.#onError(error);
      this.#disposePromise = Promise.resolve();
    }
    return this.#disposePromise;
  }

  async #run(): Promise<void> {
    // These calls intentionally happen before the first await: signal handling
    // closes every admission race synchronously.
    try {
      this.#options.beginShutdown();
    } catch (error) {
      this.#onError(error);
    }
    try {
      this.#options.stopAccepting();
    } catch (error) {
      this.#onError(error);
    }
    try {
      this.#options.notifyAndCloseClients();
    } catch (error) {
      this.#onError(error);
    }

    let transportClose: Promise<void>;
    try {
      transportClose = Promise.resolve(this.#options.closeTransports());
    } catch (error) {
      this.#onError(error);
      transportClose = Promise.resolve();
    }
    transportClose.catch(this.#onError);

    let aborts: Promise<void>;
    try {
      aborts = Promise.resolve(this.#options.abortActive());
    } catch (error) {
      this.#onError(error);
      aborts = Promise.resolve();
    }
    aborts.catch(this.#onError);

    const graceful = Promise.allSettled([aborts])
      .then(() => this.#disposeRuntimes())
      .then(() => Promise.allSettled([transportClose]))
      .then(() => undefined);

    let cancelDeadline: () => void = () => undefined;
    const deadline = this.#wait === undefined
      ? new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, this.#gracePeriodMs);
          cancelDeadline = () => clearTimeout(timer);
        })
      : this.#wait(this.#gracePeriodMs);
    const completedGracefully = await Promise.race([
      graceful.then(() => true),
      deadline.then(() => false),
    ]);
    cancelDeadline();

    if (!completedGracefully) {
      // Do not await either operation: a broken runtime, client, or HTTP
      // request must not extend the configured bound.
      void this.#disposeRuntimes();
      try {
        this.#options.forceClose();
      } catch (error) {
        this.#onError(error);
      }
    }

    try {
      this.#options.disposeListeners();
    } catch (error) {
      this.#onError(error);
    }
  }
}
