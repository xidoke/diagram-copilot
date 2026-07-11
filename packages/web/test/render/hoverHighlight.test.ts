import { describe, expect, it } from "vitest";
import type { Edge } from "@xyflow/react";
import {
  applyHoverToEdges,
  edgeLabelIdFromEventTarget,
  type HoverTarget,
} from "../../src/render/hoverHighlight.js";

const edges: Edge[] = [
  { id: "e1", source: "a", target: "b", data: { sections: [] } },
  { id: "e2", source: "b", target: "c", data: { sections: [] } },
  { id: "e3", source: "c", target: "d" },
];

describe("applyHoverToEdges — hover → highlighted-edge map (DGC-100)", () => {
  it("returns the SAME array when nothing is hovered", () => {
    expect(applyHoverToEdges(edges, null)).toBe(edges);
  });

  it("flags exactly the hovered edge (label/line hover)", () => {
    const out = applyHoverToEdges(edges, { kind: "edge", id: "e2" });
    expect(out[0]).toBe(edges[0]); // untouched edges keep identity (memo-friendly)
    expect(out[1]!.data?.highlighted).toBe(true);
    expect(out[2]).toBe(edges[2]);
  });

  it("flags every edge touching a hovered node, as source or target", () => {
    const out = applyHoverToEdges(edges, { kind: "node", id: "b" });
    expect(out[0]!.data?.highlighted).toBe(true); // a → b
    expect(out[1]!.data?.highlighted).toBe(true); // b → c
    expect(out[2]).toBe(edges[2]); // c → d untouched
  });

  it("works for group endpoints too (groups are nodes to React Flow)", () => {
    const groupEdges: Edge[] = [{ id: "g1", source: "api", target: "vpc" }];
    const out = applyHoverToEdges(groupEdges, { kind: "node", id: "vpc" });
    expect(out[0]!.data?.highlighted).toBe(true);
  });

  it("returns the same array when the hover matches nothing", () => {
    expect(applyHoverToEdges(edges, { kind: "node", id: "zz" })).toBe(edges);
  });

  it("never mutates the input edges", () => {
    const before = JSON.stringify(edges);
    applyHoverToEdges(edges, { kind: "node", id: "b" });
    expect(JSON.stringify(edges)).toBe(before);
  });

  it("preserves existing data (sections etc.) on flagged edges", () => {
    const out = applyHoverToEdges(edges, { kind: "edge", id: "e1" });
    expect(out[0]!.data?.sections).toEqual([]);
  });
});

describe("edgeLabelIdFromEventTarget — label hover delegation (DGC-100)", () => {
  /** Minimal stand-in for a DOM element inside an `.elk-edge-label`. */
  const fakeTarget = (edgeId: string | null) => ({
    closest: (sel: string) =>
      sel === ".elk-edge-label" && edgeId !== null
        ? { getAttribute: (name: string) => (name === "data-edge-id" ? edgeId : null) }
        : null,
  });

  it("resolves the edge id from a hovered label (or its descendants)", () => {
    expect(edgeLabelIdFromEventTarget(fakeTarget("e7"))).toBe("e7");
  });

  it("returns null outside any edge label", () => {
    expect(edgeLabelIdFromEventTarget(fakeTarget(null))).toBeNull();
  });

  it("tolerates non-element targets (window, text nodes, null)", () => {
    expect(edgeLabelIdFromEventTarget(null)).toBeNull();
    expect(edgeLabelIdFromEventTarget(undefined)).toBeNull();
    expect(edgeLabelIdFromEventTarget({})).toBeNull();
    expect(edgeLabelIdFromEventTarget("text")).toBeNull();
  });

  const hover: HoverTarget = { kind: "edge", id: "x" };
  it("HoverTarget shape is exported for App state", () => {
    expect(hover.kind).toBe("edge");
  });
});
