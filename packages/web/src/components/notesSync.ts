/**
 * Pure autosave logic for the notes panel (DGC-63) — deliberately free of any
 * React / DOM / fetch imports so it can be unit-tested in the project's
 * node-only vitest setup (see `test/components/notesSync.test.ts`). Mirrors
 * `drawerSync.ts`'s `makeUpdateSender`.
 *
 * The saver coalesces a burst of keystrokes into a single outbound write and
 * captures the target diagram name at `push` time (not flush time): if the
 * user switches diagrams before the debounce fires, the pending note still
 * lands on the diagram it was typed for, never the newly-active one.
 */

/** Default debounce before an edit is persisted via PUT. */
export const NOTES_SAVE_DEBOUNCE_MS = 600;

export interface MakeNotesSaverOptions {
  /**
   * Persist `markdown` for diagram `name`. Injected (rather than fetching
   * here) so this module stays DOM/network-free and testable; the panel wires
   * it to the `/api/notes/:name` PUT client.
   */
  save: (name: string, markdown: string) => void;
  /** Debounce window in ms (default {@link NOTES_SAVE_DEBOUNCE_MS}). */
  debounceMs?: number;
}

/** A debounced editor→server notes autosave pump. */
export interface NotesSaver {
  /** Record the latest notes for `name`; (re)arms the debounce timer. */
  push: (name: string, markdown: string) => void;
  /** Flush any pending edit immediately (bypasses the debounce). */
  flush: () => void;
  /** Drop any pending edit and disarm the timer (e.g. on unmount / diagram switch). */
  cancel: () => void;
}

/**
 * Build a debounced saver that coalesces a burst of edits into one write.
 * Uses the ambient `setTimeout`/`clearTimeout`, so vitest fake timers drive it
 * deterministically. The `(name, markdown)` pair is captured at `push` time so
 * the write always targets the diagram the text was typed for.
 */
export function makeNotesSaver(options: MakeNotesSaverOptions): NotesSaver {
  const debounceMs = options.debounceMs ?? NOTES_SAVE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { name: string; markdown: string } | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === null) return;
    const { name, markdown } = pending;
    pending = null;
    options.save(name, markdown);
  }

  return {
    push(name: string, markdown: string): void {
      pending = { name, markdown };
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    flush,
    cancel(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      pending = null;
    },
  };
}
