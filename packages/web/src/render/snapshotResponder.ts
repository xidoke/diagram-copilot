/**
 * Snapshot responder (T24 / DGC-44) — lets Claude "see" the diagram.
 *
 * The server cannot rasterize headlessly, so the `get_snapshot` MCP tool
 * broadcasts a `snapshot-request { id, name }` over WS and THIS module —
 * attached to the connection manager's raw-message subscription by
 * `useDiagramConnection` — renders the canvas to a PNG data URL and answers
 * with `snapshot-response { id, name, ok, dataUrl | error }`.
 *
 * Protocol contract: a client responds ONLY when `name` matches the diagram
 * it is currently rendering. A client showing something else stays silent so
 * that, with several tabs open, the one actually showing the requested
 * diagram wins the server's first-response race (the server times out when
 * nobody is showing it).
 *
 * Bounds come from React Flow, which only App (inside ReactFlowProvider) can
 * reach — so App registers a provider via {@link setSnapshotProvider} and
 * this module stays hook-free.
 *
 * Capture note: the html-to-image glue below (edge-stroke inlining + marker
 * defs cloning) intentionally mirrors the private `prepareCapture` /
 * `patchEdgesForCapture` in `render/export.ts`. Those helpers are not
 * exported, and export.ts is owned by another workstream (declared
 * import-only for this task), so the equivalent pipeline is inlined here on
 * top of the PURE pieces export.ts does export (`computeExportRect`,
 * `EXPORT_PADDING`). If export.ts ever exports its capture helpers, this
 * duplication should collapse onto them.
 */
import { toPng } from "html-to-image";
import type { Rect } from "@xyflow/react";
import type {
  ClientMessage,
  ServerMessage,
  SnapshotRequestMessage,
  SnapshotResponseMessage,
} from "@diagram-copilot/core";
import { computeExportRect, EXPORT_PADDING } from "./export.js";

/**
 * Raster scale for snapshots. Deliberately below the interactive export's 2x:
 * 1.5x keeps text in Claude's vision input crisp while roughly halving the
 * pixel count (and base64 payload) of a 2x capture.
 */
export const SNAPSHOT_SCALE = 1.5;

const VIEWPORT_SELECTOR = ".react-flow__viewport";
/** Fallback for the app's `--bg` token — kept in sync with tokens.css / export.ts. */
const FALLBACK_BG = "#0b0e14";

/** Supplies the current node bounding box (diagram coordinates). */
export type SnapshotBoundsProvider = () => Rect;

let boundsProvider: SnapshotBoundsProvider | null = null;

/**
 * Register (or clear, with `null`) the bounds provider. Called by App —
 * which owns the React Flow instance — with
 * `() => getNodesBounds(getNodes())`. The hook-bound getter resolves
 * sub-flow/group nodes correctly (same reasoning as ExportMenu).
 */
export function setSnapshotProvider(provider: SnapshotBoundsProvider | null): void {
  boundsProvider = provider;
}

/**
 * The slice of the connection manager the responder needs — structural, so
 * tests drive it with a plain fake instead of a WebSocket.
 */
export interface SnapshotConnection {
  /** Post-message connection state; `lastDiagram` names what the canvas renders. */
  getState(): { lastDiagram: { name: string } | null };
  /** Send a client→server frame (dropped with a warn when not connected). */
  send(message: ClientMessage): void;
  /** Subscribe to raw inbound server messages; returns unsubscribe. */
  onMessage(listener: (message: ServerMessage) => void): () => void;
}

export interface AttachSnapshotResponderOptions {
  /** Bounds source override — defaults to the module provider set by App. */
  getBounds?: () => Rect | null;
  /** Capture override (tests) — defaults to the DOM html-to-image capture. */
  capture?: (bounds: Rect) => Promise<string>;
}

/**
 * Start answering `snapshot-request` frames on `connection`. Returns a
 * detach function (unsubscribes; in-flight captures finish but their sends
 * are harmless no-ops once the socket is gone).
 */
export function attachSnapshotResponder(
  connection: SnapshotConnection,
  options: AttachSnapshotResponderOptions = {},
): () => void {
  const getBounds = options.getBounds ?? (() => (boundsProvider ? boundsProvider() : null));
  const capture = options.capture ?? captureSnapshotPng;

  return connection.onMessage((message) => {
    if (message.kind !== "snapshot-request") return;
    void respond(connection, message, getBounds, capture);
  });
}

async function respond(
  connection: SnapshotConnection,
  request: SnapshotRequestMessage,
  getBounds: () => Rect | null,
  capture: (bounds: Rect) => Promise<string>,
): Promise<void> {
  // Protocol contract: only the client actually rendering `name` answers.
  const rendering = connection.getState().lastDiagram?.name ?? null;
  if (rendering !== request.name) return;

  const fail = (error: string): SnapshotResponseMessage => ({
    kind: "snapshot-response",
    id: request.id,
    name: request.name,
    ok: false,
    error,
  });

  let response: SnapshotResponseMessage;
  try {
    const bounds = getBounds();
    if (bounds === null) {
      response = fail("canvas is not ready — no snapshot bounds provider registered");
    } else {
      const dataUrl = await capture(bounds);
      response = { kind: "snapshot-response", id: request.id, name: request.name, ok: true, dataUrl };
    }
  } catch (err) {
    response = fail(err instanceof Error ? err.message : String(err));
  }
  connection.send(response);
}

// ---------------------------------------------------------------------------
// DOM capture — mirrors render/export.ts's private pipeline (see module doc).
// ---------------------------------------------------------------------------

/** Rasterize the live viewport to a PNG data URL sized to `bounds` at {@link SNAPSHOT_SCALE}. */
export async function captureSnapshotPng(bounds: Rect): Promise<string> {
  const viewportEl = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
  if (!viewportEl) {
    throw new Error("canvas viewport not found — is the diagram mounted?");
  }
  const rect = computeExportRect(bounds, EXPORT_PADDING, SNAPSHOT_SCALE);
  const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim() || FALLBACK_BG;

  const restore = patchEdgesForCapture(viewportEl);
  try {
    return await toPng(viewportEl, {
      width: rect.width,
      height: rect.height,
      // Resolution is baked into rect via SNAPSHOT_SCALE; pin the ratio so
      // html-to-image doesn't multiply by devicePixelRatio again.
      pixelRatio: 1,
      backgroundColor: bg,
      style: {
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        transform: `translate(${rect.x}px, ${rect.y}px) scale(${rect.zoom})`,
      },
    });
  } finally {
    restore();
  }
}

/**
 * Copy of `patchEdgesForCapture` in render/export.ts (private there — see
 * module doc): inline computed edge-path strokes and clone the arrowhead
 * `<marker>` defs into the viewport so html-to-image's raw `<svg>` cloning
 * doesn't silently drop every edge. Returns a restore function.
 */
function patchEdgesForCapture(viewportEl: HTMLElement): () => void {
  const restores: Array<() => void> = [];

  for (const path of viewportEl.querySelectorAll<SVGPathElement>(".react-flow__edge-path")) {
    const computed = getComputedStyle(path);
    const prev = path.getAttribute("style");
    path.style.stroke = computed.stroke;
    path.style.strokeWidth = computed.strokeWidth;
    path.style.fill = computed.fill;
    restores.push(() => {
      if (prev === null) path.removeAttribute("style");
      else path.setAttribute("style", prev);
    });
  }

  const marker = document.querySelector("marker");
  const defsSvg = marker?.closest("svg");
  if (defsSvg && !viewportEl.contains(defsSvg)) {
    const clone = defsSvg.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("width", "0");
    clone.setAttribute("height", "0");
    clone.setAttribute("aria-hidden", "true");
    viewportEl.appendChild(clone);
    restores.push(() => clone.remove());
  }

  return () => {
    for (const restore of restores) restore();
  };
}
