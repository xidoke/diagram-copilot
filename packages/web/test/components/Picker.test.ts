import { describe, expect, it } from "vitest";
import { formatTemplateLabel, groupDiagrams } from "../../src/components/Picker";

describe("groupDiagrams", () => {
  it("returns an empty list for an empty workspace", () => {
    expect(groupDiagrams([])).toEqual([]);
  });

  it("treats plain names (no .stepN suffix) as rootless single-item groups", () => {
    expect(groupDiagrams(["demo", "alpha"])).toEqual([
      { root: "alpha", steps: [] },
      { root: "demo", steps: [] },
    ]);
  });

  it("groups .stepN files under their root, sorted numerically", () => {
    const result = groupDiagrams(["news-feed", "news-feed.step2", "news-feed.step1", "news-feed.step10"]);
    expect(result).toEqual([
      { root: "news-feed", steps: ["news-feed.step1", "news-feed.step2", "news-feed.step10"] },
    ]);
  });

  it("still creates a root group when only step files exist (no base file)", () => {
    expect(groupDiagrams(["orphan.step1", "orphan.step2"])).toEqual([
      { root: "orphan", steps: ["orphan.step1", "orphan.step2"] },
    ]);
  });

  it("sorts root groups alphabetically, independent of input order", () => {
    const result = groupDiagrams(["zeta", "alpha", "mid.step1", "mid"]);
    expect(result.map((g) => g.root)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("keeps unrelated diagrams and step groups separate", () => {
    const result = groupDiagrams(["news-feed", "news-feed.step1", "billing", "billing.step3", "billing.step1"]);
    expect(result).toEqual([
      { root: "billing", steps: ["billing.step1", "billing.step3"] },
      { root: "news-feed", steps: ["news-feed.step1"] },
    ]);
  });

  it("does not mistake a name merely containing '.step' without a trailing number for a step file", () => {
    expect(groupDiagrams(["my.stepper", "my.step"])).toEqual([
      { root: "my.step", steps: [] },
      { root: "my.stepper", steps: [] },
    ]);
  });
});

describe("formatTemplateLabel (DGC-66 / F6 — 'New from template ▸')", () => {
  it("pluralizes node count normally", () => {
    expect(formatTemplateLabel({ id: "news-feed", title: "News Feed", nodeCount: 12 })).toBe(
      "News Feed · 12 nodes",
    );
  });

  it("uses the singular 'node' for a count of exactly 1", () => {
    expect(formatTemplateLabel({ id: "solo", title: "Solo", nodeCount: 1 })).toBe("Solo · 1 node");
  });

  it("uses the plural 'nodes' for a count of 0", () => {
    expect(formatTemplateLabel({ id: "empty", title: "Empty", nodeCount: 0 })).toBe("Empty · 0 nodes");
  });
});
