/**
 * Opt-in icon pack loader (DGC-99) — the web-side counterpart of the
 * server's `loadIconPacksFromDisk`.
 *
 * Packs are generated locally (e.g. `pnpm icons:aws`) into
 * `packages/icons/packs/*.icons.json` — gitignored vendor artwork, never
 * committed. `import.meta.glob` resolves that pattern at build/dev time:
 * with no packs installed it matches nothing and this module is a no-op;
 * with a pack present the JSON is bundled and registered before the app
 * renders (this module is imported first in `main.tsx`), so `[icon: aws:*]`
 * chips and the 🎨 palette pick it up. Installing/removing a pack needs a
 * dev-server restart (or rebuild) — vite globs don't watch outside `src/`.
 */
import { registerIconPack, type IconPackDef } from "@diagram-copilot/icons";

const packModules = import.meta.glob("../../icons/packs/*.icons.json", { eager: true }) as Record<
  string,
  { default: IconPackDef }
>;

for (const [file, module] of Object.entries(packModules)) {
  try {
    registerIconPack(module.default);
  } catch (error) {
    // A malformed local pack must not blank the whole canvas — warn and run
    // with the built-in set (same policy as the server loader).
    console.warn(`[icons] skipping pack ${file}:`, error);
  }
}
