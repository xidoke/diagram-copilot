/**
 * `get_snapshot` MCP tool (T24 / DGC-44) — Claude "sees" the diagram.
 *
 * The server cannot render headlessly (a headless browser would be a heavy,
 * flaky dependency), so this tool delegates rasterization to whatever canvas
 * is currently open in a browser:
 *
 *   1. register a pending request with the {@link SnapshotBroker},
 *   2. broadcast `snapshot-request { id, name }` to every WS client,
 *   3. await the first `snapshot-response` with a matching id (clients that
 *      are showing a DIFFERENT diagram stay silent by protocol contract),
 *   4. return the PNG as MCP image content plus a short text receipt.
 *
 * No connected client, or no client showing the requested diagram, surfaces
 * as a clear error telling the caller to open http://localhost:4747 first.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerMessage } from "@diagram-copilot/core";
import { SNAPSHOT_TIMEOUT_MS, type SnapshotBroker } from "../snapshot-broker.js";

/** Expected prefix of the client-rendered data URL. */
const PNG_DATA_URL_PREFIX = "data:image/png;base64,";

/** The URL users open to get a rendering canvas (fixed default port). */
const CANVAS_URL = "http://localhost:4747";

/**
 * Everything `get_snapshot` needs from the live server, late-bound so tool
 * calls always see current state (same pattern as `getWorkspace`).
 */
export interface SnapshotOps {
  /** Shared broker correlating requests with responses. */
  broker: SnapshotBroker;
  /** Broadcast a frame to every connected WS client (`ServerHandle.broadcast`). */
  broadcast: (message: ServerMessage) => void;
  /** Number of currently connected WS clients (`ServerHandle.clients.size`). */
  clientCount: () => number;
  /** Active diagram name, or `null` when the workspace is empty. */
  getActive: () => string | null;
  /** Response wait override — tests use a short one. Default 5s. */
  timeoutMs?: number;
}

/** Wrap a plain string into the MCP text-content result shape. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Wrap an error string into an `isError` MCP result. */
function errorText(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/**
 * Best-effort PNG dimensions from the IHDR chunk (bytes 16–23 of the file),
 * for the text receipt. Returns `null` for anything that doesn't look like a
 * PNG — the receipt then simply omits the dimensions.
 */
export function pngDimensions(base64: string): { width: number; height: number } | null {
  try {
    const bytes = Buffer.from(base64, "base64");
    const isPng =
      bytes.length >= 24 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 && // P
      bytes[2] === 0x4e && // N
      bytes[3] === 0x47; // G
    if (!isPng) return null;
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  } catch {
    return null;
  }
}

/**
 * Register `get_snapshot` on `server`. Called from the MCP handler only when
 * the server was wired with snapshot ops (a bare ping-only server omits it).
 */
export function registerSnapshotTool(server: McpServer, ops: SnapshotOps): void {
  server.registerTool(
    "get_snapshot",
    {
      title: "Get diagram snapshot",
      description:
        "See the diagram as a rendered PNG image — exactly what the user sees on the canvas. Defaults to the active diagram; pass `name` to capture a specific one. Requires an open web client: the browser tab rendering the diagram produces the image.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Diagram name (without the .arch extension). Defaults to the active diagram."),
      },
    },
    async ({ name }) => {
      const target = name ?? ops.getActive();
      if (target === null) {
        return errorText(
          'No diagram is open. Use open_diagram with a name (e.g. { "name": "demo" }) first, then call get_snapshot.',
        );
      }
      if (ops.clientCount() === 0) {
        return errorText(
          `No web client is connected — the snapshot is rendered by the open canvas. Open ${CANVAS_URL} in a browser first, then call get_snapshot again.`,
        );
      }

      const timeoutMs = ops.timeoutMs ?? SNAPSHOT_TIMEOUT_MS;
      // Register BEFORE broadcasting so a fast client can't respond into the void.
      const { id, promise } = ops.broker.createRequest(timeoutMs);
      ops.broadcast({ kind: "snapshot-request", id, name: target });

      try {
        const response = await promise;
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
        const base64 = response.dataUrl.slice(PNG_DATA_URL_PREFIX.length);
        const dims = pngDimensions(base64);
        const size = dims ? `, ${dims.width}×${dims.height}px` : "";
        return {
          content: [
            { type: "image" as const, data: base64, mimeType: "image/png" as const },
            {
              type: "text" as const,
              text: `Snapshot of "${target}" as currently rendered on the canvas (PNG${size}).`,
            },
          ],
        };
      } catch {
        // Broker timeout — either no client is showing `target` (clients
        // rendering another diagram stay silent by design) or the capture hung.
        return errorText(
          `No canvas answered for "${target}" within ${timeoutMs}ms. Make sure a browser tab at ${CANVAS_URL} is showing that diagram (use open_diagram to activate it), then try again.`,
        );
      }
    },
  );
}
