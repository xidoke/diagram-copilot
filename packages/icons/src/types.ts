/**
 * Where an icon's artwork originates from.
 *
 * - `lucide`: generic/UX icon from the `lucide-static` package (ISC).
 * - `simple-icons`: technology/product logo from the `simple-icons`
 *   package (CC0-1.0 artwork; the brand itself remains a trademark of its
 *   owner — see ATTRIBUTION.md).
 * - `builtin`: not a real registry entry — the soft-fallback icon returned
 *   by {@link getIcon} for an id that isn't recognized.
 */
export type IconSource = "lucide" | "simple-icons" | "builtin";

/**
 * A single icon: enough metadata to render it and to credit its source
 * package/license.
 */
export interface IconMeta {
  /** Canonical kebab-case id, e.g. `"postgresql"`, `"hard-drive"`. For a
   * fallback icon, this is the original (unrecognized) input instead. */
  id: string;
  /** Human-readable display name, e.g. `"PostgreSQL"`. */
  title: string;
  /** Origin the artwork was baked from. */
  source: IconSource;
  /** License identifier for the artwork (e.g. `"ISC"`, `"CC0-1.0"`). */
  license: string;
  /** Full `<svg>...</svg>` markup. Uses `currentColor` so it inherits the
   * caller's text/fill color instead of a baked-in one. */
  svg: string;
}
