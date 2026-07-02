import { describe, expect, it } from "vitest";
import type { DiagramDoc } from "@diagram-copilot/core";
import type { PositionedGraph } from "@diagram-copilot/layout";
import { ELK_EDGE_TYPE } from "../../src/render/ElkEdge.js";
import {
  ARCH_GROUP_DRAG_HANDLE,
  ARCH_GROUP_TYPE,
  ARCH_NODE_TYPE,
  GROUP_EXTENT_PADDING,
  GROUP_TITLE_BAND,
  HANDLE_RIM_OFFSET,
  toFlow,
} from "../../src/render/toFlow.js";

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
    // Padded drag clamp (DGC-69): parent-relative, VPC is 180×120 — the top
    // inset is the title band, the other sides the plain border padding.
    expect(api?.extent).toEqual([
      [GROUP_EXTENT_PADDING, GROUP_TITLE_BAND],
      [180 - GROUP_EXTENT_PADDING, 120 - GROUP_EXTENT_PADDING],
    ]);
    const client = nodes.find((n) => n.id === "Client");
    expect(client?.parentId).toBeUndefined();
    expect(client?.extent).toBeUndefined();
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

  it("makes a group draggable by its title band, still non-selectable (DGC-71)", () => {
    const { nodes } = toFlow(doc, graph);
    const vpc = nodes.find((n) => n.id === "VPC");
    expect(vpc?.draggable).toBe(true);
    expect(vpc?.dragHandle).toBe(ARCH_GROUP_DRAG_HANDLE);
    expect(vpc?.selectable).toBe(false);
    // A root group roams free (no extent clamp).
    expect(vpc?.extent).toBeUndefined();
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

  it("clamps a nested leaf to its immediate parent's padded box", () => {
    const { nodes } = toFlow(nestedDoc, nestedGraph);
    const db = nodes.find((n) => n.id === "DB");
    // Inner is 180×100 — the extent is relative to Inner, not to the root.
    expect(db?.extent).toEqual([
      [GROUP_EXTENT_PADDING, GROUP_TITLE_BAND],
      [180 - GROUP_EXTENT_PADDING, 100 - GROUP_EXTENT_PADDING],
    ]);
  });

  it("clamps a nested GROUP to its parent's padded/title-band box (DGC-71)", () => {
    const { nodes } = toFlow(nestedDoc, nestedGraph);
    // Mid inside Outer (300×220): same title-band clamp as a leaf, relative to
    // Outer — so a dragged inner group can't cover the parent's border/title.
    const mid = nodes.find((n) => n.id === "Mid");
    expect(mid?.parentId).toBe("Outer");
    expect(mid?.draggable).toBe(true);
    expect(mid?.dragHandle).toBe(ARCH_GROUP_DRAG_HANDLE);
    expect(mid?.extent).toEqual([
      [GROUP_EXTENT_PADDING, GROUP_TITLE_BAND],
      [300 - GROUP_EXTENT_PADDING, 220 - GROUP_EXTENT_PADDING],
    ]);
    // Inner inside Mid (240×160).
    const inner = nodes.find((n) => n.id === "Inner");
    expect(inner?.extent).toEqual([
      [GROUP_EXTENT_PADDING, GROUP_TITLE_BAND],
      [240 - GROUP_EXTENT_PADDING, 160 - GROUP_EXTENT_PADDING],
    ]);
    // Root group (Outer) roams free.
    expect(nodes.find((n) => n.id === "Outer")?.extent).toBeUndefined();
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

  it("attaches layout-time handle anchors for the drift detector (DGC-69)", () => {
    // Direction "right": source anchor sits HANDLE_RIM_OFFSET outside the
    // FROM box's right border (centered vertically), target anchor the same
    // outside the TO box's left border — in ABSOLUTE coords (API is
    // parent-relative at (18, 34) inside VPC at (200, 0)).
    const { edges } = toFlow(doc, graph);
    expect(edges[0].data?.staticSource).toEqual({
      x: 10 + 120 + HANDLE_RIM_OFFSET,
      y: 20 + 24,
    }); // Client
    expect(edges[0].data?.staticTarget).toEqual({
      x: 200 + 18 - HANDLE_RIM_OFFSET,
      y: 34 + 24,
    }); // API abs
  });

  it("passes ELK's labelPos through onto the edge data", () => {
    const labeledGraph: PositionedGraph = {
      ...graph,
      edges: [{ ...graph.edges[0], labelPos: { x: 174, y: 40 } }],
    };
    const { edges } = toFlow(doc, labeledGraph);
    expect(edges[0].data?.labelPos).toEqual({ x: 174, y: 40 });
    // …and omits the key entirely when layout reported none.
    const { edges: plain } = toFlow(doc, graph);
    expect("labelPos" in (plain[0].data ?? {})).toBe(false);
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
