import { describe, expect, it } from "vitest";
import type { DocDiff } from "@diagram-copilot/core";
import { buildCompareOverlays } from "../../src/render/compareMode";
import { applyDiffToEdges, applyDiffToNodes, edgeDiffKey } from "../../src/render/diffOverlay";

/** A structurally-empty diff, spread over below with just the fields a case needs. */
function emptyDiff(): DocDiff {
  return {
    nodes: { added: [], removed: [], changed: [] },
    groups: { added: [], removed: [], changed: [], membershipChanged: [] },
    edges: { added: [], removed: [], labelChanged: [] },
  };
}
const node = (id: string) => ({ id, label: id });
const group = (id: string) => ({ id, label: id });

describe("buildCompareOverlays", () => {
  it("marks a removed node red on the LEFT pane only", () => {
    const diff = emptyDiff();
    diff.nodes.removed = [node("Search Index")];
    const { left, right } = buildCompareOverlays(diff);
    expect(left.nodeClasses).toEqual({ "Search Index": "diff-removed" });
    expect(right.nodeClasses).toEqual({});
  });

  it("marks a removed group red on the LEFT pane only", () => {
    const diff = emptyDiff();
    diff.groups.removed = [group("Legacy VPC")];
    const { left, right } = buildCompareOverlays(diff);
    expect(left.nodeClasses).toEqual({ "Legacy VPC": "diff-removed" });
    expect(right.nodeClasses).toEqual({});
  });

  it("marks an added node green on the RIGHT pane only", () => {
    const diff = emptyDiff();
    diff.nodes.added = [node("Cache")];
    const { left, right } = buildCompareOverlays(diff);
    expect(right.nodeClasses).toEqual({ Cache: "diff-added" });
    expect(left.nodeClasses).toEqual({});
  });

  it("marks a changed node amber on BOTH panes (it exists in both steps)", () => {
    const diff = emptyDiff();
    diff.nodes.changed = [{ id: "API", changes: [{ field: "color", from: "blue", to: "green" }] }];
    const { left, right } = buildCompareOverlays(diff);
    expect(left.nodeClasses).toEqual({ API: "diff-changed" });
    expect(right.nodeClasses).toEqual({ API: "diff-changed" });
  });

  it("marks a membership move amber on both panes, without overriding a louder flag", () => {
    const diff = emptyDiff();
    diff.groups.membershipChanged = [{ id: "Worker", from: null, to: "VPC" }];
    const { left, right } = buildCompareOverlays(diff);
    expect(left.nodeClasses).toEqual({ Worker: "diff-changed" });
    expect(right.nodeClasses).toEqual({ Worker: "diff-changed" });
  });

  it("marks a removed edge red on the LEFT pane, keyed by its from/to/label content", () => {
    const diff = emptyDiff();
    diff.edges.removed = [{ from: "API", to: "Search Index", label: "queries" }];
    const { left, right } = buildCompareOverlays(diff);
    expect(left.edgeClasses[edgeDiffKey("API", "Search Index", "queries")]).toBe("diff-removed");
    expect(right.edgeClasses).toEqual({});
  });

  it("marks an added edge green on the RIGHT pane only", () => {
    const diff = emptyDiff();
    diff.edges.added = [{ from: "API", to: "Cache" }];
    const { left, right } = buildCompareOverlays(diff);
    expect(right.edgeClasses[edgeDiffKey("API", "Cache")]).toBe("diff-added");
    expect(left.edgeClasses).toEqual({});
  });

  it("keys a label change by the BEFORE label on the left and the AFTER label on the right", () => {
    const diff = emptyDiff();
    diff.edges.labelChanged = [{ from: "A", to: "B", fromLabel: "old", toLabel: "new" }];
    const { left, right } = buildCompareOverlays(diff);
    expect(left.edgeClasses[edgeDiffKey("A", "B", "old")]).toBe("diff-changed");
    expect(left.edgeClasses[edgeDiffKey("A", "B", "new")]).toBeUndefined();
    expect(right.edgeClasses[edgeDiffKey("A", "B", "new")]).toBe("diff-changed");
    expect(right.edgeClasses[edgeDiffKey("A", "B", "old")]).toBeUndefined();
  });

  it("keys an unlabeled removed edge with the empty-label key", () => {
    const diff = emptyDiff();
    diff.edges.removed = [{ from: "A", to: "B" }];
    const { left } = buildCompareOverlays(diff);
    expect(left.edgeClasses[edgeDiffKey("A", "B")]).toBe("diff-removed");
  });

  it("shares one summary across both panes (the right/Δ summary)", () => {
    const diff = emptyDiff();
    diff.nodes.added = [node("Cache")];
    diff.nodes.removed = [node("Old")];
    const { left, right } = buildCompareOverlays(diff);
    expect(left.summary).toBe(right.summary);
    expect(right.summary.addedNodes).toBe(1);
    expect(right.summary.removed).toBe(1);
    expect(right.summary.removedNames).toEqual(["Old"]);
  });

  it("returns empty class maps + an empty summary for an all-empty diff", () => {
    const { left, right } = buildCompareOverlays(emptyDiff());
    expect(left.nodeClasses).toEqual({});
    expect(left.edgeClasses).toEqual({});
    expect(right.summary.empty).toBe(true);
  });
});

describe("diff-removed flows through the existing class appliers", () => {
  it("applyDiffToNodes paints diff-removed on the matching node", () => {
    const diff = emptyDiff();
    diff.nodes.removed = [node("Old")];
    const { left } = buildCompareOverlays(diff);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodes = [{ id: "Old", position: { x: 0, y: 0 }, data: {} }] as any;
    expect(applyDiffToNodes(nodes, left)[0].className).toBe("diff-removed");
  });

  it("applyDiffToEdges paints diff-removed on the matching edge", () => {
    const diff = emptyDiff();
    diff.edges.removed = [{ from: "A", to: "B", label: "x" }];
    const { left } = buildCompareOverlays(diff);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edges = [{ id: "e1", source: "A", target: "B", label: "x" }] as any;
    expect(applyDiffToEdges(edges, left)[0].className).toBe("diff-removed");
  });
});
