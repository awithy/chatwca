import express from "express";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

import {
  ConfigurationError,
  loadConfig,
  type ServerConfig,
} from "./config.js";
import { ConversationRegistry } from "./conversation-registry.js";
import { PiRuntimeFactory } from "./pi-runtime.js";
import type { OutboundFlowOptions } from "./outbound-flow.js";
import {
  DEFAULT_MAX_INBOUND_MESSAGE_BYTES,
  WebSocketProtocol,
  type ProtocolHistory,
  type ProtocolRegistry,
} from "./protocol.js";
import { SessionHistory } from "./session-history.js";
import {
  GracefulShutdown,
  WEBSOCKET_RESTART_CLOSE_CODE,
  WEBSOCKET_RESTART_CLOSE_REASON,
  type ShutdownRuntimeOwner,
} from "./shutdown.js";
import { serveWebApp } from "./static.js";
import { hasAllowedWebSocketOrigin } from "./websocket-boundary.js";

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
  readonly maxInboundMessageBytes?: number;
  readonly outboundFlow?: OutboundFlowOptions;
  /** Production supplies the registry here so transport and Pi teardown share one bound. */
  readonly shutdown?: ShutdownRuntimeOwner;
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
    console.error("ChatWCA shutdown error", error),
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
  let accepting = true;

  app.get("/api/health", (_request, response) => {
    response.json({ ready: accepting, version: serverVersion });
  });

  app.get("/api/config", (_request, response) => {
    response.json({
      defaultCwd: config.defaultCwd,
      maxImages: config.maxImages,
      maxImageBytes: config.maxImageBytes,
      maxTotalImageBytes: config.maxTotalImageBytes,
    });
  });

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

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    const runtimeFactory = await PiRuntimeFactory.create({
      ...(config.piCodingAgentDir === undefined
        ? {}
        : { agentDir: config.piCodingAgentDir }),
    });

    let registry: ConversationRegistry | undefined;
    const history = new SessionHistory({
      getLiveStatus: (identity) =>
        registry?.get(identity.id)?.status ??
        registry?.getBySessionFile(identity.sessionFile)?.status,
    });
    registry = new ConversationRegistry({
      runtimeFactory,
      maxLiveConversations: config.maxLiveConversations,
      imageLimits: {
        maxImages: config.maxImages,
        maxImageBytes: config.maxImageBytes,
        maxTotalImageBytes: config.maxTotalImageBytes,
      },
      refreshHistory: async () => {
        await history.refresh();
      },
      onListenerError: (error) => console.error("ChatWCA runtime error", error),
    });

    const server = createChatWcaServer(config, readServerVersion(), {
      registry,
      history,
      shutdown: registry,
      onInternalError: (error) =>
        console.error("ChatWCA protocol error", error),
    });
    installShutdownSignalHandlers(server);

    server.httpServer.listen(config.port, config.host, () => {
      console.log(
        `ChatWCA listening on http://${config.host}:${String(config.port)}`,
      );
    });
  } catch (error: unknown) {
    const message =
      error instanceof ConfigurationError
        ? error.message
        : "Unexpected error while starting ChatWCA";
    console.error(`ChatWCA startup error: ${message}`);
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
