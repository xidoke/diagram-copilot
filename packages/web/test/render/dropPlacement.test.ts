import { describe, expect, it } from "vitest";
import { dropOverridePosition } from "../../src/render/dropPlacement.js";

describe("dropOverridePosition", () => {
  it("centers a root-level drop on the drop point (no parent offset)", () => {
    // Drop at (200, 120); a 100×40 node → top-left offset back by half its size.
    expect(dropOverridePosition({ x: 200, y: 120 }, { width: 100, height: 40 }, null)).toEqual({
      x: 150,
      y: 100,
    });
  });

  it("subtracts the parent group's absolute origin for a nested drop", () => {
    // Same drop, but the node lands in a group whose absolute origin is (60, 30):
    // override is stored parent-relative, so the origin is subtracted too.
    expect(
      dropOverridePosition({ x: 200, y: 120 }, { width: 100, height: 40 }, { x: 60, y: 30 }),
    ).toEqual({ x: 90, y: 70 });
  });

  it("treats a zero-size node as a point at the drop", () => {
    expect(dropOverridePosition({ x: 10, y: 10 }, { width: 0, height: 0 }, null)).toEqual({
      x: 10,
      y: 10,
    });
  });

  it("handles negative drop coordinates (panned canvas)", () => {
    expect(dropOverridePosition({ x: -40, y: -10 }, { width: 20, height: 20 }, null)).toEqual({
      x: -50,
      y: -20,
    });
  });
});
