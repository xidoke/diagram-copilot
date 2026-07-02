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
import type { WorkspaceOps } from "./workspace/watcher.js";
import type { LifecycleOps } from "./workspace/lifecycle.js";
import { LAYOUT_API_PREFIX, type LayoutApiHandler } from "./layout-overrides.js";
import { NOTES_API_PREFIX, type NotesApiHandler } from "./notes.js";
import { UNDO_PATH } from "./history/http.js";

/**
 * Route for the MCP Streamable HTTP endpoint (Claude Code). Kept here so the
 * router owns its paths; the handler itself lives in `mcp/handler.ts`.
 */
export const MCP_PATH = "/mcp";

/**
 * Route for the diagram picker's "open" action (DGC-57/T36): `POST { name }`
 * activates `name` on the workspace watcher, creating it first if it doesn't
 * exist yet (same behavior as the `open_diagram` MCP tool). Unlike `/mcp`,
 * this is a small enough surface that its handler lives right here rather
 * than in its own module — see {@link createOpenHandler}.
 */
export const API_OPEN_PATH = "/api/open";

/**
 * Routes for the picker's diagram-lifecycle actions (DGC-65): `POST /api/rename`
 * `{ name, newName }` renames a diagram + its sidecars, and `POST /api/trash`
 * `{ name }` moves one into the (recoverable) trash. Both are handled by
 * {@link createLifecycleHttpHandler}, which owns its own method policy and
 * dispatches on pathname.
 */
export const API_RENAME_PATH = "/api/rename";
export const API_TRASH_PATH = "/api/trash";

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

/** A `node:http` request handler for the `/api/open` route. */
export type OpenRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Refuse bodies past this size before they're even parsed — a diagram name is a few bytes. */
const MAX_OPEN_BODY_BYTES = 16 * 1024;

/** JSON shape sent back by {@link createOpenHandler} — mirrors `WorkspaceOps.open`'s `OpenResult`. */
interface OpenResponseBody {
  ok: boolean;
  created: boolean;
  name: string;
  version: number;
  error?: string;
}

function sendJson(res: ServerResponse, status: number, body: OpenResponseBody): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Buffer and JSON-parse a request body, rejecting anything past {@link MAX_OPEN_BODY_BYTES}. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_OPEN_BODY_BYTES) {
      throw new Error("Request body too large.");
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) return {};
  return JSON.parse(raw);
}

/**
 * Build the `/api/open` route handler: reads `{ name: string }` from the POST
 * body, activates it on the workspace watcher (creating it if new), and
 * responds with the resulting `OpenResult` as JSON. `getWorkspace` follows
 * the same mutable-watcher-ref pattern as `mcpHandler`/`getWelcome` in the
 * CLI entry — it may return `null` before the watcher has started, in which
 * case the request is refused with 503 rather than crashing.
 */
export function createOpenHandler(getWorkspace: () => WorkspaceOps | null): OpenRequestHandler {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, created: false, name: "", version: 0, error: "Method Not Allowed" }));
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { ok: false, created: false, name: "", version: 0, error: "Invalid JSON body." });
      return;
    }

    const rawName =
      body !== null && typeof body === "object" && "name" in body
        ? (body as { name: unknown }).name
        : undefined;
    if (typeof rawName !== "string") {
      sendJson(res, 400, {
        ok: false,
        created: false,
        name: "",
        version: 0,
        error: '"name" must be a string.',
      });
      return;
    }

    const workspace = getWorkspace();
    if (!workspace) {
      sendJson(res, 503, {
        ok: false,
        created: false,
        name: rawName,
        version: 0,
        error: "Workspace is not ready yet — try again in a moment.",
      });
      return;
    }

    const result = workspace.open(rawName);
    sendJson(res, result.ok ? 200 : 400, result);
  };
}

/** Serialize an arbitrary JSON body with the right headers (lifecycle routes). */
function sendJsonBody(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Pull a string field from a parsed JSON body, or `undefined` when absent/non-string. */
function stringField(body: unknown, key: string): string | undefined {
  if (body !== null && typeof body === "object" && key in body) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/**
 * Build the `/api/rename` + `/api/trash` route handler (DGC-65 diagram picker):
 * `POST` only, dispatched on pathname. `rename` reads `{ name, newName }`,
 * `trash` reads `{ name }`; both act through the shared {@link LifecycleOps}
 * and echo the result as JSON. `getLifecycle` follows the same
 * mutable-watcher-ref pattern as {@link createOpenHandler} — `null` before the
 * watcher has started yields a 503.
 */
export function createLifecycleHttpHandler(
  getLifecycle: () => LifecycleOps | null,
): OpenRequestHandler {
  return async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "Method Not Allowed" }));
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJsonBody(res, 400, { ok: false, error: "Invalid JSON body." });
      return;
    }

    const lifecycle = getLifecycle();
    if (!lifecycle) {
      sendJsonBody(res, 503, { ok: false, error: "Workspace is not ready yet — try again in a moment." });
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === API_RENAME_PATH) {
      const name = stringField(body, "name");
      const newName = stringField(body, "newName");
      if (name === undefined || newName === undefined) {
        sendJsonBody(res, 400, { ok: false, error: '"name" and "newName" must be strings.' });
        return;
      }
      const result = lifecycle.rename(name, newName);
      sendJsonBody(res, result.ok ? 200 : 400, result);
      return;
    }

    // API_TRASH_PATH
    const name = stringField(body, "name");
    if (name === undefined) {
      sendJsonBody(res, 400, { ok: false, error: '"name" must be a string.' });
      return;
    }
    const result = lifecycle.trash(name);
    sendJsonBody(res, result.ok ? 200 : 400, result);
  };
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
 * validation, and the filesystem write. Same deal for `openHandler` at
 * {@link API_OPEN_PATH} (the diagram picker's "open" action, DGC-57/T36),
 * `apiHandler` for the layout-override sidecar (`/api/layout/:name`, T30),
 * and `undoHandler` for `POST /api/undo` (T31) — each owns its method policy.
 */
export function createRequestHandler(
  staticDir?: string,
  mcpHandler?: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  exportDir?: string,
  openHandler?: OpenRequestHandler,
  apiHandler?: LayoutApiHandler,
  undoHandler?: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>,
  notesHandler?: NotesApiHandler,
  lifecycleHandler?: OpenRequestHandler,
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

    if (openHandler && url.pathname === API_OPEN_PATH) {
      void openHandler(req, res);
      return;
    }

    // Diagram lifecycle (DGC-65): rename + trash. One handler, two paths.
    if (lifecycleHandler && (url.pathname === API_RENAME_PATH || url.pathname === API_TRASH_PATH)) {
      void lifecycleHandler(req, res);
      return;
    }

    // `POST /api/undo` (T31) — exact match, before the layout prefix below.
    if (undoHandler && url.pathname === UNDO_PATH) {
      void undoHandler(req, res);
      return;
    }

    // Layout-override sidecar API (`/api/layout/:name`, GET/PUT/DELETE). Placed
    // before the GET/HEAD-only guard below so its PUT/DELETE verbs reach it.
    if (apiHandler && url.pathname.startsWith(LAYOUT_API_PREFIX)) {
      void apiHandler(req, res);
      return;
    }

    // Per-diagram markdown notes API (`/api/notes/:name`, GET/PUT). Same
    // placement rationale as the layout branch — its PUT verb must reach it
    // before the GET/HEAD-only guard below.
    if (notesHandler && url.pathname.startsWith(NOTES_API_PREFIX)) {
      void notesHandler(req, res);
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
