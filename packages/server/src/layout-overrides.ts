/**
 * HTTP handler for the layout-override sidecar API (`/api/layout/:name`).
 *
 * A diagram's manually dragged node positions live in a `<name>.layout.json`
 * sidecar next to its `.arch` source in the workspace (see `layoutSidecarPath`
 * / `LayoutOverridesSchema` in core). This handler is the web app's read/write
 * door to that file:
 *   - `GET`    → the current overrides (`{}` when no sidecar exists yet)
 *   - `PUT`    → validate the body against {@link LayoutOverridesSchema} and persist it
 *   - `DELETE` → remove the sidecar (the "reset layout" back to pure auto-layout)
 *
 * The `:name` segment is sanitized exactly like the workspace watcher sanitizes
 * diagram names (empty rejected, optional `.arch` stripped, no path separators
 * or `..`), so a request can never read or write outside the workspace dir.
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import {
  ARCH_EXT,
  LayoutOverridesSchema,
  layoutSidecarPath,
  type LayoutOverrides,
} from "@diagram-copilot/core";

/** URL prefix this handler owns; requests under it are `/api/layout/:name`. */
export const LAYOUT_API_PREFIX = "/api/layout/";

/** The request-handler shape wired into {@link createRequestHandler}. */
export type LayoutApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Guard against a runaway PUT body (positions are tiny — 1 MiB is generous). */
const MAX_BODY_BYTES = 1_000_000;

/**
 * Validate + normalize a `:name` segment into a bare diagram stem. Mirrors the
 * workspace watcher's `validateDiagramName`: the same choke point that keeps a
 * request from escaping the workspace root via separators or `..`.
 */
function sanitizeName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
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

/** Read the whole request body as UTF-8, rejecting once it exceeds the cap. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large."));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * Read + validate a sidecar. A missing file (never dragged) reads as `{}`; a
 * present-but-corrupt file is tolerated the same way rather than breaking the
 * canvas — a bad sidecar just falls back to pure auto-layout.
 */
function readOverrides(sidecarPath: string): LayoutOverrides {
  let text: string;
  try {
    text = readFileSync(sidecarPath, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = LayoutOverridesSchema.safeParse(JSON.parse(text));
    if (parsed.success) return parsed.data;
    console.warn(`[layout] ignoring invalid sidecar ${sidecarPath}`);
    return {};
  } catch {
    console.warn(`[layout] ignoring unparseable sidecar ${sidecarPath}`);
    return {};
  }
}

/**
 * Build the `/api/layout/:name` request handler bound to `workspaceDir`.
 * Mirrors the `mcpHandler` wiring: constructed at the CLI entry (which owns the
 * workspace path) and forwarded into {@link createRequestHandler}.
 */
export function createLayoutApiHandler(workspaceDir: string): LayoutApiHandler {
  const root = path.resolve(workspaceDir);

  return async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");

    let rawName: string;
    try {
      rawName = decodeURIComponent(url.pathname.slice(LAYOUT_API_PREFIX.length));
    } catch {
      sendJson(res, 400, { error: "Malformed diagram name." });
      return;
    }
    const validated = sanitizeName(rawName);
    if (!validated.ok) {
      sendJson(res, 400, { error: validated.error });
      return;
    }
    const sidecarPath = path.join(root, layoutSidecarPath(validated.name));

    if (method === "GET") {
      sendJson(res, 200, readOverrides(sidecarPath));
      return;
    }

    if (method === "PUT") {
      let bodyText: string;
      try {
        bodyText = await readBody(req);
      } catch (error) {
        sendJson(res, 413, { error: (error as Error).message });
        return;
      }
      let raw: unknown;
      try {
        raw = bodyText.trim() === "" ? {} : JSON.parse(bodyText);
      } catch {
        sendJson(res, 400, { error: "Request body is not valid JSON." });
        return;
      }
      const result = LayoutOverridesSchema.safeParse(raw);
      if (!result.success) {
        sendJson(res, 400, { error: "Invalid layout overrides.", issues: result.error.issues });
        return;
      }
      writeFileSync(sidecarPath, `${JSON.stringify(result.data, null, 2)}\n`);
      sendJson(res, 200, result.data);
      return;
    }

    if (method === "DELETE") {
      // `force` makes a missing sidecar a no-op, so DELETE is idempotent.
      rmSync(sidecarPath, { force: true });
      sendJson(res, 200, {});
      return;
    }

    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
  };
}
