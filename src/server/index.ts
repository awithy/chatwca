import express from "express";

import { serveWebApp } from "./static.js";

const app = express();
serveWebApp(app);

// Typed configuration and the shared HTTP/WebSocket server are added in T1.2/T1.3.
const host = process.env.CHATWCA_HOST ?? "0.0.0.0";
const port = Number(process.env.CHATWCA_PORT ?? "8787");

app.listen(port, host, () => {
  console.log(`ChatWCA listening on http://${host}:${String(port)}`);
});
