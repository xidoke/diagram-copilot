import { describe, expect, it } from "vitest";
import type { DiagramDoc } from "@diagram-copilot/core";
import {
  DEFAULT_LAYOUT_PREFS,
  LAYOUT_PREFS_STORAGE_KEY,
  applyPrefs,
  loadLayoutPrefs,
  saveLayoutPrefs,
  type LayoutPrefs,
  type PrefsStorage,
} from "../../src/render/layoutOptions.js";

const doc: DiagramDoc = {
  type: "architecture",
  direction: "right",
  nodes: [{ id: "A", label: "A" }],
  groups: [],
  edges: [],
};

/** A bare-bones in-memory `Storage` mock — no jsdom/localStorage in this test env. */
function createMockStorage(initial: Record<string, string> = {}): PrefsStorage & { data: Record<string, string> } {
  const data: Record<string, string> = { ...initial };
  return {
    data,
    getItem: (key: string) => (key in data ? data[key]! : null),
    setItem: (key: string, value: string) => {
      data[key] = value;
    },
  };
}

describe("applyPrefs", () => {
  it("passes spacing straight through to layout options", () => {
    const { options } = applyPrefs(doc, { spacing: "airy" });
    expect(options).toEqual({ spacing: "airy" });
  });

  it("leaves the doc's direction untouched when there's no override", () => {
    const { doc: nextDoc } = applyPrefs(doc, { spacing: "normal" });
    expect(nextDoc).toBe(doc);
    expect(nextDoc.direction).toBe("right");
  });

  it("overrides the direction with a new doc object, without mutating the original", () => {
    const prefs: LayoutPrefs = { spacing: "compact", directionOverride: "down" };
    const { doc: nextDoc } = applyPrefs(doc, prefs);

    expect(nextDoc).not.toBe(doc);
    expect(nextDoc.direction).toBe("down");
    // Original doc + its collections are untouched.
    expect(doc.direction).toBe("right");
    expect(nextDoc.nodes).toBe(doc.nodes);
    expect(nextDoc.groups).toBe(doc.groups);
    expect(nextDoc.edges).toBe(doc.edges);
  });
});

describe("localStorage round-trip", () => {
  it("loadLayoutPrefs falls back to defaults when storage is empty", () => {
    const storage = createMockStorage();
    expect(loadLayoutPrefs(storage)).toEqual(DEFAULT_LAYOUT_PREFS);
  });

  it("saveLayoutPrefs then loadLayoutPrefs round-trips a full prefs object", () => {
    const storage = createMockStorage();
    const prefs: LayoutPrefs = { spacing: "airy", directionOverride: "up" };

    saveLayoutPrefs(prefs, storage);
    expect(storage.data[LAYOUT_PREFS_STORAGE_KEY]).toBeDefined();
    expect(loadLayoutPrefs(storage)).toEqual(prefs);
  });

  it("round-trips prefs without a direction override", () => {
    const storage = createMockStorage();
    const prefs: LayoutPrefs = { spacing: "compact" };

    saveLayoutPrefs(prefs, storage);
    expect(loadLayoutPrefs(storage)).toEqual(prefs);
  });

  it("ignores malformed JSON and falls back to defaults", () => {
    const storage = createMockStorage({ [LAYOUT_PREFS_STORAGE_KEY]: "{not json" });
    expect(loadLayoutPrefs(storage)).toEqual(DEFAULT_LAYOUT_PREFS);
  });

  it("ignores an invalid spacing/direction value and falls back", () => {
    const storage = createMockStorage({
      [LAYOUT_PREFS_STORAGE_KEY]: JSON.stringify({ spacing: "huge", directionOverride: "sideways" }),
    });
    expect(loadLayoutPrefs(storage)).toEqual(DEFAULT_LAYOUT_PREFS);
  });
});
