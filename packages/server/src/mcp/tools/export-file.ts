/**
 * `export_diagram` MCP tool (F2 / DGC-62) — render the diagram to a PNG and
 * SAVE it to disk, returning the absolute path so Claude can embed the image in
 * a note (e.g. an Obsidian vault).
 *
 * Rendering reuses the same canvas-delegation trick as `get_snapshot`: the
 * server cannot rasterize headlessly, so it broadcasts a `snapshot-request`
 * over the {@link SnapshotBroker} and writes whatever PNG the open canvas
 * renders back. It therefore shares {@link SnapshotOps} with `get_snapshot`.
 *
 * Where the PNG lands:
 *   - no `path` → the server's default `--export-dir` (collision-suffixed
 *     `<name>-v<version>.png` via {@link resolveExportPath}, exactly like
 *     `POST /export`).
 *   - `path` given (absolute or `~`-relative) → allowed ONLY inside one of the
 *     whitelisted `--export-root` directories; anything outside is refused with
 *     the list of roots. A directory path gets the collision-suffixed
 *     `<name>-v<version>.png`; a `*.png` file path is used verbatim.
 *
 * The version stamped into the filename comes from the workspace (last accepted
 * version), so the tool also needs the workspace ops — hence a small dedicated
 * {@link ExportOps} rather than reusing `SnapshotOps` alone.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerMessage } from "@diagram-copilot/core";
import { SNAPSHOT_TIMEOUT_MS } from "../snapshot-broker.js";
import type { WorkspaceOps } from "../../workspace/watcher.js";
import { decodeDataUrl, resolveExportPath } from "../../export/save.js";
import { pngDimensions, type SnapshotOps } from "./snapshot.js";

/** Expected prefix of the client-rendered data URL (same as `get_snapshot`). */
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/** The URL users open to get a rendering canvas (fixed default port). */
const CANVAS_URL = "http://localhost:4747";

/**
 * Everything `export_diagram` needs from the live server, late-bound so tool
 * calls always see current state. Reuses {@link SnapshotOps} for rendering and
 * adds the workspace (for the version stamp) plus the on-disk destination
 * config (default dir + whitelist roots).
 */
export interface ExportOps {
  /** Snapshot rendering wiring — shared with `get_snapshot`. */
  snapshot: SnapshotOps;
  /** Live workspace ops (for the accepted version). `null` until the watcher starts. */
  getWorkspace: () => WorkspaceOps | null;
  /**
   * Default output directory when no `path` is given (`--export-dir`). Always
   * an implicit whitelist root too (the default target must be writable), so a
   * caller `path` inside it is allowed even when `roots` omits it.
   */
  exportDir: string;
  /**
   * EXTRA whitelisted roots a caller-supplied `path` may live under, beyond the
   * always-allowed {@link exportDir}. May contain `~` (expanded here). Wired
   * from `--export-root` (default: the Obsidian vault).
   */
  roots: string[];
}

/** Wrap a plain string into the MCP text-content result shape. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Wrap an error string into an `isError` MCP result. */
function errorText(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/** Expand a leading `~` / `~/` to the user's home directory; otherwise verbatim. */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** `true` when `dir` is `root` itself or nested inside it (no `..` escape). */
function isWithin(dir: string, root: string): boolean {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Resolve the absolute PNG path a call should write to, WITHOUT touching disk
 * for anything but collision probing. Pure enough to unit-test directly:
 *
 *   - `rawPath` empty/undefined → `<exportDir>/<name>-v<version>.png` (suffixed
 *     on collision). The default dir is trusted, so no whitelist check.
 *   - `rawPath` given → `~` expanded and resolved absolute, then required to
 *     sit inside `exportDir` (always allowed) or one of `roots` (else an error
 *     listing them). A `*.png` path is used verbatim; any other path is treated
 *     as a directory and gets the collision-suffixed `<name>-v<version>.png`.
 */
export function resolveExportDestination(
  rawPath: string | undefined,
  opts: { exportDir: string; roots: string[]; name: string; version: number },
): { ok: true; path: string } | { ok: false; error: string } {
  if (rawPath === undefined || rawPath.trim() === "") {
    return { ok: true, path: resolveExportPath(opts.exportDir, opts.name, opts.version, "png") };
  }

  const expanded = path.resolve(expandTilde(rawPath.trim()));
  const isPngFile = expanded.toLowerCase().endsWith(".png");
  const destDir = isPngFile ? path.dirname(expanded) : expanded;

  // exportDir is always an implicit root; dedupe so it is never listed twice.
  const resolvedRoots = [
    ...new Set([opts.exportDir, ...opts.roots].map((r) => path.resolve(expandTilde(r)))),
  ];
  if (!resolvedRoots.some((root) => isWithin(destDir, root))) {
    const list = resolvedRoots.map((r) => `  - ${r}`).join("\n");
    return {
      ok: false,
      error: `Refusing to write "${rawPath}" — it is outside the allowed export roots:\n${list}\nUse a path inside one of these, or omit "path" to save under the default export directory.`,
    };
  }

  const finalPath = isPngFile ? expanded : resolveExportPath(destDir, opts.name, opts.version, "png");
  return { ok: true, path: finalPath };
}

/**
 * Register the `export_diagram` tool on `server`. Wired only when both the
 * snapshot ops (WS hub) and the workspace are available (see the MCP handler).
 */
export function registerExportDiagramTool(server: McpServer, ops: ExportOps): void {
  server.registerTool(
    "export_diagram",
    {
      title: "Export diagram to PNG file",
      description:
        "Render the diagram to a PNG and SAVE it to disk, returning the absolute path (embed it in a note). Defaults to the active diagram and the server's export directory; pass `name` to pick a diagram and `path` (a directory or a *.png file, absolute or ~-relative) to choose where it lands. `path` must be inside an allowed export root. Requires an open web client — the browser canvas produces the image.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Diagram name (without the .arch extension). Defaults to the active diagram."),
        path: z
          .string()
          .optional()
          .describe(
            "Where to save: a directory (file named <name>-v<version>.png) or a *.png file. Absolute or ~-relative; must be inside an allowed export root. Omit to use the default export directory.",
          ),
      },
    },
    async ({ name, path: rawPath }) => {
      const target = name ?? ops.snapshot.getActive();
      if (target === null) {
        return errorText(
          'No diagram is open. Use open_diagram with a name (e.g. { "name": "demo" }) first, then call export_diagram.',
        );
      }

      const workspace = ops.getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const read = workspace.read(target);
      if (!read.ok) {
        return errorText(read.error ?? `Could not read diagram "${target}".`);
      }
      const version = read.version;

      // Resolve + whitelist-check the destination BEFORE rendering, so a bad
      // path fails fast without asking the canvas to rasterize needlessly.
      const dest = resolveExportDestination(rawPath, {
        exportDir: ops.exportDir,
        roots: ops.roots,
        name: target,
        version,
      });
      if (!dest.ok) {
        return errorText(dest.error);
      }

      if (ops.snapshot.clientCount() === 0) {
        return errorText(
          `No web client is connected — the PNG is rendered by the open canvas. Open ${CANVAS_URL} in a browser first, then call export_diagram again.`,
        );
      }

      const timeoutMs = ops.snapshot.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
      // Register BEFORE broadcasting so a fast client can't respond into the void.
      const { id, promise } = ops.snapshot.broker.createRequest(timeoutMs);
      const request: ServerMessage = { kind: "snapshot-request", id, name: target };
      ops.snapshot.broadcast(request);

      let response;
      try {
        response = await promise;
      } catch {
        return errorText(
          `No canvas answered for "${target}" within ${timeoutMs}ms. Make sure a browser tab at ${CANVAS_URL} is showing that diagram (use open_diagram to activate it), then try again.`,
        );
      }
      if (!response.ok) {
        return errorText(
          `The canvas could not capture "${target}": ${response.error ?? "unknown error"}`,
        );
      }
      if (!response.dataUrl?.startsWith(PNG_DATA_URL_PREFIX)) {
        return errorText(
          `The canvas returned an unexpected payload for "${target}" (not a PNG data URL).`,
        );
      }
      const bytes = decodeDataUrl(response.dataUrl);
      if (!bytes) {
        return errorText(`The canvas payload for "${target}" could not be decoded to PNG bytes.`);
      }

      try {
        mkdirSync(path.dirname(dest.path), { recursive: true });
        writeFileSync(dest.path, bytes);
      } catch (error) {
        return errorText(`Failed to write PNG to ${dest.path}: ${(error as Error).message}`);
      }

      const dims = pngDimensions(response.dataUrl.slice(PNG_DATA_URL_PREFIX.length));
      const size = dims ? `, ${dims.width}×${dims.height}px` : "";
      return text(`Exported "${target}" (v${version}) to ${dest.path} (PNG${size}).`);
    },
  );
}
