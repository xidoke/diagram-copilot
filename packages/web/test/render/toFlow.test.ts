import { describe, expect, it } from "vitest";
import type { DiagramDoc } from "@diagram-copilot/core";
import type { PositionedGraph } from "@diagram-copilot/layout";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE, toFlow } from "../../src/render/toFlow.js";

const doc: DiagramDoc = {
  type: "architecture",
  direction: "right",
  nodes: [
    { id: "Client", label: "Client" },
    { id: "API", label: "API", groupId: "VPC" },
  ],
  groups: [{ id: "VPC", label: "VPC" }],
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
});
