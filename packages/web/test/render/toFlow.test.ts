import { describe, expect, it } from "vitest";
import type { DiagramDoc } from "@diagram-copilot/core";
import type { PositionedGraph } from "@diagram-copilot/layout";
import { ELK_EDGE_TYPE } from "../../src/render/ElkEdge.js";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE, toFlow } from "../../src/render/toFlow.js";

const doc: DiagramDoc = {
  type: "architecture",
  direction: "right",
  nodes: [
    { id: "Client", label: "Client" },
    { id: "API", label: "API", groupId: "VPC", icon: "server", color: "orange" },
  ],
  groups: [{ id: "VPC", label: "VPC", color: "blue" }],
  edges: [{ id: "e1", from: "Client", to: "API", label: "https" }],
};

const graph: PositionedGraph = {
  nodes: [
    { id: "Client", x: 10, y: 20, width: 120, height: 48 },
    { id: "API", x: 18, y: 34, width: 120, height: 48, parentId: "VPC" },
  ],
  groups: [{ id: "VPC", x: 200, y: 0, width: 180, height: 120 }],
  edges: [
    {
      id: "e1",
      from: "Client",
      to: "API",
      label: "https",
      sections: [{ startPoint: { x: 130, y: 44 }, endPoint: { x: 218, y: 58 } }],
    },
  ],
  width: 400,
  height: 140,
};

describe("toFlow", () => {
  it("emits groups before leaves, with parentId/extent for children", () => {
    const { nodes } = toFlow(doc, graph);
    expect(nodes.map((n) => n.type)).toEqual([ARCH_GROUP_TYPE, ARCH_NODE_TYPE, ARCH_NODE_TYPE]);
    const api = nodes.find((n) => n.id === "API");
    expect(api?.parentId).toBe("VPC");
    expect(api?.extent).toBe("parent");
    const client = nodes.find((n) => n.id === "Client");
    expect(client?.parentId).toBeUndefined();
  });

  it("carries labels from the doc and sizes from layout", () => {
    const { nodes } = toFlow(doc, graph);
    const vpc = nodes.find((n) => n.id === "VPC");
    expect(vpc?.data.label).toBe("VPC");
    expect(vpc?.style).toMatchObject({ width: 180, height: 120 });
  });

  it("maps edges with labels", () => {
    const { edges } = toFlow(doc, graph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "Client", target: "API", label: "https" });
  });

  it("carries icon and color from a node onto its ArchNodeData", () => {
    const { nodes } = toFlow(doc, graph);
    const api = nodes.find((n) => n.id === "API");
    expect(api?.data).toMatchObject({ icon: "server", color: "orange" });
  });

  it("carries color from a group onto its ArchNodeData, without an icon key when unset", () => {
    const { nodes } = toFlow(doc, graph);
    const vpc = nodes.find((n) => n.id === "VPC");
    expect(vpc?.data).toMatchObject({ color: "blue" });
    expect(vpc?.data.icon).toBeUndefined();
  });

  it("omits icon/color entirely for nodes that don't set them", () => {
    const { nodes } = toFlow(doc, graph);
    const client = nodes.find((n) => n.id === "Client");
    expect(client?.data.icon).toBeUndefined();
    expect(client?.data.color).toBeUndefined();
    expect("icon" in (client?.data ?? {})).toBe(false);
    expect("color" in (client?.data ?? {})).toBe(false);
  });

  it("tags the group with depth 0 (root)", () => {
    const { nodes } = toFlow(doc, graph);
    const vpc = nodes.find((n) => n.id === "VPC");
    expect(vpc?.data.depth).toBe(0);
  });
});

describe("toFlow — nested group depth", () => {
  const nestedDoc: DiagramDoc = {
    type: "architecture",
    direction: "right",
    nodes: [{ id: "DB", label: "DB", groupId: "Inner" }],
    groups: [
      { id: "Outer", label: "Outer" },
      { id: "Mid", label: "Mid", parentId: "Outer" },
      { id: "Inner", label: "Inner", parentId: "Mid" },
    ],
    edges: [],
  };

  const nestedGraph: PositionedGraph = {
    nodes: [{ id: "DB", x: 8, y: 8, width: 120, height: 48, parentId: "Inner" }],
    groups: [
      { id: "Outer", x: 0, y: 0, width: 300, height: 220 },
      { id: "Mid", x: 20, y: 20, width: 240, height: 160, parentId: "Outer" },
      { id: "Inner", x: 20, y: 20, width: 180, height: 100, parentId: "Mid" },
    ],
    edges: [],
    width: 300,
    height: 220,
  };

  it("computes depth along the parentId chain (0/1/2)", () => {
    const { nodes } = toFlow(nestedDoc, nestedGraph);
    const depthOf = (id: string) => nodes.find((n) => n.id === id)?.data.depth;
    expect(depthOf("Outer")).toBe(0);
    expect(depthOf("Mid")).toBe(1);
    expect(depthOf("Inner")).toBe(2);
  });
});

describe("toFlow — edge targeting a group", () => {
  const groupEdgeDoc: DiagramDoc = {
    type: "architecture",
    direction: "right",
    nodes: [{ id: "API", label: "API" }],
    groups: [{ id: "VPC", label: "VPC" }],
    // `API > VPC` — grammar (T9) allows an edge to terminate on a group id.
    edges: [{ id: "e1", from: "API", to: "VPC" }],
  };

  const groupEdgeGraph: PositionedGraph = {
    nodes: [{ id: "API", x: 0, y: 0, width: 120, height: 48 }],
    groups: [{ id: "VPC", x: 200, y: 0, width: 180, height: 120 }],
    edges: [
      {
        id: "e1",
        from: "API",
        to: "VPC",
        sections: [{ startPoint: { x: 120, y: 24 }, endPoint: { x: 200, y: 60 } }],
      },
    ],
    width: 380,
    height: 120,
  };

  it("preserves source/target when an edge points at a group", () => {
    const { edges } = toFlow(groupEdgeDoc, groupEdgeGraph);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ id: "e1", source: "API", target: "VPC" });
  });
});

describe("toFlow — ELK bend-point edges (T15)", () => {
  it("emits the elk edge type with the routed sections in data", () => {
    const { edges } = toFlow(doc, graph);
    expect(edges[0].type).toBe(ELK_EDGE_TYPE);
    expect(edges[0].data?.sections).toEqual(graph.edges[0].sections);
  });

  it("passes root-container sections through untouched even when the target node is parent-relative", () => {
    // Client (root) → API (inside VPC): the ELK container is the root (LCA of
    // the endpoints), so the sections are already absolute (end 218 = 200 +
    // 18) and must NOT be re-offset — React Flow draws custom edge paths in
    // the root flow coordinate space, while the node keeps its parent-
    // relative position.
    const { nodes, edges } = toFlow(doc, graph);
    const api = nodes.find((n) => n.id === "API");
    expect(api?.position).toEqual({ x: 18, y: 34 }); // relative to VPC at (200, 0)
    expect(edges[0].data?.sections).toEqual([
      { startPoint: { x: 130, y: 44 }, endPoint: { x: 218, y: 58 } },
    ]);
  });

  it("keeps bendPoints intact on the edge data", () => {
    const bentGraph: PositionedGraph = {
      ...graph,
      edges: [
        {
          id: "e1",
          from: "Client",
          to: "API",
          sections: [
            {
              startPoint: { x: 130, y: 44 },
              endPoint: { x: 218, y: 58 },
              bendPoints: [
                { x: 170, y: 44 },
                { x: 170, y: 58 },
              ],
            },
          ],
        },
      ],
    };
    const { edges } = toFlow(doc, bentGraph);
    expect((edges[0].data?.sections as any)[0].bendPoints).toEqual([
      { x: 170, y: 44 },
      { x: 170, y: 58 },
    ]);
  });
});

describe("toFlow — lifting ELK container-relative sections to absolute", () => {
  // ELK emits edge sections relative to the endpoints' lowest common
  // ancestor (a group endpoint counting as its own ancestor); layout passes
  // them through un-normalized, so toFlow must lift them by the container's
  // absolute origin. Fixture: VPC at (100, 50) containing "Data tier" at
  // (30, 40), i.e. Data tier's absolute origin is (130, 90).
  const liftDoc: DiagramDoc = {
    type: "architecture",
    direction: "right",
    nodes: [
      { id: "Client", label: "Client" },
      { id: "API", label: "API", groupId: "VPC" },
      { id: "DB", label: "DB", groupId: "Data" },
      { id: "Cache", label: "Cache", groupId: "Data" },
    ],
    groups: [
      { id: "VPC", label: "VPC" },
      { id: "Data", label: "Data tier", parentId: "VPC" },
    ],
    edges: [
      { id: "inVpc", from: "API", to: "DB" },
      { id: "inData", from: "DB", to: "Cache" },
      { id: "toGroup", from: "API", to: "VPC" },
    ],
  };

  const liftGraph: PositionedGraph = {
    nodes: [
      { id: "Client", x: 0, y: 60, width: 120, height: 48 },
      { id: "API", x: 10, y: 10, width: 120, height: 48, parentId: "VPC" },
      { id: "DB", x: 8, y: 8, width: 100, height: 48, parentId: "Data" },
      { id: "Cache", x: 8, y: 70, width: 100, height: 48, parentId: "Data" },
    ],
    groups: [
      { id: "VPC", x: 100, y: 50, width: 300, height: 200 },
      { id: "Data", x: 30, y: 40, width: 160, height: 140, parentId: "VPC" },
    ],
    edges: [
      {
        id: "inVpc",
        from: "API",
        to: "DB",
        // VPC-relative (ELK container = VPC, the endpoints' LCA).
        sections: [
          { startPoint: { x: 130, y: 34 }, endPoint: { x: 38, y: 48 }, bendPoints: [{ x: 135, y: 34 }] },
        ],
      },
      {
        id: "inData",
        from: "DB",
        to: "Cache",
        // Data-tier-relative (both endpoints inside the nested group).
        sections: [{ startPoint: { x: 58, y: 56 }, endPoint: { x: 58, y: 70 } }],
      },
      {
        id: "toGroup",
        from: "API",
        to: "VPC",
        // A group↔descendant edge is contained in the group itself → VPC-relative.
        sections: [{ startPoint: { x: 130, y: 34 }, endPoint: { x: 300, y: 100 } }],
      },
    ],
    width: 500,
    height: 300,
  };

  const sectionsOf = (id: string) =>
    toFlow(liftDoc, liftGraph).edges.find((e) => e.id === id)?.data?.sections as any;

  it("lifts an intra-group edge by the group's absolute origin (incl. bendPoints)", () => {
    expect(sectionsOf("inVpc")).toEqual([
      {
        startPoint: { x: 230, y: 84 }, // +(100, 50)
        endPoint: { x: 138, y: 98 },
        bendPoints: [{ x: 235, y: 84 }],
      },
    ]);
  });

  it("lifts a nested-group edge by the accumulated ancestor origin", () => {
    expect(sectionsOf("inData")).toEqual([
      { startPoint: { x: 188, y: 146 }, endPoint: { x: 188, y: 160 } }, // +(130, 90)
    ]);
  });

  it("treats a group endpoint as its own container (group↔descendant edge)", () => {
    expect(sectionsOf("toGroup")).toEqual([
      { startPoint: { x: 230, y: 84 }, endPoint: { x: 400, y: 150 } }, // +(100, 50)
    ]);
  });
});
