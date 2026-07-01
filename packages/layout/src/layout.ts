/**
 * `layoutDiagram` — turn a {@link DiagramDoc} into a positioned graph via
 * elkjs. Pure and DOM-free: builds an ELK hierarchy from the flat
 * node/group/edge lists, runs the `layered` algorithm, and maps the result
 * back into the renderer-facing shapes in `./types.ts`.
 */
import ElkConstructor, {
  type ELK,
  type ElkNode,
  type ElkExtendedEdge,
} from "elkjs/lib/elk.bundled.js";
import type { DiagramDoc } from "@diagram-copilot/core";
import { measureNode } from "./sizing.js";
import {
  DEFAULT_SPACING,
  SPACING_PRESETS,
  groupLayoutOptions,
  rootLayoutOptions,
} from "./options.js";
import type {
  LayoutOptions,
  PositionedEdge,
  PositionedEdgeSection,
  PositionedGraph,
  PositionedGroup,
  PositionedNode,
} from "./types.js";

// A single reused engine. elkjs is stateless per `layout()` call, so one
// instance serves every request and avoids re-spinning its worker.
let elkEngine: ELK | undefined;
function getElk(): ELK {
  return (elkEngine ??= new ElkConstructor());
}

/** Build the ELK input graph from a doc, plus the set of ids that are groups. */
function buildElkGraph(
  doc: DiagramDoc,
  spacing: NonNullable<LayoutOptions["spacing"]>,
): { graph: ElkNode; groupIds: Set<string> } {
  const preset = SPACING_PRESETS[spacing];
  const groupIds = new Set(doc.groups.map((g) => g.id));

  // One ElkNode per group; children filled in below.
  const elkGroups = new Map<string, ElkNode>();
  for (const group of doc.groups) {
    elkGroups.set(group.id, {
      id: group.id,
      layoutOptions: groupLayoutOptions(preset),
      children: [],
    });
  }

  const rootChildren: ElkNode[] = [];

  // Nest groups under their parent group; orphans (parent missing) go to root.
  // validateDoc rejects unknown parents upstream — this stays defensive.
  for (const group of doc.groups) {
    const elk = elkGroups.get(group.id)!;
    const parent =
      group.parentId !== undefined ? elkGroups.get(group.parentId) : undefined;
    (parent?.children ?? rootChildren).push(elk);
  }

  // Attach leaf nodes to their group; orphans go to root.
  for (const node of doc.nodes) {
    const { width, height } = measureNode(node.label);
    const elkLeaf: ElkNode = { id: node.id, width, height };
    const parent =
      node.groupId !== undefined ? elkGroups.get(node.groupId) : undefined;
    (parent?.children ?? rootChildren).push(elkLeaf);
  }

  // All edges live on the root graph; INCLUDE_CHILDREN lets them cross
  // hierarchy boundaries (matches the spike).
  const edges: ElkExtendedEdge[] = doc.edges.map((edge) => ({
    id: edge.id,
    sources: [edge.from],
    targets: [edge.to],
    ...(edge.label !== undefined ? { labels: [{ text: edge.label }] } : {}),
  }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: rootLayoutOptions(doc.direction, preset),
    children: rootChildren,
    edges,
  };
  return { graph, groupIds };
}

/** Map ELK's laid-out graph into the renderer-facing {@link PositionedGraph}. */
function toPositionedGraph(result: ElkNode, groupIds: Set<string>): PositionedGraph {
  const nodes: PositionedNode[] = [];
  const groups: PositionedGroup[] = [];
  const edges: PositionedEdge[] = [];

  // Depth-first pre-order: a group is emitted before its descendants, so
  // `groups` ends up parent-before-child (React Flow's ordering requirement).
  // `absX`/`absY` accumulate ancestor offsets to normalize edge geometry;
  // node/group x/y stay parent-relative as ELK returns them.
  const walk = (parent: ElkNode, parentId: string | undefined, absX: number, absY: number): void => {
    for (const edge of parent.edges ?? []) {
      edges.push(toPositionedEdge(edge as ElkExtendedEdge, absX, absY));
    }
    for (const child of parent.children ?? []) {
      const x = child.x ?? 0;
      const y = child.y ?? 0;
      const box = {
        id: child.id,
        x,
        y,
        width: child.width ?? 0,
        height: child.height ?? 0,
        ...(parentId !== undefined ? { parentId } : {}),
      };
      if (groupIds.has(child.id)) {
        groups.push(box);
        walk(child, child.id, absX + x, absY + y);
      } else {
        nodes.push(box);
      }
    }
  };
  walk(result, undefined, 0, 0);

  return {
    nodes,
    groups,
    edges,
    width: result.width ?? 0,
    height: result.height ?? 0,
  };
}

/** Convert one ELK edge, offsetting its sections into absolute canvas coords. */
function toPositionedEdge(
  edge: ElkExtendedEdge,
  offsetX: number,
  offsetY: number,
): PositionedEdge {
  const label = edge.labels?.[0]?.text;
  const sections: PositionedEdgeSection[] = (edge.sections ?? []).map((section) => ({
    startPoint: { x: section.startPoint.x + offsetX, y: section.startPoint.y + offsetY },
    endPoint: { x: section.endPoint.x + offsetX, y: section.endPoint.y + offsetY },
    ...(section.bendPoints
      ? { bendPoints: section.bendPoints.map((p) => ({ x: p.x + offsetX, y: p.y + offsetY })) }
      : {}),
  }));
  return {
    id: edge.id,
    from: edge.sources[0]!,
    to: edge.targets[0]!,
    ...(label !== undefined ? { label } : {}),
    sections,
  };
}

/**
 * Lay out a diagram document.
 *
 * @param doc  A validated {@link DiagramDoc} (see `@diagram-copilot/core`).
 * @param options  Optional {@link LayoutOptions}; `spacing` defaults to `'normal'`.
 * @returns A {@link PositionedGraph} with absolute-coord edge geometry and
 *   parent-relative node/group boxes. Async because elkjs is Promise-based.
 */
export async function layoutDiagram(
  doc: DiagramDoc,
  options?: LayoutOptions,
): Promise<PositionedGraph> {
  const spacing = options?.spacing ?? DEFAULT_SPACING;
  const { graph, groupIds } = buildElkGraph(doc, spacing);
  const result = await getElk().layout(graph);
  return toPositionedGraph(result, groupIds);
}
