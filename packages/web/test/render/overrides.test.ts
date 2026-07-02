import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import type { LayoutOverrides } from "@diagram-copilot/core";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE } from "../../src/render/toFlow.js";
import { applyOverrides, markDirtyEdges, PINNED_CLASS } from "../../src/render/overrides.js";

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

  it("overrides a group node too (DGC-71 — groups drag by their title band)", () => {
    const out = applyOverrides(fixtureNodes(), { VPC: { x: 1, y: 1 } });
    const vpc = out.find((n) => n.id === "VPC");
    expect(vpc?.position).toEqual({ x: 1, y: 1 });
    expect(vpc?.className).toContain(PINNED_CLASS);
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

/** Minimal elk edges mirroring what `toFlow` produces (no dirty flag yet). */
function fixtureEdges(): Edge[] {
  return [
    { id: "e1", source: "Client", target: "API", data: { sections: [] } },
    { id: "e2", source: "API", target: "DB", data: { sections: [] } },
  ];
}

describe("markDirtyEdges (DGC-69)", () => {
  it("flags an edge whose SOURCE has an override", () => {
    const out = markDirtyEdges(fixtureEdges(), { Client: { x: 1, y: 2 } });
    expect(out[0].data?.dirtyEndpoints).toBe(true);
    expect(Boolean(out[1].data?.dirtyEndpoints)).toBe(false);
  });

  it("flags an edge whose TARGET has an override", () => {
    const out = markDirtyEdges(fixtureEdges(), { DB: { x: 1, y: 2 } });
    expect(Boolean(out[0].data?.dirtyEndpoints)).toBe(false);
    expect(out[1].data?.dirtyEndpoints).toBe(true);
  });

  it("flags both edges touching an overridden shared endpoint", () => {
    const out = markDirtyEdges(fixtureEdges(), { API: { x: 1, y: 2 } });
    expect(out[0].data?.dirtyEndpoints).toBe(true);
    expect(out[1].data?.dirtyEndpoints).toBe(true);
  });

  it("clears the flag once the overrides are gone (reset layout)", () => {
    const dirty = markDirtyEdges(fixtureEdges(), { API: { x: 1, y: 2 } });
    const clean = markDirtyEdges(dirty, {});
    expect(clean.every((e) => e.data?.dirtyEndpoints === false)).toBe(true);
  });

  it("keeps edge identity when the flag already matches, and never mutates", () => {
    const edges = fixtureEdges();
    const snapshot = JSON.parse(JSON.stringify(edges));
    const out = markDirtyEdges(edges, {});
    expect(out[0]).toBe(edges[0]); // unflagged → unchanged object
    expect(out[1]).toBe(edges[1]);
    markDirtyEdges(edges, { API: { x: 1, y: 2 } });
    expect(edges).toEqual(snapshot); // input untouched
  });

  it("preserves the rest of the edge data when flagging", () => {
    const edges: Edge[] = [
      {
        id: "e1",
        source: "a",
        target: "b",
        data: { sections: [{ startPoint: { x: 0, y: 0 }, endPoint: { x: 1, y: 1 } }], labelPos: { x: 5, y: 6 } },
      },
    ];
    const out = markDirtyEdges(edges, { a: { x: 9, y: 9 } });
    expect(out[0].data).toMatchObject({
      dirtyEndpoints: true,
      labelPos: { x: 5, y: 6 },
    });
    expect(out[0].data?.sections).toEqual(edges[0].data?.sections);
  });
});

describe("markDirtyEdges — ancestor (group) case (DGC-71)", () => {
  // Outer group ▸ Mid group ▸ DB leaf; Ext/Ext2 are root leaves outside Outer.
  const nodes: Node[] = [
    { id: "Outer", type: ARCH_GROUP_TYPE, position: { x: 0, y: 0 }, data: {} },
    { id: "Mid", type: ARCH_GROUP_TYPE, position: { x: 10, y: 10 }, parentId: "Outer", data: {} },
    { id: "DB", type: ARCH_NODE_TYPE, position: { x: 5, y: 40 }, parentId: "Mid", data: {} },
    { id: "Ext", type: ARCH_NODE_TYPE, position: { x: 500, y: 0 }, data: {} },
  ];
  const edges = (): Edge[] => [
    { id: "cross", source: "Ext", target: "DB", data: { sections: [] } },
    { id: "far", source: "Ext", target: "Ext2", data: { sections: [] } },
  ];
  const dirtyOf = (out: Edge[], id: string) =>
    Boolean(out.find((e) => e.id === id)?.data?.dirtyEndpoints);

  it("flags a boundary-crossing edge when a grand-ancestor group is dragged", () => {
    const out = markDirtyEdges(edges(), { Outer: { x: 9, y: 9 } }, nodes);
    // DB is Outer ▸ Mid ▸ DB, so the Ext→DB edge's ELK route is stale.
    expect(dirtyOf(out, "cross")).toBe(true);
    // The Ext→Ext2 edge touches nothing under Outer → stays clean.
    expect(dirtyOf(out, "far")).toBe(false);
  });

  it("also flags when the intermediate (Mid) group is the one dragged", () => {
    const out = markDirtyEdges(edges(), { Mid: { x: 9, y: 9 } }, nodes);
    expect(dirtyOf(out, "cross")).toBe(true);
  });

  it("without a nodes arg, ancestry is ignored (endpoint-only, back-compat)", () => {
    const out = markDirtyEdges(edges(), { Outer: { x: 9, y: 9 } });
    expect(dirtyOf(out, "cross")).toBe(false);
  });
});
