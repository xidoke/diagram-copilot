import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { diffDocs, isDiffEmpty, parseDsl } from "../src/index.js";
import type { DiagramDoc, DiagramEdge, DiagramGroup, DiagramNode } from "../src/index.js";

/**
 * diffDocs (DGC-74): structural delta between two DiagramDocs.
 *
 * Nodes/groups match by id (= name); edges match by from/to/label because the
 * parser renumbers `eN` ids by source position (DGC-17). Tests build docs
 * inline for precise per-category coverage, then diff the url-shortener fixture
 * against a hand-edited evolution to prove the categories compose.
 */

function mkDoc(parts: Partial<DiagramDoc> = {}): DiagramDoc {
  return { type: "architecture", direction: "right", nodes: [], groups: [], edges: [], ...parts };
}
function n(id: string, extra: Partial<DiagramNode> = {}): DiagramNode {
  return { id, label: id, ...extra };
}
function g(id: string, extra: Partial<DiagramGroup> = {}): DiagramGroup {
  return { id, label: id, ...extra };
}
function e(from: string, to: string, label?: string): DiagramEdge {
  // id is arbitrary — diffEdges ignores it and matches on from/to/label.
  return label === undefined ? { id: "e", from, to } : { id: "e", from, to, label };
}
function parseText(dsl: string, label: string): DiagramDoc {
  const result = parseDsl(dsl);
  if (!result.ok) throw new Error(`${label} did not parse`);
  return result.doc;
}
function parse(name: string): DiagramDoc {
  return parseText(
    readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8"),
    `fixture ${name}`,
  );
}

/**
 * A hand-edited "next iteration" of the shipped url-shortener.arch fixture,
 * kept INLINE (not a fixture file) because `packages/core/fixtures/*.arch` is
 * the shipped template set — dropping a variant there would surface it in the
 * picker. Deltas vs url-shortener.arch, one per diff category:
 *   + added:   CDN (root), Metrics DB (Data tier)
 *   - removed: Analytics Queue (+ its two edges)
 *   ~ changed: Client (icon monitor→smartphone), LB (color blue→green)
 *   ↪ moved:   Postgres (Data tier → Service tier)
 *   group ~:   Data tier gains color gray
 *   edges:     Client>LB label "HTTPS request"→"HTTPS"; + Client>CDN, CDN>LB.
 */
const URL_SHORTENER_V2 = [
  "direction right",
  "",
  "Client [icon: smartphone]",
  "CDN [icon: cloud, color: purple]",
  "",
  "Service tier {",
  "  LB [icon: network, color: green]",
  "  API Server A [icon: server, color: orange]",
  "  API Server B [icon: server, color: orange]",
  "  Postgres [icon: postgresql, color: blue]",
  "}",
  "",
  "Data tier [color: gray] {",
  "  Cache Redis [icon: redis, color: red]",
  "  Metrics DB [icon: postgresql, color: teal]",
  "}",
  "",
  "Client > CDN",
  "CDN > LB",
  "Client > LB: HTTPS",
  "LB > API Server A, API Server B: round robin",
  "",
  "API Server A > Cache Redis: GET short_code",
  "API Server A > Postgres: fallback on cache miss",
  "",
  "API Server B > Cache Redis: GET short_code",
  "API Server B > Postgres: fallback on cache miss",
].join("\n");

describe("diffDocs — nodes", () => {
  it("detects added and removed nodes by id", () => {
    const a = mkDoc({ nodes: [n("A"), n("B")] });
    const b = mkDoc({ nodes: [n("B"), n("C")] });
    const diff = diffDocs(a, b);
    expect(diff.nodes.added.map((x) => x.id)).toEqual(["C"]);
    expect(diff.nodes.removed.map((x) => x.id)).toEqual(["A"]);
    expect(diff.nodes.changed).toEqual([]);
  });

  it("reports an icon change (old → new) on a kept node", () => {
    const a = mkDoc({ nodes: [n("A", { icon: "server" })] });
    const b = mkDoc({ nodes: [n("A", { icon: "database" })] });
    expect(diffDocs(a, b).nodes.changed).toEqual([
      { id: "A", changes: [{ field: "icon", from: "server", to: "database" }] },
    ]);
  });

  it("reports a color change, including added (undefined → value)", () => {
    const a = mkDoc({ nodes: [n("A")] });
    const b = mkDoc({ nodes: [n("A", { color: "blue" })] });
    expect(diffDocs(a, b).nodes.changed).toEqual([
      { id: "A", changes: [{ field: "color", from: undefined, to: "blue" }] },
    ]);
  });

  it("reports a label change and orders multiple fields icon→color→label", () => {
    const a = mkDoc({ nodes: [n("A", { icon: "server", color: "blue", label: "A" })] });
    const b = mkDoc({ nodes: [n("A", { icon: "cpu", color: "red", label: "Api" })] });
    expect(diffDocs(a, b).nodes.changed[0].changes.map((c) => c.field)).toEqual(["icon", "color", "label"]);
  });

  it("treats a rename as remove + add (no id linkage available)", () => {
    const a = mkDoc({ nodes: [n("Old", { icon: "server" })] });
    const b = mkDoc({ nodes: [n("New", { icon: "server" })] });
    const diff = diffDocs(a, b);
    expect(diff.nodes.removed.map((x) => x.id)).toEqual(["Old"]);
    expect(diff.nodes.added.map((x) => x.id)).toEqual(["New"]);
    expect(diff.nodes.changed).toEqual([]);
  });
});

describe("diffDocs — membership", () => {
  it("detects a move from root into a group (root modeled as null)", () => {
    const a = mkDoc({ groups: [g("VPC")], nodes: [n("Svc")] });
    const b = mkDoc({ groups: [g("VPC")], nodes: [n("Svc", { groupId: "VPC" })] });
    expect(diffDocs(a, b).groups.membershipChanged).toEqual([{ id: "Svc", from: null, to: "VPC" }]);
  });

  it("detects a move from a group back to root", () => {
    const a = mkDoc({ groups: [g("VPC")], nodes: [n("Svc", { groupId: "VPC" })] });
    const b = mkDoc({ groups: [g("VPC")], nodes: [n("Svc")] });
    expect(diffDocs(a, b).groups.membershipChanged).toEqual([{ id: "Svc", from: "VPC", to: null }]);
  });

  it("detects a move between two groups without reporting an attr change", () => {
    const groups = [g("Web"), g("Data")];
    const a = mkDoc({ groups, nodes: [n("Svc", { groupId: "Web", icon: "server" })] });
    const b = mkDoc({ groups, nodes: [n("Svc", { groupId: "Data", icon: "server" })] });
    const diff = diffDocs(a, b);
    expect(diff.groups.membershipChanged).toEqual([{ id: "Svc", from: "Web", to: "Data" }]);
    expect(diff.nodes.changed).toEqual([]);
  });
});

describe("diffDocs — groups", () => {
  it("detects added and removed groups", () => {
    const a = mkDoc({ groups: [g("A")] });
    const b = mkDoc({ groups: [g("B")] });
    const diff = diffDocs(a, b);
    expect(diff.groups.added.map((x) => x.id)).toEqual(["B"]);
    expect(diff.groups.removed.map((x) => x.id)).toEqual(["A"]);
  });

  it("detects group label and color changes", () => {
    const a = mkDoc({ groups: [g("VPC", { label: "VPC", color: "gray" })] });
    const b = mkDoc({ groups: [g("VPC", { label: "Prod VPC", color: "blue" })] });
    expect(diffDocs(a, b).groups.changed).toEqual([
      {
        id: "VPC",
        changes: [
          { field: "color", from: "gray", to: "blue" },
          { field: "label", from: "VPC", to: "Prod VPC" },
        ],
      },
    ]);
  });
});

describe("diffDocs — edges (content match, ids ignored)", () => {
  it("ignores eN ids: same content in a different position is unchanged", () => {
    const a = mkDoc({
      nodes: [n("A"), n("B"), n("C")],
      edges: [{ id: "e1", from: "A", to: "B" }, { id: "e2", from: "B", to: "C" }],
    });
    const b = mkDoc({
      nodes: [n("A"), n("B"), n("C")],
      // reversed order + renumbered ids, identical content
      edges: [{ id: "e1", from: "B", to: "C" }, { id: "e2", from: "A", to: "B" }],
    });
    const diff = diffDocs(a, b);
    expect(diff.edges.added).toEqual([]);
    expect(diff.edges.removed).toEqual([]);
    expect(diff.edges.labelChanged).toEqual([]);
    expect(isDiffEmpty(diff)).toBe(true);
  });

  it("fan-out one-to-many: adding a target is a single added edge", () => {
    const a = mkDoc({ edges: [e("LB", "A", "rr"), e("LB", "B", "rr")] });
    const b = mkDoc({ edges: [e("LB", "A", "rr"), e("LB", "B", "rr"), e("LB", "C", "rr")] });
    const diff = diffDocs(a, b);
    expect(diff.edges.added).toEqual([{ from: "LB", to: "C", label: "rr" }]);
    expect(diff.edges.removed).toEqual([]);
    expect(diff.edges.labelChanged).toEqual([]);
  });

  it("label change on a stable connection reads as labelChanged, not add+remove", () => {
    const a = mkDoc({ edges: [e("A", "B", "old")] });
    const b = mkDoc({ edges: [e("A", "B", "new")] });
    const diff = diffDocs(a, b);
    expect(diff.edges.labelChanged).toEqual([{ from: "A", to: "B", fromLabel: "old", toLabel: "new" }]);
    expect(diff.edges.added).toEqual([]);
    expect(diff.edges.removed).toEqual([]);
  });

  it("labeled ↔ unlabeled is a label change (undefined captured)", () => {
    const a = mkDoc({ edges: [e("A", "B", "cache")] });
    const b = mkDoc({ edges: [e("A", "B")] });
    expect(diffDocs(a, b).edges.labelChanged).toEqual([
      { from: "A", to: "B", fromLabel: "cache" },
    ]);
  });

  it("pure add and remove when endpoints do not overlap", () => {
    const a = mkDoc({ edges: [e("A", "B")] });
    const b = mkDoc({ edges: [e("C", "D", "x")] });
    const diff = diffDocs(a, b);
    expect(diff.edges.removed).toEqual([{ from: "A", to: "B" }]);
    expect(diff.edges.added).toEqual([{ from: "C", to: "D", label: "x" }]);
    expect(diff.edges.labelChanged).toEqual([]);
  });

  it("pairs multiple same-endpoint leftovers deterministically by sorted label", () => {
    const a = mkDoc({ edges: [e("A", "B", "a1"), e("A", "B", "a2")] });
    const b = mkDoc({ edges: [e("A", "B", "b2"), e("A", "B", "b1")] });
    // leftover A sorted a1,a2 ; leftover B bucket sorted b1,b2 → a1↔b1, a2↔b2
    expect(diffDocs(a, b).edges.labelChanged).toEqual([
      { from: "A", to: "B", fromLabel: "a1", toLabel: "b1" },
      { from: "A", to: "B", fromLabel: "a2", toLabel: "b2" },
    ]);
  });
});

describe("diffDocs — identity & determinism", () => {
  it("identical docs → isDiffEmpty is true", () => {
    const doc = mkDoc({
      nodes: [n("A", { icon: "server" }), n("B")],
      groups: [g("VPC")],
      edges: [e("A", "B", "x")],
    });
    expect(isDiffEmpty(diffDocs(doc, doc))).toBe(true);
  });

  it("every list is sorted by id / endpoints regardless of input order", () => {
    const a = mkDoc({ nodes: [n("Z"), n("M")] });
    const b = mkDoc({ nodes: [n("M"), n("Q"), n("B")] });
    const diff = diffDocs(a, b);
    expect(diff.nodes.added.map((x) => x.id)).toEqual(["B", "Q"]);
    expect(diff.nodes.removed.map((x) => x.id)).toEqual(["Z"]);
  });

  it("url-shortener diffed against itself is empty", () => {
    expect(isDiffEmpty(diffDocs(parse("url-shortener.arch"), parse("url-shortener.arch")))).toBe(true);
  });
});

describe("diffDocs — url-shortener → url-shortener-v2 fixture", () => {
  const diff = diffDocs(parse("url-shortener.arch"), parseText(URL_SHORTENER_V2, "url-shortener-v2"));

  it("added nodes: CDN and Metrics DB", () => {
    expect(diff.nodes.added.map((x) => x.id)).toEqual(["CDN", "Metrics DB"]);
  });

  it("removed node: Analytics Queue", () => {
    expect(diff.nodes.removed.map((x) => x.id)).toEqual(["Analytics Queue"]);
  });

  it("changed nodes: Client icon, LB color", () => {
    expect(diff.nodes.changed).toEqual([
      { id: "Client", changes: [{ field: "icon", from: "monitor", to: "smartphone" }] },
      { id: "LB", changes: [{ field: "color", from: "blue", to: "green" }] },
    ]);
  });

  it("group change: Data tier gains color gray", () => {
    expect(diff.groups.added).toEqual([]);
    expect(diff.groups.removed).toEqual([]);
    expect(diff.groups.changed).toEqual([
      { id: "Data tier", changes: [{ field: "color", from: undefined, to: "gray" }] },
    ]);
  });

  it("membership: Postgres moved Data tier → Service tier", () => {
    expect(diff.groups.membershipChanged).toEqual([
      { id: "Postgres", from: "Data tier", to: "Service tier" },
    ]);
  });

  it("edges: +2 (Client>CDN, CDN>LB), −2 (Analytics Queue), Client>LB label changed", () => {
    expect(diff.edges.added).toEqual([
      { from: "CDN", to: "LB" },
      { from: "Client", to: "CDN" },
    ]);
    expect(diff.edges.removed).toEqual([
      { from: "API Server A", to: "Analytics Queue", label: "click event" },
      { from: "API Server B", to: "Analytics Queue", label: "click event" },
    ]);
    expect(diff.edges.labelChanged).toEqual([
      { from: "Client", to: "LB", fromLabel: "HTTPS request", toLabel: "HTTPS" },
    ]);
  });

  it("the composite diff is not empty", () => {
    expect(isDiffEmpty(diff)).toBe(false);
  });
});
