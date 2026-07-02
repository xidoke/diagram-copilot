import type { CoordinateExtent, Edge, Node } from "@xyflow/react";
import type { DiagramDoc, Direction } from "@diagram-copilot/core";
import type { Point, PositionedGraph } from "@diagram-copilot/layout";
import { ELK_EDGE_TYPE, type ElkEdgeData } from "./ElkEdge.js";

/** Node `type` keys registered in React Flow's `nodeTypes`. */
export const ARCH_NODE_TYPE = "archNode";
export const ARCH_GROUP_TYPE = "archGroup";

/**
 * Drag handle for a group (DGC-71): React Flow only starts a group drag when
 * the pointerdown lands on an element matching this selector — the group's
 * title band (`ArchGroup`) — so the body stays free for pan/select/child-drag
 * (drag-by-header, like FigJam sections). Kept in sync with `ArchGroup`'s
 * title element class and the `.arch-group__title` CSS in `App.css`.
 */
export const ARCH_GROUP_DRAG_HANDLE = ".arch-group__title";

/**
 * Drag clamp inside a group (DGC-69): keep a dragged child this many px off
 * the group's left/right/bottom borders…
 */
export const GROUP_EXTENT_PADDING = 8;
/**
 * …and this many px off the top — the taller band reserves the group's
 * dashed border + uppercase title row so a child can't be dropped over it.
 */
export const GROUP_TITLE_BAND = 32;

export interface ArchNodeData extends Record<string, unknown> {
  label: string;
  direction: Direction;
  /** Icon registry id (see `@diagram-copilot/icons`). Absent → no icon chip. */
  icon?: string;
  /** Color token name (e.g. `"orange"`), resolved by `resolveColor`. */
  color?: string;
  /**
   * Nesting depth for a group (0 = root group, 1 = one level in, …). Only set
   * on group nodes; drives the depth-based background tint in `ArchGroup`.
   */
  depth?: number;
}

interface NodeMeta {
  label: string;
  icon?: string;
  color?: string;
}

/** Absolute box of a laid-out element (canvas frame, not parent-relative). */
interface AbsBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * How far (px) an edge anchor protrudes from the node border. React Flow's
 * `getHandlePosition` anchors an edge at the handle box's OUTER rim — and the
 * default handle (6px + 1px border, `.arch-handle` only hides it) is an 8px
 * box centered on the border, putting the rim 4px outside the node.
 */
export const HANDLE_RIM_OFFSET = 4;

/**
 * Edge anchor points for a box, given the flow direction — mirrors ArchNode's
 * `HANDLE_POSITIONS` (target on the incoming side, source on the outgoing
 * side, centered along the border, {@link HANDLE_RIM_OFFSET} outside it).
 * React Flow reports exactly these points as `sourceX/Y` / `targetX/Y` while
 * the node sits at its layout position (verified live to ~1px), which is what
 * makes them usable as drift anchors in `ElkEdge`.
 */
function handleAnchors(box: AbsBox, direction: Direction): { source: Point; target: Point } {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const before = { x: box.x - HANDLE_RIM_OFFSET, y: cy };
  const after = { x: box.x + box.width + HANDLE_RIM_OFFSET, y: cy };
  const above = { x: cx, y: box.y - HANDLE_RIM_OFFSET };
  const below = { x: cx, y: box.y + box.height + HANDLE_RIM_OFFSET };
  switch (direction) {
    case "left":
      return { source: before, target: after };
    case "down":
      return { source: below, target: above };
    case "up":
      return { source: above, target: below };
    default: // "right"
      return { source: after, target: before };
  }
}

/**
 * Pure mapping: positioned graph (+ labels/icon/color from the doc) → React
 * Flow arrays. Groups come first (already parent-before-child from
 * layout), then leaves — React Flow requires parents to precede children.
 */
export function toFlow(doc: DiagramDoc, graph: PositionedGraph): { nodes: Node[]; edges: Edge[] } {
  const meta = new Map<string, NodeMeta>();
  for (const n of doc.nodes) meta.set(n.id, { label: n.label, icon: n.icon, color: n.color });
  for (const g of doc.groups) meta.set(g.id, { label: g.label, icon: g.icon, color: g.color });

  const nodes: Node[] = [];

  // Nesting depth per group (0 = root). Walks the `parentId` chain, which the
  // model guarantees is acyclic, and memoizes so each group is computed once.
  const parentOf = new Map<string, string | undefined>();
  for (const g of graph.groups) parentOf.set(g.id, g.parentId);
  const depthCache = new Map<string, number>();
  const groupDepth = (id: string): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    const parent = parentOf.get(id);
    const d = parent === undefined ? 0 : groupDepth(parent) + 1;
    depthCache.set(id, d);
    return d;
  };

  // Absolute boxes for every element (groups are parent-before-child, so a
  // parent's absolute origin is always available when its child needs it).
  // Feed the per-edge handle anchors below.
  const absBoxes = new Map<string, AbsBox>();
  for (const box of [...graph.groups, ...graph.nodes]) {
    const parent = box.parentId !== undefined ? absBoxes.get(box.parentId) : undefined;
    absBoxes.set(box.id, {
      x: (parent?.x ?? 0) + box.x,
      y: (parent?.y ?? 0) + box.y,
      width: box.width,
      height: box.height,
    });
  }

  // Drag clamp for a child: the parent's box inset by GROUP_EXTENT_PADDING,
  // with the taller GROUP_TITLE_BAND at the top so drags can't cover the
  // group's border or title. React Flow resolves a child's CoordinateExtent
  // in parent-relative coordinates and clamps the node's whole box into it.
  const childExtent = (parentId: string): CoordinateExtent | undefined => {
    const parent = absBoxes.get(parentId);
    if (!parent) return undefined;
    return [
      [GROUP_EXTENT_PADDING, GROUP_TITLE_BAND],
      [parent.width - GROUP_EXTENT_PADDING, parent.height - GROUP_EXTENT_PADDING],
    ];
  };

  for (const g of graph.groups) {
    const m = meta.get(g.id);
    // A nested group clamps into its parent just like a leaf does — the same
    // title-band inset keeps it from covering the parent's border/title
    // (reuses `childExtent`, DGC-69/T-POLISH). Root groups roam free.
    const extent = g.parentId ? childExtent(g.parentId) : undefined;
    nodes.push({
      id: g.id,
      type: ARCH_GROUP_TYPE,
      position: { x: g.x, y: g.y },
      data: {
        label: m?.label ?? g.id,
        direction: doc.direction,
        depth: groupDepth(g.id),
        ...(m?.icon !== undefined ? { icon: m.icon } : {}),
        ...(m?.color !== undefined ? { color: m.color } : {}),
      } satisfies ArchNodeData,
      style: { width: g.width, height: g.height },
      ...(g.parentId ? { parentId: g.parentId, extent: extent ?? ("parent" as const) } : {}),
      // Groups drag by their title band only (DGC-71): the body is left to
      // pan/select and to drag child nodes. Persisted as an override on drag
      // stop — descendants ride along because their positions are
      // parent-relative. Still non-selectable (body is a pan surface).
      selectable: false,
      draggable: true,
      dragHandle: ARCH_GROUP_DRAG_HANDLE,
    });
  }

  for (const n of graph.nodes) {
    const m = meta.get(n.id);
    const extent = n.parentId ? childExtent(n.parentId) : undefined;
    nodes.push({
      id: n.id,
      type: ARCH_NODE_TYPE,
      position: { x: n.x, y: n.y },
      data: {
        label: m?.label ?? n.id,
        direction: doc.direction,
        ...(m?.icon !== undefined ? { icon: m.icon } : {}),
        ...(m?.color !== undefined ? { color: m.color } : {}),
      } satisfies ArchNodeData,
      style: { width: n.width, height: n.height },
      // Fall back to the plain parent clamp if the parent box is unknown
      // (defensive — layout always emits the parent first).
      ...(n.parentId ? { parentId: n.parentId, extent: extent ?? ("parent" as const) } : {}),
      // Leaves are draggable so users can nudge positions; the drag is persisted
      // as a layout override (T30). Groups stay non-draggable (see above).
      draggable: true,
    });
  }

  // Edges carry ELK's routed sections (already absolute from layout, which
  // offsets each by its `edge.container` origin) so the `elk` edge type draws
  // the true orthogonal path; source/target stay logical anchors. labelPos is
  // ELK's own label spot, and staticSource/staticTarget are the handle
  // centers at layout time — ElkEdge goes dynamic when the live handles
  // drift off them (DGC-69).
  const edges: Edge[] = graph.edges.map((e) => {
    const from = absBoxes.get(e.from);
    const to = absBoxes.get(e.to);
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      ...(e.label ? { label: e.label } : {}),
      type: ELK_EDGE_TYPE,
      data: {
        sections: e.sections,
        ...(e.labelPos ? { labelPos: e.labelPos } : {}),
        ...(from ? { staticSource: handleAnchors(from, doc.direction).source } : {}),
        ...(to ? { staticTarget: handleAnchors(to, doc.direction).target } : {}),
      } satisfies ElkEdgeData,
    };
  });

  return { nodes, edges };
}
