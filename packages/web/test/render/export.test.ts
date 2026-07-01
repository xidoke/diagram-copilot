import { describe, expect, it } from "vitest";
import {
  buildExportFilename,
  computeExportRect,
  copyPngToClipboard,
  EXPORT_PADDING,
  EXPORT_SCALE,
  exportPng,
  exportSvg,
  MAX_EXPORT_DIMENSION,
} from "../../src/render/export.js";

/**
 * `computeExportRect` is the pure half of export.ts — bbox + padding + scale
 * → raster canvas size + the translate/zoom transform for
 * `.react-flow__viewport`. No DOM needed, matching this package's node-only
 * vitest convention. Expected numbers below were cross-checked against
 * `@xyflow/react`'s own `getViewportForBounds` (which computeExportRect
 * delegates to for the x/y transform).
 */
describe("computeExportRect", () => {
  it("pads the bbox and scales it by the default padding/scale", () => {
    const rect = computeExportRect({ x: 100, y: 200, width: 300, height: 150 });
    // padded bbox = { x: 76, y: 176, width: 348, height: 198 } (24px padding
    // each side), then scaled 2x: 696×396.
    expect(rect).toEqual({ width: 696, height: 396, zoom: 2, x: -152, y: -352 });
  });

  it("honors explicit padding and scale overrides", () => {
    const rect = computeExportRect({ x: 0, y: 0, width: 100, height: 100 }, 10, 3);
    // padded bbox = { x: -10, y: -10, width: 120, height: 120 }, scaled 3x: 360×360.
    expect(rect).toEqual({ width: 360, height: 360, zoom: 3, x: 30, y: 30 });
  });

  it("uses the module defaults (EXPORT_PADDING=24, EXPORT_SCALE=2) when not overridden", () => {
    expect(EXPORT_PADDING).toBe(24);
    expect(EXPORT_SCALE).toBe(2);
    const withDefaults = computeExportRect({ x: 0, y: 0, width: 100, height: 100 });
    const withExplicitDefaults = computeExportRect({ x: 0, y: 0, width: 100, height: 100 }, EXPORT_PADDING, EXPORT_SCALE);
    expect(withDefaults).toEqual(withExplicitDefaults);
  });

  it("degrades a 0-node (empty) bbox to a padding-sized canvas instead of NaN/0×0", () => {
    const rect = computeExportRect({ x: 0, y: 0, width: 0, height: 0 });
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);
    expect(Number.isFinite(rect.x)).toBe(true);
    expect(Number.isFinite(rect.y)).toBe(true);
  });

  it("clamps the raster size to MAX_EXPORT_DIMENSION on the binding axis, preserving aspect ratio", () => {
    const rect = computeExportRect({ x: 0, y: 0, width: 20000, height: 10000 });
    // width is the more-constraining axis here (wide diagram) so it lands
    // exactly on the cap; height shrinks proportionally instead of clipping.
    expect(rect.width).toBe(MAX_EXPORT_DIMENSION);
    expect(rect.height).toBeLessThan(MAX_EXPORT_DIMENSION);
    expect(rect.height).toBeGreaterThan(0);
    // zoom must shrink below the requested scale once clamped.
    expect(rect.zoom).toBeLessThan(EXPORT_SCALE);

    // Aspect ratio of the padded bbox is preserved within rounding.
    const padded = { width: 20000 + EXPORT_PADDING * 2, height: 10000 + EXPORT_PADDING * 2 };
    expect(rect.width / rect.height).toBeCloseTo(padded.width / padded.height, 1);
  });

  it("never exceeds MAX_EXPORT_DIMENSION on either axis even for extreme bounds", () => {
    const rect = computeExportRect({ x: 0, y: 0, width: 100000, height: 5 });
    expect(rect.width).toBeLessThanOrEqual(MAX_EXPORT_DIMENSION);
    expect(rect.height).toBeLessThanOrEqual(MAX_EXPORT_DIMENSION);
  });

  it("leaves small diagrams unclamped (clamp is a no-op under the cap)", () => {
    const rect = computeExportRect({ x: 0, y: 0, width: 400, height: 300 });
    expect(rect.zoom).toBe(EXPORT_SCALE);
  });
});

describe("buildExportFilename", () => {
  it('builds "<name>-v<version>.<ext>"', () => {
    expect(buildExportFilename("checkout-flow", 3, "png")).toBe("checkout-flow-v3.png");
    expect(buildExportFilename("checkout-flow", 3, "svg")).toBe("checkout-flow-v3.svg");
  });

  it("sanitizes spaces and filesystem-unsafe characters in the diagram name", () => {
    expect(buildExportFilename("My Diagram/v2:test", 1, "png")).toBe("My-Diagram-v2-test-v1.png");
  });

  it("falls back to 'diagram' for an empty/whitespace-only name", () => {
    expect(buildExportFilename("   ", 5, "png")).toBe("diagram-v5.png");
    expect(buildExportFilename("", 0, "svg")).toBe("diagram-v0.svg");
  });
});

/**
 * html-to-image drives an actual `<canvas>`/`Image`/clipboard pipeline that
 * needs a real browser DOM — not testable under plain Node/vitest (no
 * jsdom in this package, per its existing hook-free component tests). These
 * are smoke tests only: importing the module must not throw (proves
 * html-to-image resolves and has no top-level DOM access) and the exported
 * functions must have the right shape.
 */
describe("export.ts (smoke)", () => {
  it("exposes exportPng, exportSvg, copyPngToClipboard as callable functions", () => {
    expect(typeof exportPng).toBe("function");
    expect(typeof exportSvg).toBe("function");
    expect(typeof copyPngToClipboard).toBe("function");
  });
});
