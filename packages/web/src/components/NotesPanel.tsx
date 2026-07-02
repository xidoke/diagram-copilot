/**
 * Slide-over notes panel (DGC-63) — the right-edge mirror of the DSL `Drawer`.
 * It overlays the right edge of the canvas (the canvas never resizes); a
 * vertical toggle tab rides its left edge, and ⌘I / Ctrl+I toggles it from
 * anywhere.
 *
 * The panel edits a diagram's free-form markdown *notes* — the "why" behind
 * the picture (trade-offs, rationale) — stored in `<name>.notes.md` via the
 * `/api/notes/:name` API. It is a plain `<textarea>` (deliberately NOT Monaco)
 * with a preview toggle that renders the raw markdown as pre-wrapped text —
 * good enough to read back a note; rich markdown rendering is a later upgrade
 * (no markdown library is pulled in for it). Edits autosave, debounced, via
 * PUT; the notes reload whenever the active diagram changes.
 *
 * All debounce logic lives in the DOM-free `notesSync.ts` so it stays
 * unit-testable in the project's node-only vitest setup.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { makeNotesSaver, type NotesSaver } from "./notesSync.js";
import "./notes.css";

/**
 * HTTP origin of the diagram-copilot server. Same derivation as
 * `render/overrides.ts`: relative URLs (same-origin in prod, the vite dev
 * proxy forwards `/api/*` to :4747) unless `VITE_WS_URL` points elsewhere.
 */
function apiBase(): string {
  const wsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (!wsUrl) return "";
  try {
    const url = new URL(wsUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function notesUrl(name: string): string {
  return `${apiBase()}/api/notes/${encodeURIComponent(name)}`;
}

/** Fetch the saved notes markdown for `name` (`""` when none / on a missing file). */
async function fetchNotes(name: string, signal?: AbortSignal): Promise<string> {
  const res = await fetch(notesUrl(name), { signal });
  if (!res.ok) throw new Error(`GET notes for "${name}" failed: ${res.status}`);
  const body = (await res.json()) as { markdown?: string };
  return body.markdown ?? "";
}

/** Persist the notes markdown for `name`. */
async function putNotes(name: string, markdown: string): Promise<void> {
  const res = await fetch(notesUrl(name), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ markdown }),
  });
  if (!res.ok) throw new Error(`PUT notes for "${name}" failed: ${res.status}`);
}

export interface NotesPanelProps {
  /** Whether the panel is slid open. */
  open: boolean;
  /** Toggle handler (also bound to ⌘I / Ctrl+I). */
  onToggle: () => void;
  /** Active diagram name, or `null` before the first diagram arrives. */
  name: string | null;
}

export function NotesPanel({ open, onToggle, name }: NotesPanelProps) {
  const [markdown, setMarkdown] = useState<string>("");
  const [preview, setPreview] = useState(false);
  // "saved" | "saving" | "error" — a tiny status hint in the header.
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const saverRef = useRef<NotesSaver | null>(null);
  if (saverRef.current === null) {
    saverRef.current = makeNotesSaver({
      save: (target, md) => {
        setStatus("saving");
        putNotes(target, md)
          .then(() => setStatus("saved"))
          .catch((err) => {
            console.error("save notes failed", err);
            setStatus("error");
          });
      },
    });
  }
  useEffect(() => () => saverRef.current?.cancel(), []);

  // ⌘I / Ctrl+I toggles the panel from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToggle]);

  // Load notes for whichever diagram just became active. Any pending save for
  // the previous diagram was already captured with its own name (see
  // notesSync), but cancel here too so a switch never fires a stale write.
  useEffect(() => {
    saverRef.current?.cancel();
    if (!name) {
      setMarkdown("");
      setStatus("idle");
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setStatus("idle");
    fetchNotes(name, controller.signal)
      .then((loaded) => {
        if (!cancelled) setMarkdown(loaded);
      })
      .catch((err) => {
        if (!cancelled && (err as Error).name !== "AbortError") {
          console.error("load notes failed", err);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [name]);

  const handleChange = useCallback(
    (next: string) => {
      setMarkdown(next);
      if (name) saverRef.current?.push(name, next);
    },
    [name],
  );

  const statusText =
    status === "saving" ? "saving…" : status === "saved" ? "saved" : status === "error" ? "save failed" : "";

  return (
    <div className={`notes${open ? " notes--open" : ""}`}>
      <button
        type="button"
        className="notes-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? "Close notes (⌘I)" : "Open notes (⌘I)"}
        title={open ? "Close notes · ⌘I" : "Open notes · ⌘I"}
      >
        <span className="notes-toggle__glyph" aria-hidden="true">
          📝
        </span>
        <span className="notes-toggle__text" aria-hidden="true">
          NOTES
        </span>
      </button>

      <div className="notes-panel">
        <header className="notes-header">
          <div className="notes-header__title">
            {name ? (
              <b className="notes-header__name">{name}</b>
            ) : (
              <span className="notes-header__name notes-header__name--empty">no diagram</span>
            )}
            {statusText && <span className="notes-header__status">{statusText}</span>}
          </div>
          <button
            type="button"
            className="notes-tab"
            onClick={() => setPreview((p) => !p)}
            aria-pressed={preview}
            title={preview ? "Edit notes" : "Preview notes"}
          >
            {preview ? "Edit" : "Preview"}
          </button>
        </header>

        <div className="notes-body">
          {preview ? (
            <pre className="notes-preview">{markdown || "No notes yet."}</pre>
          ) : (
            <textarea
              className="notes-textarea"
              value={markdown}
              onChange={(e) => handleChange(e.target.value)}
              placeholder={
                name
                  ? "Design notes — the WHY behind this diagram (trade-offs, decisions, rationale)…"
                  : "Open a diagram to take notes."
              }
              disabled={!name}
              spellCheck={false}
            />
          )}
        </div>
      </div>
    </div>
  );
}
