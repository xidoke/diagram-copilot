/**
 * Undo button + ⌘Z / Ctrl+Z shortcut (T31).
 *
 * The web canvas has no MCP channel, so undo is wired over plain HTTP to the
 * server's `POST /api/undo`, which restores the active diagram to the content
 * it held before the most recent change (the same safety net as the
 * `undo_diagram` MCP tool). The restored state comes back through the normal
 * `diagram` broadcast, so there is nothing to apply here — fire and forget.
 *
 * The keyboard shortcut is deliberately ignored while focus is inside a text
 * field or the Monaco DSL editor, so ⌘Z keeps its native meaning there instead
 * of yanking the whole diagram back. ⇧⌘Z (redo) is left untouched — there is no
 * web redo affordance in v0.4.
 */
import { useCallback, useEffect, useState } from "react";

/**
 * Base URL for the server's `/api/*` routes. Same origin in production (the
 * server serves the web bundle), overridable via `VITE_API_BASE` for the
 * split dev origins (`vite :4700` ↔ server `:4747`).
 */
export function resolveApiBase(): string {
  const fromEnv = import.meta.env.VITE_API_BASE as string | undefined;
  return fromEnv ? fromEnv.replace(/\/+$/, "") : "";
}

/** True for the Undo chord (⌘Z / Ctrl+Z) — but NOT ⇧⌘Z, which is redo. */
export function isUndoShortcut(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey">,
): boolean {
  return (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "z";
}

/**
 * True when the event originated in an editable surface — an `<input>`,
 * `<textarea>`, a `contentEditable` element, or anywhere inside the Monaco
 * editor — where ⌘Z must stay the native (text) undo.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (target === null || typeof target !== "object") return false;
  const el = target as Partial<HTMLElement> & { tagName?: string; isContentEditable?: boolean };
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return true;
  if (el.isContentEditable === true) return true;
  if (typeof el.closest === "function" && el.closest(".monaco-editor") !== null) return true;
  return false;
}

export interface UndoButtonProps {
  /** Active diagram name, or `null` when none is open (button disabled). */
  name: string | null;
}

export function UndoButton({ name }: UndoButtonProps) {
  const [busy, setBusy] = useState(false);

  const runUndo = useCallback(async () => {
    if (name === null || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`${resolveApiBase()}/api/undo`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string; message?: string } | null;
        console.warn("[undo] request rejected:", body?.error ?? body?.message ?? res.status);
      }
    } catch (error) {
      console.warn("[undo] request failed:", error);
    } finally {
      setBusy(false);
    }
  }, [name, busy]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isUndoShortcut(e) || isEditableTarget(e.target)) return;
      e.preventDefault();
      void runUndo();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [runUndo]);

  return (
    <button
      type="button"
      className="undo-btn"
      title="Undo last change (⌘Z)"
      aria-label="Undo last change"
      disabled={name === null || busy}
      onClick={() => void runUndo()}
    >
      ↶ Undo
    </button>
  );
}
