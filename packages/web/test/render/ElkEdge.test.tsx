import { describe, expect, it } from "vitest";
import { BaseEdge, EdgeLabelRenderer, SmoothStepEdge, type EdgeProps } from "@xyflow/react";
import type { PositionedEdgeSection } from "@diagram-copilot/layout";
import { ELK_ARROW_ID, ElkEdge, ElkEdgeMarkerDefs } from "../../src/render/ElkEdge.js";
import { buildElkPath } from "../../src/render/elkPath.js";

/**
 * Like ArchNode.test.tsx: ElkEdge is hook-free, so we call it as a plain
 * function and walk the returned element tree — no DOM needed. BaseEdge /
 * EdgeLabelRenderer stay un-invoked element types we can assert on.
 */
function collect(node: unknown, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) collect(c, out);
    return out;
  }
  out.push(node);
  collect((node as any).props?.children, out);
  return out;
}

const sections: PositionedEdgeSection[] = [
  { startPoint: { x: 0, y: 0 }, endPoint: { x: 50, y: 40 }, bendPoints: [{ x: 50, y: 0 }] },
];

const renderEdge = (props: Record<string, unknown>) =>
  ElkEdge({ id: "e1", source: "a", target: "b", ...props } as unknown as EdgeProps);

describe("ElkEdge", () => {
  it("draws the exact ELK route via BaseEdge with the arrow marker", () => {
    const base = collect(renderEdge({ data: { sections } })).find((n) => n.type === BaseEdge);
    expect(base).toBeDefined();
    expect(base.props.path).toBe(buildElkPath(sections));
    expect(base.props.markerEnd).toBe(`url(#${ELK_ARROW_ID})`);
  });

  it("renders no label chrome when the edge has no label", () => {
    const els = collect(renderEdge({ data: { sections } }));
    expect(els.find((n) => n.type === EdgeLabelRenderer)).toBeUndefined();
  });

  it("places the label at the longest segment's midpoint, offset off the line", () => {
    const els = collect(renderEdge({ data: { sections }, label: "https" }));
    expect(els.find((n) => n.type === EdgeLabelRenderer)).toBeDefined();
    const label = els.find((n) => n.props?.className === "elk-edge-label");
    expect(label).toBeDefined();
    // Longest segment is (0,0)→(50,0): midpoint (25,0), normal up, offset 14.
    expect(label.props.style.transform).toBe("translate(-50%, -50%) translate(25px, -14px)");
    expect(label.props.children).toBe("https");
  });

  it("falls back to smoothstep when sections are missing or empty", () => {
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
