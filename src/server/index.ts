import express from "express";

import { ConfigurationError, loadConfig } from "./config.js";
import { serveWebApp } from "./static.js";

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

  const app = express();
  serveWebApp(app);

  // The shared HTTP/WebSocket server is added in T1.3.
  app.listen(config.port, config.host, () => {
    console.log(
      `ChatWCA listening on http://${config.host}:${String(config.port)}`,
    );
  });
}

main();
