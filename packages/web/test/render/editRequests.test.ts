import { describe, expect, it } from "vitest";
import {
  buildAddEdgeOp,
  buildDropNodeOp,
  buildDuplicateOp,
  buildDuplicateOps,
  buildRemoveOps,
  buildSetAttrOp,
  describeRemoval,
  describeReparent,
  groupAtPoint,
  uniqueName,
  validateRename,
  type DuplicableNode,
  type EditOp,
  type GroupBox,
} from "../../src/render/editRequests.js";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE } from "../../src/render/toFlow.js";

describe("buildRemoveOps", () => {
  it("maps every selected node to a remove op, ignoring unselected ones", () => {
    const ops = buildRemoveOps(
      [{ id: "API", selected: true }, { id: "DB" }, { id: "Cache", selected: false }],
      [],
    );
    expect(ops).toEqual([{ op: "remove", id: "API" }]);
  });

  it("maps a selected edge to remove_edge by ENDPOINTS (not the positional eN id)", () => {
    const ops = buildRemoveOps([], [{ source: "API", target: "DB", selected: true }]);
    expect(ops).toEqual([{ op: "remove_edge", from: "API", to: "DB" }]);
  });

  it("passes a string edge label through so parallel edges stay disambiguated", () => {
    const ops = buildRemoveOps([], [{ source: "A", target: "B", selected: true, label: "reads" }]);
    expect(ops).toEqual([{ op: "remove_edge", from: "A", to: "B", label: "reads" }]);
  });

  it("omits non-string and empty labels", () => {
    expect(buildRemoveOps([], [{ source: "A", target: "B", selected: true, label: "" }])).toEqual([
      { op: "remove_edge", from: "A", to: "B" },
    ]);
    expect(buildRemoveOps([], [{ source: "A", target: "B", selected: true, label: { odd: true } }])).toEqual([
      { op: "remove_edge", from: "A", to: "B" },
    ]);
  });

  it("skips edges that already fall with a selected endpoint node (all-or-nothing safety)", () => {
    // Removing "API" cascades to its edges server-side — a second remove of
    // the same edge would fail and abort the whole batch.
    const ops = buildRemoveOps(
      [{ id: "API", selected: true }],
      [
        { source: "API", target: "DB", selected: true }, // cascades with API
        { source: "Client", target: "API", selected: true }, // cascades with API
        { source: "Client", target: "DB", selected: true }, // independent — kept
      ],
    );
    expect(ops).toEqual([
      { op: "remove", id: "API" },
      { op: "remove_edge", from: "Client", to: "DB" },
    ]);
  });

  it("returns no ops when nothing is selected", () => {
    expect(buildRemoveOps([{ id: "A" }], [{ source: "A", target: "B" }])).toEqual([]);
  });

  it("skips a selected GROUP node so Delete never cascades a whole group (DGC-19)", () => {
    // Groups became selectable for resize; excluding them here preserves the
    // pre-DGC-19 behavior where a group can't be deleted from the canvas.
    const ops = buildRemoveOps(
      [
        { id: "VPC", type: ARCH_GROUP_TYPE, selected: true },
        { id: "API", selected: true },
      ],
      [],
    );
    expect(ops).toEqual([{ op: "remove", id: "API" }]);
  });
});

describe("describeReparent", () => {
  it("names a move into a group", () => {
    expect(describeReparent("API", "VPC")).toBe('Đã chuyển "API" vào nhóm "VPC"');
  });

  it("names a move out to the document root", () => {
    expect(describeReparent("API", null)).toBe('Đã đưa "API" ra ngoài nhóm');
  });
});

describe("describeRemoval", () => {
  it("names a single node", () => {
    expect(describeRemoval([{ op: "remove", id: "API Server" }])).toBe('"API Server"');
  });

  it("names a single edge by endpoints", () => {
    expect(describeRemoval([{ op: "remove_edge", from: "API", to: "DB" }])).toBe("cạnh API > DB");
  });

  it("counts a mixed batch", () => {
    const ops: EditOp[] = [
      { op: "remove", id: "API" },
      { op: "remove_edge", from: "Client", to: "DB" },
    ];
    expect(describeRemoval(ops)).toBe("2 phần tử");
  });
});

describe("validateRename", () => {
  it("trims and returns the new name", () => {
    expect(validateRename("API", "  Core API ")).toBe("Core API");
  });

  it("returns null for empty or whitespace-only input", () => {
    expect(validateRename("API", "")).toBeNull();
    expect(validateRename("API", "   ")).toBeNull();
  });

  it("returns null when the name is unchanged (pure no-op — skip the request)", () => {
    expect(validateRename("API", "API")).toBeNull();
    expect(validateRename("API", " API ")).toBeNull();
  });
});

describe("uniqueName", () => {
  it("returns the base name when it is free", () => {
    expect(uniqueName("redis", new Set(["postgres"]))).toBe("redis");
  });

  it("suffixes -2 for the first collision", () => {
    expect(uniqueName("redis", new Set(["redis"]))).toBe("redis-2");
  });

  it("keeps incrementing past a run of taken suffixes", () => {
    expect(uniqueName("redis", new Set(["redis", "redis-2", "redis-3"]))).toBe("redis-4");
  });
});

describe("buildDropNodeOp", () => {
  it("names the node after the icon and stores the icon attr", () => {
    expect(buildDropNodeOp("postgresql", [])).toEqual({
      op: "add_node",
      name: "postgresql",
      icon: "postgresql",
    });
  });

  it("de-duplicates against existing node AND group ids", () => {
    const op = buildDropNodeOp("redis", ["redis", "redis-2", "SomeGroup"]);
    expect(op).toEqual({ op: "add_node", name: "redis-3", icon: "redis" });
  });

  it("nests into a group when one is passed", () => {
    expect(buildDropNodeOp("redis", [], "Cache")).toEqual({
      op: "add_node",
      name: "redis",
      icon: "redis",
      group: "Cache",
    });
  });

  it("omits an empty group (drop at document root)", () => {
    expect(buildDropNodeOp("redis", [], "")).toEqual({
      op: "add_node",
      name: "redis",
      icon: "redis",
    });
  });
});

describe("groupAtPoint", () => {
  // Cache (inner, small) nested inside VPC (outer, large); Edge is disjoint.
  const boxes: GroupBox[] = [
    { id: "VPC", left: 0, top: 0, right: 300, bottom: 300 },
    { id: "Cache", left: 40, top: 40, right: 140, bottom: 140 },
    { id: "Edge", left: 400, top: 0, right: 500, bottom: 100 },
  ];

  it("returns the innermost (smallest) group containing the point", () => {
    expect(groupAtPoint(80, 80, boxes)).toBe("Cache");
  });

  it("returns the outer group when the point is outside the inner one", () => {
    expect(groupAtPoint(250, 250, boxes)).toBe("VPC");
  });

  it("returns a disjoint group when the point lands only in it", () => {
    expect(groupAtPoint(450, 50, boxes)).toBe("Edge");
  });

  it("returns undefined when the point misses every group (→ root)", () => {
    expect(groupAtPoint(350, 350, boxes)).toBeUndefined();
  });

  it("nests on an inclusive border", () => {
    expect(groupAtPoint(140, 140, boxes)).toBe("Cache");
  });
});

describe("buildSetAttrOp", () => {
  it("builds a set_attr op that changes an icon (context menu → op)", () => {
    expect(buildSetAttrOp("API", "icon", "lambda")).toEqual({
      op: "set_attr",
      id: "API",
      key: "icon",
      value: "lambda",
    });
  });

  it("builds a set_attr op that changes a color", () => {
    expect(buildSetAttrOp("API", "color", "orange")).toEqual({
      op: "set_attr",
      id: "API",
      key: "color",
      value: "orange",
    });
  });

  it("passes null through to remove an attribute (bỏ icon / bỏ màu)", () => {
    expect(buildSetAttrOp("API", "color", null)).toEqual({
      op: "set_attr",
      id: "API",
      key: "color",
      value: null,
    });
  });
});

describe("buildDuplicateOp", () => {
  it("names the copy via uniqueName (-2 suffix) against the taken set", () => {
    const op = buildDuplicateOp({ id: "API", type: ARCH_NODE_TYPE }, new Set(["API"]));
    expect(op).toEqual({ op: "add_node", name: "API-2" });
  });

  it("copies icon and color attrs from the original node's data", () => {
    const op = buildDuplicateOp(
      { id: "cache", type: ARCH_NODE_TYPE, data: { icon: "redis", color: "orange", label: "cache" } },
      new Set(["cache"]),
    );
    expect(op).toEqual({ op: "add_node", name: "cache-2", icon: "redis", color: "orange" });
  });

  it("copies an EXPLICIT label (one that differs from the id) verbatim", () => {
    const op = buildDuplicateOp(
      { id: "api", type: ARCH_NODE_TYPE, data: { label: "API Server" } },
      new Set(["api"]),
    );
    expect(op).toEqual({ op: "add_node", name: "api-2", label: "API Server" });
  });

  it("omits a DEFAULT label (label === id) so the copy shows its new unique name", () => {
    const op = buildDuplicateOp(
      { id: "API", type: ARCH_NODE_TYPE, data: { label: "API" } },
      new Set(["API"]),
    );
    expect(op).toEqual({ op: "add_node", name: "API-2" });
  });

  it("keeps the copy in the same group as the original (parentId → group)", () => {
    const op = buildDuplicateOp(
      { id: "redis", type: ARCH_NODE_TYPE, parentId: "Cache", data: { icon: "redis" } },
      new Set(["redis"]),
    );
    expect(op).toEqual({ op: "add_node", name: "redis-2", icon: "redis", group: "Cache" });
  });

  it("ignores non-string / empty attr values", () => {
    const op = buildDuplicateOp(
      { id: "n", type: ARCH_NODE_TYPE, data: { icon: 42, color: "", label: undefined } },
      new Set(["n"]),
    );
    expect(op).toEqual({ op: "add_node", name: "n-2" });
  });
});

describe("buildDuplicateOps", () => {
  it("duplicates every selected leaf node with batch-safe unique names", () => {
    const nodes: DuplicableNode[] = [
      { id: "API", type: ARCH_NODE_TYPE },
      { id: "DB", type: ARCH_NODE_TYPE, data: { color: "blue" } },
    ];
    expect(buildDuplicateOps(nodes, ["API", "DB"])).toEqual([
      { op: "add_node", name: "API-2" },
      { op: "add_node", name: "DB-2", color: "blue" },
    ]);
  });

  it("accumulates generated names so two copies in one batch never collide", () => {
    // Duplicating both "API" and its existing copy "API-2" at once must yield
    // distinct names — the second op must see the first op's name as taken.
    const nodes: DuplicableNode[] = [
      { id: "API", type: ARCH_NODE_TYPE },
      { id: "API-2", type: ARCH_NODE_TYPE },
    ];
    const ops = buildDuplicateOps(nodes, ["API", "API-2"]);
    const names = ops.map((o) => o.name);
    expect(new Set(names).size).toBe(2);
    expect(names).toEqual(["API-3", "API-2-2"]);
  });

  it("skips GROUP nodes — a group can't be duplicated via add_node (v1 non-goal)", () => {
    const nodes: DuplicableNode[] = [
      { id: "VPC", type: ARCH_GROUP_TYPE },
      { id: "API", type: ARCH_NODE_TYPE },
    ];
    expect(buildDuplicateOps(nodes, ["VPC", "API"])).toEqual([{ op: "add_node", name: "API-2" }]);
  });

  it("returns no ops for an empty / group-only selection", () => {
    expect(buildDuplicateOps([], [])).toEqual([]);
    expect(buildDuplicateOps([{ id: "VPC", type: ARCH_GROUP_TYPE }], ["VPC"])).toEqual([]);
  });
});

describe("buildAddEdgeOp", () => {
  it("builds an unlabeled edge from two node ids", () => {
    expect(buildAddEdgeOp("API", "DB")).toEqual({ op: "add_edge", from: "API", to: "DB" });
  });

  it("attaches a trimmed non-empty label", () => {
    expect(buildAddEdgeOp("API", "DB", "  reads  ")).toEqual({
      op: "add_edge",
      from: "API",
      to: "DB",
      label: "reads",
    });
  });

  it("omits an empty / whitespace / null label", () => {
    expect(buildAddEdgeOp("API", "DB", "")).toEqual({ op: "add_edge", from: "API", to: "DB" });
    expect(buildAddEdgeOp("API", "DB", "   ")).toEqual({ op: "add_edge", from: "API", to: "DB" });
    expect(buildAddEdgeOp("API", "DB", null)).toEqual({ op: "add_edge", from: "API", to: "DB" });
  });

  it("returns null when an endpoint is missing", () => {
    expect(buildAddEdgeOp("", "DB")).toBeNull();
    expect(buildAddEdgeOp("API", "")).toBeNull();
  });
});
