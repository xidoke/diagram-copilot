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
import { measureEdgeLabel, measureNode } from "./sizing.js";
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
  // hierarchy boundaries (matches the spike). Labels carry an estimated box
  // (measureEdgeLabel) so ELK reserves real room for them while routing —
  // labeled edges get their own space between layers instead of the label
  // overlapping nodes or sibling labels (DGC-69).
  const edges: ElkExtendedEdge[] = doc.edges.map((edge) => ({
    id: edge.id,
    sources: [edge.from],
    targets: [edge.to],
    ...(edge.label !== undefined
      ? { labels: [{ text: edge.label, ...measureEdgeLabel(edge.label) }] }
      : {}),
  }));

  const graph: ElkNode = {
    id: "root",
    layoutOptions: rootLayoutOptions(doc.direction, preset),
    children: rootChildren,
    edges,
  };
  return { graph, groupIds };
}

/**
 * elkjs tags every laid-out edge with `container` — the id of the endpoints'
 * lowest common ancestor, the coordinate frame its `sections` are reported in.
 * It isn't in elkjs's published types, so we read it through this alias.
 */
type LaidOutEdge = ElkExtendedEdge & { container?: string };

/** Map ELK's laid-out graph into the renderer-facing {@link PositionedGraph}. */
function toPositionedGraph(result: ElkNode, groupIds: Set<string>): PositionedGraph {
  const nodes: PositionedNode[] = [];
  const groups: PositionedGroup[] = [];

  // Absolute top-left origin of every element, keyed by id (root at 0,0).
  // elkjs reports each edge's sections relative to `edge.container` (the
  // endpoints' lowest common ancestor, a group endpoint counting as its own
  // ancestor). Recording every origin here lets us offset each edge by *its*
  // container below — not by the node the edge was declared on, which is
  // always the root and therefore a no-op.
  const absOrigin = new Map<string, { x: number; y: number }>([
    [result.id ?? "root", { x: 0, y: 0 }],
  ]);
  const elkEdges: LaidOutEdge[] = [];

  // Depth-first pre-order: a group is emitted before its descendants, so
  // `groups` ends up parent-before-child (React Flow's ordering requirement).
  // `absX`/`absY` accumulate ancestor offsets to build each element's absolute
  // origin; node/group x/y stay parent-relative as ELK returns them.
  const walk = (parent: ElkNode, parentId: string | undefined, absX: number, absY: number): void => {
    for (const edge of parent.edges ?? []) elkEdges.push(edge as LaidOutEdge);
    for (const child of parent.children ?? []) {
      const x = child.x ?? 0;
      const y = child.y ?? 0;
      const originX = absX + x;
      const originY = absY + y;
      absOrigin.set(child.id, { x: originX, y: originY });
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
        walk(child, child.id, originX, originY);
      } else {
        nodes.push(box);
      }
    }
  };
  walk(result, undefined, 0, 0);

  // Offset each edge's sections by its container's absolute origin, yielding
  // true absolute geometry for every case (root-level, intra-group, cross-
  // boundary, and group↔descendant edges). Falls back to the origin when
  // `container` is missing/unknown (e.g. a root-level edge).
  const edges: PositionedEdge[] = elkEdges.map((edge) => {
    const origin =
      (edge.container !== undefined ? absOrigin.get(edge.container) : undefined) ?? { x: 0, y: 0 };
    return toPositionedEdge(edge, origin.x, origin.y);
  });

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
  const elkLabel = edge.labels?.[0];
  const label = elkLabel?.text;
  // ELK reports the label's top-left in the same container-relative frame as
  // the sections; lift it by the same offset and convert to the box center
  // (the renderer places labels with a centering transform).
  const labelPos =
    elkLabel?.x !== undefined && elkLabel?.y !== undefined
      ? {
          x: elkLabel.x + (elkLabel.width ?? 0) / 2 + offsetX,
          y: elkLabel.y + (elkLabel.height ?? 0) / 2 + offsetY,
        }
      : undefined;
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
    ...(labelPos !== undefined ? { labelPos } : {}),
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
