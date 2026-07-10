import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import type { DiagramDoc } from "@diagram-copilot/core";
import {
  COLLAPSE_STORAGE_PREFIX,
  collapseDoc,
  collapsedNodeIds,
  loadCollapsed,
  markCollapsedNodes,
  pruneCollapsedSizes,
  saveCollapsed,
} from "../../src/render/collapse.js";
import type { SizedOverrides } from "../../src/render/overrides.js";

/**
 * Fixture: client → [vpc: api, [data: db, cache]] with edges into and across
 * the nesting. `data` nests inside `vpc`, so collapsing either exercises the
 * re-target + dedupe paths.
 */
function fixture(): DiagramDoc {
  return {
    type: "architecture",
    direction: "right",
    nodes: [
      { id: "client", label: "Client" },
      { id: "api", label: "API", groupId: "vpc" },
      { id: "db", label: "DB", groupId: "data", icon: "postgresql" },
      { id: "cache", label: "Cache", groupId: "data" },
    ],
    groups: [
      { id: "vpc", label: "VPC", color: "blue" },
      { id: "data", label: "Data", parentId: "vpc", icon: "database" },
    ],
    edges: [
      { id: "e1", from: "client", to: "api", label: "https" },
      { id: "e2", from: "api", to: "db", label: "sql" },
      { id: "e3", from: "api", to: "cache" },
      { id: "e4", from: "client", to: "db", label: "metrics" },
    ],
  };
}

describe("collapseDoc", () => {
  it("is the identity (same references) when nothing is collapsed", () => {
    const doc = fixture();
    const result = collapseDoc(doc, new Set());
    expect(result.doc).toBe(doc);
    expect(result.applied.size).toBe(0);
  });

  it("ignores collapsed ids that are not groups (stale localStorage, node ids)", () => {
    const doc = fixture();
    const result = collapseDoc(doc, new Set(["gone-group", "client"]));
    expect(result.doc).toBe(doc);
    expect(result.applied.size).toBe(0);
  });

  it("replaces a collapsed group with a leaf carrying its label (+member count), icon, color, and parent", () => {
    const doc = fixture();
    const { doc: out, applied } = collapseDoc(doc, new Set(["data"]));
    // The group is gone from `groups`…
    expect(out.groups.map((g) => g.id)).toEqual(["vpc"]);
    // …and stands in `nodes` as a leaf nested where the group was.
    const rep = out.nodes.find((n) => n.id === "data");
    expect(rep).toBeDefined();
    expect(rep!.label).toBe("Data (2)");
    expect(rep!.icon).toBe("database");
    expect(rep!.groupId).toBe("vpc");
    // Members are absorbed.
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["api", "client", "data"]);
    expect(applied.get("data")).toEqual({ members: 2 });
    // Untouched doc fields survive.
    expect(out.type).toBe("architecture");
    expect(out.direction).toBe("right");
    // Input doc is not mutated.
    expect(doc.nodes).toHaveLength(4);
    expect(doc.groups).toHaveLength(2);
  });

  it("omits the member count for an empty collapsed group", () => {
    const doc: DiagramDoc = {
      type: "architecture",
      direction: "right",
      nodes: [],
      groups: [{ id: "g", label: "Empty" }],
      edges: [],
    };
    const { doc: out, applied } = collapseDoc(doc, new Set(["g"]));
    expect(out.nodes[0]).toMatchObject({ id: "g", label: "Empty" });
    expect(out.nodes[0].groupId).toBeUndefined();
    expect(applied.get("g")).toEqual({ members: 0 });
  });

  it("re-targets edges of absorbed members to the representative and dedupes them", () => {
    const { doc: out } = collapseDoc(fixture(), new Set(["data"]));
    // e1 is untouched. e2 (api>db) + e3 (api>cache) both map to api>data →
    // ONE aggregated edge keeping the first id; both share one distinct label
    // ("sql"), so it reads "sql ×2". e4 (client>db) maps alone to client>data.
    expect(out.edges).toEqual([
      { id: "e1", from: "client", to: "api", label: "https" },
      { id: "e2", from: "api", to: "data", label: "sql ×2" },
      { id: "e4", from: "client", to: "data", label: "metrics" },
    ]);
  });

  it("drops edges that become self-loops (both endpoints inside the collapsed group)", () => {
    const doc = fixture();
    doc.edges.push({ id: "e5", from: "db", to: "cache", label: "replicate" });
    const { doc: out } = collapseDoc(doc, new Set(["data"]));
    expect(out.edges.find((e) => e.id === "e5")).toBeUndefined();
  });

  it("drops an edge from a collapsed group to its own descendant (group endpoint)", () => {
    const doc = fixture();
    doc.edges.push({ id: "e5", from: "data", to: "db" });
    const { doc: out } = collapseDoc(doc, new Set(["data"]));
    expect(out.edges.find((e) => e.id === "e5")).toBeUndefined();
  });

  it("merges a pre-existing edge onto the group with re-targeted member edges", () => {
    const doc = fixture();
    // client already points at the group itself; collapsing `data` folds the
    // client>db edge into the same pair.
    doc.edges.push({ id: "e5", from: "client", to: "data", label: "metrics" });
    const { doc: out } = collapseDoc(doc, new Set(["data"]));
    const merged = out.edges.filter((e) => e.from === "client" && e.to === "data");
    expect(merged).toHaveLength(1);
    expect(merged[0].label).toBe("metrics ×2");
  });

  it("labels an aggregate ×N when merged edges disagree (or have no labels)", () => {
    const { doc: out } = collapseDoc(fixture(), new Set(["vpc"]));
    // e1 (client>api "https") + e4 (client>db "metrics") → client>vpc ×2.
    expect(out.edges).toEqual([{ id: "e1", from: "client", to: "vpc", label: "×2" }]);

    const unlabeled = fixture();
    unlabeled.edges = [
      { id: "u1", from: "client", to: "db" },
      { id: "u2", from: "client", to: "cache" },
    ];
    const merged = collapseDoc(unlabeled, new Set(["data"])).doc.edges;
    expect(merged).toEqual([{ id: "u1", from: "client", to: "data", label: "×2" }]);
  });

  it("keeps edge direction distinct while deduping (a>member vs member>a)", () => {
    const doc = fixture();
    doc.edges = [
      { id: "in", from: "client", to: "db" },
      { id: "out", from: "cache", to: "client" },
    ];
    const { doc: out } = collapseDoc(doc, new Set(["data"]));
    expect(out.edges).toEqual([
      { id: "in", from: "client", to: "data" },
      { id: "out", from: "data", to: "client" },
    ]);
  });

  it("leaves duplicate edges alone when no endpoint was re-targeted", () => {
    const doc = fixture();
    doc.edges = [
      { id: "d1", from: "client", to: "api" },
      { id: "d2", from: "client", to: "api" },
    ];
    const { doc: out } = collapseDoc(doc, new Set(["data"]));
    expect(out.edges.map((e) => e.id)).toEqual(["d1", "d2"]);
  });

  it("absorbs nested groups (and their members) into the outermost collapsed ancestor", () => {
    const { doc: out, applied } = collapseDoc(fixture(), new Set(["vpc"]));
    expect(out.groups).toEqual([]);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["client", "vpc"]);
    const rep = out.nodes.find((n) => n.id === "vpc")!;
    expect(rep.label).toBe("VPC (3)"); // api + db + cache
    expect(rep.color).toBe("blue");
    expect(rep.groupId).toBeUndefined(); // root group → root leaf
    expect(applied.size).toBe(1);
  });

  it("applies only the outermost group when nested groups are both collapsed", () => {
    const { doc: out, applied } = collapseDoc(fixture(), new Set(["vpc", "data"]));
    expect(applied.size).toBe(1);
    expect(applied.has("vpc")).toBe(true);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["client", "vpc"]);
    // Expanding the outer group later re-applies the inner one on its own.
    const inner = collapseDoc(fixture(), new Set(["data"]));
    expect(inner.applied.has("data")).toBe(true);
  });
});

describe("markCollapsedNodes / collapsedNodeIds", () => {
  const flowNodes = [
    { id: "client", data: { label: "Client" } },
    { id: "data", data: { label: "Data (2)" } },
  ] as unknown as Node[];

  it("flags exactly the representative nodes with data.collapsed", () => {
    const applied = new Map([["data", { members: 2 }]]);
    const marked = markCollapsedNodes(flowNodes, applied);
    expect(marked[0]).toBe(flowNodes[0]); // untouched node keeps its reference
    expect(marked[1].data.collapsed).toBe(true);
    expect(collapsedNodeIds(marked)).toEqual(new Set(["data"]));
  });

  it("is the identity when nothing is collapsed", () => {
    expect(markCollapsedNodes(flowNodes, new Map())).toBe(flowNodes);
    expect(collapsedNodeIds(flowNodes)).toEqual(new Set());
  });
});

describe("pruneCollapsedSizes", () => {
  it("strips a collapsed group's size override but keeps its position", () => {
    const overrides: SizedOverrides = {
      data: { x: 10, y: 20, width: 400, height: 300 },
      client: { x: 1, y: 2 },
    };
    const pruned = pruneCollapsedSizes(overrides, new Set(["data"]));
    expect(pruned.data).toEqual({ x: 10, y: 20 });
    expect(pruned.client).toBe(overrides.client);
    // Input untouched.
    expect(overrides.data.width).toBe(400);
  });

  it("returns the same reference when there is nothing to strip", () => {
    const overrides: SizedOverrides = { client: { x: 1, y: 2 } };
    expect(pruneCollapsedSizes(overrides, new Set(["client"]))).toBe(overrides);
    expect(pruneCollapsedSizes(overrides, new Set())).toBe(overrides);
  });
});

describe("collapse persistence (localStorage sidecar-free, DGC-67)", () => {
  function mockStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      dump: () => Object.fromEntries(map),
    };
  }

  it("round-trips a set of collapsed group ids per diagram name", () => {
    const storage = mockStorage();
    saveCollapsed("shop", new Set(["vpc", "data"]), storage);
    expect(loadCollapsed("shop", storage)).toEqual(new Set(["vpc", "data"]));
    // Keyed per diagram: another name is untouched.
    expect(loadCollapsed("other", storage)).toEqual(new Set());
    expect(Object.keys(storage.dump())).toEqual([`${COLLAPSE_STORAGE_PREFIX}shop`]);
  });

  it("parses malformed or wrong-shaped payloads to an empty set", () => {
    const storage = mockStorage({
      [`${COLLAPSE_STORAGE_PREFIX}bad`]: "{not json",
      [`${COLLAPSE_STORAGE_PREFIX}shape`]: JSON.stringify({ a: 1 }),
      [`${COLLAPSE_STORAGE_PREFIX}mixed`]: JSON.stringify(["ok", 7, null]),
    });
    expect(loadCollapsed("bad", storage)).toEqual(new Set());
    expect(loadCollapsed("shape", storage)).toEqual(new Set());
    // Non-strings are dropped, strings survive.
    expect(loadCollapsed("mixed", storage)).toEqual(new Set(["ok"]));
    expect(loadCollapsed("missing", storage)).toEqual(new Set());
  });
});
