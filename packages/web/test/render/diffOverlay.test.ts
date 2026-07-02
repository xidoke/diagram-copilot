import { describe, expect, it } from "vitest";
import type { DocDiff } from "@diagram-copilot/core";
import {
  applyDiffToEdges,
  buildDiffClassNames,
  edgeDiffKey,
  prevStepName,
  type DiffOverlay,
} from "../../src/render/diffOverlay";

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

describe("buildDiffClassNames", () => {
  it("flags an added node green and counts it", () => {
    const diff = emptyDiff();
    diff.nodes.added = [node("Cache")];
    const overlay = buildDiffClassNames(diff);
    expect(overlay.nodeClasses).toEqual({ Cache: "diff-added" });
    expect(overlay.summary.addedNodes).toBe(1);
    expect(overlay.summary.empty).toBe(false);
  });

  it("flags a changed node amber and counts it as changed", () => {
    const diff = emptyDiff();
    diff.nodes.changed = [{ id: "API", changes: [{ field: "color", from: "blue", to: "green" }] }];
    const overlay = buildDiffClassNames(diff);
    expect(overlay.nodeClasses).toEqual({ API: "diff-changed" });
    expect(overlay.summary.changed).toBe(1);
  });

  it("flags an added group green", () => {
    const diff = emptyDiff();
    diff.groups.added = [group("VPC")];
    expect(buildDiffClassNames(diff).nodeClasses).toEqual({ VPC: "diff-added" });
  });

  it("flags an added edge green, keyed by from/to/label", () => {
    const diff = emptyDiff();
    diff.edges.added = [{ from: "API", to: "Cache", label: "reads" }];
    const overlay = buildDiffClassNames(diff);
    expect(overlay.edgeClasses[edgeDiffKey("API", "Cache", "reads")]).toBe("diff-added");
    expect(overlay.summary.addedEdges).toBe(1);
  });

  it("flags an added unlabeled edge green (empty-label key)", () => {
    const diff = emptyDiff();
    diff.edges.added = [{ from: "A", to: "B" }];
    expect(buildDiffClassNames(diff).edgeClasses[edgeDiffKey("A", "B")]).toBe("diff-added");
  });

  it("flags an edge whose label changed amber, keyed by the CURRENT (after) label", () => {
    const diff = emptyDiff();
    diff.edges.labelChanged = [{ from: "A", to: "B", fromLabel: "old", toLabel: "new" }];
    const overlay = buildDiffClassNames(diff);
    expect(overlay.edgeClasses[edgeDiffKey("A", "B", "new")]).toBe("diff-changed");
    expect(overlay.edgeClasses[edgeDiffKey("A", "B", "old")]).toBeUndefined();
    expect(overlay.summary.changed).toBe(1);
  });

  it("surfaces removed elements as a count + name list, never a class", () => {
    const diff = emptyDiff();
    diff.nodes.removed = [node("Search Index")];
    diff.edges.removed = [{ from: "API", to: "Search Index" }];
    const overlay = buildDiffClassNames(diff);
    expect(overlay.nodeClasses).toEqual({});
    expect(overlay.summary.removed).toBe(2); // one node + one edge
    expect(overlay.summary.removedNames).toEqual(["Search Index"]);
  });

  it("counts a membership move as a change", () => {
    const diff = emptyDiff();
    diff.groups.membershipChanged = [{ id: "Worker", from: null, to: "VPC" }];
    const overlay = buildDiffClassNames(diff);
    expect(overlay.nodeClasses).toEqual({ Worker: "diff-changed" });
    expect(overlay.summary.changed).toBe(1);
  });

  it("reports empty for an all-empty diff", () => {
    const overlay = buildDiffClassNames(emptyDiff());
    expect(overlay.summary.empty).toBe(true);
    expect(overlay.nodeClasses).toEqual({});
    expect(overlay.edgeClasses).toEqual({});
  });
});

describe("edgeDiffKey", () => {
  it("is stable and label-sensitive", () => {
    expect(edgeDiffKey("A", "B", "x")).toBe(edgeDiffKey("A", "B", "x"));
    expect(edgeDiffKey("A", "B", "x")).not.toBe(edgeDiffKey("A", "B", "y"));
    expect(edgeDiffKey("A", "B")).toBe(edgeDiffKey("A", "B", undefined));
  });
});

describe("prevStepName", () => {
  const chain = ["news-feed", "news-feed.step1", "news-feed.step2"];

  it("returns null at the base diagram (no previous step)", () => {
    expect(prevStepName(chain, "news-feed")).toBeNull();
  });

  it("resolves step1 → base", () => {
    expect(prevStepName(chain, "news-feed.step1")).toBe("news-feed");
  });

  it("resolves step2 → step1", () => {
    expect(prevStepName(chain, "news-feed.step2")).toBe("news-feed.step1");
  });

  it("returns null for a standalone diagram (not part of a chain)", () => {
    expect(prevStepName(["solo", "other"], "solo")).toBeNull();
  });

  it("returns null when active is null", () => {
    expect(prevStepName(chain, null)).toBeNull();
  });
});

describe("applyDiffToEdges", () => {
  it("matches flow edges to the diff by from/to/label content", () => {
    const overlay: DiffOverlay = {
      nodeClasses: {},
      edgeClasses: { [edgeDiffKey("API", "Cache", "reads")]: "diff-added" },
      summary: { addedNodes: 0, addedEdges: 1, changed: 0, removed: 0, removedNames: [], empty: false },
    };
    // React Flow edges key on source/target/label — the same content the diff uses.
    const edges = [
      { id: "e1", source: "API", target: "Cache", label: "reads" },
      { id: "e2", source: "API", target: "DB", label: "writes" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ] as any;
    const marked = applyDiffToEdges(edges, overlay);
    expect(marked[0].className).toBe("diff-added");
    expect(marked[1].className).toBeUndefined();
  });

  it("is a no-op for a null overlay", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const edges = [{ id: "e1", source: "A", target: "B" }] as any;
    expect(applyDiffToEdges(edges, null)).toBe(edges);
  });
});
