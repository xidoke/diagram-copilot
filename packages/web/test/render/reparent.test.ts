import { describe, expect, it } from "vitest";
import {
  absoluteBoxes,
  decideReparent,
  descendantIds,
  groupAtPoint,
  type AbsBox,
  type NodeGeom,
} from "../../src/render/reparent.js";

describe("groupAtPoint", () => {
  const groups: AbsBox[] = [
    { id: "Outer", x: 0, y: 0, width: 300, height: 300 },
    // Inner sits fully inside Outer — smaller area.
    { id: "Inner", x: 50, y: 50, width: 100, height: 100 },
    // Far is disjoint.
    { id: "Far", x: 500, y: 0, width: 80, height: 80 },
  ];

  it("returns null when the point is outside every group", () => {
    expect(groupAtPoint({ x: 400, y: 400 }, groups)).toBeNull();
  });

  it("returns the group whose box contains the point", () => {
    expect(groupAtPoint({ x: 520, y: 20 }, groups)).toBe("Far");
  });

  it("picks the INNERMOST (smallest-area) group when boxes nest", () => {
    // (100,100) is inside both Outer and Inner → Inner wins (smaller area).
    expect(groupAtPoint({ x: 100, y: 100 }, groups)).toBe("Inner");
  });

  it("falls back to the enclosing group when the point misses the inner one", () => {
    // (250,250) is in Outer but not Inner.
    expect(groupAtPoint({ x: 250, y: 250 }, groups)).toBe("Outer");
  });

  it("treats the box as inclusive of its top-left edge, exclusive past the far edge", () => {
    expect(groupAtPoint({ x: 0, y: 0 }, groups)).toBe("Outer");
    // Just past the right/bottom edge of Outer.
    expect(groupAtPoint({ x: 300.1, y: 0 }, groups)).toBeNull();
  });
});

describe("descendantIds", () => {
  // Outer ▸ Mid ▸ DB, plus a sibling leaf under Outer, and an unrelated root.
  const nodes = [
    { id: "Outer" },
    { id: "Mid", parentId: "Outer" },
    { id: "DB", parentId: "Mid" },
    { id: "Cache", parentId: "Outer" },
    { id: "Root" },
  ];

  it("collects transitive descendants (children + grandchildren)", () => {
    expect(descendantIds("Outer", nodes)).toEqual(new Set(["Mid", "DB", "Cache"]));
  });

  it("collects only the direct child for a one-level group", () => {
    expect(descendantIds("Mid", nodes)).toEqual(new Set(["DB"]));
  });

  it("returns an empty set for a leaf with no children", () => {
    expect(descendantIds("DB", nodes)).toEqual(new Set());
  });

  it("does not include the node itself", () => {
    expect(descendantIds("Outer", nodes).has("Outer")).toBe(false);
  });
});

describe("absoluteBoxes", () => {
  const geoms: NodeGeom[] = [
    { id: "G", position: { x: 200, y: 100 }, width: 300, height: 200 },
    { id: "Child", parentId: "G", position: { x: 20, y: 40 }, width: 120, height: 48 },
    { id: "GChild", parentId: "Child", position: { x: 5, y: 5 }, width: 30, height: 30 },
    { id: "Root", position: { x: 10, y: 10 }, width: 100, height: 50 },
  ];

  it("keeps a root node's box absolute (position is already canvas-frame)", () => {
    expect(absoluteBoxes(geoms).get("Root")).toEqual({ id: "Root", x: 10, y: 10, width: 100, height: 50 });
  });

  it("offsets a child by its parent's absolute origin", () => {
    expect(absoluteBoxes(geoms).get("Child")).toEqual({ id: "Child", x: 220, y: 140, width: 120, height: 48 });
  });

  it("sums the whole parent chain for a grandchild", () => {
    expect(absoluteBoxes(geoms).get("GChild")).toEqual({ id: "GChild", x: 225, y: 145, width: 30, height: 30 });
  });

  it("is order-independent (a child listed before its parent still resolves)", () => {
    const reversed = [...geoms].reverse();
    expect(absoluteBoxes(reversed).get("GChild")).toEqual({ id: "GChild", x: 225, y: 145, width: 30, height: 30 });
  });
});

describe("decideReparent", () => {
  // Two sibling groups at root, one leaf currently inside A.
  const groups: AbsBox[] = [
    { id: "A", x: 0, y: 0, width: 200, height: 200 },
    { id: "B", x: 300, y: 0, width: 200, height: 200 },
  ];
  const nodes = [
    { id: "A" },
    { id: "B" },
    { id: "leaf", parentId: "A" },
  ];

  it("no change when dropped inside the SAME parent (plain reposition)", () => {
    const d = decideReparent({
      nodeId: "leaf",
      currentParent: "A",
      dropPoint: { x: 100, y: 100 }, // inside A
      groups,
      nodes,
    });
    expect(d).toEqual({ changed: false });
  });

  it("reparents into a DIFFERENT group the drop lands in", () => {
    const d = decideReparent({
      nodeId: "leaf",
      currentParent: "A",
      dropPoint: { x: 400, y: 100 }, // inside B
      groups,
      nodes,
    });
    expect(d).toEqual({ changed: true, group: "B" });
  });

  it("moves to root (group: null) when dropped outside every group", () => {
    const d = decideReparent({
      nodeId: "leaf",
      currentParent: "A",
      dropPoint: { x: 250, y: 300 }, // gap between A and B, below both
      groups,
      nodes,
    });
    expect(d).toEqual({ changed: true, group: null });
  });

  it("no change for a root node dropped in open canvas (root → root)", () => {
    const d = decideReparent({
      nodeId: "B",
      currentParent: null,
      dropPoint: { x: 250, y: 300 },
      groups,
      nodes,
    });
    expect(d).toEqual({ changed: false });
  });

  it("reparents a root node dropped into a group", () => {
    const rootLeaf = [...nodes, { id: "free" }];
    const d = decideReparent({
      nodeId: "free",
      currentParent: null,
      dropPoint: { x: 100, y: 100 }, // inside A
      groups,
      nodes: rootLeaf,
    });
    expect(d).toEqual({ changed: true, group: "A" });
  });

  it("excludes the dragged group and its descendants as reparent targets (no self/cycle)", () => {
    // Dragging Outer whose own box (and its child Inner's box) contain the drop
    // point must NOT reparent Outer into itself or into Inner.
    const nested: AbsBox[] = [
      { id: "Outer", x: 0, y: 0, width: 400, height: 400 },
      { id: "Inner", x: 50, y: 50, width: 200, height: 200 },
      { id: "Other", x: 600, y: 0, width: 100, height: 100 },
    ];
    const nestedNodes = [
      { id: "Outer" },
      { id: "Inner", parentId: "Outer" },
      { id: "Other" },
    ];
    const d = decideReparent({
      nodeId: "Outer",
      currentParent: null,
      dropPoint: { x: 100, y: 100 }, // inside Outer & Inner, both excluded
      groups: nested,
      nodes: nestedNodes,
    });
    // No valid candidate contains the point → stays at root (no change).
    expect(d).toEqual({ changed: false });
  });

  it("lets a group reparent into an unrelated group", () => {
    const nested: AbsBox[] = [
      { id: "Outer", x: 0, y: 0, width: 400, height: 400 },
      { id: "Inner", parentId: undefined as unknown as never, x: 50, y: 50, width: 200, height: 200 },
      { id: "Other", x: 600, y: 0, width: 150, height: 150 },
    ];
    const nestedNodes = [{ id: "Outer" }, { id: "Inner", parentId: "Outer" }, { id: "Other" }];
    const d = decideReparent({
      nodeId: "Inner",
      currentParent: "Outer",
      dropPoint: { x: 650, y: 40 }, // inside Other
      groups: nested,
      nodes: nestedNodes,
    });
    expect(d).toEqual({ changed: true, group: "Other" });
  });
});
