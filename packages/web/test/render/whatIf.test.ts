import { describe, expect, it } from "vitest";
import type { Edge, Node } from "@xyflow/react";
import type { DiagramDoc, DiagramEdge, DiagramNode } from "@diagram-copilot/core";
import {
  WHATIF_DEAD_CLASS,
  WHATIF_ISOLATED_CLASS,
  applyKill,
  applyKillToEdges,
  applyKillToNodes,
} from "../../src/render/whatIf.js";

/** Minimal doc builder — nodes by id, edges as `[id, from, to]` triples. */
function doc(nodeIds: string[], edges: [string, string, string][], groups: DiagramDoc["groups"] = []): DiagramDoc {
  return {
    type: "architecture",
    direction: "right",
    nodes: nodeIds.map((id): DiagramNode => ({ id, label: id.toUpperCase() })),
    groups,
    edges: edges.map(([id, from, to]): DiagramEdge => ({ id, from, to })),
  };
}

describe("applyKill — dead marking", () => {
  it("marks the killed node and every edge touching it", () => {
    const d = doc(["a", "b", "c"], [["e1", "a", "b"], ["e2", "b", "c"]]);
    const r = applyKill(d, new Set(["b"]));
    expect([...r.deadNodes]).toEqual(["b"]);
    expect(r.deadEdges).toEqual(new Set(["e1", "e2"]));
  });

  it("ignores dead ids that do not exist in this doc (stale toggles)", () => {
    const d = doc(["a", "b"], [["e1", "a", "b"]]);
    const r = applyKill(d, new Set(["ghost"]));
    expect(r.deadNodes.size).toBe(0);
    expect(r.deadEdges.size).toBe(0);
    expect(r.isolatedNodes.size).toBe(0);
  });

  it("returns empty sets for an empty dead set", () => {
    const d = doc(["a", "b"], [["e1", "a", "b"]]);
    const r = applyKill(d, new Set());
    expect(r.deadNodes.size).toBe(0);
    expect(r.deadEdges.size).toBe(0);
    expect(r.isolatedNodes.size).toBe(0);
  });
});

describe("applyKill — isolation (BFS from sources)", () => {
  it("chain: killing the middle node isolates everything downstream", () => {
    // a → b → c → d ; a is the only source.
    const d = doc(["a", "b", "c", "d"], [
      ["e1", "a", "b"],
      ["e2", "b", "c"],
      ["e3", "c", "d"],
    ]);
    const r = applyKill(d, new Set(["b"]));
    expect(r.isolatedNodes).toEqual(new Set(["c", "d"]));
  });

  it("keeps nodes reachable through a redundant path alive", () => {
    // a → b → d and a → c → d ; killing b leaves d reachable via c.
    const d = doc(["a", "b", "c", "d"], [
      ["e1", "a", "b"],
      ["e2", "a", "c"],
      ["e3", "b", "d"],
      ["e4", "c", "d"],
    ]);
    const r = applyKill(d, new Set(["b"]));
    expect(r.isolatedNodes.size).toBe(0);
    expect(r.deadEdges).toEqual(new Set(["e1", "e3"]));
  });

  it("fan-out: killing the hub isolates all its exclusive consumers", () => {
    // s → hub → {x, y, z}
    const d = doc(["s", "hub", "x", "y", "z"], [
      ["e1", "s", "hub"],
      ["e2", "hub", "x"],
      ["e3", "hub", "y"],
      ["e4", "hub", "z"],
    ]);
    const r = applyKill(d, new Set(["hub"]));
    expect(r.isolatedNodes).toEqual(new Set(["x", "y", "z"]));
  });

  it("node between two groups: killing the bridge isolates the far group's leaf", () => {
    // client → api (g1) → bridge → db (g2); groups are containers only.
    const d = doc(
      ["client", "api", "bridge", "db"],
      [
        ["e1", "client", "api"],
        ["e2", "api", "bridge"],
        ["e3", "bridge", "db"],
      ],
      [
        { id: "g1", label: "G1" },
        { id: "g2", label: "G2" },
      ],
    );
    d.nodes = d.nodes.map((n) =>
      n.id === "api" ? { ...n, groupId: "g1" } : n.id === "db" ? { ...n, groupId: "g2" } : n,
    );
    const r = applyKill(d, new Set(["bridge"]));
    expect(r.isolatedNodes).toEqual(new Set(["db"]));
    // Container groups with no edges are never marked isolated.
    expect(r.isolatedNodes.has("g1")).toBe(false);
    expect(r.isolatedNodes.has("g2")).toBe(false);
  });

  it("treats a group edge-endpoint as a plain vertex (no containment propagation)", () => {
    // a → g (a group with a member m). Killing a isolates the group vertex,
    // but NOT its member — membership is not an edge.
    const d = doc(
      ["src", "a", "m"],
      [
        ["e1", "src", "a"],
        ["e2", "a", "g"],
      ],
      [{ id: "g", label: "G" }],
    );
    d.nodes = d.nodes.map((n) => (n.id === "m" ? { ...n, groupId: "g" } : n));
    const r = applyKill(d, new Set(["a"]));
    expect(r.isolatedNodes).toEqual(new Set(["g"]));
  });

  it("kill two nodes at once: unions dead edges and isolates across both", () => {
    // s → a → x ; s → b → y ; kill a AND b → x and y isolated.
    const d = doc(["s", "a", "b", "x", "y"], [
      ["e1", "s", "a"],
      ["e2", "s", "b"],
      ["e3", "a", "x"],
      ["e4", "b", "y"],
    ]);
    const r = applyKill(d, new Set(["a", "b"]));
    expect(r.deadNodes).toEqual(new Set(["a", "b"]));
    expect(r.deadEdges).toEqual(new Set(["e1", "e2", "e3", "e4"]));
    expect(r.isolatedNodes).toEqual(new Set(["x", "y"]));
  });

  it("graph with no sources (cycle): only dead is marked, nothing isolated", () => {
    // a → b → a — every vertex has inbound, so there is no traffic origin to
    // reason from; the documented fallback marks dead only.
    const d = doc(["a", "b"], [["e1", "a", "b"], ["e2", "b", "a"]]);
    const r = applyKill(d, new Set(["a"]));
    expect(r.deadNodes).toEqual(new Set(["a"]));
    expect(r.deadEdges).toEqual(new Set(["e1", "e2"]));
    expect(r.isolatedNodes.size).toBe(0);
  });

  it("nodes already unreachable before the kill are not blamed on it", () => {
    // Main flow s → a; detached cycle x ⇄ y was never reachable from a source
    // — killing a must not paint the cycle orange.
    const d = doc(["s", "a", "x", "y"], [
      ["e1", "s", "a"],
      ["e2", "x", "y"],
      ["e3", "y", "x"],
    ]);
    const r = applyKill(d, new Set(["a"]));
    expect(r.isolatedNodes.size).toBe(0);
  });

  it("a standalone node (no edges) is never isolated", () => {
    const d = doc(["s", "a", "lone"], [["e1", "s", "a"]]);
    const r = applyKill(d, new Set(["a"]));
    expect(r.isolatedNodes.has("lone")).toBe(false);
  });

  it("killing a source isolates its whole exclusive downstream", () => {
    // client → cdn → lb; kill cdn → lb isolated (client still alive).
    const d = doc(["client", "cdn", "lb"], [
      ["e1", "client", "cdn"],
      ["e2", "cdn", "lb"],
    ]);
    const r = applyKill(d, new Set(["cdn"]));
    expect(r.isolatedNodes).toEqual(new Set(["lb"]));
  });

  it("a dead source stops seeding reachability", () => {
    // Kill the only source itself → everything downstream is isolated.
    const d = doc(["s", "a", "b"], [["e1", "s", "a"], ["e2", "a", "b"]]);
    const r = applyKill(d, new Set(["s"]));
    expect(r.isolatedNodes).toEqual(new Set(["a", "b"]));
  });
});

describe("applyKillToNodes / applyKillToEdges", () => {
  const flowNodes: Node[] = [
    { id: "a", position: { x: 0, y: 0 }, data: {} },
    { id: "b", position: { x: 0, y: 0 }, data: {}, className: "existing" },
    { id: "c", position: { x: 0, y: 0 }, data: {} },
  ];
  const flowEdges: Edge[] = [
    { id: "e1", source: "a", target: "b" },
    { id: "e2", source: "b", target: "c", className: "existing" },
  ];

  it("null overlay returns the input arrays untouched (same reference)", () => {
    expect(applyKillToNodes(flowNodes, null)).toBe(flowNodes);
    expect(applyKillToEdges(flowEdges, null)).toBe(flowEdges);
  });

  it("stamps dead/isolated classes, preserving existing classNames", () => {
    const kill = {
      deadNodes: new Set(["b"]),
      deadEdges: new Set(["e1", "e2"]),
      isolatedNodes: new Set(["c"]),
    };
    const nodes = applyKillToNodes(flowNodes, kill);
    expect(nodes[0].className).toBeUndefined();
    expect(nodes[0]).toBe(flowNodes[0]); // untouched keeps identity
    expect(nodes[1].className).toBe(`existing ${WHATIF_DEAD_CLASS}`);
    expect(nodes[2].className).toBe(WHATIF_ISOLATED_CLASS);

    const edges = applyKillToEdges(flowEdges, kill);
    expect(edges[0].className).toBe(WHATIF_DEAD_CLASS);
    expect(edges[1].className).toBe(`existing ${WHATIF_DEAD_CLASS}`);
  });
});
