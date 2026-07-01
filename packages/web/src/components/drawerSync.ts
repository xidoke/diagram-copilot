/**
 * Pure two-way sync logic for the Monaco DSL drawer — deliberately free of
 * any React / Monaco / DOM imports so it can be unit-tested in the project's
 * node-only vitest setup (see `test/components/drawerSync.test.ts`).
 *
 * Two concerns live here:
 *   1. {@link shouldApplyRemote} — decides whether an inbound server diagram
 *      should overwrite the editor, be ignored, or be deferred (and surface a
 *      "remote changed" badge) because the user is mid-edit. This is what
 *      prevents the classic echo/clobber loop in collaborative editors.
 *   2. {@link makeUpdateSender} — a debounced sender that turns editor changes
 *      into a well-formed {@link UpdateMessage}, coalescing a burst of
 *      keystrokes into a single outbound frame.
 */
import type { ClientMessage } from "@diagram-copilot/core";

/** Grace window after the last keystroke during which we still treat the
 *  editor as "being edited", so a remote update mid-thought doesn't clobber
 *  a pause between keypresses. */
export const KEYSTROKE_GRACE_MS = 1000;

/** Default debounce before an editor change is pushed to the server. */
export const UPDATE_DEBOUNCE_MS = 400;

/** Snapshot of the editor at the moment a remote diagram arrives. */
export interface EditorSyncState {
  /** Current text in the editor's model. */
  value: string;
  /** True if the editor is focused OR within {@link KEYSTROKE_GRACE_MS} of
   *  the last keystroke — i.e. the user is actively editing. */
  isEditing: boolean;
}

/** The relevant slice of an inbound server diagram. */
export interface RemoteIncoming {
  /** DSL source the server just broadcast. */
  dsl: string;
}

/**
 * What to do with an inbound remote diagram:
 *  - `apply`  → overwrite the editor with `incoming.dsl` (safe: editor idle).
 *  - `ignore` → identical content; nothing to do (also clears any stale badge).
 *  - `defer`  → content differs but the user is editing; keep local text and
 *              raise the "remote changed" badge instead of clobbering.
 */
export type RemoteAction = "apply" | "ignore" | "defer";

/**
 * Decide how to reconcile an inbound remote diagram against local editor
 * state. Pure and total — every branch is covered, no DOM needed.
 */
export function shouldApplyRemote(
  editor: EditorSyncState,
  incoming: RemoteIncoming,
): RemoteAction {
  // Identical text: never touch the model (avoids resetting cursor/undo) and
  // there is nothing to flag as "changed".
  if (incoming.dsl === editor.value) return "ignore";
  // Content genuinely differs. If the user is mid-edit we must not clobber
  // their work — defer and let the caller surface a badge.
  if (editor.isEditing) return "defer";
  // Editor is idle and the server has newer text: adopt it.
  return "apply";
}

/** Target diagram an outbound edit is based on. `null` ⇒ nothing to update. */
export interface UpdateMeta {
  /** Diagram name the edit targets. */
  name: string;
  /** Server version the edit was made on top of (stale-write detection). */
  baseVersion: number;
}

export interface MakeUpdateSenderOptions {
  /** Sink for the assembled message (e.g. the WS connection's `send`). */
  send: (message: ClientMessage) => void;
  /** Resolved lazily at flush time so we always base the edit on the freshest
   *  diagram; returning `null` drops the pending edit (no active diagram). */
  getMeta: () => UpdateMeta | null;
  /** Debounce window in ms (default {@link UPDATE_DEBOUNCE_MS}). */
  debounceMs?: number;
}

/** A debounced editor→server update pump. */
export interface UpdateSender {
  /** Record the latest editor text; (re)arms the debounce timer. */
  push: (dsl: string) => void;
  /** Flush any pending edit immediately (bypasses the debounce). */
  flush: () => void;
  /** Drop any pending edit and disarm the timer (e.g. on unmount). */
  cancel: () => void;
}

/**
 * Build a debounced sender that coalesces a burst of editor changes into one
 * {@link UpdateMessage}. Uses the ambient `setTimeout`/`clearTimeout`, so
 * vitest fake timers drive it deterministically. The message is assembled at
 * flush time from `getMeta()`, so the `baseVersion` reflects the newest
 * diagram the client has seen.
 */
export function makeUpdateSender(options: MakeUpdateSenderOptions): UpdateSender {
  const debounceMs = options.debounceMs ?? UPDATE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: string | null = null;

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending === null) return;
    const dsl = pending;
    pending = null;
    const meta = options.getMeta();
    // No active diagram to base the edit on — drop it rather than send a
    // half-formed frame.
    if (!meta) return;
    options.send({
      kind: "update",
      name: meta.name,
      dsl,
      origin: "drawer",
      baseVersion: meta.baseVersion,
    });
  }

  return {
    push(dsl: string): void {
      pending = dsl;
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
