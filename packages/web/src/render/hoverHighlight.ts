/**
 * Hover association for long-label diagrams (DGC-100).
 *
 * With `direction right` a long edge label can float far from its line — the
 * fix is bidirectional highlighting: hovering a label (or the line itself)
 * lights up that edge, and hovering a node lights up every edge touching it.
 *
 * App owns one piece of state (`HoverTarget | null`) fed by React Flow's
 * node/edge mouse handlers plus a mouseover/mouseout delegation on the canvas
 * host for the edge-label divs (they render in `EdgeLabelRenderer`'s HTML
 * layer, OUTSIDE the edge's SVG group, so React Flow's own edge hover events
 * never fire for them). {@link applyHoverToEdges} then derives the render
 * array: affected edges get `data.highlighted`, which `ElkEdge` turns into
 * accent classes on both the path and the label. Purely derived — the
 * underlying `flow` state, diff overlay classes (DGC-79), and compare mode
 * (DGC-88) are never touched.
 */
import type { Edge } from "@xyflow/react";

/** What the pointer is currently over: a node/group, or one edge (line/label). */
export interface HoverTarget {
  kind: "node" | "edge";
  id: string;
}

/**
 * Pure: derive the edge array to render for the current hover. Edges touching
 * the hover target get `data.highlighted: true`; every other edge keeps its
 * object identity (and the whole array is returned as-is when nothing
 * matches), so React Flow's memoized edge wrappers skip re-rendering them.
 */
export function applyHoverToEdges(edges: Edge[], hover: HoverTarget | null): Edge[] {
  if (hover === null) return edges;
  const hit =
    hover.kind === "edge"
      ? (e: Edge) => e.id === hover.id
      : (e: Edge) => e.source === hover.id || e.target === hover.id;
  let any = false;
  const next = edges.map((e) => {
    if (!hit(e)) return e;
    any = true;
    return { ...e, data: { ...e.data, highlighted: true } };
  });
  return any ? next : edges;
}

/**
 * Delegation helper for the canvas host's mouseover/mouseout: resolve an event
 * target to the edge id of the `.elk-edge-label` it sits in, or `null` when
 * the pointer isn't over a label. Duck-typed (no `Element` global) so it stays
 * testable in this package's node-only vitest setup.
 */
export function edgeLabelIdFromEventTarget(target: unknown): string | null {
  const el = target as
    | { closest?: (sel: string) => { getAttribute(name: string): string | null } | null }
    | null
    | undefined;
  if (el == null || typeof el.closest !== "function") return null;
  const label = el.closest(".elk-edge-label");
  return label?.getAttribute("data-edge-id") ?? null;
}
