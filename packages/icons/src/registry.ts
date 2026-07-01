import { FALLBACK_LICENSE, FALLBACK_SVG, LUCIDE_ICONS } from "./lucide-icons.js";
import { SIMPLE_ICONS } from "./simple-icons.js";
import type { IconMeta } from "./types.js";

/** All canonical icons keyed by id, baked in at module-load time. */
export const ICONS: Readonly<Record<string, IconMeta>> = Object.freeze(
  Object.fromEntries([...LUCIDE_ICONS, ...SIMPLE_ICONS].map((icon) => [icon.id, icon] as const)),
);

/**
 * Builds the soft-fallback icon for an id that isn't in the registry (and
 * has no alias pointing into it). Never throws: an unrecognized id always
 * renders as a generic box, tagged with the original input `id` and
 * `source: "builtin"` so callers can detect that a substitution happened.
 */
export function buildFallbackIcon(id: string): IconMeta {
  return {
    id,
    title: id,
    source: "builtin",
    license: FALLBACK_LICENSE,
    svg: FALLBACK_SVG,
  };
}
