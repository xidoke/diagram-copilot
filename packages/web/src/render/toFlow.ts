import type { Edge, Node } from "@xyflow/react";
import type { DiagramDoc, Direction } from "@diagram-copilot/core";
import type { PositionedGraph } from "@diagram-copilot/layout";

/** Node `type` keys registered in React Flow's `nodeTypes`. */
export const ARCH_NODE_TYPE = "archNode";
export const ARCH_GROUP_TYPE = "archGroup";

export interface ArchNodeData extends Record<string, unknown> {
  label: string;
  direction: Direction;
  /** Icon registry id (see `@diagram-copilot/icons`). Absent → no icon chip. */
  icon?: string;
  /** Color token name (e.g. `"orange"`), resolved by `resolveColor`. */
  color?: string;
}

interface NodeMeta {
  label: string;
  icon?: string;
  color?: string;
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

  for (const g of graph.groups) {
    const m = meta.get(g.id);
    nodes.push({
      id: g.id,
      type: ARCH_GROUP_TYPE,
      position: { x: g.x, y: g.y },
      data: {
        label: m?.label ?? g.id,
        direction: doc.direction,
        ...(m?.icon !== undefined ? { icon: m.icon } : {}),
        ...(m?.color !== undefined ? { color: m.color } : {}),
      } satisfies ArchNodeData,
      style: { width: g.width, height: g.height },
      ...(g.parentId ? { parentId: g.parentId, extent: "parent" as const } : {}),
      selectable: false,
      draggable: false,
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
      ...(n.parentId ? { parentId: n.parentId, extent: "parent" as const } : {}),
      draggable: false,
    });
  }

  const edges: Edge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    ...(e.label ? { label: e.label } : {}),
    type: "smoothstep",
  }));

  return { nodes, edges };
}
