import { describe, expect, it } from "vitest";
import type { PositionedEdgeSection } from "@diagram-copilot/layout";
import { buildElkPath, edgeLabelAnchor, sectionsToPolyline } from "../../src/render/elkPath.js";

const section = (
  start: [number, number],
  end: [number, number],
  bends: [number, number][] = [],
): PositionedEdgeSection => ({
  startPoint: { x: start[0], y: start[1] },
  endPoint: { x: end[0], y: end[1] },
  ...(bends.length ? { bendPoints: bends.map(([x, y]) => ({ x, y })) } : {}),
});

describe("buildElkPath", () => {
  it("renders a straight section as M + L", () => {
    expect(buildElkPath([section([0, 10], [100, 10])])).toBe("M 0 10 L 100 10");
  });

  it("rounds a single bend with a quadratic corner (default radius 6)", () => {
    expect(buildElkPath([section([0, 0], [50, 40], [[50, 0]])])).toBe(
      "M 0 0 L 44 0 Q 50 0 50 6 L 50 40",
    );
  });

  it("rounds every bend in a multi-bend section", () => {
    expect(
      buildElkPath([
        section(
          [0, 0],
          [90, 30],
          [
            [40, 0],
            [40, 30],
          ],
        ),
      ]),
    ).toBe("M 0 0 L 34 0 Q 40 0 40 6 L 40 24 Q 40 30 46 30 L 90 30");
  });

  it("joins multiple sections into one polyline, rounding across the junction", () => {
    // The second section starts exactly where the first ends — the shared
    // point is deduped and the junction becomes a rounded corner, identical
    // to the single-section single-bend case.
    expect(buildElkPath([section([0, 0], [50, 0]), section([50, 0], [50, 40])])).toBe(
      "M 0 0 L 44 0 Q 50 0 50 6 L 50 40",
    );
  });

  it("clamps the radius to half of the shortest adjacent segment", () => {
    // Incoming segment is only 8px long → r = min(6, 8/2, 40/2) = 4.
    expect(buildElkPath([section([0, 0], [8, 40], [[8, 0]])])).toBe(
      "M 0 0 L 4 0 Q 8 0 8 4 L 8 40",
    );
  });

  it("falls back to a sharp corner when the clamped radius is sub-visual", () => {
    // Incoming segment 0.6px → r = 0.3 < 0.5 threshold → plain L, no Q.
    expect(buildElkPath([section([0, 0], [0.6, 40], [[0.6, 0]])])).toBe(
      "M 0 0 L 0.6 0 L 0.6 40",
    );
  });

  it("passes straight through a collinear bend point without a curve", () => {
    expect(buildElkPath([section([0, 0], [100, 0], [[50, 0]])])).toBe("M 0 0 L 50 0 L 100 0");
  });

  it("honours an explicit radius", () => {
    expect(buildElkPath([section([0, 0], [50, 40], [[50, 0]])], 10)).toBe(
      "M 0 0 L 40 0 Q 50 0 50 10 L 50 40",
    );
  });

  it("returns an empty string for empty or degenerate sections", () => {
    expect(buildElkPath([])).toBe("");
    expect(buildElkPath([{ startPoint: { x: 5, y: 5 }, endPoint: { x: 5, y: 5 } }])).toBe("");
  });
});

describe("sectionsToPolyline", () => {
  it("drops consecutive duplicate points across section boundaries", () => {
    const pts = sectionsToPolyline([section([0, 0], [50, 0]), section([50, 0], [50, 40])]);
    expect(pts).toEqual([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 50, y: 40 },
    ]);
  });
});

describe("edgeLabelAnchor", () => {
  it("anchors at the midpoint of the LONGEST segment, not the path midpoint", () => {
    // Segments: 10px, 100px (vertical), 10px → anchor rides the vertical run.
    const anchor = edgeLabelAnchor([
      section(
        [0, 0],
        [20, 100],
        [
          [10, 0],
          [10, 100],
        ],
      ),
    ]);
    expect(anchor).toEqual({ x: 10, y: 50, nx: 1, ny: 0 }); // normal → right
  });

  it("offsets upward for a horizontal longest segment", () => {
    const anchor = edgeLabelAnchor([section([0, 0], [80, 10], [[80, 0]])]);
    expect(anchor).toEqual({ x: 40, y: 0, nx: 0, ny: -1 }); // normal → up
  });

  it("spans sections when finding the longest segment", () => {
    const anchor = edgeLabelAnchor([section([0, 0], [10, 0]), section([10, 0], [10, 60])]);
    expect(anchor).toEqual({ x: 10, y: 30, nx: 1, ny: 0 });
  });

  it("returns null when there is no routable geometry", () => {
    expect(edgeLabelAnchor([])).toBeNull();
  });
});
