/**
 * Toolbar icon set (DGC-94) — ONE consistent family for all chrome buttons:
 * lucide-static SVG strings, the same package @diagram-copilot/icons bakes its
 * infra glyphs from, so the chrome and the canvas share a single icon language
 * (and the workspace gains no new third-party dependency).
 *
 * Every string is baked, trusted markup shipped inside lucide-static (ISC) with
 * `stroke="currentColor"`, so a glyph inherits its button's text color — the
 * same injection pattern IconPalette already uses for registry icons.
 */
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Download,
  Moon,
  Palette,
  Play,
  RotateCcw,
  Rows2,
  Rows3,
  Rows4,
  Sun,
  ZapOff,
} from "lucide-static";

/** Chrome glyphs by role. Spacing maps density literally: more rows = tighter. */
export const TOOLBAR_ICONS = {
  spacingCompact: Rows4,
  spacingNormal: Rows3,
  spacingAiry: Rows2,
  directionRight: ArrowRight,
  directionDown: ArrowDown,
  directionLeft: ArrowLeft,
  directionUp: ArrowUp,
  reset: RotateCcw,
  themeToLight: Sun,
  themeToDark: Moon,
  present: Play,
  palette: Palette,
  export: Download,
  // What-if kill-node simulation (DGC-91) — a cut power bolt: "outage".
  whatIf: ZapOff,
} as const;

/**
 * Renders a lucide-static SVG string at toolbar size (14px, see `.toolbar-icon`
 * in App.css). `aria-hidden` — the owning button carries the accessible name.
 */
export function ToolbarIcon({ svg }: { svg: string }) {
  return <span className="toolbar-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />;
}
