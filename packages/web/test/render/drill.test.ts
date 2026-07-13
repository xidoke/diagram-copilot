import { describe, expect, it } from "vitest";
import type { Node } from "@xyflow/react";
import type { DiagramDoc } from "@diagram-copilot/core";
import {
  DRILL_STORAGE_PREFIX,
  breadcrumbItems,
  drillDoc,
  drillPathTo,
  externalNodeIds,
  loadDrill,
  markExternalNodes,
  saveDrill,
  validateDrillPath,
} from "../../src/render/drill.js";

/**
 * Fixture: client + [vpc: api, worker, [data: db, cache]] + [ops: grafana],
 * with edges into every layer so drilling exercises re-target/keep/drop:
 *   e1 client>api        (root leaf → scope leaf)
 *   e2 api>db            (scope-internal, crosses the data boundary)
 *   e3 worker>cache      (scope-internal)
 *   e4 grafana>api       (sibling group → scope leaf)
 *   e5 grafana>db        (sibling group → nested scope leaf)
 *   e6 client>grafana    (external ↔ external)
 *   e7 client>data       (root leaf → group endpoint)
 */
function fixture(): DiagramDoc {
  return {
    type: "architecture",
    direction: "right",
    nodes: [
      { id: "client", label: "Client" },
      { id: "api", label: "API", groupId: "vpc" },
      { id: "worker", label: "Worker", groupId: "vpc" },
      { id: "db", label: "DB", groupId: "data" },
      { id: "cache", label: "Cache", groupId: "data" },
      { id: "grafana", label: "Grafana", groupId: "ops" },
    ],
    groups: [
      { id: "vpc", label: "VPC", color: "blue" },
      { id: "data", label: "Data", parentId: "vpc", icon: "database" },
      { id: "ops", label: "Ops" },
    ],
    edges: [
      { id: "e1", from: "client", to: "api", label: "https" },
      { id: "e2", from: "api", to: "db", label: "sql" },
      { id: "e3", from: "worker", to: "cache" },
      { id: "e4", from: "grafana", to: "api", label: "scrape" },
      { id: "e5", from: "grafana", to: "db", label: "scrape db" },
      { id: "e6", from: "client", to: "grafana" },
      { id: "e7", from: "client", to: "data", label: "export" },
    ],
  };
}

describe("drillPathTo", () => {
  it("returns the root→group ancestor chain", () => {
    const doc = fixture();
    expect(drillPathTo(doc, "vpc")).toEqual(["vpc"]);
    expect(drillPathTo(doc, "data")).toEqual(["vpc", "data"]);
    expect(drillPathTo(doc, "ops")).toEqual(["ops"]);
  });

  it("returns null for leaf nodes and unknown ids", () => {
    const doc = fixture();
    expect(drillPathTo(doc, "api")).toBeNull();
    expect(drillPathTo(doc, "nope")).toBeNull();
  });
});

describe("validateDrillPath", () => {
  it("keeps a fully valid path (same reference)", () => {
    const doc = fixture();
    const path = ["vpc", "data"];
    expect(validateDrillPath(doc, path)).toBe(path);
  });

  it("truncates at a deleted group (deepest deleted → parent level)", () => {
    const doc = fixture();
    doc.groups = doc.groups.filter((g) => g.id !== "data");
    expect(validateDrillPath(doc, ["vpc", "data"])).toEqual(["vpc"]);
  });

  it("resets to root when the top of the path is gone or not root-level", () => {
    const doc = fixture();
    expect(validateDrillPath(doc, ["gone", "data"])).toEqual([]);
    // "data" is not a root-level group, so a path starting there is invalid.
    expect(validateDrillPath(doc, ["data"])).toEqual([]);
  });

  it("truncates when the parent chain no longer matches", () => {
    const doc = fixture();
    expect(validateDrillPath(doc, ["ops", "data"])).toEqual(["ops"]);
  });

  it("keeps the empty path as-is", () => {
    expect(validateDrillPath(fixture(), [])).toEqual([]);
  });
});

describe("breadcrumbItems", () => {
  it("maps the path to id+label pairs from the doc", () => {
    expect(breadcrumbItems(fixture(), ["vpc", "data"])).toEqual([
      { id: "vpc", label: "VPC" },
      { id: "data", label: "Data" },
    ]);
  });

  it("falls back to the id when a group is missing (defensive)", () => {
    expect(breadcrumbItems(fixture(), ["gone"])).toEqual([{ id: "gone", label: "gone" }]);
  });
});

describe("drillDoc — collapse externals (default)", () => {
  it("is the identity (same reference) at root", () => {
    const doc = fixture();
    const result = drillDoc(doc, []);
    expect(result.doc).toBe(doc);
    expect(result.externalIds.size).toBe(0);
  });

  it("drilling one level keeps the focus interior and collapses sibling groups to context reps", () => {
    const doc = fixture();
    const { doc: out, externalIds } = drillDoc(doc, ["vpc"]);
    // Focus group + its interior groups survive as containers.
    expect(out.groups.map((g) => g.id)).toEqual(["vpc", "data"]);
    expect(out.groups[0].parentId).toBeUndefined();
    // Scope leaves intact; externals = connected context only.
    const ids = out.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["api", "cache", "client", "db", "ops", "worker"]);
    // Sibling group became a representative leaf with the member count.
    const rep = out.nodes.find((n) => n.id === "ops");
    expect(rep!.label).toBe("Ops (1)");
    expect(externalIds).toEqual(new Set(["client", "ops"]));
    // Input doc untouched.
    expect(doc.groups).toHaveLength(3);
    expect(doc.nodes).toHaveLength(6);
  });

  it("re-targets sibling-interior edges to the representative and drops external↔external edges", () => {
    const { doc: out } = drillDoc(fixture(), ["vpc"]);
    expect(out.edges).toEqual([
      { id: "e1", from: "client", to: "api", label: "https" },
      { id: "e2", from: "api", to: "db", label: "sql" },
      { id: "e3", from: "worker", to: "cache" },
      { id: "e4", from: "ops", to: "api", label: "scrape" },
      { id: "e5", from: "ops", to: "db", label: "scrape db" },
      // e6 client>grafana → client>ops is external↔external → dropped.
      { id: "e7", from: "client", to: "data", label: "export" },
    ]);
  });

  it("drilling two levels removes ancestors, roots ancestor-level leaves, keeps only scope-touching edges", () => {
    const { doc: out, externalIds } = drillDoc(fixture(), ["vpc", "data"]);
    // Only the focus group remains as a container, rooted.
    expect(out.groups).toEqual([{ id: "data", label: "Data", icon: "database" }]);
    // api/worker lived directly inside the removed ancestor → rooted externals.
    const api = out.nodes.find((n) => n.id === "api");
    expect(api!.groupId).toBeUndefined();
    // Edges: only those touching the scope (db, cache, data) survive.
    expect(out.edges.map((e) => e.id).sort()).toEqual(["e2", "e3", "e5", "e7"]);
    expect(externalIds).toEqual(new Set(["api", "client", "ops", "worker"]));
  });

  it("drops edges onto a removed ancestor group", () => {
    const doc = fixture();
    doc.edges.push({ id: "e8", from: "grafana", to: "vpc", label: "monitor vpc" });
    const { doc: out } = drillDoc(doc, ["vpc", "data"]);
    expect(out.edges.find((e) => e.id === "e8")).toBeUndefined();
  });

  it("drops external context elements with no edge into the scope", () => {
    const doc = fixture();
    doc.edges = [{ id: "e2", from: "api", to: "db", label: "sql" }];
    const { doc: out, externalIds } = drillDoc(doc, ["vpc"]);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["api", "cache", "db", "worker"]);
    expect(externalIds.size).toBe(0);
  });

  it("dedupes multiple edges into one context rep (collapseDoc reuse)", () => {
    const doc = fixture();
    doc.nodes.push({ id: "loki", label: "Loki", groupId: "ops" });
    doc.edges = [
      { id: "a1", from: "api", to: "grafana" },
      { id: "a2", from: "api", to: "loki" },
    ];
    const { doc: out } = drillDoc(doc, ["vpc"]);
    expect(out.edges).toEqual([{ id: "a1", from: "api", to: "ops", label: "×2" }]);
    expect(out.nodes.find((n) => n.id === "ops")!.label).toBe("Ops (2)");
  });
});

describe("drillDoc — hide externals", () => {
  it("keeps only the focus scope and in-scope edges", () => {
    const { doc: out, externalIds } = drillDoc(fixture(), ["vpc"], "hide");
    expect(out.groups.map((g) => g.id)).toEqual(["vpc", "data"]);
    expect(out.groups[0].parentId).toBeUndefined();
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["api", "cache", "db", "worker"]);
    expect(out.edges.map((e) => e.id)).toEqual(["e2", "e3"]);
    expect(externalIds.size).toBe(0);
  });

  it("drops cross-boundary edges entirely on a deep drill", () => {
    const { doc: out } = drillDoc(fixture(), ["vpc", "data"], "hide");
    expect(out.groups.map((g) => g.id)).toEqual(["data"]);
    expect(out.nodes.map((n) => n.id).sort()).toEqual(["cache", "db"]);
    expect(out.edges).toEqual([]);
  });
});

describe("markExternalNodes / externalNodeIds", () => {
  const flowNodes = [
    { id: "api", data: { label: "API" } },
    { id: "ops", data: { label: "Ops (1)" } },
  ] as unknown as Node[];

  it("flags exactly the external context nodes", () => {
    const marked = markExternalNodes(flowNodes, new Set(["ops"]));
    expect(marked[0]).toBe(flowNodes[0]); // untouched node keeps its reference
    expect(marked[1].data.drillExternal).toBe(true);
    expect(externalNodeIds(marked)).toEqual(new Set(["ops"]));
  });

  it("is the identity when nothing is external", () => {
    expect(markExternalNodes(flowNodes, new Set())).toBe(flowNodes);
    expect(externalNodeIds(flowNodes)).toEqual(new Set());
  });
});

describe("drill persistence (localStorage, per diagram)", () => {
  function mockStorage(initial: Record<string, string> = {}) {
    const map = new Map(Object.entries(initial));
    return {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      dump: () => Object.fromEntries(map),
    };
  }

  it("round-trips a drill path per diagram name", () => {
    const storage = mockStorage();
    saveDrill("shop", ["vpc", "data"], storage);
    expect(loadDrill("shop", storage)).toEqual(["vpc", "data"]);
    expect(loadDrill("other", storage)).toEqual([]);
    expect(Object.keys(storage.dump())).toEqual([`${DRILL_STORAGE_PREFIX}shop`]);
  });

  it("parses malformed or wrong-shaped payloads to the root path", () => {
    const storage = mockStorage({
      [`${DRILL_STORAGE_PREFIX}bad`]: "{not json",
      [`${DRILL_STORAGE_PREFIX}shape`]: JSON.stringify({ a: 1 }),
      [`${DRILL_STORAGE_PREFIX}mixed`]: JSON.stringify(["ok", 7, null]),
    });
    expect(loadDrill("bad", storage)).toEqual([]);
    expect(loadDrill("shape", storage)).toEqual([]);
    // Non-strings poison the whole path (a partial path is a different place).
    expect(loadDrill("mixed", storage)).toEqual([]);
    expect(loadDrill("missing", storage)).toEqual([]);
  });
});
