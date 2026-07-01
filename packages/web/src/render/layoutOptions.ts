/**
 * Layout preferences — spacing preset + an optional temporary direction
 * override, persisted to `localStorage`. Pure state module (no React, no
 * DOM APIs beyond `Storage`) so it's trivially unit-testable; `App.tsx`
 * owns the actual `useState`/`useEffect` wiring (T16).
 */
import type { DiagramDoc, Direction } from "@diagram-copilot/core";
import type { LayoutOptions } from "@diagram-copilot/layout";

/** One of the spacing presets `@diagram-copilot/layout` understands. */
export type SpacingPreset = NonNullable<LayoutOptions["spacing"]>;

/** Display order for the spacing toggle in the toolbar. */
export const SPACING_PRESET_ORDER: readonly SpacingPreset[] = ["compact", "normal", "airy"];

/** Display order for the direction toggle in the toolbar (→ ↓ ← ↑). */
export const DIRECTION_ORDER: readonly Direction[] = ["right", "down", "left", "up"];

/**
 * User-controlled layout preferences.
 *
 * `directionOverride` is *temporary* relative to the document: when absent,
 * layout follows `doc.direction` ("auto"); when set, it wins until the user
 * picks "auto" again or another direction.
 */
export interface LayoutPrefs {
  spacing: SpacingPreset;
  directionOverride?: Direction;
}

/** Default prefs when nothing is persisted yet. */
export const DEFAULT_LAYOUT_PREFS: LayoutPrefs = { spacing: "normal" };

/** `localStorage` key layout prefs are persisted under. */
export const LAYOUT_PREFS_STORAGE_KEY = "dgc.layoutPrefs";

function isSpacingPreset(value: unknown): value is SpacingPreset {
  return value === "compact" || value === "normal" || value === "airy";
}

function isDirection(value: unknown): value is Direction {
  return value === "right" || value === "left" || value === "up" || value === "down";
}

/** Minimal slice of `Storage` this module needs — narrows the test surface. */
export type PrefsStorage = Pick<Storage, "getItem" | "setItem">;

/** Parse persisted JSON defensively; malformed/missing/partial data falls back to defaults. */
function parsePrefs(raw: string | null): LayoutPrefs {
  if (!raw) return { ...DEFAULT_LAYOUT_PREFS };
  try {
    const parsed: unknown = JSON.parse(raw);
    const spacing =
      typeof parsed === "object" && parsed !== null && isSpacingPreset((parsed as Record<string, unknown>).spacing)
        ? (parsed as { spacing: SpacingPreset }).spacing
        : DEFAULT_LAYOUT_PREFS.spacing;
    const rawDirection =
      typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).directionOverride : undefined;
    return isDirection(rawDirection) ? { spacing, directionOverride: rawDirection } : { spacing };
  } catch {
    return { ...DEFAULT_LAYOUT_PREFS };
  }
}

/** Load persisted prefs. Defaults to `window.localStorage`; pass a mock `Storage` in tests. */
export function loadLayoutPrefs(storage: PrefsStorage = window.localStorage): LayoutPrefs {
  return parsePrefs(storage.getItem(LAYOUT_PREFS_STORAGE_KEY));
}

/** Persist prefs. Defaults to `window.localStorage`; pass a mock `Storage` in tests. */
export function saveLayoutPrefs(prefs: LayoutPrefs, storage: PrefsStorage = window.localStorage): void {
  storage.setItem(LAYOUT_PREFS_STORAGE_KEY, JSON.stringify(prefs));
}

/**
 * Resolve prefs against a document: `directionOverride` (when set) wins over
 * `doc.direction`, expressed as a *new* doc object — `doc` itself is never
 * mutated, since callers (and the layout cache) may still hold a reference to
 * it. `spacing` passes straight through to `layoutDiagram`'s options.
 */
export function applyPrefs(doc: DiagramDoc, prefs: LayoutPrefs): { doc: DiagramDoc; options: LayoutOptions } {
  const nextDoc: DiagramDoc = prefs.directionOverride ? { ...doc, direction: prefs.directionOverride } : doc;
  return { doc: nextDoc, options: { spacing: prefs.spacing } };
}
