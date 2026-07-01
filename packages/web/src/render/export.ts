/**
 * Client-side diagram export — PNG / SVG snapshot of the canvas, plus "copy
 * PNG to clipboard" (DGC-48 / T28). No server round-trip: everything is
 * rasterized in the browser from the live `.react-flow__viewport` DOM via
 * html-to-image.
 *
 * The exported image is sized to the diagram's node bounding box (+ padding)
 * rather than whatever's currently panned/zoomed into view, so the file
 * always shows the whole diagram. This follows React Flow's own "Download
 * Image" example: `getNodesBounds` + `getViewportForBounds` compute a
 * translate/zoom transform that fits the bbox exactly into a target pixel
 * size, which is then stamped onto the viewport element's inline style
 * before handing it to html-to-image.
 * See: https://reactflow.dev/examples/misc/download-image
 *
 * Callers compute `bounds` themselves via the hook-bound
 * `useReactFlow().getNodesBounds(getNodes())` (see ExportMenu) rather than
 * this module doing it — the hook-bound version resolves sub-flow/group
 * nodes correctly and avoids an "use the hook" dev-mode warning that
 * @xyflow/react's standalone `getNodesBounds` utility logs when called
 * without a nodeLookup. That also keeps this module free of any dependency
 * on the `Node[]` shape — it only needs a plain `Rect`.
 */
import { toBlob, toPng, toSvg } from "html-to-image";
import { getViewportForBounds, type Rect } from "@xyflow/react";

// html-to-image's `Options` type isn't a named export (only used internally
// for its function signatures), so derive the options shape from `toPng`
// itself rather than reaching into a private subpath import.
type CaptureOptions = NonNullable<Parameters<typeof toPng>[1]>;

/** Diagram-space padding (px, pre-scale) added around the node bbox before export. */
export const EXPORT_PADDING = 24;
/** Default raster scale factor — 2x reads as "retina quality" at 100% zoom. */
export const EXPORT_SCALE = 2;
/**
 * Hard clamp on the exported canvas's pixel width/height (either axis).
 * Guards against runaway `<canvas>` allocations (and the browser tab locking
 * up) for very large or very zoomed-out diagrams combined with a high scale.
 */
export const MAX_EXPORT_DIMENSION = 8192;

const VIEWPORT_SELECTOR = ".react-flow__viewport";
/** Fallback for the app's `--bg` token — kept in sync with tokens.css. */
const FALLBACK_BG = "#0b0e14";

export interface ExportRect {
  /** Final raster width in device pixels (post scale + clamp). */
  width: number;
  /** Final raster height in device pixels (post scale + clamp). */
  height: number;
  /** Effective zoom to stamp on the viewport element so the padded bbox fills width×height. */
  zoom: number;
  /** Translate X (px) to stamp on the viewport element, paired with `zoom`. */
  x: number;
  /** Translate Y (px) to stamp on the viewport element, paired with `zoom`. */
  y: number;
}

/**
 * Pure: node bbox → export rect (raster canvas size + the translate/zoom
 * transform to apply to `.react-flow__viewport`). No DOM access, so this is
 * unit-testable without jsdom, matching this package's node-only vitest
 * convention (see ArchNode.test.tsx / ElkEdge.test.tsx).
 *
 * `scale` inflates raster resolution (2 = retina). If `bounds` padded and
 * scaled would push either axis past `MAX_EXPORT_DIMENSION`, both axes are
 * scaled back down together — preserving aspect ratio — rather than
 * clipping the image.
 */
export function computeExportRect(bounds: Rect, padding: number = EXPORT_PADDING, scale: number = EXPORT_SCALE): ExportRect {
  const padded: Rect = {
    x: bounds.x - padding,
    y: bounds.y - padding,
    // Guard against a 0-node diagram (empty bbox) producing a degenerate
    // (and later div-by-zero-prone) 0×0 export canvas.
    width: Math.max(bounds.width + padding * 2, 1),
    height: Math.max(bounds.height + padding * 2, 1),
  };

  const rawWidth = padded.width * scale;
  const rawHeight = padded.height * scale;
  const clampFactor = Math.min(1, MAX_EXPORT_DIMENSION / rawWidth, MAX_EXPORT_DIMENSION / rawHeight);

  const width = Math.round(rawWidth * clampFactor);
  const height = Math.round(rawHeight * clampFactor);
  const zoom = scale * clampFactor;

  // width/height were derived directly from padded×zoom, so passing zoom as
  // both min and max just pins the result to that value (sidesteps rounding
  // from the width/height Math.round above nudging xZoom/yZoom apart).
  const { x, y } = getViewportForBounds(padded, width, height, zoom, zoom, 0);

  return { width, height, zoom, x, y };
}

/** Sanitize a diagram name for use in a downloaded filename. */
function sanitizeForFilename(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|\s]+/g, "-");
  return cleaned || "diagram";
}

/** Pure: `<diagramName>-v<version>.<ext>` — the download filename shown to the user. */
export function buildExportFilename(name: string, version: number, ext: "png" | "svg"): string {
  return `${sanitizeForFilename(name)}-v${version}.${ext}`;
}

export interface ExportPngOptions {
  /** Transparent background instead of the app's `--bg` canvas color. */
  transparent?: boolean;
  /** Raster scale factor (default `EXPORT_SCALE` = 2, retina quality). */
  scale?: number;
}

function getViewportElement(): HTMLElement {
  const el = document.querySelector<HTMLElement>(VIEWPORT_SELECTOR);
  if (!el) {
    throw new Error("Export failed: .react-flow__viewport not found — is the canvas mounted?");
  }
  return el;
}

/** Resolve the app's canvas background (the `--bg` token), falling back to
 *  the known dark-theme value if it isn't resolvable (e.g. no stylesheet loaded). */
function resolveBgColor(): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
  return value || FALLBACK_BG;
}

/** Shared setup for every capture: bbox → export rect → html-to-image options
 *  targeting the live viewport element at exactly that rect. */
function prepareCapture(bounds: Rect, opts: ExportPngOptions): { viewportEl: HTMLElement; options: CaptureOptions } {
  const { transparent = false, scale = EXPORT_SCALE } = opts;
  const rect = computeExportRect(bounds, EXPORT_PADDING, scale);
  const viewportEl = getViewportElement();

  const options: CaptureOptions = {
    width: rect.width,
    height: rect.height,
    // Resolution is already baked into rect.width/height via `scale` above;
    // without pinning this to 1, html-to-image multiplies by
    // window.devicePixelRatio again and silently produces a 2-3x larger
    // (and slower) canvas than the caller asked for.
    pixelRatio: 1,
    backgroundColor: transparent ? undefined : resolveBgColor(),
    style: {
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      transform: `translate(${rect.x}px, ${rect.y}px) scale(${rect.zoom})`,
    },
  };

  return { viewportEl, options };
}

function downloadDataUrl(dataUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

/**
 * Rasterize the diagram to a PNG and trigger a browser download. `bounds` is
 * the node bbox (e.g. from `useReactFlow().getNodesBounds(getNodes())`).
 */
export async function exportPng(bounds: Rect, filename: string, opts: ExportPngOptions = {}): Promise<void> {
  const { viewportEl, options } = prepareCapture(bounds, opts);
  const dataUrl = await toPng(viewportEl, options);
  downloadDataUrl(dataUrl, filename);
}

/**
 * Export the diagram as SVG and trigger a browser download.
 *
 * Caveat (see task notes): html-to-image's `toSvg` wraps a full HTML clone
 * of the DOM in an SVG `<foreignObject>` rather than producing "real" vector
 * paths/shapes. That renders correctly in a browser tab or `<img>` tag, but
 * design tools that don't support `foreignObject` (older Illustrator, some
 * Figma import paths) may show it blank or refuse to open it. Accepted as a
 * known limitation per the task brief — a true vector export would require
 * a bespoke SVG renderer for the diagram model, out of scope here.
 */
export async function exportSvg(bounds: Rect, filename: string, opts: ExportPngOptions = {}): Promise<void> {
  const { viewportEl, options } = prepareCapture(bounds, opts);
  const dataUrl = await toSvg(viewportEl, options);
  downloadDataUrl(dataUrl, filename);
}

export interface CopyPngResult {
  ok: boolean;
  /** Human-readable reason, set only when `ok` is false. */
  error?: string;
}

/**
 * Rasterize the diagram to a PNG and write it to the OS clipboard via the
 * Async Clipboard API. Never throws — clipboard access is blocked by some
 * browsers/permission policies, so failures are reported back as a soft
 * `{ ok: false, error }` result for the caller to surface in the UI instead
 * of an uncaught rejection.
 */
export async function copyPngToClipboard(bounds: Rect, opts: ExportPngOptions = {}): Promise<CopyPngResult> {
  try {
    if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
      return { ok: false, error: "Clipboard image copy isn't supported in this browser" };
    }
    const { viewportEl, options } = prepareCapture(bounds, opts);
    const blob = await toBlob(viewportEl, options);
    if (!blob) {
      return { ok: false, error: "Failed to render diagram to an image" };
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
