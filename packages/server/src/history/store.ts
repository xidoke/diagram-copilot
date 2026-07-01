/**
 * Diagram history — the undo/redo safety net (T31, spec §6).
 *
 * Every successful workspace update is recorded here as a PRE-apply snapshot,
 * so a later `undo_diagram` (or the web ⌘Z button) can restore the content a
 * diagram held *before* that write — the guardrail for an unwanted AI overwrite.
 * Snapshots live in a per-diagram ring buffer (max {@link HISTORY_LIMIT}) and
 * are persisted append-only to `<workspace>/.history/<name>.jsonl`, so history
 * survives a server restart. The log is compacted to the last
 * {@link HISTORY_LIMIT} lines the first time a diagram's history is loaded
 * (lazily, on first access).
 *
 * Undo/redo are the textbook two-stack algorithm over full snapshots:
 *   - the undo stack holds past states (persisted, loaded lazily);
 *   - the redo stack holds states left behind by undos (in-memory only — a
 *     restart legitimately starts with an empty redo stack).
 * A fresh normal edit clears the redo stack.
 *
 * VERSION SEMANTICS (important): undo/redo do NOT rewind the version counter.
 * They re-apply the restored DSL as a brand-new `update`, so versions keep
 * climbing monotonically. Undoing to v3's content while at v4 lands on v5, not
 * back on v3; the receipt reports both ("… to v3 content (now v5)"). This keeps
 * the sync contract simple — every client just sees another forward update.
 *
 * RE-ENTRANCY: undo/redo apply their restore write through the very same
 * `workspace.update` that fires {@link onApplied}. An internal guard suppresses
 * recording during that self-write, so the restored state is not itself pushed
 * back onto the undo stack (which would turn undo into a no-op cycle).
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Origin } from "@diagram-copilot/core";
import type { UpdateAppliedEvent, WorkspaceOps } from "../workspace/watcher.js";

/** Max snapshots retained per diagram, both in memory and in the on-disk log. */
export const HISTORY_LIMIT = 50;

/** One restorable snapshot of a diagram at a point in time. */
export interface HistoryEntry {
  /** Accepted version this content was served at (for the receipt — not a rewind target). */
  version: number;
  /** Full DSL of the snapshot. */
  dsl: string;
  /** Origin of the update associated with this snapshot. */
  origin: Origin;
  /** Epoch-ms when the snapshot was recorded. */
  ts: number;
}

/** Outcome of an {@link HistoryStore.undo}/{@link HistoryStore.redo} action. */
export interface HistoryActionResult {
  /** `true` when a snapshot was restored and re-applied. */
  ok: boolean;
  /** Diagram name acted on. */
  name: string;
  /** Version the restored content originally carried (present on success). */
  fromVersion?: number;
  /** New version after re-applying the restored content (present on success). */
  toVersion?: number;
  /** Human-readable receipt (success) or reason (failure). */
  message: string;
}

export interface HistoryStore {
  /**
   * Record a pre-apply snapshot. Wire to
   * {@link WorkspaceWatcherOptions.onApplied}. A no-op while this store is
   * applying its own undo/redo restore (the re-entrancy guard).
   */
  onApplied(event: UpdateAppliedEvent): void;
  /** Restore the most recent snapshot for `name` (or report nothing to undo). */
  undo(name: string, workspace: WorkspaceOps): HistoryActionResult;
  /** Re-apply the most recently undone snapshot for `name` (or report nothing to redo). */
  redo(name: string, workspace: WorkspaceOps): HistoryActionResult;
}

export interface HistoryStoreOptions {
  /** Workspace directory; history lives in its `.history/` subdirectory. */
  dir: string;
}

/**
 * Create a history store rooted at `<dir>/.history`. One instance is shared
 * between the watcher hook (record), the MCP tools, and the `/api/undo` route.
 */
export function createHistoryStore(options: HistoryStoreOptions): HistoryStore {
  const historyDir = path.join(path.resolve(options.dir), ".history");

  const undoStacks = new Map<string, HistoryEntry[]>();
  const redoStacks = new Map<string, HistoryEntry[]>();
  const loaded = new Set<string>();
  // Re-entrancy guard: true while undo/redo is applying its restore write, so
  // the resulting onApplied is ignored (it would otherwise re-record the state
  // we are trying to leave, breaking the two-stack invariant).
  let applying = false;

  function fileFor(name: string): string {
    return path.join(historyDir, `${name}.jsonl`);
  }

  function undoStack(name: string): HistoryEntry[] {
    let stack = undoStacks.get(name);
    if (stack === undefined) {
      stack = [];
      undoStacks.set(name, stack);
    }
    return stack;
  }

  function redoStack(name: string): HistoryEntry[] {
    let stack = redoStacks.get(name);
    if (stack === undefined) {
      stack = [];
      redoStacks.set(name, stack);
    }
    return stack;
  }

  /**
   * Lazily hydrate a diagram's undo stack from its jsonl log (once). Trims to
   * the last {@link HISTORY_LIMIT} entries and compacts the file to that window
   * so it cannot grow without bound across restarts.
   */
  function ensureLoaded(name: string): void {
    if (loaded.has(name)) return;
    loaded.add(name);

    let raw: string;
    try {
      raw = readFileSync(fileFor(name), "utf8");
    } catch {
      return; // no history logged yet
    }

    const entries: HistoryEntry[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as HistoryEntry;
        if (typeof parsed?.dsl === "string" && typeof parsed?.version === "number") {
          entries.push(parsed);
        }
      } catch {
        // Skip a malformed/torn line rather than losing the whole log.
      }
    }

    const kept = entries.slice(-HISTORY_LIMIT);
    undoStacks.set(name, kept);
    if (kept.length !== entries.length) {
      try {
        mkdirSync(historyDir, { recursive: true });
        const body = kept.map((entry) => JSON.stringify(entry)).join("\n");
        writeFileSync(fileFor(name), body.length > 0 ? `${body}\n` : "");
      } catch (error) {
        console.error(`[history] failed to compact log for "${name}":`, error);
      }
    }
  }

  function persist(name: string, entry: HistoryEntry): void {
    try {
      mkdirSync(historyDir, { recursive: true });
      appendFileSync(fileFor(name), `${JSON.stringify(entry)}\n`);
    } catch (error) {
      console.error(`[history] failed to persist entry for "${name}":`, error);
    }
  }

  function record(event: UpdateAppliedEvent): void {
    ensureLoaded(event.name);
    const entry: HistoryEntry = {
      version: event.previousVersion,
      dsl: event.previousDsl,
      origin: event.origin,
      ts: Date.now(),
    };
    const stack = undoStack(event.name);
    stack.push(entry);
    if (stack.length > HISTORY_LIMIT) stack.shift();
    // A fresh edit invalidates any redo future for this diagram.
    redoStacks.set(event.name, []);
    persist(event.name, entry);
  }

  function onApplied(event: UpdateAppliedEvent): void {
    if (applying) return; // our own undo/redo restore write — do not re-record
    record(event);
  }

  /** Apply `dsl` to `name` through the workspace with recording suppressed. */
  function applyRestore(name: string, dsl: string, workspace: WorkspaceOps) {
    applying = true;
    try {
      return workspace.update(name, dsl, { origin: "mcp" });
    } finally {
      applying = false;
    }
  }

  function snapshotOf(current: { dsl: string; version: number }): HistoryEntry {
    return { version: current.version, dsl: current.dsl, origin: "mcp", ts: Date.now() };
  }

  function undo(name: string, workspace: WorkspaceOps): HistoryActionResult {
    ensureLoaded(name);
    const current = workspace.read(name);
    if (!current.ok || current.dsl === undefined) {
      return { ok: false, name, message: current.error ?? `Cannot undo — diagram "${name}" is not readable.` };
    }

    const stack = undoStack(name);
    const past = stack.pop();
    if (past === undefined) {
      return { ok: false, name, message: `Nothing to undo for "${name}".` };
    }

    // Leave the present on the redo stack so it can be re-applied later.
    redoStack(name).push(snapshotOf({ dsl: current.dsl, version: current.version }));
    const result = applyRestore(name, past.dsl, workspace);
    if (!result.ok) {
      // Roll the stacks back so a transient failure doesn't drop history.
      stack.push(past);
      redoStack(name).pop();
      return { ok: false, name, message: result.error ?? `Undo failed for "${name}".` };
    }

    return {
      ok: true,
      name,
      fromVersion: past.version,
      toVersion: result.version,
      message: `Reverted "${name}" to v${past.version} content (now v${result.version}).`,
    };
  }

  function redo(name: string, workspace: WorkspaceOps): HistoryActionResult {
    ensureLoaded(name);
    const current = workspace.read(name);
    if (!current.ok || current.dsl === undefined) {
      return { ok: false, name, message: current.error ?? `Cannot redo — diagram "${name}" is not readable.` };
    }

    const stack = redoStack(name);
    const future = stack.pop();
    if (future === undefined) {
      return { ok: false, name, message: `Nothing to redo for "${name}".` };
    }

    // Put the present back on the undo stack so the redo can itself be undone.
    undoStack(name).push(snapshotOf({ dsl: current.dsl, version: current.version }));
    const result = applyRestore(name, future.dsl, workspace);
    if (!result.ok) {
      stack.push(future);
      undoStack(name).pop();
      return { ok: false, name, message: result.error ?? `Redo failed for "${name}".` };
    }

    return {
      ok: true,
      name,
      fromVersion: future.version,
      toVersion: result.version,
      message: `Redid "${name}" to v${future.version} content (now v${result.version}).`,
    };
  }

  return { onApplied, undo, redo };
}
