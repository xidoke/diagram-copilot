import { describe, expect, it } from "vitest";
import {
  buildRemoveOps,
  describeRemoval,
  validateRename,
  type EditOp,
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
