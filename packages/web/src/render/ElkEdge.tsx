/**
 * Custom React Flow edge that draws the exact orthogonal route ELK computed
 * (T15), instead of letting React Flow re-guess a smoothstep between handles.
 *
 * Coordinate system: `data.sections` are **absolute canvas coordinates** —
 * `toFlow` lifts ELK's container-relative section geometry into the root
 * space before it reaches this component. React Flow renders edge paths in
 * that same root flow coordinate space, so the path data can be emitted
 * as-is; the source/target handles remain purely logical anchors.
 *
 * Live endpoints (DGC-69): the ELK route is only valid while both endpoints
 * still sit where ELK put them. The edge switches to a *dynamic* smoothstep
 * drawn from React Flow's live handle positions when either
 *  - `data.dirtyEndpoints` is set (an endpoint has a saved manual override —
 *    marked by `markDirtyEdges` in App), or
 *  - the live handle positions drift off the layout-time anchors
 *    (`data.staticSource` / `data.staticTarget`) by more than
 *    {@link HANDLE_MATCH_EPSILON} — which is exactly what happens on every
 *    frame of an in-progress drag, so the edge follows the node live.
 * The anchors are the node-border handle centers `toFlow` computes from the
 * positioned graph — NOT the ELK section endpoints, which ELK fans out along
 * the border when a node has several edges and therefore rarely coincide
 * with the single React Flow handle.
 */
import {
  BaseEdge,
  EdgeLabelRenderer,
  SmoothStepEdge,
  getSmoothStepPath,
  type EdgeProps,
} from "@xyflow/react";
import { EDGE_LABEL_MAX_WIDTH, type Point, type PositionedEdgeSection } from "@diagram-copilot/layout";
import { ELK_EDGE_RADIUS, buildElkPath, edgeLabelAnchor } from "./elkPath.js";
import { tooltipFor } from "./labelTooltip.js";

/** Edge `type` key registered in React Flow's `edgeTypes`. */
export const ELK_EDGE_TYPE = "elk";

/** `data` payload `toFlow` attaches to every `elk` edge. */
export interface ElkEdgeData extends Record<string, unknown> {
  sections: PositionedEdgeSection[];
  /** ELK-placed label box center (absolute coords); heuristic fallback when absent. */
  labelPos?: Point;
  /** Source handle center at layout time (absolute coords) — drift detector input. */
  staticSource?: Point;
  /** Target handle center at layout time (absolute coords) — drift detector input. */
  staticTarget?: Point;
  /** True when either endpoint has a saved manual override (stale ELK route). */
  dirtyEndpoints?: boolean;
  /**
   * Hover association (DGC-100): set by `applyHoverToEdges` when this edge —
   * or a node it touches — is under the pointer. Accents the path and lifts
   * the label so a floating label maps back to its line at a glance.
   */
  highlighted?: boolean;
}

/** SVG marker id for the edge arrowhead (defined by `ElkEdgeMarkerDefs`). */
export const ELK_ARROW_ID = "elk-edge-arrow";

/** How far (px) the heuristic label sits off the line, along the segment normal. */
const LABEL_OFFSET = 14;

/**
 * Max drift (px, per axis) between a live handle and its layout-time anchor
 * before the ELK route is considered stale and the edge goes dynamic.
 */
export const HANDLE_MATCH_EPSILON = 2;

/** Is `(x, y)` within {@link HANDLE_MATCH_EPSILON} of `anchor` on both axes? */
function nearAnchor(x: number, y: number, anchor: Point): boolean {
  return (
    Math.abs(x - anchor.x) <= HANDLE_MATCH_EPSILON &&
    Math.abs(y - anchor.y) <= HANDLE_MATCH_EPSILON
  );
}

/**
 * One-off `<defs>` holding the arrowhead marker: a chevron in the resting
 * edge ink (`--edge-stroke`, DGC-97) with a stroke width matching the
 * 1.5px edge stroke (`--edge-stroke-width`). `userSpaceOnUse` keeps it a
 * constant size when hover/selection thickens the stroke. Rendered once by
 * the canvas — `url(#…)` resolves document-wide, so it must not repeat per
 * edge.
 */
export function ElkEdgeMarkerDefs() {
  return (
    <svg style={{ position: "absolute", width: 0, height: 0 }} aria-hidden="true">
      <defs>
        <marker
          id={ELK_ARROW_ID}
          viewBox="0 0 12 12"
          refX="9"
          refY="6"
          markerWidth="12"
          markerHeight="12"
          markerUnits="userSpaceOnUse"
          orient="auto-start-reverse"
        >
          <path
            d="M 3 2 L 9 6 L 3 10"
            fill="none"
            stroke="var(--edge-stroke)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>
    </svg>
  );
}

/**
 * Shared label chrome: centered on `(x, y)`; text wraps to two lines at the
 * same width cap ELK reserved room for (DGC-100), then ellipsizes. Full text
 * lives in the native `title` plus, for genuinely long labels, the styled
 * `[data-full-label]` CSS tooltip. `data-edge-id` feeds App's hover
 * delegation — the div lives in `EdgeLabelRenderer`'s HTML layer, outside the
 * edge's SVG group, so React Flow's own edge hover events never see it.
 * `highlighted` mirrors the path accent so label and line light up together.
 */
function ElkEdgeLabel({
  id,
  x,
  y,
  label,
  highlighted,
}: {
  id: string;
  x: number;
  y: number;
  label: EdgeProps["label"];
  highlighted: boolean;
}) {
  const text = typeof label === "string" ? label : undefined;
  const tooltip = text !== undefined ? tooltipFor(text, "edge") : undefined;
  return (
    <EdgeLabelRenderer>
      <div
        className={highlighted ? "elk-edge-label elk-edge-label--hl" : "elk-edge-label"}
        data-edge-id={id}
        {...(tooltip !== undefined ? { "data-full-label": tooltip } : {})}
        title={text}
        style={{
          transform: `translate(-50%, -50%) translate(${x}px, ${y}px)`,
          maxWidth: EDGE_LABEL_MAX_WIDTH,
        }}
      >
        <span className="elk-edge-label__text">{label}</span>
      </div>
    </EdgeLabelRenderer>
  );
}

/**
 * ELK bend-point edge with a live fallback:
 *
 * - **Static** (endpoints untouched): orthogonal ELK segments with rounded
 *   corners, arrowhead, and the label at ELK's own label position
 *   (`data.labelPos`; longest-segment heuristic when absent).
 * - **Dynamic** (endpoint overridden or mid-drag, see module docs): a
 *   smoothstep from React Flow's live handle coordinates, same arrowhead and
 *   label chrome, so the edge tracks the node on every frame of a drag.
 * - Defensive: when `data.sections` is missing/degenerate *and* no live
 *   handle coordinates are available, render React Flow's own smoothstep so
 *   the edge never disappears.
 */
export function ElkEdge(props: EdgeProps) {
  const { id, label, data, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition } =
    props;
  const d = data as Partial<ElkEdgeData> | undefined;
  const sections = d?.sections ?? [];
  const path = buildElkPath(sections);
  const hasLabel = label != null && label !== "";
  const highlighted = d?.highlighted === true;
  // Accent + thicker stroke while hover-associated (DGC-100); BaseEdge merges
  // this onto the `.react-flow__edge-path` element itself, so the diff
  // overlay's stroke color (a more specific `.react-flow__edge.diff-* path`
  // rule) still wins where both apply.
  const pathClass = highlighted ? "elk-edge-path--hl" : undefined;

  const liveHandles = [sourceX, sourceY, targetX, targetY].every(Number.isFinite);
  const anchorsMatch =
    !liveHandles ||
    !d?.staticSource ||
    !d?.staticTarget ||
    (nearAnchor(sourceX, sourceY, d.staticSource) &&
      nearAnchor(targetX, targetY, d.staticTarget));

  if (path && d?.dirtyEndpoints !== true && anchorsMatch) {
    const anchor = hasLabel ? edgeLabelAnchor(sections) : null;
    const labelXY = hasLabel
      ? d?.labelPos ??
        (anchor
          ? { x: anchor.x + anchor.nx * LABEL_OFFSET, y: anchor.y + anchor.ny * LABEL_OFFSET }
          : null)
      : null;
    return (
      <>
        <BaseEdge id={id} path={path} className={pathClass} markerEnd={`url(#${ELK_ARROW_ID})`} />
        {labelXY && (
          <ElkEdgeLabel id={id} x={labelXY.x} y={labelXY.y} label={label} highlighted={highlighted} />
        )}
      </>
    );
  }

  // No route *and* no live handle coordinates (degenerate data in tests /
  // first frame) — let React Flow draw its own smoothstep rather than a NaN path.
  if (!liveHandles) return <SmoothStepEdge {...props} />;

  const [dynamicPath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: ELK_EDGE_RADIUS,
  });
  return (
    <>
      <BaseEdge id={id} path={dynamicPath} className={pathClass} markerEnd={`url(#${ELK_ARROW_ID})`} />
      {hasLabel && (
        <ElkEdgeLabel id={id} x={labelX} y={labelY} label={label} highlighted={highlighted} />
      )}
    </>
  );
}
