import { describe, expect, it } from "vitest";
import {
  EDGE_TOOLTIP_MIN_CHARS,
  GROUP_TOOLTIP_MIN_CHARS,
  NODE_TOOLTIP_MIN_CHARS,
  tooltipFor,
} from "../../src/render/labelTooltip.js";

describe("tooltipFor — full-text tooltip gate (DGC-100)", () => {
  it("suppresses the tooltip for short labels (no redundant chrome)", () => {
    expect(tooltipFor("Client", "node")).toBeUndefined();
    expect(tooltipFor("cache", "edge")).toBeUndefined();
    expect(tooltipFor("VPC", "group")).toBeUndefined();
  });

  it("returns the full text once a label can plausibly truncate", () => {
    const nodeLabel = "UserRepository · interface — Spring Data sinh implementation";
    expect(tooltipFor(nodeLabel, "node")).toBe(nodeLabel);

    const edgeLabel = "Controller > Client: ⑦ 201 UserResponse — không bao giờ lộ hash password";
    expect(tooltipFor(edgeLabel, "edge")).toBe(edgeLabel);

    const groupLabel = "Registration slice — application layer (hexagonal)";
    expect(tooltipFor(groupLabel, "group")).toBe(groupLabel);
  });

  it("applies the per-kind threshold exactly (boundary)", () => {
    for (const [kind, min] of [
      ["node", NODE_TOOLTIP_MIN_CHARS],
      ["edge", EDGE_TOOLTIP_MIN_CHARS],
      ["group", GROUP_TOOLTIP_MIN_CHARS],
    ] as const) {
      expect(tooltipFor("x".repeat(min), kind)).toBeUndefined();
      expect(tooltipFor("x".repeat(min + 1), kind)).toBe("x".repeat(min + 1));
    }
  });

  it("edge threshold sits at ~2 wrapped lines — a label that fits both lines needs no tooltip", () => {
    // The canvas wraps edge labels to 2 lines (DGC-100 part 3); only text that
    // can still be cut after wrapping earns a tooltip.
    expect(EDGE_TOOLTIP_MIN_CHARS).toBeGreaterThan(NODE_TOOLTIP_MIN_CHARS - 1);
  });
});
