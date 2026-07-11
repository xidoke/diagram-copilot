/**
 * Node sizing heuristic — pure, DOM-free.
 *
 * The renderer (T12) has not measured real DOM yet, so layout estimates a
 * node box from its label length plus room for the icon chip. These
 * constants are exported so the renderer can reproduce the exact same box
 * (avoiding a layout/paint mismatch) until real measurement replaces this.
 */

/** Fixed leaf-node height, in px. Every node is a single label row. */
export const NODE_HEIGHT = 48;

/** Lower clamp for node width, in px. */
export const NODE_MIN_WIDTH = 120;

/** Upper clamp for node width, in px (long labels ellipsize past this). */
export const NODE_MAX_WIDTH = 320;

/** Horizontal padding (left + right) around a node's content, in px. */
export const NODE_HORIZONTAL_PADDING = 24;

/** Room reserved for the icon chip and its gaps, in px. */
export const NODE_ICON_WIDTH = 34;

/** Approximate advance width of one label character, in px. */
export const NODE_CHAR_WIDTH = 8.5;

/** Fixed edge-label height, in px (one 11px row plus chrome: 16 + 2·2 + 1·2). */
export const EDGE_LABEL_HEIGHT = 22;

/** Approximate advance width of one edge-label character, in px (11px font). */
export const EDGE_LABEL_CHAR_WIDTH = 7.2;

/** Horizontal chrome (padding + border) around an edge label, in px. */
export const EDGE_LABEL_HORIZONTAL_PADDING = 16;

/**
 * Widest an edge label box may get (px) before its text wraps to a second
 * line (DGC-100). The renderer clamps `.elk-edge-label` to the same value
 * (ElkEdge imports this constant), so ELK's reserved box and the painted
 * chrome stay the same shape.
 */
export const EDGE_LABEL_MAX_WIDTH = 220;

/**
 * One additional text row, in px — the renderer pins `line-height: 16px` on
 * `.elk-edge-label`, so row 1 = 16 + 6px vertical chrome = EDGE_LABEL_HEIGHT
 * and every extra row adds exactly this much.
 */
export const EDGE_LABEL_LINE_HEIGHT = 16;

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(min: number, value: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Estimated pixel box for an edge label with the given text, handed to ELK so
 * the router reserves real room for the label instead of letting it overlap
 * nodes/edges. One line while the estimate fits: `width = chars * 7.2 + 16`,
 * `height = 22` — same character-count heuristic as {@link measureNode}.
 *
 * Long labels (DGC-100) no longer stretch the layout with one enormous row:
 * past {@link EDGE_LABEL_MAX_WIDTH} the box caps its width and grows a second
 * row instead (the renderer wraps the text via `-webkit-line-clamp: 2`;
 * anything beyond two lines ellipsizes and lives in the hover tooltip).
 */
export function measureEdgeLabel(text: string): { width: number; height: number } {
  const oneLineWidth = text.length * EDGE_LABEL_CHAR_WIDTH + EDGE_LABEL_HORIZONTAL_PADDING;
  if (oneLineWidth <= EDGE_LABEL_MAX_WIDTH) {
    return { width: oneLineWidth, height: EDGE_LABEL_HEIGHT };
  }
  return {
    width: EDGE_LABEL_MAX_WIDTH,
    height: EDGE_LABEL_HEIGHT + EDGE_LABEL_LINE_HEIGHT,
  };
}

/**
 * Estimated pixel box for a leaf node with the given label.
 *
 * `width = clamp(120, 24 + label.length * 8.5 + 34, 320)`, `height = 48`.
 * Character count (not grapheme clusters) is intentional: it is cheap and
 * good enough for auto-layout spacing; ELK only needs a stable estimate.
 */
export function measureNode(label: string): { width: number; height: number } {
  const width = clamp(
    NODE_MIN_WIDTH,
    NODE_HORIZONTAL_PADDING + label.length * NODE_CHAR_WIDTH + NODE_ICON_WIDTH,
    NODE_MAX_WIDTH,
  );
  return { width, height: NODE_HEIGHT };
}
