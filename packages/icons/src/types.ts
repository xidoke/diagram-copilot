/**
 * Where an icon's artwork originates from.
 *
 * - `lucide`: generic/UX icon from the `lucide-static` package (ISC).
 * - `simple-icons`: technology/product logo from the `simple-icons`
 *   package (CC0-1.0 artwork; the brand itself remains a trademark of its
 *   owner — see ATTRIBUTION.md).
 * - `pack`: glyph from an opt-in, locally-generated icon pack (e.g. the
 *   official AWS Architecture Icons via `pnpm icons:aws`). Pack artwork is
 *   never committed to this repo — see `src/packs.ts` and ATTRIBUTION.md.
 * - `builtin`: not a real registry entry — the soft-fallback icon returned
 *   by {@link getIcon} for an id that isn't recognized.
 */
export type IconSource = "lucide" | "simple-icons" | "pack" | "builtin";

/**
 * A single icon: enough metadata to render it and to credit its source
 * package/license.
 */
export interface IconMeta {
  /** Canonical kebab-case id, e.g. `"postgresql"`, `"hard-drive"`. Pack
   * icons are namespaced, e.g. `"aws:dynamodb"`. For a fallback icon, this
   * is the original (unrecognized) input instead. */
  id: string;
  /** Human-readable display name, e.g. `"PostgreSQL"`. */
  title: string;
  /** Origin the artwork was baked from. */
  source: IconSource;
  /** Pack namespace (e.g. `"aws"`) — set only when `source` is `"pack"`. */
  pack?: string;
  /** License identifier for the artwork (e.g. `"ISC"`, `"CC0-1.0"`). */
  license: string;
  /** Full `<svg>...</svg>` markup. Open-set icons use `currentColor` so
   * they inherit the caller's text/fill color; pack glyphs (official vendor
   * artwork) keep their baked-in colors verbatim instead — vendor terms
   * (e.g. AWS) forbid altering the artwork, so no recoloring is applied. */
  svg: string;
}
