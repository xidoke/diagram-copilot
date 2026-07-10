/**
 * Floating layout toolbar (top-right) — two segmented clusters (DGC-94):
 *   - Layout: spacing (compact / normal / airy, radio-style) · direction
 *     (→ ↓ ← ↑ + "auto", radio-style) · reset dragged positions.
 *   - View: theme toggle (DGC-70) · present mode (DGC-73) · icon palette
 *     (DGC-77) · the export menu (passed in as `children` so it keeps owning
 *     its name/version props and dropdown state in App.tsx/ExportMenu.tsx).
 *
 * All glyphs come from ONE family (lucide-static via toolbarIcons.tsx) so the
 * chrome reads as a single system; tooltips stay on `title` as before.
 *
 * Pure presentational component for spacing/direction — `onChange` is the
 * only way that state moves, so `App.tsx` owns the actual prefs state +
 * persistence (T16). The theme toggle is the one exception: it owns its
 * `useTheme()` call directly (see `theme.ts`) since it's an unrelated,
 * self-contained concern — routing it through `App.tsx`'s prefs plumbing
 * would just add a prop only this button reads.
 */
import type { ReactNode } from "react";
import type { Direction } from "@diagram-copilot/core";
import {
  DIRECTION_ORDER,
  SPACING_PRESET_ORDER,
  type LayoutPrefs,
  type SpacingPreset,
} from "../render/layoutOptions.js";
import { useTheme } from "../theme.js";
import { IconPalette } from "./IconPalette.js";
import { TOOLBAR_ICONS, ToolbarIcon } from "./toolbarIcons.js";

const SPACING_META: Record<SpacingPreset, { icon: string; title: string }> = {
  compact: { icon: TOOLBAR_ICONS.spacingCompact, title: "Spacing: compact" },
  normal: { icon: TOOLBAR_ICONS.spacingNormal, title: "Spacing: normal" },
  airy: { icon: TOOLBAR_ICONS.spacingAiry, title: "Spacing: airy" },
};

const DIRECTION_META: Record<Direction, { icon: string; title: string }> = {
  right: { icon: TOOLBAR_ICONS.directionRight, title: "Direction: left to right" },
  down: { icon: TOOLBAR_ICONS.directionDown, title: "Direction: top to bottom" },
  left: { icon: TOOLBAR_ICONS.directionLeft, title: "Direction: right to left" },
  up: { icon: TOOLBAR_ICONS.directionUp, title: "Direction: bottom to top" },
};

export interface ToolbarProps {
  prefs: LayoutPrefs;
  onChange: (prefs: LayoutPrefs) => void;
  /**
   * Clear all manually dragged positions for the active diagram (T30). Omitted
   * → the reset button is hidden (e.g. before any diagram is loaded).
   */
  onResetLayout?: () => void;
  /** Enter present mode (DGC-73) — the play button; also bound to ⌘⇧P. */
  onPresent?: () => void;
  /**
   * Presentational slot: extra view actions rendered at the end of the View
   * cluster — App.tsx passes the ExportMenu here so it keeps its own props
   * and dropdown state (DGC-94).
   */
  children?: ReactNode;
}

export function Toolbar({ prefs, onChange, onResetLayout, onPresent, children }: ToolbarProps) {
  const { theme, toggleTheme } = useTheme();
  return (
    <div className="toolbar">
      <div className="toolbar-cluster" role="group" aria-label="Layout">
        <div className="toolbar-group" role="group" aria-label="Spacing">
          {SPACING_PRESET_ORDER.map((preset) => {
            const meta = SPACING_META[preset];
            const active = prefs.spacing === preset;
            return (
              <button
                key={preset}
                type="button"
                title={meta.title}
                aria-label={meta.title}
                aria-pressed={active}
                className={`toolbar-btn${active ? " toolbar-btn--active" : ""}`}
                onClick={() => onChange({ ...prefs, spacing: preset })}
              >
                <ToolbarIcon svg={meta.icon} />
              </button>
            );
          })}
        </div>
        <span className="toolbar-sep" aria-hidden="true" />
        <div className="toolbar-group" role="group" aria-label="Direction">
          {DIRECTION_ORDER.map((direction) => {
            const meta = DIRECTION_META[direction];
            const active = prefs.directionOverride === direction;
            return (
              <button
                key={direction}
                type="button"
                title={meta.title}
                aria-label={meta.title}
                aria-pressed={active}
                className={`toolbar-btn${active ? " toolbar-btn--active" : ""}`}
                onClick={() => onChange({ ...prefs, directionOverride: direction })}
              >
                <ToolbarIcon svg={meta.icon} />
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
        {onResetLayout && (
          <>
            <span className="toolbar-sep" aria-hidden="true" />
            <button
              type="button"
              title="Reset layout: clear manually dragged positions"
              aria-label="Reset layout"
              className="toolbar-btn"
              onClick={onResetLayout}
            >
              <ToolbarIcon svg={TOOLBAR_ICONS.reset} />
            </button>
          </>
        )}
      </div>
      <div className="toolbar-cluster" role="group" aria-label="View">
        <button
          type="button"
          title={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
          aria-pressed={theme === "light"}
          className="toolbar-btn"
          onClick={toggleTheme}
        >
          <ToolbarIcon svg={theme === "dark" ? TOOLBAR_ICONS.themeToLight : TOOLBAR_ICONS.themeToDark} />
        </button>
        {onPresent && (
          <button
            type="button"
            title="Present mode · ⌘⇧P"
            aria-label="Enter present mode"
            className="toolbar-btn"
            onClick={onPresent}
          >
            <ToolbarIcon svg={TOOLBAR_ICONS.present} />
          </button>
        )}
        {/* Icon palette (DGC-77) — self-contained: owns its own popover + copy
            state, so App.tsx doesn't need to plumb anything through here. */}
        <IconPalette />
        {children}
      </div>
    </div>
  );
}
