import express from "express";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import {
  ConfigurationError,
  loadConfig,
  type ServerConfig,
} from "./config.js";
import { ConversationRegistry } from "./conversation-registry.js";
import { PiRuntimeFactory } from "./pi-runtime.js";
import {
  WebSocketProtocol,
  type ProtocolHistory,
  type ProtocolRegistry,
} from "./protocol.js";
import { SessionHistory } from "./session-history.js";
import { serveWebApp } from "./static.js";
import { hasAllowedWebSocketOrigin } from "./websocket-boundary.js";

interface PackageMetadata {
  readonly version?: unknown;
}

export interface ChatWcaServer {
  readonly httpServer: Server;
  readonly webSocketServer: WebSocketServer;
  readonly protocol: WebSocketProtocol | undefined;
}

export interface ChatWcaProtocolServices {
  readonly registry: ProtocolRegistry;
  readonly history: ProtocolHistory;
  readonly onInternalError?: (error: unknown) => void;
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

/** Build the shared HTTP/WebSocket server without binding a network port. */
export function createChatWcaServer(
  config: Readonly<ServerConfig>,
  serverVersion = readServerVersion(),
  services?: ChatWcaProtocolServices,
): ChatWcaServer {
  const app = express();

  app.get("/api/health", (_request, response) => {
    response.json({ ready: true, version: serverVersion });
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
  const webSocketServer = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
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

  return { httpServer, webSocketServer, protocol };
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
      refreshHistory: async () => {
        await history.refresh();
      },
      onListenerError: (error) => console.error("ChatWCA runtime error", error),
    });

    const { httpServer } = createChatWcaServer(config, readServerVersion(), {
      registry,
      history,
      onInternalError: (error) =>
        console.error("ChatWCA protocol error", error),
    });
    httpServer.listen(config.port, config.host, () => {
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
