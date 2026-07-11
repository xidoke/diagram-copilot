/**
 * @diagram-copilot/layout
 *
 * Model → positioned graph. Takes a {@link DiagramDoc} from
 * `@diagram-copilot/core` and returns a {@link PositionedGraph} laid out with
 * elkjs (layered algorithm, nested groups, orthogonal edges). Pure and
 * DOM-free, so it runs identically on the server and in the browser.
 */
export const LAYOUT_PACKAGE_NAME = "@diagram-copilot/layout";

export { layoutDiagram } from "./layout.js";

export type {
  LayoutOptions,
  Point,
  PositionedEdge,
  PositionedEdgeSection,
  PositionedGraph,
  PositionedGroup,
  PositionedNode,
} from "./types.js";

// Node/edge-label sizing — exported so the renderer (T12) can reproduce the
// exact boxes ELK laid out with.
export {
  NODE_HEIGHT,
  NODE_MIN_WIDTH,
  NODE_MAX_WIDTH,
  NODE_HORIZONTAL_PADDING,
  NODE_ICON_WIDTH,
  NODE_CHAR_WIDTH,
  EDGE_LABEL_HEIGHT,
  EDGE_LABEL_CHAR_WIDTH,
  EDGE_LABEL_HORIZONTAL_PADDING,
  EDGE_LABEL_LINE_HEIGHT,
  EDGE_LABEL_MAX_WIDTH,
  measureNode,
  measureEdgeLabel,
} from "./sizing.js";

// Spacing presets / direction mapping — exported for tooling and tests.
export {
  DEFAULT_SPACING,
  DIRECTION_TO_ELK,
  SPACING_PRESETS,
  type SpacingPreset,
} from "./options.js";
