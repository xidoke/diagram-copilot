/**
 * Per-diagram markdown notes: read/write door plus HTTP handler for the
 * `/api/notes/:name` API (DGC-63).
 *
 * Alongside each diagram's `.arch` source lives an optional `<name>.notes.md`
 * file — free-form markdown where the human (or Claude, via the `get_notes` /
 * `set_notes` MCP tools) records the design reasoning behind the picture: the
 * trade-offs weighed, why a queue over a direct call, the TTL chosen, and so
 * on. The diagram is the "what"; the notes are the "why".
 *
 * The file is deliberately NOT a `.arch` file, so the workspace watcher's
 * scan (`isArchFile`) never surfaces it in `list_diagrams` or the picker — it
 * rides along with a diagram but is not one itself.
 *
 *   - `GET`  `/api/notes/:name` → `{ name, markdown }` (`markdown: ""` when no file yet)
 *   - `PUT`  `/api/notes/:name` with `{ markdown }` → persist (capped at 1 MB), echo it back
 *
 * The `:name` segment is sanitized exactly like the layout sidecar handler and
 * the workspace watcher (empty rejected, optional `.arch` stripped, no path
 * separators or `..`), so a request can never read or write outside the
 * workspace dir. The same {@link NotesStore} backs the MCP tools, so both paths
 * share one sanitize + 1 MB cap.
 */
import { readFileSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { ARCH_EXT } from "@diagram-copilot/core";

/** Extension of a diagram's markdown notes file (sits next to its `.arch`). */
export const NOTES_EXT = ".notes.md";

/** URL prefix this handler owns; requests under it are `/api/notes/:name`. */
export const NOTES_API_PREFIX = "/api/notes/";

/** The request-handler shape wired into {@link createRequestHandler}. */
export type NotesApiHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/** Hard cap on a notes document — generous for prose, guards against abuse. */
export const MAX_NOTES_BYTES = 1_000_000;

/**
 * Buffer past which a PUT body is rejected before parsing. Slightly above
 * {@link MAX_NOTES_BYTES} so the `{ "markdown": "…" }` JSON envelope (quotes +
 * escaping) around a right-at-the-limit note is not what trips the guard — the
 * authoritative 1 MB check is on the decoded markdown string, in {@link NotesStore.write}.
 */
const MAX_BODY_BYTES = 2 * MAX_NOTES_BYTES;

/** Sanitize outcome — a bare, workspace-safe diagram stem, or a reason it was refused. */
type SanitizeResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Validate + normalize a `:name` / tool `name` into a bare diagram stem.
 * Mirrors the workspace watcher's `validateDiagramName`: the choke point that
 * keeps a request from escaping the workspace root via separators or `..`.
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

/** Outcome of {@link NotesStore.read}. */
export type NotesReadResult =
  | { ok: true; name: string; markdown: string }
  | { ok: false; error: string };

/** Outcome of {@link NotesStore.write}. */
export type NotesWriteResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Read/write view of a workspace's per-diagram notes, shared by the HTTP
 * handler and the MCP tools so both go through one sanitize + 1 MB cap.
 */
export interface NotesStore {
  /** Read `name`'s notes. A missing file (never written) reads as `""`. */
  read(name: string): NotesReadResult;
  /** Persist `markdown` for `name` (rejected over {@link MAX_NOTES_BYTES}). */
  write(name: string, markdown: string): NotesWriteResult;
}

/**
 * Build a {@link NotesStore} bound to `workspaceDir`. Every note path is
 * resolved under the (absolute) workspace root, and every name flows through
 * {@link sanitizeName}, so a caller can never read/write outside it.
 */
export function createNotesStore(workspaceDir: string): NotesStore {
  const root = path.resolve(workspaceDir);

  function notesPath(name: string): string {
    return path.join(root, `${name}${NOTES_EXT}`);
  }

  return {
    read(name) {
      const validated = sanitizeName(name);
      if (!validated.ok) return { ok: false, error: validated.error };
      let markdown: string;
      try {
        markdown = readFileSync(notesPath(validated.name), "utf8");
      } catch {
        // No file yet (or unreadable) → an empty note, not an error: notes are
        // optional and absence is the common case.
        markdown = "";
      }
      return { ok: true, name: validated.name, markdown };
    },

    write(name, markdown) {
      const validated = sanitizeName(name);
      if (!validated.ok) return { ok: false, error: validated.error };
      if (typeof markdown !== "string") {
        return { ok: false, error: '"markdown" must be a string.' };
      }
      if (Buffer.byteLength(markdown, "utf8") > MAX_NOTES_BYTES) {
        return { ok: false, error: `Notes too large — the limit is ${MAX_NOTES_BYTES} bytes (1 MB).` };
      }
      writeFileSync(notesPath(validated.name), markdown);
      return { ok: true, name: validated.name };
    },
  };
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
 * Build the `/api/notes/:name` request handler bound to `workspaceDir`.
 * Mirrors {@link createLayoutApiHandler}: constructed at the CLI entry (which
 * owns the workspace path) and forwarded into {@link createRequestHandler}.
 */
export function createNotesApiHandler(workspaceDir: string): NotesApiHandler {
  const store = createNotesStore(workspaceDir);

  return async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");

    let rawName: string;
    try {
      rawName = decodeURIComponent(url.pathname.slice(NOTES_API_PREFIX.length));
    } catch {
      sendJson(res, 400, { error: "Malformed diagram name." });
      return;
    }

    if (method === "GET") {
      const result = store.read(rawName);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      sendJson(res, 200, { name: result.name, markdown: result.markdown });
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
      const markdown =
        raw !== null && typeof raw === "object" && "markdown" in raw
          ? (raw as { markdown: unknown }).markdown
          : undefined;
      if (typeof markdown !== "string") {
        sendJson(res, 400, { error: '"markdown" must be a string.' });
        return;
      }
      const result = store.write(rawName, markdown);
      if (!result.ok) {
        sendJson(res, 400, { error: result.error });
        return;
      }
      sendJson(res, 200, { name: result.name, markdown });
      return;
    }

    res.writeHead(405, { "content-type": "text/plain; charset=utf-8" });
    res.end("Method Not Allowed");
  };
}
