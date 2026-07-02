import { describe, expect, it } from "vitest";
import {
  BaseEdge,
  EdgeLabelRenderer,
  SmoothStepEdge,
  getSmoothStepPath,
  Position,
  type EdgeProps,
} from "@xyflow/react";
import type { PositionedEdgeSection } from "@diagram-copilot/layout";
import {
  ELK_ARROW_ID,
  ElkEdge,
  ElkEdgeMarkerDefs,
  HANDLE_MATCH_EPSILON,
} from "../../src/render/ElkEdge.js";
import { buildElkPath, ELK_EDGE_RADIUS } from "../../src/render/elkPath.js";

/**
 * Like ArchNode.test.tsx: ElkEdge is hook-free, so we call it as a plain
 * function and walk the returned element tree — no DOM needed. Local helper
 * components (plain functions, no hooks) are expanded in place; React Flow's
 * own components (BaseEdge / EdgeLabelRenderer / SmoothStepEdge) use hooks,
 * so they stay un-invoked element types we can assert on.
 */
const RF_TYPES = new Set<unknown>([BaseEdge, EdgeLabelRenderer, SmoothStepEdge]);
function collect(node: unknown, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) collect(c, out);
    return out;
  }
  out.push(node);
  const type = (node as any).type;
  if (typeof type === "function" && !RF_TYPES.has(type)) {
    collect(type((node as any).props), out);
  }
  collect((node as any).props?.children, out);
  return out;
}

const sections: PositionedEdgeSection[] = [
  { startPoint: { x: 0, y: 0 }, endPoint: { x: 50, y: 40 }, bendPoints: [{ x: 50, y: 0 }] },
];

/** Live handle coords that sit exactly on the section endpoints. */
const handles = {
  sourceX: 0,
  sourceY: 0,
  targetX: 50,
  targetY: 40,
  sourcePosition: Position.Right,
  targetPosition: Position.Left,
};

/** Anchors matching `handles` — an edge whose endpoints haven't moved. */
const anchors = { staticSource: { x: 0, y: 0 }, staticTarget: { x: 50, y: 40 } };

const renderEdge = (props: Record<string, unknown>) =>
  ElkEdge({ id: "e1", source: "a", target: "b", ...props } as unknown as EdgeProps);

const findLabel = (els: any[]) => els.find((n) => n.props?.className === "elk-edge-label");

describe("ElkEdge — static ELK route", () => {
  it("draws the exact ELK route via BaseEdge with the arrow marker", () => {
    const base = collect(renderEdge({ data: { sections } })).find((n) => n.type === BaseEdge);
    expect(base).toBeDefined();
    expect(base.props.path).toBe(buildElkPath(sections));
    expect(base.props.markerEnd).toBe(`url(#${ELK_ARROW_ID})`);
  });

  it("stays on the ELK route while live handles sit on the anchors", () => {
    const base = collect(renderEdge({ data: { sections, ...anchors }, ...handles })).find(
      (n) => n.type === BaseEdge,
    );
    expect(base.props.path).toBe(buildElkPath(sections));
  });

  it("tolerates sub-epsilon handle drift (measurement noise)", () => {
    const base = collect(
      renderEdge({
        data: { sections, ...anchors },
        ...handles,
        sourceX: HANDLE_MATCH_EPSILON - 0.5,
      }),
    ).find((n) => n.type === BaseEdge);
    expect(base.props.path).toBe(buildElkPath(sections));
  });

  it("renders no label chrome when the edge has no label", () => {
    const els = collect(renderEdge({ data: { sections } }));
    expect(els.find((n) => n.type === EdgeLabelRenderer)).toBeUndefined();
  });

  it("places the label at ELK's labelPos when provided", () => {
    const els = collect(
      renderEdge({ data: { sections, labelPos: { x: 40, y: 10 } }, label: "https" }),
    );
    const label = findLabel(els);
    expect(label).toBeDefined();
    expect(label.props.style.transform).toBe("translate(-50%, -50%) translate(40px, 10px)");
    expect(label.props.children).toBe("https");
  });

  it("falls back to the longest-segment midpoint when labelPos is absent", () => {
    const els = collect(renderEdge({ data: { sections }, label: "https" }));
    expect(els.find((n) => n.type === EdgeLabelRenderer)).toBeDefined();
    const label = findLabel(els);
    expect(label).toBeDefined();
    // Longest segment is (0,0)→(50,0): midpoint (25,0), normal up, offset 14.
    expect(label.props.style.transform).toBe("translate(-50%, -50%) translate(25px, -14px)");
    expect(label.props.children).toBe("https");
  });

  it("exposes the full label text as a hover tooltip", () => {
    const els = collect(renderEdge({ data: { sections }, label: "cho phép nếu còn quota" }));
    expect(findLabel(els).props.title).toBe("cho phép nếu còn quota");
  });
});

describe("ElkEdge — dynamic endpoints (DGC-69)", () => {
  const expectDynamic = (props: Record<string, unknown>) => {
    const els = collect(renderEdge(props));
    const base = els.find((n) => n.type === BaseEdge);
    expect(base).toBeDefined();
    const [expectedPath, labelX, labelY] = getSmoothStepPath({
      sourceX: (props.sourceX as number) ?? handles.sourceX,
      sourceY: (props.sourceY as number) ?? handles.sourceY,
      sourcePosition: handles.sourcePosition,
      targetX: handles.targetX,
      targetY: handles.targetY,
      targetPosition: handles.targetPosition,
      borderRadius: ELK_EDGE_RADIUS,
    });
    expect(base.props.path).toBe(expectedPath);
    expect(base.props.markerEnd).toBe(`url(#${ELK_ARROW_ID})`);
    return { els, labelX, labelY };
  };

  it("ignores the ELK route when dirtyEndpoints is set (saved override)", () => {
    expectDynamic({ data: { sections, ...anchors, dirtyEndpoints: true }, ...handles });
  });

  it("goes dynamic when a live handle drifts off its anchor (mid-drag)", () => {
    expectDynamic({
      data: { sections, ...anchors },
      ...handles,
      sourceX: HANDLE_MATCH_EPSILON + 5,
    });
  });

  it("keeps the label, centered on the smoothstep midpoint, with the tooltip", () => {
    const { els, labelX, labelY } = expectDynamic({
      data: { sections, ...anchors, dirtyEndpoints: true },
      ...handles,
      label: "https",
    });
    const label = findLabel(els);
    expect(label).toBeDefined();
    expect(label.props.style.transform).toBe(
      `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
    );
    expect(label.props.title).toBe("https");
  });

  it("draws a live smoothstep when sections are missing but handles exist", () => {
    expectDynamic({ data: {}, ...handles });
  });

  it("falls back to smoothstep when sections AND handle coords are missing", () => {
    expect(renderEdge({}).type).toBe(SmoothStepEdge);
    expect(renderEdge({ data: {} }).type).toBe(SmoothStepEdge);
    expect(renderEdge({ data: { sections: [] } }).type).toBe(SmoothStepEdge);
  });
});

describe("ElkEdgeMarkerDefs", () => {
  it("defines the accent arrowhead marker the edges reference", () => {
    const marker = collect(ElkEdgeMarkerDefs()).find((n) => n.type === "marker");
    expect(marker).toBeDefined();
    expect(marker.props.id).toBe(ELK_ARROW_ID);
    // userSpaceOnUse keeps the arrow the same size when hover thickens the stroke.
    expect(marker.props.markerUnits).toBe("userSpaceOnUse");
  });
});
