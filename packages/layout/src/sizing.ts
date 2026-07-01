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

/** Clamp `value` into the inclusive `[min, max]` range. */
function clamp(min: number, value: number, max: number): number {
  return Math.min(Math.max(value, min), max);
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
