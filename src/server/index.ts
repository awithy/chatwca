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
import { serveWebApp } from "./static.js";
import { hasAllowedWebSocketOrigin } from "./websocket-boundary.js";

interface PackageMetadata {
  readonly version?: unknown;
}

export interface ChatWcaServer {
  readonly httpServer: Server;
  readonly webSocketServer: WebSocketServer;
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

  webSocketServer.on("connection", (socket) => {
    socket.send(JSON.stringify({ type: "ready", serverVersion }));
  });

  return { httpServer, webSocketServer };
}

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error: unknown) {
    const message =
      error instanceof ConfigurationError
        ? error.message
        : "Unexpected error while loading configuration";
    console.error(`ChatWCA configuration error: ${message}`);
    process.exitCode = 1;
    return;
  }

  const { httpServer } = createChatWcaServer(config);
  httpServer.listen(config.port, config.host, () => {
    console.log(
      `ChatWCA listening on http://${config.host}:${String(config.port)}`,
    );
  });
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(entryPoint)
) {
  main();
}
