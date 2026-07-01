/**
 * HTTP surface for the history feature — the `POST /api/undo` route (T31).
 *
 * The web canvas has no MCP channel, so its ⌘Z Undo button reaches the exact
 * same {@link HistoryStore.undo} logic the `undo_diagram` MCP tool uses, over
 * plain HTTP. The router (`http.ts`) forwards every `/api/*` request here; this
 * handler owns the method policy + body parsing and answers with a small JSON
 * receipt (the {@link import("./store.js").HistoryActionResult} shape).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { HistoryStore } from "./store.js";
import type { WorkspaceOps } from "../workspace/watcher.js";

/** Route this handler answers. */
export const UNDO_PATH = "/api/undo";

/** Cap on the request body we will buffer — undo bodies are tiny (`{ name }`). */
const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** Buffer a (small) request body to a string, rejecting anything oversized. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > MAX_BODY_BYTES) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/** Name of the active diagram, or `null` when the workspace is empty. */
function activeName(diagrams: ReturnType<WorkspaceOps["list"]>): string | null {
  return diagrams.find((d) => d.active)?.name ?? null;
}

/**
 * Build the `/api/undo` request handler. `getWorkspace`/`getHistory` are thunks
 * (the watcher + store are created only after the port is secured), returning
 * `null` before the workspace is ready. Body: optional `{ name }` — defaults to
 * the active diagram.
 */
export function createUndoApiHandler(
  getWorkspace: () => WorkspaceOps | null,
  getHistory: () => HistoryStore | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed — POST only." });
      return;
    }

    const workspace = getWorkspace();
    const history = getHistory();
    if (workspace === null || history === null) {
      sendJson(res, 503, { ok: false, error: "Workspace is not ready yet." });
      return;
    }

    let name: string | undefined;
    try {
      const raw = await readBody(req);
      if (raw.trim().length > 0) {
        const parsed = JSON.parse(raw) as { name?: unknown };
        if (typeof parsed.name === "string") name = parsed.name;
      }
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON body." });
      return;
    }

    const target = name ?? activeName(workspace.list());
    if (target === null) {
      sendJson(res, 409, { ok: false, error: "No diagram is open." });
      return;
    }

    const result = history.undo(target, workspace);
    // 200 on a successful revert; 409 (conflict) when there is nothing to undo
    // or the diagram is unreadable — the receipt body explains which.
    sendJson(res, result.ok ? 200 : 409, result);
  };
}
