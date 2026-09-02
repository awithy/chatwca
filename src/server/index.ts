import express from "express";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

import { redactedErrorDiagnostic, toAppError } from "../shared/errors.js";
import {
  ConfigurationError,
  loadConfig,
  type ServerConfig,
} from "./config.js";
import { ConversationRegistry } from "./conversation-registry.js";
import type { ConversationImageOwner } from "./conversation-images.js";
import {
  openDatabase,
  type ChatWcaDatabase,
} from "./database.js";
import {
  PiRuntimeFactory,
  type PiRuntimeFactoryPort,
} from "./pi-runtime.js";
import type { OutboundFlowOptions } from "./outbound-flow.js";
import {
  DEFAULT_MAX_INBOUND_MESSAGE_BYTES,
  WebSocketProtocol,
  type ProtocolHistory,
  type ProtocolRegistry,
  type ProtocolWorkspaceRepository,
} from "./protocol.js";
import {
  SessionHistory,
  type SessionHistoryOptions,
} from "./session-history.js";
import {
  GracefulShutdown,
  WEBSOCKET_RESTART_CLOSE_CODE,
  WEBSOCKET_RESTART_CLOSE_REASON,
  type ShutdownRuntimeOwner,
} from "./shutdown.js";
import {
  validateBwrapAndToolchain,
  type SandboxWorkerArtifact,
  type ValidatedSandboxHost,
} from "./sandbox/bwrap.js";
import {
  loadSandboxWorkerArtifact,
  runSandboxStartupProbe,
  type SandboxFunctionalProbeResult,
} from "./sandbox/probe.js";
import { publicSandboxConfig } from "./sandbox/config.js";
import { publicManagedEgressConfig } from "./network/config.js";
import { serveWebApp } from "./static.js";
import { hasAllowedWebSocketOrigin } from "./websocket-boundary.js";
import { WorkspaceRepository } from "./workspace-repository.js";

interface PackageMetadata {
  readonly version?: unknown;
}

export interface ChatWcaServer {
  readonly httpServer: Server;
  readonly webSocketServer: WebSocketServer;
  readonly protocol: WebSocketProtocol | undefined;
  readonly isShuttingDown: boolean;
  shutdown(): Promise<void>;
}

export interface ChatWcaProtocolServices {
  readonly registry: ProtocolRegistry;
  readonly history: ProtocolHistory;
  /** Optional HTTP owner for image blocks retained in live Pi sessions. */
  readonly images?: ConversationImageOwner;
  /** Required authority for every browser workspace and conversation lifecycle command. */
  readonly workspaces: ProtocolWorkspaceRepository;
  readonly maxInboundMessageBytes?: number;
  readonly outboundFlow?: OutboundFlowOptions;
  /** Production supplies the registry here so transport and Pi teardown share one bound. */
  readonly shutdown?: ShutdownRuntimeOwner;
  /** Production supplies the process-wide SQLite owner. */
  readonly closeStorage?: () => void;
  readonly sandboxFunctionalProbeSucceeded?: boolean;
  readonly managedNetworkFunctionalProbeSucceeded?: boolean;
  readonly onInternalError?: (error: unknown) => void;
}

export interface ShutdownSignalTarget {
  on(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(signal: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/** Install coalesced process signal handlers; the returned function removes them. */
export function installShutdownSignalHandlers(
  server: Pick<ChatWcaServer, "shutdown">,
  target: ShutdownSignalTarget = process,
  exit: (code: number) => void = (code) => process.exit(code),
  onError: (error: unknown) => void = (error) =>
    console.error(`ChatWCA shutdown error: ${redactedErrorDiagnostic(error)}`),
): () => void {
  let handled = false;
  const handle = () => {
    if (handled) return;
    handled = true;
    void server.shutdown().then(
      () => exit(0),
      (error: unknown) => {
        onError(error);
        exit(1);
      },
    );
  };

  target.on("SIGINT", handle);
  target.on("SIGTERM", handle);
  return () => {
    target.off("SIGINT", handle);
    target.off("SIGTERM", handle);
  };
}

function readServerVersion(): string {
  let directory = path.dirname(fileURLToPath(import.meta.url));

  while (true) {
    try {
      const metadata = JSON.parse(
        readFileSync(path.join(directory, "package.json"), "utf8"),
      ) as PackageMetadata;
      if (typeof metadata.version === "string") {
        return metadata.version;
      }
    } catch (error: unknown) {
      const code =
        error !== null && typeof error === "object" && "code" in error
          ? error.code
          : undefined;
      if (code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error("Unable to locate ChatWCA package metadata");
    }
    directory = parent;
  }
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

function closeWebSocketServer(server: WebSocketServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error !== undefined) reject(error);
      else resolve();
    });
  });
}

/** Build the shared HTTP/WebSocket server without binding a network port. */
export function createChatWcaServer(
  config: Readonly<ServerConfig>,
  serverVersion = readServerVersion(),
  services?: ChatWcaProtocolServices,
): ChatWcaServer {
  const app = express();
  // Readiness is distinct from construction: production constructs this shell
  // only after SQLite and shared Pi services initialize, then becomes ready
  // when its network listener is actually bound.
  let accepting = false;

  app.get("/api/health", (_request, response) => {
    response.json({ ready: accepting, version: serverVersion });
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      maxImages: config.maxImages,
      maxImageBytes: config.maxImageBytes,
      maxTotalImageBytes: config.maxTotalImageBytes,
      sandbox: publicSandboxConfig(
        config.sandbox,
        services?.sandboxFunctionalProbeSucceeded ?? false,
      ),
      managedEgress: publicManagedEgressConfig(
        config.managedNetwork,
        services?.managedNetworkFunctionalProbeSucceeded ?? false,
      ),
    });
  });

  app.get(
    "/api/conversations/:conversationId/workspace-images",
    async (request, response) => {
      const filePath = request.query.path;
      if (typeof filePath !== "string") {
        response.sendStatus(404);
        return;
      }
      const image = await services?.images?.getWorkspaceImage(
        request.params.conversationId,
        filePath,
      );
      if (image === undefined) {
        response.sendStatus(404);
        return;
      }

      response.set({
        "Cache-Control": "private, no-store",
        "Content-Type": image.mimeType,
        "Content-Length": String(image.data.byteLength),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      });
      response.send(image.data);
    },
  );

  app.get(
    "/api/conversations/:conversationId/messages/:entryId/images/:imageIndex",
    (request, response) => {
      const rawIndex = request.params.imageIndex;
      if (!/^(0|[1-9]\d*)$/.test(rawIndex)) {
        response.sendStatus(404);
        return;
      }
      const image = services?.images?.getImage(
        request.params.conversationId,
        request.params.entryId,
        Number(rawIndex),
      );
      if (image === undefined) {
        response.sendStatus(404);
        return;
      }

      response.set({
        "Cache-Control": "private, no-store",
        "Content-Type": image.mimeType,
        "Content-Length": String(image.data.byteLength),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      });
      response.send(image.data);
    },
  );

  serveWebApp(app);

  const httpServer = createHttpServer(app);
  const maxInboundMessageBytes =
    services?.maxInboundMessageBytes ?? DEFAULT_MAX_INBOUND_MESSAGE_BYTES;
  const webSocketServer = new WebSocketServer({
    noServer: true,
    // Enforce the same aggregate frame/fragment bound inside ws, before the
    // command decoder allocates or parses the payload.
    maxPayload: maxInboundMessageBytes,
  });

  httpServer.on("listening", () => {
    if (!gracefulShutdown.started) accepting = true;
  });
  httpServer.on("upgrade", (request, socket, head) => {
    if (!accepting) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    if (request.url !== "/ws") {
      socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      return;
    }

    if (!hasAllowedWebSocketOrigin(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }

    webSocketServer.handleUpgrade(request, socket, head, (client) => {
      webSocketServer.emit("connection", client, request);
    });
  });

  const protocol =
    services === undefined
      ? undefined
      : new WebSocketProtocol({
          webSocketServer,
          serverVersion,
          registry: services.registry,
          history: services.history,
          workspaces: services.workspaces,
          maxInboundMessageBytes,
          ...(services.outboundFlow === undefined
            ? {}
            : { outboundFlow: services.outboundFlow }),
          ...(services.onInternalError === undefined
            ? {}
            : { onInternalError: services.onInternalError }),
        });

  // The dependency-free shell remains useful for HTTP and upgrade-boundary
  // tests. Production always supplies protocol services.
  if (protocol === undefined) {
    webSocketServer.on("connection", (socket) => {
      socket.send(JSON.stringify({ type: "ready", serverVersion }));
    });
  }
  webSocketServer.once("close", () => protocol?.dispose());

  const onInternalError = services?.onInternalError ?? (() => undefined);
  const shutdownOwner = services?.shutdown;
  const gracefulShutdown = new GracefulShutdown({
    gracePeriodMs: config.shutdownGraceMs,
    beginShutdown: () => shutdownOwner?.beginShutdown(),
    stopAccepting: () => {
      accepting = false;
    },
    notifyAndCloseClients: () => {
      if (protocol !== undefined) {
        protocol.beginShutdown(config.shutdownGraceMs);
        return;
      }
      const notice = JSON.stringify({
        type: "server.shutdown",
        gracePeriodMs: config.shutdownGraceMs,
      });
      for (const client of webSocketServer.clients) {
        if (client.readyState !== WebSocket.OPEN) continue;
        try {
          client.send(notice);
          client.close(
            WEBSOCKET_RESTART_CLOSE_CODE,
            WEBSOCKET_RESTART_CLOSE_REASON,
          );
        } catch (error) {
          onInternalError(error);
        }
      }
    },
    closeTransports: async () => {
      await Promise.all([
        closeWebSocketServer(webSocketServer),
        closeHttpServer(httpServer),
      ]);
    },
    abortActive: () => shutdownOwner?.abortActive() ?? Promise.resolve(),
    disposeRuntimes: () => shutdownOwner?.dispose() ?? Promise.resolve(),
    disposeListeners: () => protocol?.dispose(),
    closeStorage: () => services?.closeStorage?.(),
    forceClose: () => {
      protocol?.terminateClients();
      if (protocol === undefined) {
        for (const client of webSocketServer.clients) client.terminate();
      }
      httpServer.closeAllConnections();
    },
    onError: onInternalError,
  });

  return {
    httpServer,
    webSocketServer,
    protocol,
    get isShuttingDown() {
      return gracefulShutdown.started;
    },
    shutdown: () => gracefulShutdown.shutdown(),
  };
}

export interface ChatWcaStartupOptions {
  readonly loadConfiguration?: () => Readonly<ServerConfig>;
  readonly openDatabase?: (dataDir: string) => ChatWcaDatabase;
  readonly createWorkspaceRepository?: (
    connection: ChatWcaDatabase["connection"],
    config: Readonly<ServerConfig>,
  ) => ProtocolWorkspaceRepository;
  readonly loadSandboxWorkerArtifact?: () => Promise<Readonly<SandboxWorkerArtifact>>;
  readonly validateSandboxHost?: (
    config: Readonly<ServerConfig["sandbox"]>,
  ) => Readonly<ValidatedSandboxHost>;
  readonly runSandboxStartupProbe?: (input: {
    readonly config: Readonly<ServerConfig["sandbox"]>;
    readonly host: Readonly<ValidatedSandboxHost>;
    readonly worker: Readonly<SandboxWorkerArtifact>;
    readonly dataDirectory: string;
    readonly piAgentDirectory: string;
  }) => Promise<Readonly<SandboxFunctionalProbeResult>>;
  readonly createRuntimeFactory?: (
    config: Readonly<ServerConfig>,
  ) => Promise<PiRuntimeFactoryPort>;
  /** Injectable only to assert that startup performs no Pi history listing. */
  readonly listSessions?: SessionHistoryOptions["listSessions"];
  readonly serverVersion?: string;
  readonly listen?: (
    server: ChatWcaServer,
    config: Readonly<ServerConfig>,
  ) => Promise<void>;
  readonly onInternalError?: (error: unknown) => void;
}

function listen(
  server: ChatWcaServer,
  config: Readonly<ServerConfig>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.httpServer.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.httpServer.off("error", onError);
      resolve();
    };
    server.httpServer.once("error", onError);
    server.httpServer.once("listening", onListening);
    try {
      server.httpServer.listen(config.port, config.host);
    } catch (error) {
      server.httpServer.off("error", onError);
      server.httpServer.off("listening", onListening);
      reject(error);
    }
  });
}

function canonicalPathIfPresent(target: string): string {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let candidate = absolute;
  while (true) {
    try {
      return path.join(realpathSync(candidate), ...missing.reverse());
    } catch (error) {
      const code = typeof error === "object" && error !== null && "code" in error
        ? (error as { readonly code?: unknown }).code
        : undefined;
      if (code !== "ENOENT") throw error;
      const parent = path.dirname(candidate);
      if (parent === candidate) throw error;
      missing.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Initialize process-owned services in dependency order and bind listeners last.
 * Any failure after SQLite opens unwinds all ownership before rejecting.
 */
export async function startChatWcaServer(
  options: ChatWcaStartupOptions = {},
): Promise<ChatWcaServer> {
  const reportError = options.onInternalError ?? (() => undefined);
  let database: ChatWcaDatabase | undefined;
  let registry: ConversationRegistry | undefined;
  let server: ChatWcaServer | undefined;

  try {
    const config = (options.loadConfiguration ?? loadConfig)();
    database = (options.openDatabase ?? openDatabase)(config.dataDir);
    const dataDirectory = realpathSync(config.dataDir);
    const piAgentDirectory = canonicalPathIfPresent(
      config.piCodingAgentDir ?? path.join(homedir(), ".pi", "agent"),
    );
    let functionalProbeSucceeded = false;
    let sandboxWorker: Readonly<SandboxWorkerArtifact> | undefined;
    let sandboxHost: Readonly<ValidatedSandboxHost> | undefined;
    if (config.sandbox.mode !== "disabled") {
      let worker: Readonly<SandboxWorkerArtifact>;
      try {
        worker = await (options.loadSandboxWorkerArtifact ?? loadSandboxWorkerArtifact)();
      } catch (error) {
        throw toAppError(error, { source: "sandbox", phase: "configuration" });
      }
      const host = (options.validateSandboxHost ?? validateBwrapAndToolchain)(config.sandbox);
      sandboxWorker = worker;
      sandboxHost = host;
      await (options.runSandboxStartupProbe ?? runSandboxStartupProbe)({
        config: config.sandbox,
        host,
        worker,
        dataDirectory,
        piAgentDirectory,
      });
      functionalProbeSucceeded = true;
    }
    const workspaces = (
      options.createWorkspaceRepository ??
      ((connection, loadedConfig) => new WorkspaceRepository(connection, {
        policy: {
          mode: loadedConfig.sandbox.mode,
          workspaceRoots: loadedConfig.sandbox.workspaceRoots,
          dataDirectory,
          piAgentDirectory,
          readOnlyMounts: loadedConfig.sandbox.readOnlyMounts.map((mount) => mount.source),
          managedEgressMode: loadedConfig.managedNetwork.mode,
          networkHelperPath: loadedConfig.managedNetwork.helperPath,
          networkHelperDirectory: loadedConfig.managedNetwork.helperDirectory,
        },
      }))
    )(database.connection, config);
    const runtimeFactory = await (
      options.createRuntimeFactory ??
      ((loadedConfig) => PiRuntimeFactory.create({
        ...(loadedConfig.piCodingAgentDir === undefined
          ? {}
          : { agentDir: loadedConfig.piCodingAgentDir }),
        ...(sandboxWorker === undefined || sandboxHost === undefined
          ? {}
          : {
              sandbox: {
                config: loadedConfig.sandbox,
                host: sandboxHost,
                worker: sandboxWorker,
                hiddenPaths: [dataDirectory, piAgentDirectory],
              },
            }),
      }))
    )(config);

    const history = new SessionHistory({
      ...(options.listSessions === undefined
        ? {}
        : { listSessions: options.listSessions }),
      getLiveStatus: (identity) => {
        const byFile = registry?.getBySessionFile(identity.sessionFile);
        const byId = registry?.get(identity.id);
        const record =
          byFile ??
          (byId?.sessionFile === identity.sessionFile ? byId : undefined);
        return record === undefined
          ? undefined
          : { workspaceId: record.workspaceId, status: record.status };
      },
    });
    registry = new ConversationRegistry({
      runtimeFactory,
      maxLiveConversations: config.maxLiveConversations,
      imageLimits: {
        maxImages: config.maxImages,
        maxImageBytes: config.maxImageBytes,
        maxTotalImageBytes: config.maxTotalImageBytes,
      },
      onListenerError: reportError,
    });

    server = createChatWcaServer(
      config,
      options.serverVersion ?? readServerVersion(),
      {
        registry,
        history,
        images: registry,
        workspaces,
        shutdown: registry,
        closeStorage: () => database?.close(),
        sandboxFunctionalProbeSucceeded: functionalProbeSucceeded,
        onInternalError: reportError,
      },
    );
    await (options.listen ?? listen)(server, config);
    return server;
  } catch (error) {
    if (server !== undefined) {
      // The normal shutdown coordinator owns registry/protocol/database order.
      await server.shutdown().catch(reportError);
    } else {
      // Construction failed before a coordinator existed. There can be no
      // listener, but registry and SQLite ownership may already exist.
      registry?.beginShutdown();
      await registry?.dispose().catch(reportError);
      try {
        database?.close();
      } catch (cleanupError) {
        reportError(cleanupError);
      }
    }
    throw error;
  }
}

async function main(): Promise<void> {
  try {
    const environmentFile = path.resolve(process.cwd(), ".env");
    if (existsSync(environmentFile)) {
      loadEnvFile(environmentFile);
    }

    const server = await startChatWcaServer({
      onInternalError: (error) =>
        console.error(`ChatWCA internal error: ${redactedErrorDiagnostic(error)}`),
    });
    installShutdownSignalHandlers(server);
    const address = server.httpServer.address();
    const display =
      typeof address === "object" && address !== null
        ? `${address.address}:${String(address.port)}`
        : String(address);
    console.log(`ChatWCA listening on http://${display}`);
  } catch (error: unknown) {
    if (error instanceof ConfigurationError) {
      console.error(`ChatWCA startup error: ${error.message}`);
    } else {
      console.error(`ChatWCA startup error: ${redactedErrorDiagnostic(error)}`);
    }
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(entryPoint)
) {
  main();
}
