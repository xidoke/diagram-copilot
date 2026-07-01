/**
 * Static file serving for the diagram-copilot web app.
 *
 * The server ships the built web bundle (`packages/web/dist`) over plain
 * `node:http` — no framework, to keep the single binary light (Master's
 * decision). When the bundle has not been built yet we serve a small
 * fallback page so `--dev` and fresh checkouts still show something useful.
 */
import { createReadStream, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { EXPORT_PATH, handleExportRequest } from "./export/save.js";

/**
 * Route for the MCP Streamable HTTP endpoint (Claude Code). Kept here so the
 * router owns its paths; the handler itself lives in `mcp/handler.ts`.
 */
export const MCP_PATH = "/mcp";

/** Shown when `packages/web/dist` is missing (web app not built yet). */
export const FALLBACK_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>diagram-copilot</title>
    <style>
      body { font: 16px/1.5 system-ui, sans-serif; margin: 4rem auto; max-width: 40rem; color: #222; }
      code { background: #f2f2f2; padding: 0.1em 0.35em; border-radius: 4px; }
    </style>
  </head>
  <body>
    <h1>diagram-copilot — web app chưa build</h1>
    <p>The server is running, but no web bundle was found at <code>packages/web/dist</code>.</p>
    <p>Build the web app (<code>pnpm --filter @diagram-copilot/web build</code>) then reload.</p>
  </body>
</html>
`;

/** Minimal extension → content-type map for the assets we actually serve. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** `statSync` that returns `undefined` instead of throwing on a missing path. */
function statOrUndefined(target: string) {
  return statSync(target, { throwIfNoEntry: false });
}

/**
 * Resolve a request path to a file inside `staticDir`, guarding against
 * path traversal (`../`). Returns `null` if the resolved path escapes the
 * directory.
 */
function resolveWithin(staticDir: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const filePath = path.join(staticDir, path.normalize(decoded));
  const relative = path.relative(staticDir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return filePath;
}

function sendFallback(res: ServerResponse, method: string): void {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(FALLBACK_HTML),
  });
  res.end(method === "HEAD" ? undefined : FALLBACK_HTML);
}

function sendFile(res: ServerResponse, method: string, filePath: string, size: number): void {
  res.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "content-length": size,
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

/**
 * Build a `node:http` request listener that serves the web bundle from
 * `staticDir`, falling back to {@link FALLBACK_HTML} when the bundle is
 * absent. Unknown routes resolve to `index.html` (SPA-style) when it
 * exists, so client-side routing works.
 *
 * When `mcpHandler` is provided, requests to {@link MCP_PATH} (any method —
 * the handler owns its own method policy) are forwarded to it instead of
 * the static pipeline.
 *
 * When `exportDir` is provided, `POST` {@link EXPORT_PATH} is forwarded to
 * `handleExportRequest` (see `export/save.ts`), which owns body reading,
 * validation, and the filesystem write.
 */
export function createRequestHandler(
  staticDir?: string,
  mcpHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  exportDir?: string,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (mcpHandler && url.pathname === MCP_PATH) {
      void mcpHandler(req, res);
      return;
    }

    if (exportDir && req.method === "POST" && url.pathname === EXPORT_PATH) {
      void handleExportRequest(req, res, exportDir);
      return;
    }

    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    // No bundle on disk → always serve the fallback page.
    if (!staticDir || !statOrUndefined(staticDir)?.isDirectory()) {
      sendFallback(res, method);
      return;
    }

    const pathname = url.pathname === "/" ? "/index.html" : url.pathname;

    const resolved = resolveWithin(staticDir, pathname);
    if (resolved === null) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    let filePath = resolved;
    let stat = statOrUndefined(filePath);
    if (stat?.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      stat = statOrUndefined(filePath);
    }

    if (stat?.isFile()) {
      sendFile(res, method, filePath, stat.size);
      return;
    }

    // Unknown route: fall back to the SPA shell if present, else the notice.
    const indexPath = path.join(staticDir, "index.html");
    const indexStat = statOrUndefined(indexPath);
    if (indexStat?.isFile()) {
      sendFile(res, method, indexPath, indexStat.size);
      return;
    }
    sendFallback(res, method);
  };
}
