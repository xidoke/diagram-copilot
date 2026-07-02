import { describe, expect, it } from "vitest";
import { buildStepChain } from "../../src/components/StepsNav";

describe("buildStepChain", () => {
  it("returns the full chain, positioned at 0, when active is the base diagram with steps", () => {
    const diagrams = ["news-feed", "news-feed.step1", "news-feed.step2"];
    expect(buildStepChain(diagrams, "news-feed")).toEqual({
      chain: ["news-feed", "news-feed.step1", "news-feed.step2"],
      index: 0,
    });
  });

  it("positions the index correctly when active is a .stepN", () => {
    const diagrams = ["news-feed", "news-feed.step1", "news-feed.step2"];
    expect(buildStepChain(diagrams, "news-feed.step2")).toEqual({
      chain: ["news-feed", "news-feed.step1", "news-feed.step2"],
      index: 2,
    });
  });

  it("returns null for a diagram with no .stepN siblings (not a chain)", () => {
    const diagrams = ["solo", "other"];
    expect(buildStepChain(diagrams, "solo")).toBeNull();
  });

  it("returns null when active is null/undefined/empty", () => {
    const diagrams = ["news-feed", "news-feed.step1"];
    expect(buildStepChain(diagrams, null)).toBeNull();
    expect(buildStepChain(diagrams, undefined)).toBeNull();
    expect(buildStepChain(diagrams, "")).toBeNull();
  });

  it("returns null when active isn't present in the diagrams list at all", () => {
    expect(buildStepChain(["news-feed", "news-feed.step1"], "ghost")).toBeNull();
  });

  it("sorts numerically, not lexically, so step10 lands after step9", () => {
    const diagrams = ["news-feed", "news-feed.step1", "news-feed.step2", "news-feed.step9", "news-feed.step10"];
    const result = buildStepChain(diagrams, "news-feed.step10");
    expect(result).toEqual({
      chain: ["news-feed", "news-feed.step1", "news-feed.step2", "news-feed.step9", "news-feed.step10"],
      index: 4,
    });
  });

  it("builds a chain for orphan steps with no base diagram present", () => {
    const diagrams = ["orphan.step1", "orphan.step2"];
    expect(buildStepChain(diagrams, "orphan.step1")).toEqual({
      chain: ["orphan", "orphan.step1", "orphan.step2"],
      index: 1,
    });
  });
});
