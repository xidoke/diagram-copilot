import { describe, expect, it } from "vitest";
import type { DiagramDoc } from "@diagram-copilot/core";
import type { PositionedGraph } from "@diagram-copilot/layout";
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
