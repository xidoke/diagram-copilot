/**
 * Present mode (DGC-73) — walk a diagram "like a lecture", full screen.
 *
 * Enter with the ▶ button on the {@link Toolbar} or ⌘⇧P from anywhere; leave
 * with Esc or the dim ✕ in the corner. While presenting, a `presenting` class
 * on the app root hides ALL chrome (toolbar, picker, status pill, drawer/notes
 * tabs, minimap, controls, undo, …) via one block in `present.css`, leaving the
 * canvas alone with a slim caption bar:
 *   - the active diagram name, and — when it's part of a `.stepN` evolution
 *     chain — a big `‹ bước 2/4 ›` stepper (reuses {@link buildStepChain}, so
 *     the chain rules never drift from {@link StepsNav}); ←/→ flip steps.
 *   - a dim, read-only notes panel on the right, toggled with `n`, showing the
 *     current diagram's `.notes.md` (pre-wrapped, same `/api/notes/:name` the
 *     {@link NotesPanel} writes).
 *
 * Stepping just POSTs `/api/open`; the resulting diagram message re-fits the
 * canvas through `App`'s existing fitView effect, so this component never
 * re-implements auto-fit — it only fits once on ENTER (the chrome it hides is
 * all overlay, so nothing reflows; the fit is a clean reframe).
 *
 * `presentKeyAction` is the pure half — key → action, no DOM, no network — so
 * it's unit-testable in the project's node-only vitest setup (mirrors
 * `buildStepChain` / `statusPillContent`).
 */
import { useCallback, useEffect, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import type { WorkspaceMessage } from "@diagram-copilot/core";
import { buildStepChain } from "./StepsNav.js";
import { isEditableTarget } from "./UndoButton.js";
import "./present.css";

/** What a keypress maps to while presenting. `null` = ignore the key. */
export type PresentAction = "exit" | "prev" | "next" | "toggle-notes" | null;

/** Whether stepping backward / forward is currently possible. */
export interface PresentKeyState {
  hasPrev: boolean;
  hasNext: boolean;
}

/**
 * Map a keydown `key` to a present-mode action — pure, DOM-free, so it's
 * unit-testable without a browser. `←`/`→` collapse to `null` when there's
 * nowhere to step, so the caller never fires a no-op `/api/open`; `n`/`N`
 * toggles the notes panel; `Escape` always exits.
 */
export function presentKeyAction(key: string, state: PresentKeyState): PresentAction {
  switch (key) {
    case "Escape":
      return "exit";
    case "ArrowLeft":
      return state.hasPrev ? "prev" : null;
    case "ArrowRight":
      return state.hasNext ? "next" : null;
    case "n":
    case "N":
      return "toggle-notes";
    default:
      return null;
  }
}

/**
 * Origin of the diagram-copilot server for the notes fetch — relative
 * (same-origin in prod, the vite dev proxy forwards `/api/*` to :4747) unless
 * `VITE_WS_URL` points at another host, matching `NotesPanel` / `overrides.ts`.
 */
function apiBase(): string {
  const wsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (!wsUrl) return "";
  try {
    const url = new URL(wsUrl);
    return `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}`;
  } catch {
    return "";
  }
}

/** Fetch the saved notes markdown for `name` (`""` when none). */
async function fetchNotes(name: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(`${apiBase()}/api/notes/${encodeURIComponent(name)}`, { signal });
  if (!res.ok) throw new Error(`GET notes for "${name}" failed: ${res.status}`);
  const body = (await res.json()) as { markdown?: string };
  return body.markdown ?? "";
}

/** Activate `name` — same endpoint `StepsNav` uses to flip steps. */
async function requestOpen(name: string): Promise<void> {
  await fetch("/api/open", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

export interface PresentModeProps {
  /** Whether present mode is active. */
  present: boolean;
  /** Enter present mode (bound to ⌘⇧P from anywhere). */
  onEnter: () => void;
  /** Leave present mode (Esc / ✕). */
  onExit: () => void;
  /** Workspace listing — drives the step chain + active diagram name. */
  workspace: WorkspaceMessage | null;
}

export function PresentMode({ present, onEnter, onExit, workspace }: PresentModeProps) {
  const { fitView } = useReactFlow();
  const [notesShown, setNotesShown] = useState(false);
  const [notes, setNotes] = useState<string>("");

  const active = workspace?.active ?? null;
  const stepChain = buildStepChain(workspace?.diagrams ?? [], active);
  const prevName = stepChain && stepChain.index > 0 ? stepChain.chain[stepChain.index - 1] : undefined;
  const nextName =
    stepChain && stepChain.index < stepChain.chain.length - 1 ? stepChain.chain[stepChain.index + 1] : undefined;

  const goTo = useCallback((target: string | undefined) => {
    if (!target) return;
    void requestOpen(target).catch((err) => console.warn("[present] open failed:", err));
  }, []);

  // ⌘⇧P enters present mode from anywhere — ignored inside a text field / the
  // Monaco DSL editor (same guard StepsNav / UndoButton use for ←→ / ⌘Z).
  useEffect(() => {
    if (present) return;
    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        onEnter();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [present, onEnter]);

  // While presenting: Esc exits, ←/→ flip steps, n toggles notes.
  useEffect(() => {
    if (!present) return;
    const onKey = (e: KeyboardEvent) => {
      const action = presentKeyAction(e.key, { hasPrev: Boolean(prevName), hasNext: Boolean(nextName) });
      if (!action) return;
      e.preventDefault();
      switch (action) {
        case "exit":
          onExit();
          break;
        case "prev":
          goTo(prevName);
          break;
        case "next":
          goTo(nextName);
          break;
        case "toggle-notes":
          setNotesShown((s) => !s);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [present, prevName, nextName, goTo, onExit]);

  // On enter, reframe the canvas now the chrome is gone. The chrome overlays
  // (never reflows the canvas), so this is a clean re-fit, not a resize
  // response — one rAF lets the `.presenting` class paint first. Step changes
  // re-fit on their own: a new diagram message trips App's fitView effect.
  useEffect(() => {
    if (!present) return;
    const raf = requestAnimationFrame(() => fitView({ padding: 0.15, duration: 300 }));
    return () => cancelAnimationFrame(raf);
  }, [present, fitView]);

  // Collapse the notes panel whenever we leave present mode, so a re-entry
  // starts clean.
  useEffect(() => {
    if (!present) setNotesShown(false);
  }, [present]);

  // Load notes for the active diagram while the panel is showing; re-runs on a
  // step flip so the panel tracks whatever diagram is on screen.
  useEffect(() => {
    if (!present || !notesShown || !active) {
      setNotes("");
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    fetchNotes(active, controller.signal)
      .then((md) => {
        if (!cancelled) setNotes(md);
      })
      .catch((err) => {
        if (!cancelled && (err as Error).name !== "AbortError") console.error("[present] load notes failed", err);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [present, notesShown, active]);

  if (!present) return null;

  return (
    <div className="present" role="region" aria-label="Present mode">
      <button
        type="button"
        className="present-exit"
        onClick={onExit}
        aria-label="Exit present mode (Esc)"
        title="Exit · Esc"
      >
        ✕
      </button>

      <div className="present-bar" role="group" aria-label="Presentation caption">
        <span className="present-bar__name">{active ?? "diagram"}</span>
        {stepChain && (
          <span className="present-bar__nav">
            <button
              type="button"
              className="present-bar__btn"
              disabled={!prevName}
              onClick={() => goTo(prevName)}
              aria-label="Previous step"
            >
              ‹
            </button>
            <span className="present-bar__step">
              bước {stepChain.index + 1}/{stepChain.chain.length}
            </span>
            <button
              type="button"
              className="present-bar__btn"
              disabled={!nextName}
              onClick={() => goTo(nextName)}
              aria-label="Next step"
            >
              ›
            </button>
          </span>
        )}
      </div>

      {notesShown && (
        <aside className="present-notes" aria-label="Diagram notes">
          <pre className="present-notes__body">{notes || "No notes yet."}</pre>
        </aside>
      )}

      <div className="present-watermark" aria-hidden="true">
        diagram-copilot
      </div>
    </div>
  );
}
