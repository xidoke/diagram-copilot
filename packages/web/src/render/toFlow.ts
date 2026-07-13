import type { Edge, Node } from "@xyflow/react";
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
 * Reserved top band (px) for a group's dashed border + uppercase title row —
 * matches the `.arch-group__title` height in `App.css`. Kept as the title
 * band's documented height; no longer used as a drag clamp (DGC-19 removed the
 * per-child `extent` so nodes can be dragged in/out of groups).
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
  /**
   * `true` on the compact leaf standing in for a collapsed group (DGC-67).
   * Never set by `toFlow` itself — `markCollapsedNodes` (collapse.ts) stamps
   * it after the fact; `ArchNode` then shows the ▸ expand toggle + styling.
   */
  collapsed?: boolean;
  /**
   * `true` on a context element outside the drill focus (DGC-89). Never set
   * by `toFlow` itself — `markExternalNodes` (drill.ts) stamps it after the
   * fact; `ArchNode` then applies the dimmed external styling.
   */
  drillExternal?: boolean;
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

  // DGC-19: children carry NO `extent`. The old DGC-69 clamp trapped a child
  // inside its parent group; dragging a node OUT of a group (→ re-nest to root
  // or another group) needs it to roam the whole canvas. The drop is hit-tested
  // geometrically on stop (see `reparent.ts` / `App`), not clamped here.

  for (const g of graph.groups) {
    const m = meta.get(g.id);
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
      ...(g.parentId ? { parentId: g.parentId } : {}),
      // Groups drag by their title band only (DGC-71): the body is left to
      // pan and to drag child nodes. Persisted as an override on drag stop —
      // descendants ride along because their positions are parent-relative.
      // Selectable now (DGC-19) so a selected group shows its resize handles
      // (NodeResizer); the wrapper stays `pointer-events:none` in CSS, only the
      // title band + resize controls opt back in.
      selectable: true,
      draggable: true,
      dragHandle: ARCH_GROUP_DRAG_HANDLE,
    });
  }

  for (const n of graph.nodes) {
    const m = meta.get(n.id);
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
      ...(n.parentId ? { parentId: n.parentId } : {}),
      // Leaves are draggable so users can nudge positions / re-nest them; the
      // drag is persisted as a layout override (T30) or, on a cross-group drop,
      // rewritten as a `move_to_group` op (DGC-19).
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
