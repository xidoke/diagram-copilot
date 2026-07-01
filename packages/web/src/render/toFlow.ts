import type { Edge, Node } from "@xyflow/react";
import type { DiagramDoc, Direction } from "@diagram-copilot/core";
import type { PositionedGraph } from "@diagram-copilot/layout";

/** Node `type` keys registered in React Flow's `nodeTypes`. */
export const ARCH_NODE_TYPE = "archNode";
export const ARCH_GROUP_TYPE = "archGroup";

export interface ArchNodeData extends Record<string, unknown> {
  label: string;
  direction: Direction;
}

/**
 * Pure mapping: positioned graph (+ labels from the doc) → React Flow arrays.
 * Groups come first (already parent-before-child from layout), then leaves —
 * React Flow requires parents to precede children.
 */
export function toFlow(doc: DiagramDoc, graph: PositionedGraph): { nodes: Node[]; edges: Edge[] } {
  const labels = new Map<string, string>();
  for (const n of doc.nodes) labels.set(n.id, n.label);
  for (const g of doc.groups) labels.set(g.id, g.label);

  const nodes: Node[] = [];

  for (const g of graph.groups) {
    nodes.push({
      id: g.id,
      type: ARCH_GROUP_TYPE,
      position: { x: g.x, y: g.y },
      data: { label: labels.get(g.id) ?? g.id, direction: doc.direction } satisfies ArchNodeData,
      style: { width: g.width, height: g.height },
      ...(g.parentId ? { parentId: g.parentId, extent: "parent" as const } : {}),
      selectable: false,
      draggable: false,
    });
  }

  for (const n of graph.nodes) {
    nodes.push({
      id: n.id,
      type: ARCH_NODE_TYPE,
      position: { x: n.x, y: n.y },
      data: { label: labels.get(n.id) ?? n.id, direction: doc.direction } satisfies ArchNodeData,
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
