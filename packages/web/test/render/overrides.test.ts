import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import type { LayoutOverrides } from "@diagram-copilot/core";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE } from "../../src/render/toFlow.js";
import { applyOverrides, PINNED_CLASS } from "../../src/render/overrides.js";

/** A minimal leaf/group node array mirroring what `toFlow` produces. */
function fixtureNodes(): Node[] {
  return [
    { id: "VPC", type: ARCH_GROUP_TYPE, position: { x: 200, y: 0 }, data: {} },
    { id: "Client", type: ARCH_NODE_TYPE, position: { x: 10, y: 20 }, data: {} },
    // A child inside VPC — its position is parent-relative (extent: parent).
    { id: "API", type: ARCH_NODE_TYPE, position: { x: 18, y: 34 }, parentId: "VPC", data: {} },
  ];
}

describe("applyOverrides", () => {
  it("overrides the position of the node whose id matches", () => {
    const nodes = fixtureNodes();
    const overrides: LayoutOverrides = { Client: { x: 999, y: -50 } };
    const out = applyOverrides(nodes, overrides);
    expect(out.find((n) => n.id === "Client")?.position).toEqual({ x: 999, y: -50 });
    // The pinned marker class is added.
    expect(out.find((n) => n.id === "Client")?.className).toContain(PINNED_CLASS);
  });

  it("applies a child override verbatim (kept in the node's parent-relative frame)", () => {
    const overrides: LayoutOverrides = { API: { x: 5, y: 7 } };
    const out = applyOverrides(fixtureNodes(), overrides);
    const api = out.find((n) => n.id === "API");
    // Position is used as-is (no conversion) and parentId is preserved.
    expect(api?.position).toEqual({ x: 5, y: 7 });
    expect(api?.parentId).toBe("VPC");
  });

  it("ignores override ids with no matching node", () => {
    const out = applyOverrides(fixtureNodes(), { Ghost: { x: 1, y: 2 } });
    expect(out.map((n) => n.position)).toEqual([
      { x: 200, y: 0 },
      { x: 10, y: 20 },
      { x: 18, y: 34 },
    ]);
    expect(out.every((n) => !n.className?.includes(PINNED_CLASS))).toBe(true);
  });

  it("never overrides a group node, even if its id is present", () => {
    const out = applyOverrides(fixtureNodes(), { VPC: { x: 1, y: 1 } });
    const vpc = out.find((n) => n.id === "VPC");
    expect(vpc?.position).toEqual({ x: 200, y: 0 });
    expect(vpc?.className).toBeUndefined();
  });

  it("leaves non-overridden nodes unchanged and does not mutate the input", () => {
    const nodes = fixtureNodes();
    const snapshot = JSON.parse(JSON.stringify(nodes));
    const out = applyOverrides(nodes, { Client: { x: 3, y: 4 } });
    // Input untouched.
    expect(nodes).toEqual(snapshot);
    // The untouched API node keeps its identity.
    expect(out.find((n) => n.id === "API")).toBe(nodes.find((n) => n.id === "API"));
  });

  it("returns positions unchanged for an empty override record", () => {
    const nodes = fixtureNodes();
    const out = applyOverrides(nodes, {});
    expect(out.map((n) => n.position)).toEqual(nodes.map((n) => n.position));
  });
});
