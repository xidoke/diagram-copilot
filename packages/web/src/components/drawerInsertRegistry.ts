/**
 * Drawer insert registry (T-VE3 / DGC-80) — lets other UI (the icon palette,
 * for now) insert text at the Monaco cursor of the open DSL drawer, without
 * either side depending on the other directly.
 *
 * Mirrors the module-level registry pattern already used for
 * `setSnapshotProvider` in `render/snapshotResponder.ts`: `Drawer` owns the
 * Monaco editor instance and is the only thing that can reach it, so it
 * registers an inserter function when the editor is mounted AND the drawer
 * is open, and clears it (passing `null`) the moment either stops being true
 * (drawer closed, or the component unmounts). Callers never see the editor —
 * they just get a boolean back from {@link insertIntoDrawer} telling them
 * whether the text landed anywhere.
 */

/** Inserts `text` at the current cursor/selection of the open drawer editor. */
export type DrawerInsertFn = (text: string) => void;

let inserter: DrawerInsertFn | null = null;

/** Register (or clear, with `null`) the active inserter. Called by Drawer. */
export function registerDrawerInsert(fn: DrawerInsertFn | null): void {
  inserter = fn;
}

/**
 * Insert `text` into the open drawer's editor at its cursor/selection.
 * Returns `false` — a pure no-op — when the drawer is closed or no editor
 * has ever registered, so callers (e.g. IconPalette) can fall back to a
 * different behavior (copy to clipboard) instead of failing silently.
 */
export function insertIntoDrawer(text: string): boolean {
  if (!inserter) return false;
  inserter(text);
  return true;
}
