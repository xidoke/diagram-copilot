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
 * Render gate (DGC-101): `lastDiagram` is CONNECTION state — it flips the
 * instant the `diagram` frame arrives, long before React re-renders and the
 * async ELK layout commits the new nodes to the DOM. A responder that trusts
 * it alone therefore captures the PREVIOUS diagram's pixels when a
 * snapshot-request races an `open_diagram`/`set_diagram` (correct name on
 * the PNG, wrong image — the silent data-corruption bug). So before
 * capturing, {@link respond} waits until App has reported — via
 * {@link reportSnapshotRendered}, fired AFTER the laid-out flow commits —
 * that the DOM shows exactly `lastDiagram`'s (name, version). Version
 * equality is deliberate: versions are monotonic per diagram (undo/redo
 * re-apply, never rewind — see server `history/store.ts`), and `>=` would
 * bless a stale pre-server-restart render whose version is higher than the
 * fresh server's counter. If the target content never renders within
 * {@link RENDER_WAIT_MS} the responder stays SILENT — semantically it is
 * "showing something else", and silence keeps the server's broker-timeout +
 * headless-retry machinery intact.
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

/**
 * How long {@link respond} waits for the canvas to render the requested
 * (name, version) before giving up silently. Generous on purpose: the
 * server's snapshot broker owns the actual deadline (5s per attempt, with a
 * headless retry) and drops late responses by correlation id, so a long
 * client-side wait can never mis-deliver — it only keeps slow-but-correct
 * captures possible.
 */
const RENDER_WAIT_MS = 10_000;

/** Gap between render-gate polls (see {@link respond}). */
const RENDER_POLL_MS = 100;

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

/** The (name, version) a canvas has actually committed to the DOM. */
export interface RenderedStamp {
  /** Diagram name (workspace file stem, no extension). */
  name: string;
  /** Monotonic server version of the rendered content. */
  version: number;
}

let renderedStamp: RenderedStamp | null = null;

/**
 * Report which diagram content the DOM now shows (or `null` when nothing
 * does — unmount). Called by App from an effect that runs AFTER the
 * laid-out flow commits, i.e. once React Flow's nodes for that exact
 * (name, version) are in the DOM. This is the render gate's source of truth
 * (DGC-101) — see the module doc.
 */
export function reportSnapshotRendered(stamp: RenderedStamp | null): void {
  renderedStamp = stamp;
}

/**
 * The slice of the connection manager the responder needs — structural, so
 * tests drive it with a plain fake instead of a WebSocket.
 */
export interface SnapshotConnection {
  /**
   * Post-message connection state; `lastDiagram` names what the canvas has
   * been TOLD to render (the DOM may still lag — see the render gate).
   */
  getState(): { lastDiagram: { name: string; version: number } | null };
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
  /** Rendered-stamp source override — defaults to the module value App reports. */
  getRenderedStamp?: () => RenderedStamp | null;
  /** Render-gate wait budget override (tests) — defaults to {@link RENDER_WAIT_MS}. */
  renderWaitMs?: number;
  /** Render-gate poll interval override (tests) — defaults to {@link RENDER_POLL_MS}. */
  renderPollMs?: number;
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
  const getRenderedStamp = options.getRenderedStamp ?? (() => renderedStamp);
  const renderWaitMs = options.renderWaitMs ?? RENDER_WAIT_MS;
  const renderPollMs = options.renderPollMs ?? RENDER_POLL_MS;

  return connection.onMessage((message) => {
    if (message.kind !== "snapshot-request") return;
    void respond(connection, message, getBounds, capture, getRenderedStamp, renderWaitMs, renderPollMs);
  });
}

/**
 * Render gate (DGC-101): resolve `true` once the DOM shows exactly what the
 * connection says the canvas should render — the reported stamp equals
 * `lastDiagram`'s (name, version) — re-reading `lastDiagram` every poll so a
 * mid-wait version bump retargets the wait. Resolve `false` (→ stay silent)
 * when the canvas moves on to a DIFFERENT diagram or the budget elapses.
 * The common settled case passes the first check — zero added latency.
 */
async function waitUntilTargetRendered(
  connection: SnapshotConnection,
  name: string,
  getRenderedStamp: () => RenderedStamp | null,
  waitMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const expected = connection.getState().lastDiagram;
    if (expected === null || expected.name !== name) return false;
    const stamp = getRenderedStamp();
    if (stamp !== null && stamp.name === expected.name && stamp.version === expected.version) {
      return true;
    }
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

async function respond(
  connection: SnapshotConnection,
  request: SnapshotRequestMessage,
  getBounds: () => Rect | null,
  capture: (bounds: Rect) => Promise<string>,
  getRenderedStamp: () => RenderedStamp | null,
  renderWaitMs: number,
  renderPollMs: number,
): Promise<void> {
  // Protocol contract: only the client actually rendering `name` answers.
  const rendering = connection.getState().lastDiagram?.name ?? null;
  if (rendering !== request.name) return;

  // Render gate (DGC-101): `lastDiagram` alone only proves the frame ARRIVED.
  // Hold the capture until the DOM shows that exact (name, version); give up
  // silently if it never does — same contract as "showing something else".
  const rendered = await waitUntilTargetRendered(
    connection,
    request.name,
    getRenderedStamp,
    renderWaitMs,
    renderPollMs,
  );
  if (!rendered) return;

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
