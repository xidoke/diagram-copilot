import { describe, expect, it } from "vitest";
import { COLOR_TOKENS, resolveColor } from "../../src/render/colors.js";

describe("resolveColor", () => {
  it("resolves known named colors to theme B hex values", () => {
    expect(resolveColor("orange")).toBe("#ff9900");
    expect(resolveColor("blue")).toBe("#336fe0");
    expect(resolveColor("green")).toBe("#28c840");
    expect(resolveColor("red")).toBe("#ff6b6b");
    expect(resolveColor("purple")).toBe("#8a63d2");
    expect(resolveColor("pink")).toBe("#d64ea3");
    expect(resolveColor("yellow")).toBe("#ffb454");
    expect(resolveColor("teal")).toBe("#61dafb");
    expect(resolveColor("gray")).toBe("#7f92c0");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveColor("Orange")).toBe("#ff9900");
    expect(resolveColor("  BLUE  ")).toBe("#336fe0");
  });

  it("falls back to the theme accent when color is undefined", () => {
    expect(resolveColor(undefined)).toBe("var(--accent)");
  });

  it("falls back to the theme accent for an unrecognized name", () => {
    expect(resolveColor("mystery-color")).toBe("var(--accent)");
    expect(resolveColor("")).toBe("var(--accent)");
  });
});

describe("COLOR_TOKENS", () => {
  it("lists exactly the DSL-supported color names, each resolvable (context-menu swatches source)", () => {
    expect(COLOR_TOKENS).toEqual(["blue", "orange", "green", "red", "purple", "pink", "yellow", "teal", "gray"]);
    for (const token of COLOR_TOKENS) {
      // Every swatch token must resolve to a real hex value, not the fallback.
      expect(resolveColor(token)).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
