/**
 * Raw DSL read API for the diff overlay (DGC-79): `GET /api/dsl/:name` returns
 * a diagram's `.arch` source verbatim as `{ name, dsl }`.
 *
 * The web's Δ (diff) overlay compares a step to the one before it — it fetches
 * both steps' DSL by name, parses each with the shared core parser, and diffs
 * the two documents client-side (see `packages/web/src/render/diffOverlay.ts`).
 * The step navigation only has diagram *names*, not their source, so this
 * read-only endpoint hands back the raw text for any diagram in the workspace.
 *
 * The `:name` segment is sanitized exactly like the notes / layout-sidecar
 * handlers and the workspace watcher (empty rejected, optional `.arch` stripped,
 * no path separators or `..`), so a request can never read outside the
 * workspace dir. A name with no `.arch` file on disk is a 404 (not an error) —
 * the common case when a step chain references a base diagram that was never
 * materialized.
 */
import { readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ARCH_EXT } from "@diagram-copilot/core";

/** URL prefix this handler owns; requests under it are `/api/dsl/:name`. */
export const DSL_API_PREFIX = "/api/dsl/";

/** The request-handler shape wired into {@link createRequestHandler}. */
export type DslApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Sanitize outcome — a bare, workspace-safe diagram stem, or a reason it was refused. */
type SanitizeResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Validate + normalize a `:name` into a bare diagram stem. Mirrors the notes
 * handler's `sanitizeName` (and the workspace watcher's `validateDiagramName`):
 * the choke point that keeps a request from escaping the workspace root via
 * separators or `..`.
 */
function sanitizeName(raw: string): SanitizeResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Diagram name must not be empty." };
  }
  const name = trimmed.endsWith(ARCH_EXT) ? trimmed.slice(0, -ARCH_EXT.length) : trimmed;
  if (name.length === 0) {
    return { ok: false, error: "Diagram name must not be empty." };
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return {
      ok: false,
      error: `Invalid diagram name "${raw}" — names cannot contain path separators or "..".`,
    };
  }
  return { ok: true, name };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * Build the `/api/dsl/:name` request handler bound to `workspaceDir`. GET-only;
 * mirrors {@link createNotesApiHandler}: constructed at the CLI entry (which
 * owns the workspace path) and forwarded into {@link createRequestHandler}.
 */
export function createDslApiHandler(workspaceDir: string): DslApiHandler {
  const root = path.resolve(workspaceDir);

  return async (req, res) => {
    const method = req.method ?? "GET";
    if (method !== "GET") {
      res.writeHead(405, { allow: "GET", "content-type": "text/plain; charset=utf-8" });
      res.end("Method Not Allowed");
      return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    let rawName: string;
    try {
      rawName = decodeURIComponent(url.pathname.slice(DSL_API_PREFIX.length));
    } catch {
      sendJson(res, 400, { error: "Malformed diagram name." });
      return;
    }

    const validated = sanitizeName(rawName);
    if (!validated.ok) {
      sendJson(res, 400, { error: validated.error });
      return;
    }

    let dsl: string;
    try {
      dsl = readFileSync(path.join(root, `${validated.name}${ARCH_EXT}`), "utf8");
    } catch {
      // No `.arch` on disk (or unreadable) → 404: a diagram that was never
      // materialized, not a server error.
      sendJson(res, 404, { error: `No diagram named "${validated.name}".` });
      return;
    }

    sendJson(res, 200, { name: validated.name, dsl });
  };
}
