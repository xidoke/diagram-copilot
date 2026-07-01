/**
 * Output contracts for `@diagram-copilot/layout`: the positioned graph that
 * `layoutDiagram` produces from a {@link import("@diagram-copilot/core").DiagramDoc}.
 * These shapes are consumed by the React Flow renderer (T15).
 */

/** Options controlling {@link import("./layout.js").layoutDiagram}. */
export interface LayoutOptions {
  /**
   * Overall breathing room between elements. `'normal'` is the default and
   * the only preset verified for v0.1; `'compact'` / `'airy'` are wired to
   * pre-set constants.
   */
  spacing?: "compact" | "normal" | "airy";
}

/** A 2D point (px). */
export interface Point {
  x: number;
  y: number;
}

/**
 * One routed segment of an edge, straight from ELK.
 *
 * Points are in **absolute canvas coordinates**: ELK routes each edge within
 * its container node, and layout normalizes every section by that container's
 * absolute offset so all edge geometry shares one coordinate space (ready for
 * a custom bend-point renderer in T15).
 */
export interface PositionedEdgeSection {
  /** Where the segment begins. */
  startPoint: Point;
  /** Where the segment ends. */
  endPoint: Point;
  /** Intermediate right-angle turn points, in order (absent when straight). */
  bendPoints?: Point[];
}

/**
 * A laid-out leaf node.
 *
 * `x` / `y` are the **top-left corner relative to the parent group** (or to
 * the canvas when `parentId` is absent) — the React Flow convention, taken
 * directly from ELK's local coordinates. To get an absolute position, add the
 * accumulated offsets of every ancestor group.
 */
export interface PositionedNode {
  id: string;
  /** Left edge, relative to `parentId` (or canvas). */
  x: number;
  /** Top edge, relative to `parentId` (or canvas). */
  y: number;
  width: number;
  height: number;
  /** Containing group id, or absent for a root-level node. */
  parentId?: string;
}

/**
 * A laid-out group container. Coordinates follow the same parent-relative
 * convention as {@link PositionedNode}.
 */
export interface PositionedGroup {
  id: string;
  /** Left edge, relative to `parentId` (or canvas). */
  x: number;
  /** Top edge, relative to `parentId` (or canvas). */
  y: number;
  width: number;
  height: number;
  /** Parent group id, or absent for a root-level group. */
  parentId?: string;
}

/** A laid-out edge with its ELK routing preserved for bend-point rendering. */
export interface PositionedEdge {
  id: string;
  /** Source node/group id. */
  from: string;
  /** Target node/group id. */
  to: string;
  label?: string;
  /** ELK routing sections (absolute coords). Non-empty for a routed edge. */
  sections: PositionedEdgeSection[];
}

/**
 * The complete laid-out graph.
 *
 * `groups` is ordered **parent-before-child** so it can be fed straight to
 * React Flow (which requires a parent node to precede its children).
 * `width` / `height` are the root graph's bounding box.
 */
export interface PositionedGraph {
  nodes: PositionedNode[];
  groups: PositionedGroup[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}
