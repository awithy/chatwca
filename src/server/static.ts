import express, { type Express, type RequestHandler } from "express";
import path from "node:path";

function isServerPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/ws" ||
    pathname.startsWith("/ws/")
  );
}

/** Mount this after API routes so unknown browser routes fall back to index.html. */
export function serveWebApp(
  app: Express,
  webRoot = path.resolve(process.cwd(), "dist/web"),
): void {
  const staticFiles: RequestHandler = express.static(webRoot, { index: false });

  app.use((request, response, next) => {
    if (isServerPath(request.path)) {
      next();
      return;
    }

    staticFiles(request, response, next);
  });

  app.use((request, response, next) => {
    if (request.method !== "GET" || isServerPath(request.path)) {
      next();
      return;
    }

    response.sendFile(path.join(webRoot, "index.html"));
  });
}
