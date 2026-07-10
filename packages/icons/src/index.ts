/**
 * @diagram-copilot/icons
 *
 * An open, license-safe icon set (~38 icons) for rendering system/backend
 * diagrams: generic infra shapes from `lucide-static` (ISC) plus
 * technology logos from `simple-icons` (CC0-1.0). No hand-drawn artwork
 * and no committed AWS/GCP/Azure icons — see ATTRIBUTION.md for the full
 * per-icon license table.
 *
 * All SVG markup is imported from the source packages and baked into the
 * registry at build time (no runtime file reads, no network fetches).
 * Every baked icon uses `currentColor` so it themes with the surrounding
 * UI.
 *
 * Opt-in icon PACKS (DGC-99) extend the registry at runtime with official
 * vendor glyphs (e.g. `pnpm icons:aws` → `[icon: aws:s3]`) without any
 * artwork entering the repo — see `src/packs.ts`. Pack resolution never
 * shadows a built-in id, and a namespaced id whose pack isn't installed
 * falls back to the generic box like any unknown id.
 *
 * `getIcon` never throws and never returns `undefined`: an id that isn't
 * recognized (directly, via {@link ALIASES}, or via a registered pack)
 * resolves to a generic "box" fallback tagged `source: "builtin"`.
 */
import { ALIASES } from "./aliases.js";
import { listPackIcons, packAliases, resolvePackIcon } from "./packs.js";
import { buildFallbackIcon, ICONS } from "./registry.js";
import type { IconMeta, IconSource } from "./types.js";

export type { IconMeta, IconSource };
export { ALIASES } from "./aliases.js";
export {
  registerIconPack,
  unregisterIconPack,
  registeredIconPacks,
  type IconPackDef,
  type IconPackIconDef,
  type IconPackInfo,
} from "./packs.js";

function normalize(id: string): string {
  return id.trim().toLowerCase();
}

/** Resolves an id/alias to a canonical BUILT-IN registry key, or `undefined` if unknown. */
function resolveCanonicalId(id: string): string | undefined {
  const key = normalize(id);
  if (key in ICONS) return key;
  const aliased = ALIASES[key];
  if (aliased !== undefined && aliased in ICONS) return aliased;
  return undefined;
}

/** Built-in ids + aliases — bare names packs may never claim (see packAliases). */
const BUILTIN_KEYS: ReadonlySet<string> = new Set([...Object.keys(ICONS), ...Object.keys(ALIASES)]);

/**
 * Looks up an icon by canonical id or known alias (case-insensitive,
 * whitespace-trimmed). Resolution order: built-in registry → built-in
 * aliases → registered icon packs (namespaced `aws:s3` or bare `s3`).
 * Never returns `undefined` and never throws: an unrecognized id resolves
 * to the generic "box" fallback with `id` set to the original input and
 * `source: "builtin"`, so an unknown service (or an uninstalled pack's
 * `aws:*` id) still renders something instead of breaking the diagram.
 */
export function getIcon(id: string): IconMeta {
  const canonical = resolveCanonicalId(id);
  if (canonical !== undefined) return ICONS[canonical];
  return resolvePackIcon(normalize(id)) ?? buildFallbackIcon(id);
}

/** True if `id` resolves to a real entry (built-in, alias, or registered pack). */
export function hasIcon(id: string): boolean {
  return resolveCanonicalId(id) !== undefined || resolvePackIcon(normalize(id)) !== undefined;
}

/**
 * Lists registry icons (never the fallback) — the built-in set plus every
 * registered pack's icons — optionally filtered by a case-insensitive
 * substring match against id or title.
 */
export function listIcons(query?: string): IconMeta[] {
  const all = [...Object.values(ICONS), ...listPackIcons()];
  if (query === undefined || query.trim() === "") return all;
  const q = normalize(query);
  return all.filter((icon) => icon.id.includes(q) || icon.title.toLowerCase().includes(q));
}

/**
 * Every live alias, as `alias → canonical id`: the built-in {@link ALIASES}
 * table plus bare-name shortcuts contributed by registered packs (e.g.
 * `s3 → aws:simple-storage-service`). Pack shortcuts that collide with a
 * built-in id/alias are omitted — those bare names resolve to the built-in
 * icon, and this map never lies about where a name lands.
 */
export function listAliases(): Record<string, string> {
  return { ...ALIASES, ...packAliases(BUILTIN_KEYS) };
}
