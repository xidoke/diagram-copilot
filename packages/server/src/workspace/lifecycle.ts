/**
 * Diagram lifecycle — rename and trash/restore (DGC-65).
 *
 * The data-safety layer over a diagram's whole on-disk footprint. A diagram is
 * never just its `.arch` source: it drags along a set of sidecars that live
 * next to it in the workspace and must move as one unit, or the diagram loses
 * its layout / notes / undo history:
 *
 *   - `<name>.arch`         — the DSL source (see core `ARCH_EXT`)
 *   - `<name>.layout.json`  — manual node positions (see core `LAYOUT_SIDECAR_EXT`)
 *   - `<name>.notes.md`     — design notes (see `../notes.ts` `NOTES_EXT`)
 *   - `.history/<name>.jsonl` — undo/redo snapshots (see `../history/store.ts`)
 *
 * {@link renameDiagram} moves that whole set to a new stem (refusing to clobber
 * an existing diagram); {@link trashDiagram} moves it into a timestamped folder
 * under `<workspace>/.trash/` so nothing is ever hard-deleted — the receipt tells
 * the caller how to get it back. {@link restoreDiagram} reverses a trash, and
 * {@link listTrash} enumerates what is recoverable.
 *
 * Deleting means "move to `.trash/`", never `rm`: an AI (or a fat-fingered
 * human) deleting the wrong diagram is fully recoverable. Because `.trash` is a
 * directory — not an `.arch` file at the workspace root — the workspace watcher's
 * scan never surfaces its contents in `list_diagrams` or the picker; they are
 * invisible until restored, for free.
 *
 * The filesystem side of every op ends with a single {@link WorkspaceWatcher.resync}
 * so the in-memory view + all connected clients update immediately and
 * consistently, without waiting on the debounced fs watcher.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { ARCH_EXT, LAYOUT_SIDECAR_EXT, isArchFile, diagramNameFromFile } from "@diagram-copilot/core";
import { NOTES_EXT } from "../notes.js";
import type { WorkspaceState } from "./watcher.js";

/** Directory (under the workspace root) trashed diagrams are moved into. */
export const TRASH_DIR = ".trash";

/**
 * Undo-history subdirectory + its per-diagram log extension. Hardcoded here
 * (rather than imported) because `../history/store.ts` keeps them private; kept
 * in sync with it — a diagram's history is `<workspace>/.history/<name>.jsonl`.
 */
const HISTORY_DIR = ".history";
const HISTORY_EXT = ".jsonl";

/**
 * Sidecar extensions that sit at the workspace ROOT next to a diagram's stem,
 * in the order they move (the `.arch` first: it is the diagram itself, and its
 * presence is what a rename/trash is validated against). History is handled
 * separately because it lives one directory down.
 */
const ROOT_ARTIFACT_EXTS = [ARCH_EXT, LAYOUT_SIDECAR_EXT, NOTES_EXT] as const;

/** Outcome of {@link LifecycleOps.rename}. */
export interface RenameResult {
  ok: boolean;
  /** Normalized old stem (or the raw input on a validation failure). */
  oldName: string;
  /** Normalized new stem (or the raw input on a validation failure). */
  newName: string;
  /** Active diagram after the rename (present on success). */
  active?: string | null;
  /** Sidecar extensions that moved alongside the `.arch` (present on success). */
  movedSidecars?: string[];
  /** Human-readable reason when `ok` is `false`. */
  error?: string;
}

/** Outcome of {@link LifecycleOps.trash}. */
export interface TrashResult {
  ok: boolean;
  /** Normalized stem (or the raw input on a validation failure). */
  name: string;
  /** Trash id (the `<timestamp>-<name>` folder) used to restore it (present on success). */
  id?: string;
  /** Active diagram after the trash — the fallback pick, or `null` if none remain. */
  active?: string | null;
  /** Human-readable reason when `ok` is `false`. */
  error?: string;
}

/** One recoverable diagram in the trash. */
export interface TrashEntry {
  /** Folder name under `.trash/` — the id passed to {@link LifecycleOps.restore}. */
  id: string;
  /** Original diagram stem (read from the `.arch` inside the folder). */
  name: string;
  /** When it was trashed (folder mtime, ISO-8601). */
  trashedAt: string;
}

/** Outcome of {@link LifecycleOps.restore}. */
export interface RestoreResult {
  ok: boolean;
  /** Trash id acted on. */
  id: string;
  /** Restored diagram stem (present on success). */
  name?: string;
  /** Human-readable reason when `ok` is `false`. */
  error?: string;
}

/** Rename + trash/restore operations exposed to the MCP tools and HTTP routes. */
export interface LifecycleOps {
  /** Rename a diagram and every sidecar; refuses to overwrite an existing name. */
  rename(oldName: string, newName: string): RenameResult;
  /** Move a diagram + sidecars into the trash (recoverable). */
  trash(name: string): TrashResult;
  /** Every recoverable diagram in the trash, newest first. */
  listTrash(): TrashEntry[];
  /** Restore a trashed diagram (by its trash id) and make it active. */
  restore(id: string): RestoreResult;
}

/**
 * The slice of the workspace watcher the lifecycle ops drive: read current
 * state, and reconcile-then-broadcast after a direct on-disk mutation.
 */
export interface LifecycleHost {
  getState(): WorkspaceState;
  resync(preferActive?: string): void;
}

/** Sanitize outcome — a bare, workspace-safe stem, or the reason it was refused. */
type SanitizeResult = { ok: true; name: string } | { ok: false; error: string };

/**
 * Validate + normalize a caller-supplied name into a bare file stem. Mirrors
 * the workspace watcher's `validateDiagramName` (and the layout/notes handlers):
 * the choke point that keeps a rename/trash target from escaping the workspace
 * via path separators or `..`.
 */
function sanitizeName(raw: string): SanitizeResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Diagram name must not be empty." };
  }
  const name = trimmed.endsWith(ARCH_EXT) ? trimmed.slice(0, -ARCH_EXT.length) : trimmed;
  if (name.length === 0) {
    return { ok: false, error: "Diagram name must not be empty." };
  }
  if (name.includes("/") || name.includes("\\") || name.includes("..")) {
    return {
      ok: false,
      error: `Invalid diagram name "${raw}" — names cannot contain path separators or "..".`,
    };
  }
  return { ok: true, name };
}

/**
 * Validate a trash id — the `.trash/` subfolder name. Same escape guard as a
 * diagram name: no separators or `..`, so `restore` can never read/write outside
 * the trash directory.
 */
function sanitizeTrashId(raw: string): SanitizeResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, error: "Trash id must not be empty." };
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return { ok: false, error: `Invalid trash id "${raw}" — ids cannot contain path separators or "..".` };
  }
  return { ok: true, name: trimmed };
}

/**
 * A filesystem-safe, lexically-sortable timestamp for a trash-folder id:
 * `2026-07-02T10-30-00.000Z` (ISO-8601 with `:` swapped for `-`, which some
 * filesystems disallow in names). Sorting ids ascending sorts them by time.
 */
function trashTimestamp(now: Date): string {
  return now.toISOString().replace(/:/g, "-");
}

/** One artifact move: absolute source + destination. */
interface Move {
  src: string;
  dst: string;
}

/**
 * The full set of moves for relocating a diagram's footprint from `(fromDir,
 * fromStem)` to `(toDir, toStem)` — only for files that actually exist. Root
 * sidecars map ext-for-ext; history maps `fromDir/.history/<stem>.jsonl` →
 * `toDir/.history/<stem>.jsonl`. `label` is the sidecar tag reported in receipts.
 */
function plannedMoves(
  fromDir: string,
  fromStem: string,
  toDir: string,
  toStem: string,
): Array<Move & { label: string }> {
  const moves: Array<Move & { label: string }> = [];
  for (const ext of ROOT_ARTIFACT_EXTS) {
    const src = path.join(fromDir, `${fromStem}${ext}`);
    if (existsSync(src)) moves.push({ src, dst: path.join(toDir, `${toStem}${ext}`), label: ext });
  }
  const histSrc = path.join(fromDir, HISTORY_DIR, `${fromStem}${HISTORY_EXT}`);
  if (existsSync(histSrc)) {
    moves.push({ src: histSrc, dst: path.join(toDir, HISTORY_DIR, `${toStem}${HISTORY_EXT}`), label: HISTORY_EXT });
  }
  return moves;
}

/** Execute a batch of moves, creating destination directories as needed. */
function applyMoves(moves: Move[]): void {
  for (const { src, dst } of moves) {
    mkdirSync(path.dirname(dst), { recursive: true });
    renameSync(src, dst);
  }
}

/**
 * Build the lifecycle ops bound to a workspace `dir`. `getHost` follows the
 * same mutable-watcher-ref pattern as the MCP/HTTP wiring: it returns `null`
 * before the watcher has started, in which case every op fails gracefully.
 */
export function createLifecycleOps(dir: string, getHost: () => LifecycleHost | null): LifecycleOps {
  const root = path.resolve(dir);
  const trashRoot = path.join(root, TRASH_DIR);

  return {
    rename(oldRaw, newRaw) {
      const host = getHost();
      if (host === null) {
        return { ok: false, oldName: oldRaw, newName: newRaw, error: "Workspace is not ready yet — try again in a moment." };
      }
      const oldV = sanitizeName(oldRaw);
      if (!oldV.ok) return { ok: false, oldName: oldRaw, newName: newRaw, error: oldV.error };
      const newV = sanitizeName(newRaw);
      if (!newV.ok) return { ok: false, oldName: oldV.name, newName: newRaw, error: newV.error };
      const oldStem = oldV.name;
      const newStem = newV.name;

      if (oldStem === newStem) {
        return { ok: false, oldName: oldStem, newName: newStem, error: `"${oldStem}" already has that name.` };
      }
      const state = host.getState();
      if (!state.diagrams.includes(oldStem)) {
        return { ok: false, oldName: oldStem, newName: newStem, error: `Diagram "${oldStem}" does not exist.` };
      }
      // Refuse to clobber: check the live list AND disk (a stray `.arch` the
      // watcher has not scanned yet still counts).
      if (state.diagrams.includes(newStem) || existsSync(path.join(root, `${newStem}${ARCH_EXT}`))) {
        return { ok: false, oldName: oldStem, newName: newStem, error: `A diagram named "${newStem}" already exists.` };
      }

      const wasActive = state.active === oldStem;
      const moves = plannedMoves(root, oldStem, root, newStem);
      try {
        applyMoves(moves);
      } catch (error) {
        return { ok: false, oldName: oldStem, newName: newStem, error: `Rename failed: ${(error as Error).message}` };
      }

      // Active follows the new name only when the old one was active; otherwise
      // leave the current pick untouched.
      host.resync(wasActive ? newStem : undefined);
      const movedSidecars = moves.map((m) => m.label).filter((label) => label !== ARCH_EXT);
      return { ok: true, oldName: oldStem, newName: newStem, active: host.getState().active, movedSidecars };
    },

    trash(nameRaw) {
      const host = getHost();
      if (host === null) {
        return { ok: false, name: nameRaw, error: "Workspace is not ready yet — try again in a moment." };
      }
      const v = sanitizeName(nameRaw);
      if (!v.ok) return { ok: false, name: nameRaw, error: v.error };
      const stem = v.name;

      const state = host.getState();
      if (!state.diagrams.includes(stem)) {
        return { ok: false, name: stem, error: `Diagram "${stem}" does not exist.` };
      }

      const id = `${trashTimestamp(new Date())}-${stem}`;
      const trashDir = path.join(trashRoot, id);
      const moves = plannedMoves(root, stem, trashDir, stem);
      try {
        mkdirSync(trashDir, { recursive: true });
        applyMoves(moves);
      } catch (error) {
        return { ok: false, name: stem, error: `Delete failed: ${(error as Error).message}` };
      }

      // Trashing the active diagram clears its sticky choice inside resync, so
      // active falls back to the automatic pick (or null when none remain).
      host.resync();
      return { ok: true, name: stem, id, active: host.getState().active };
    },

    listTrash() {
      let entries: string[];
      try {
        entries = readdirSync(trashRoot);
      } catch {
        return []; // no `.trash` yet
      }
      const result: TrashEntry[] = [];
      for (const id of entries) {
        const trashDir = path.join(trashRoot, id);
        let stat;
        try {
          stat = statSync(trashDir);
        } catch {
          continue;
        }
        if (!stat.isDirectory()) continue;
        // The original name is the stem of the `.arch` inside — robust even if
        // the diagram name contains dashes (the id's `-` separators would not
        // parse reliably).
        const arch = readdirSync(trashDir).find((f) => isArchFile(f));
        if (arch === undefined) continue;
        result.push({ id, name: diagramNameFromFile(arch), trashedAt: stat.mtime.toISOString() });
      }
      // Newest first — ids lead with a sortable timestamp, so descending id order
      // is descending time order.
      return result.sort((a, b) => b.id.localeCompare(a.id));
    },

    restore(idRaw) {
      const host = getHost();
      if (host === null) {
        return { ok: false, id: idRaw, error: "Workspace is not ready yet — try again in a moment." };
      }
      const v = sanitizeTrashId(idRaw);
      if (!v.ok) return { ok: false, id: idRaw, error: v.error };
      const id = v.name;
      const trashDir = path.join(trashRoot, id);

      let arch: string | undefined;
      try {
        if (!statSync(trashDir).isDirectory()) throw new Error("not a directory");
        arch = readdirSync(trashDir).find((f) => isArchFile(f));
      } catch {
        return { ok: false, id, error: `Nothing in the trash with id "${id}".` };
      }
      if (arch === undefined) {
        return { ok: false, id, error: `Trash entry "${id}" has no diagram to restore.` };
      }
      const stem = diagramNameFromFile(arch);

      // Refuse to clobber a diagram recreated since it was trashed.
      const state = host.getState();
      if (state.diagrams.includes(stem) || existsSync(path.join(root, `${stem}${ARCH_EXT}`))) {
        return { ok: false, id, error: `Cannot restore — a diagram named "${stem}" already exists.` };
      }

      const moves = plannedMoves(trashDir, stem, root, stem);
      try {
        applyMoves(moves);
        // The now-empty trash folder (and its `.history/` subdir) is cleaned up.
        rmSync(trashDir, { recursive: true, force: true });
      } catch (error) {
        return { ok: false, id, error: `Restore failed: ${(error as Error).message}` };
      }

      // Make the restored diagram active — "here is your diagram back".
      host.resync(stem);
      return { ok: true, id, name: stem };
    },
  };
}
