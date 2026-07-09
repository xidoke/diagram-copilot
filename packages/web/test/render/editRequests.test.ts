import { describe, expect, it } from "vitest";
import {
  buildAddEdgeOp,
  buildDropNodeOp,
  buildRemoveOps,
  describeRemoval,
  groupAtPoint,
  uniqueName,
  validateRename,
  type EditOp,
  type GroupBox,
} from "../../src/render/editRequests.js";

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
