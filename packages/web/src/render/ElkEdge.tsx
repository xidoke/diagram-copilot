/**
 * Custom React Flow edge that draws the exact orthogonal route ELK computed
 * (T15), instead of letting React Flow re-guess a smoothstep between handles.
 *
 * Coordinate system: `data.sections` are **absolute canvas coordinates** —
 * `toFlow` lifts ELK's container-relative section geometry into the root
 * space before it reaches this component. React Flow renders edge paths in
 * that same root flow coordinate space, so the path data can be emitted
 * as-is; the source/target handles remain purely logical anchors.
 */
import { BaseEdge, EdgeLabelRenderer, SmoothStepEdge, type EdgeProps } from "@xyflow/react";
import type { PositionedEdgeSection } from "@diagram-copilot/layout";
import { buildElkPath, edgeLabelAnchor } from "./elkPath.js";

/** Edge `type` key registered in React Flow's `edgeTypes`. */
export const ELK_EDGE_TYPE = "elk";

/** `data` payload `toFlow` attaches to every `elk` edge. */
export interface ElkEdgeData extends Record<string, unknown> {
  sections: PositionedEdgeSection[];
}

/** SVG marker id for the edge arrowhead (defined by `ElkEdgeMarkerDefs`). */
export const ELK_ARROW_ID = "elk-edge-arrow";

/** How far (px) the label sits off the line, along the segment normal. */
const LABEL_OFFSET = 14;

/**
 * One-off `<defs>` holding the arrowhead marker: an accent-colored chevron
 * sized for the 1.6px edge stroke. `userSpaceOnUse` keeps it a constant size
 * when hover/selection thickens the stroke. Rendered once by the canvas —
 * `url(#…)` resolves document-wide, so it must not repeat per edge.
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
            stroke="var(--accent)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </marker>
      </defs>
    </svg>
  );
}

/**
 * ELK bend-point edge: orthogonal segments with rounded corners, arrowhead,
 * and the label riding the longest segment. Defensive fallback: when
 * `data.sections` is missing/empty (or degenerate), render the old
 * smoothstep so the edge never disappears.
 */
export function ElkEdge(props: EdgeProps) {
  const { id, label, data } = props;
  const sections = (data as Partial<ElkEdgeData> | undefined)?.sections ?? [];
  const path = buildElkPath(sections);
  if (!path) return <SmoothStepEdge {...props} />;

  const anchor = label != null && label !== "" ? edgeLabelAnchor(sections) : null;
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={`url(#${ELK_ARROW_ID})`} />
      {anchor && (
        <EdgeLabelRenderer>
          <div
            className="elk-edge-label"
            style={{
              transform: `translate(-50%, -50%) translate(${anchor.x + anchor.nx * LABEL_OFFSET}px, ${anchor.y + anchor.ny * LABEL_OFFSET}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
