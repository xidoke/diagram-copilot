/**
 * Opt-in icon pack loader (DGC-99) — the server-side counterpart of the
 * web's vite-glob loader (`packages/web/src/iconPacks.ts`).
 *
 * Packs are generated locally (e.g. `pnpm icons:aws`) into
 * `packages/icons/packs/*.icons.json` — gitignored vendor artwork that is
 * licensed for USE in diagrams but not for redistribution. At startup the
 * server reads every pack file from that directory and registers it on the
 * shared `@diagram-copilot/icons` registry, so `list_icons` advertises
 * `aws:*` ids exactly when (and only when) the user has installed the pack.
 * No packs installed → the directory simply doesn't exist and this is a
 * silent no-op.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { registerIconPack, type IconPackDef, type IconPackInfo } from "@diagram-copilot/icons";

/**
 * The `packs/` directory inside the installed `@diagram-copilot/icons`
 * package (resolved through its exports map, so this works from both
 * `src/` under tsx and `dist/` after build), or `null` when the package
 * can't be resolved (never expected in practice, but a missing icons dep
 * must not take the whole server down).
 */
export function defaultIconPacksDir(): string | null {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@diagram-copilot/icons/package.json");
    return path.join(path.dirname(pkgJson), "packs");
  } catch {
    return null;
  }
}

/**
 * Loads and registers every `*.icons.json` pack in `dir` (sorted, so
 * multi-pack registration order is deterministic). Returns the packs that
 * registered successfully; a malformed file is warned about and skipped —
 * one broken pack must not stop the server or the other packs.
 */
export function loadIconPacksFromDisk(
  dir: string | null = defaultIconPacksDir(),
  warn: (message: string) => void = (message) => console.warn(message),
): IconPackInfo[] {
  if (dir === null || !fs.existsSync(dir)) return [];
  const loaded: IconPackInfo[] = [];
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".icons.json"))
    .sort();
  for (const name of files) {
    const file = path.join(dir, name);
    try {
      const def = JSON.parse(fs.readFileSync(file, "utf8")) as IconPackDef;
      loaded.push(registerIconPack(def));
    } catch (error) {
      warn(`[icons] skipping pack ${file}: ${(error as Error).message}`);
    }
  }
  return loaded;
}
