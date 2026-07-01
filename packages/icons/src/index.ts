/**
 * @diagram-copilot/icons
 *
 * An open, license-safe icon set (~38 icons) for rendering system/backend
 * diagrams: generic infra shapes from `lucide-static` (ISC) plus
 * technology logos from `simple-icons` (CC0-1.0). No hand-drawn artwork
 * and no official AWS/GCP/Azure icons — see ATTRIBUTION.md for the full
 * per-icon license table.
 *
 * All SVG markup is imported from the source packages and baked into the
 * registry at build time (no runtime file reads, no network fetches).
 * Every icon uses `currentColor` so it themes with the surrounding UI.
 *
 * `getIcon` never throws and never returns `undefined`: an id that isn't
 * recognized (directly or via {@link ALIASES}) resolves to a generic
 * "box" fallback tagged `source: "builtin"`.
 */
import { ALIASES } from "./aliases.js";
import { buildFallbackIcon, ICONS } from "./registry.js";
import type { IconMeta, IconSource } from "./types.js";

export type { IconMeta, IconSource };
export { ALIASES } from "./aliases.js";

function normalize(id: string): string {
  return id.trim().toLowerCase();
}

/** Resolves an id/alias to a canonical registry key, or `undefined` if unknown. */
function resolveCanonicalId(id: string): string | undefined {
  const key = normalize(id);
  if (key in ICONS) return key;
  const aliased = ALIASES[key];
  if (aliased !== undefined && aliased in ICONS) return aliased;
  return undefined;
}

/**
 * Looks up an icon by canonical id or known alias (case-insensitive,
 * whitespace-trimmed). Never returns `undefined` and never throws: an
 * unrecognized id resolves to the generic "box" fallback with `id` set to
 * the original input and `source: "builtin"`, so an unknown service still
 * renders something instead of breaking the diagram.
 */
export function getIcon(id: string): IconMeta {
  const canonical = resolveCanonicalId(id);
  return canonical !== undefined ? ICONS[canonical] : buildFallbackIcon(id);
}

/** True if `id` (or one of its aliases) resolves to a real registry entry. */
export function hasIcon(id: string): boolean {
  return resolveCanonicalId(id) !== undefined;
}

/**
 * Lists registry icons (never the fallback), optionally filtered by a
 * case-insensitive substring match against id or title.
 */
export function listIcons(query?: string): IconMeta[] {
  const all = Object.values(ICONS);
  if (query === undefined || query.trim() === "") return all;
  const q = normalize(query);
  return all.filter((icon) => icon.id.includes(q) || icon.title.toLowerCase().includes(q));
}
