/**
 * Floating layout toolbar (top-right) — mirrors the translucent panel look
 * of `.diagram-info`. Three groups:
 *   - Spacing: compact / normal / airy, radio-style (always exactly one active).
 *   - Direction: → ↓ ← ↑ plus "auto" (clears the override, follows the
 *     document's own `direction`). Also radio-style.
 *   - Theme: a single ☀/🌙 toggle (DGC-70) between dark (theme B) and light
 *     (theme A).
 *
 * Pure presentational component for spacing/direction — `onChange` is the
 * only way that state moves, so `App.tsx` owns the actual prefs state +
 * persistence (T16). The theme toggle is the one exception: it owns its
 * `useTheme()` call directly (see `theme.ts`) since it's an unrelated,
 * self-contained concern — routing it through `App.tsx`'s prefs plumbing
 * would just add a prop only this button reads.
 */
import type { Direction } from "@diagram-copilot/core";
import {
  DIRECTION_ORDER,
  SPACING_PRESET_ORDER,
  type LayoutPrefs,
  type SpacingPreset,
} from "../render/layoutOptions.js";
import { useTheme } from "../theme.js";
import { IconPalette } from "./IconPalette.js";

const SPACING_META: Record<SpacingPreset, { label: string; title: string }> = {
  compact: { label: "C", title: "Spacing: compact" },
  normal: { label: "N", title: "Spacing: normal" },
  airy: { label: "A", title: "Spacing: airy" },
};

const DIRECTION_META: Record<Direction, { icon: string; title: string }> = {
  right: { icon: "→", title: "Direction: left to right" },
  down: { icon: "↓", title: "Direction: top to bottom" },
  left: { icon: "←", title: "Direction: right to left" },
  up: { icon: "↑", title: "Direction: bottom to top" },
};

export interface ToolbarProps {
  prefs: LayoutPrefs;
  onChange: (prefs: LayoutPrefs) => void;
  /**
   * Clear all manually dragged positions for the active diagram (T30). Omitted
   * → the reset button is hidden (e.g. before any diagram is loaded).
   */
  onResetLayout?: () => void;
  /** Enter present mode (DGC-73) — the ▶ button; also bound to ⌘⇧P. */
  onPresent?: () => void;
}

export function Toolbar({ prefs, onChange, onResetLayout, onPresent }: ToolbarProps) {
  const { theme, toggleTheme } = useTheme();
  return (
    <div className="toolbar">
      <div className="toolbar-group" role="group" aria-label="Spacing">
        {SPACING_PRESET_ORDER.map((preset) => {
          const meta = SPACING_META[preset];
          const active = prefs.spacing === preset;
          return (
            <button
              key={preset}
              type="button"
              title={meta.title}
              aria-pressed={active}
              className={`toolbar-btn${active ? " toolbar-btn--active" : ""}`}
              onClick={() => onChange({ ...prefs, spacing: preset })}
            >
              {meta.label}
            </button>
          );
        })}
        {onResetLayout && (
          <button
            type="button"
            title="Reset layout: clear manually dragged positions"
            aria-label="Reset layout"
            className="toolbar-btn"
            onClick={onResetLayout}
          >
            ⟲
          </button>
        )}
      </div>
      <div className="toolbar-group" role="group" aria-label="Direction">
        {DIRECTION_ORDER.map((direction) => {
          const meta = DIRECTION_META[direction];
          const active = prefs.directionOverride === direction;
          return (
            <button
              key={direction}
              type="button"
              title={meta.title}
              aria-pressed={active}
              className={`toolbar-btn${active ? " toolbar-btn--active" : ""}`}
              onClick={() => onChange({ ...prefs, directionOverride: direction })}
            >
              {meta.icon}
            </button>
          );
        })}
        <button
          type="button"
          title="Direction: auto (follow the diagram)"
          aria-pressed={prefs.directionOverride === undefined}
          className={`toolbar-btn toolbar-btn--auto${prefs.directionOverride === undefined ? " toolbar-btn--active" : ""}`}
          onClick={() => onChange({ spacing: prefs.spacing })}
        >
          auto
        </button>
      </div>
      <div className="toolbar-group" role="group" aria-label="Theme">
        <button
          type="button"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-pressed={theme === "light"}
          className="toolbar-btn"
          onClick={toggleTheme}
        >
          {theme === "dark" ? "☀" : "🌙"}
        </button>
        {onPresent && (
          <button
            type="button"
            title="Present mode · ⌘⇧P"
            aria-label="Enter present mode"
            className="toolbar-btn"
            onClick={onPresent}
          >
            ▶
          </button>
        )}
        {/* Icon palette (DGC-77) — self-contained: owns its own popover + copy
            state, so App.tsx doesn't need to plumb anything through here. */}
        <IconPalette />
      </div>
    </div>
  );
}
