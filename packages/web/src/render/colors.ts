/**
 * Named color palette — theme B ("dark blueprint"). `DiagramNode.color` /
 * `DiagramGroup.color` carry a theme-agnostic token name (e.g. `"orange"`),
 * never a raw CSS color; this module is the single place that resolves a
 * name to an actual value for the current theme. When v1.1 adds a light
 * theme, only the hex values below need to change — call sites stay the
 * same.
 *
 * Hex values are drawn from the theme B reference palette in
 * `spikes/reactflow-elk-layout/src/styles.css` / `App.tsx` so nodes match
 * the approved visual spike.
 */
const NAMED_COLORS: Readonly<Record<string, string>> = Object.freeze({
  blue: "#336fe0",
  orange: "#ff9900",
  green: "#28c840",
  red: "#ff6b6b",
  purple: "#8a63d2",
  pink: "#d64ea3",
  yellow: "#ffb454",
  teal: "#61dafb",
  gray: "#7f92c0",
});

/**
 * Resolves a DSL color token name (case-insensitive, whitespace-trimmed)
 * to a CSS color value. Never throws: an unrecognized name or a missing
 * `color` both fall back to the theme's default accent token
 * (`var(--accent)`), so an unknown color still renders instead of
 * breaking the diagram.
 */
export function resolveColor(name?: string): string {
  if (name === undefined) return "var(--accent)";
  return NAMED_COLORS[name.trim().toLowerCase()] ?? "var(--accent)";
}
