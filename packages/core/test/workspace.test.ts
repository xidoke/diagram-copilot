import { describe, expect, it } from "vitest";
import {
  ARCH_EXT,
  LAYOUT_SIDECAR_EXT,
  LayoutOverridesSchema,
  diagramNameFromFile,
  isArchFile,
  layoutSidecarPath,
} from "../src/index.js";

describe("workspace file conventions", () => {
  it("exposes the canonical extensions", () => {
    expect(ARCH_EXT).toBe(".arch");
    expect(LAYOUT_SIDECAR_EXT).toBe(".layout.json");
  });

  it("isArchFile matches .arch files, including snapshot steps and paths", () => {
    expect(isArchFile("news-feed.arch")).toBe(true);
    expect(isArchFile("news-feed.step2.arch")).toBe(true);
    expect(isArchFile("/ws/dir/url-shortener.arch")).toBe(true);
  });

  it("isArchFile rejects everything else", () => {
    expect(isArchFile("news-feed.layout.json")).toBe(false);
    // A diagram's markdown notes sidecar (DGC-63) is NOT a diagram, so it never
    // shows up in list_diagrams / the picker.
    expect(isArchFile("news-feed.notes.md")).toBe(false);
    expect(isArchFile("notes.txt")).toBe(false);
    expect(isArchFile("news-feed.arch.bak")).toBe(false);
    expect(isArchFile(".arch")).toBe(false); // no diagram name
    expect(isArchFile("")).toBe(false);
  });

  it("diagramNameFromFile strips the directory and the .arch extension", () => {
    expect(diagramNameFromFile("news-feed.arch")).toBe("news-feed");
    expect(diagramNameFromFile("news-feed.step2.arch")).toBe("news-feed.step2");
    expect(diagramNameFromFile("/ws/dir/news-feed.arch")).toBe("news-feed");
    expect(diagramNameFromFile("dir\\news-feed.arch")).toBe("news-feed");
  });

  it("diagramNameFromFile leaves names without the extension untouched", () => {
    expect(diagramNameFromFile("news-feed")).toBe("news-feed");
  });

  it("layoutSidecarPath appends the sidecar extension to a diagram name", () => {
    expect(layoutSidecarPath("news-feed")).toBe("news-feed.layout.json");
    expect(layoutSidecarPath("news-feed.step2")).toBe("news-feed.step2.layout.json");
  });
});

describe("LayoutOverridesSchema", () => {
  it("accepts a record of node id → position", () => {
    const result = LayoutOverridesSchema.safeParse({
      api: { x: 120, y: -40.5 },
      db: { x: 0, y: 0 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty record", () => {
    expect(LayoutOverridesSchema.safeParse({}).success).toBe(true);
  });

  it("rejects non-numeric coordinates and missing fields", () => {
    expect(LayoutOverridesSchema.safeParse({ api: { x: "1", y: 2 } }).success).toBe(false);
    expect(LayoutOverridesSchema.safeParse({ api: { x: 1 } }).success).toBe(false);
    expect(LayoutOverridesSchema.safeParse([]).success).toBe(false);
  });
});
