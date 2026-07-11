/**
 * Full-text hover tooltip gate (DGC-100 part 2).
 *
 * Truncated labels ("UserRepository · interface — Spring Data sinh i…") are
 * unreadable on canvas AND in the exported PNG. Elements whose label is long
 * enough to plausibly truncate get a `data-full-label` attribute; a pure-CSS
 * tooltip (`[data-full-label]::after` in App.css, ~400ms delay) shows the
 * whole text on hover. Native `title` stays as the accessibility floor.
 *
 * The gate is a char-count heuristic deliberately mirroring the sizing
 * estimates in `@diagram-copilot/layout` (sizing.ts): rendering can't know
 * real truncation without measuring the DOM, and a tooltip that shows a bit
 * too eagerly is harmless next to one that misses a truncated label — so
 * every threshold sits safely BELOW the estimated visible capacity.
 */

/**
 * Nodes cap at NODE_MAX_WIDTH (320px ≈ 31 chars/line) and wrap to 2 lines
 * (DGC-100 part 3) ≈ 62 chars visible; wide glyphs make the estimate
 * optimistic, so gate well under it.
 */
export const NODE_TOOLTIP_MIN_CHARS = 48;

/**
 * Edge labels cap at EDGE_LABEL_MAX_WIDTH (220px ≈ 28 chars/line) and wrap to
 * 2 lines ≈ 56 chars visible; same safety margin as nodes.
 */
export const EDGE_TOOLTIP_MIN_CHARS = 48;

/**
 * Group titles stay single-line (the 32px title band can't grow), but the
 * band is as wide as the group, which is usually generous — gate earlier
 * anyway since uppercase + tracking eats width fast.
 */
export const GROUP_TOOLTIP_MIN_CHARS = 24;

const MIN_CHARS = {
  node: NODE_TOOLTIP_MIN_CHARS,
  edge: EDGE_TOOLTIP_MIN_CHARS,
  group: GROUP_TOOLTIP_MIN_CHARS,
} as const;

/**
 * The `data-full-label` value for a label, or `undefined` when the label is
 * short enough that a tooltip would just repeat what's already readable.
 */
export function tooltipFor(label: string, kind: keyof typeof MIN_CHARS): string | undefined {
  return label.length > MIN_CHARS[kind] ? label : undefined;
}
