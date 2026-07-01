/**
 * Slide-over DSL drawer (theme B: dark blueprint) — Layout C: it overlays the
 * left edge of the canvas rather than shrinking it, so the diagram keeps its
 * full viewport. A vertical toggle tab rides the drawer's right edge; ⌘E /
 * Ctrl+E toggles it from anywhere.
 *
 * The editor is Monaco (`@monaco-editor/react`, language `plaintext` — DSL
 * syntax highlighting is a later task). All non-visual logic — deciding when a
 * remote diagram may overwrite the buffer, and debouncing outbound edits —
 * lives in the DOM-free `drawerSync.ts` so it stays unit-testable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import type { ClientMessage, DiagramMessage } from "@diagram-copilot/core";
import {
  KEYSTROKE_GRACE_MS,
  makeUpdateSender,
  shouldApplyRemote,
  type UpdateSender,
} from "./drawerSync.js";
import "./drawer.css";

/** Registered once via `beforeMount`; keeps the editor background flush with
 *  the `--panel` surface so it reads as part of the drawer, not a widget. */
const MONACO_THEME = "dgc-dark";

export interface DrawerProps {
  /** Whether the drawer is slid open. */
  open: boolean;
  /** Toggle handler (also bound to ⌘E / Ctrl+E). */
  onToggle: () => void;
  /** Latest diagram from the server, or `null` before the first arrives. */
  diagram: DiagramMessage | null;
  /** Outbound sink (from `useDiagramConnection`). */
  send: (message: ClientMessage) => void;
}

export function Drawer({ open, onToggle, diagram, send }: DrawerProps) {
  // Editor text lives in React state (controlled Monaco) so it survives the
  // editor being unmounted while the drawer is closed.
  const [value, setValue] = useState<string>(diagram?.dsl ?? "");
  // Raised when a remote diagram diverged from the buffer while the user was
  // editing — we keep their text and surface a small badge instead.
  const [remoteChanged, setRemoteChanged] = useState(false);
  // Lazily mount Monaco only once the drawer has actually been opened, so a
  // user who never touches it doesn't pay the editor's load cost.
  const [everOpened, setEverOpened] = useState(open);

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const focusedRef = useRef(false);
  const lastKeystrokeRef = useRef(0);
  // Read inside the sender's `getMeta` at flush time — always the freshest.
  const diagramRef = useRef<DiagramMessage | null>(diagram);
  const senderRef = useRef<UpdateSender | null>(null);

  useEffect(() => {
    diagramRef.current = diagram;
  }, [diagram]);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  // One sender for the component's lifetime. `send` is stable (see
  // useDiagramConnection), so capturing it once is safe.
  if (senderRef.current === null) {
    senderRef.current = makeUpdateSender({
      send,
      getMeta: () => {
        const d = diagramRef.current;
        return d ? { name: d.name, baseVersion: d.version } : null;
      },
    });
  }
  useEffect(() => () => senderRef.current?.cancel(), []);

  // ⌘E / Ctrl+E toggles the drawer from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        onToggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onToggle]);

  // Server → editor. Runs only when a *new* diagram object arrives; reads the
  // live buffer + edit state through refs so the decision reflects "right now",
  // not a stale render.
  useEffect(() => {
    if (!diagram) return;
    const currentValue = editorRef.current?.getValue() ?? value;
    const isEditing =
      focusedRef.current || Date.now() - lastKeystrokeRef.current < KEYSTROKE_GRACE_MS;
    const action = shouldApplyRemote({ value: currentValue, isEditing }, { dsl: diagram.dsl });
    if (action === "apply") {
      setValue(diagram.dsl);
      setRemoteChanged(false);
    } else if (action === "defer") {
      setRemoteChanged(true);
    } else {
      setRemoteChanged(false);
    }
    // Intentionally keyed on `diagram` only — see refs above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram]);

  const handleBeforeMount = useCallback<BeforeMount>((monaco) => {
    monaco.editor.defineTheme(MONACO_THEME, {
      base: "vs-dark",
      inherit: true,
      rules: [],
      colors: {
        "editor.background": "#141b28", // --panel
        "editor.foreground": "#dfe8ff", // --text
        "editorLineNumber.foreground": "#3a4a68",
        "editorLineNumber.activeForeground": "#9fb4d8", // --text-dim
        "editor.lineHighlightBackground": "#1a2740", // --grid-dot
        "editorCursor.foreground": "#4aa3ff", // --accent
        "editor.selectionBackground": "#2c3f6066", // --border, translucent
      },
    });
  }, []);

  const handleMount = useCallback<OnMount>((instance) => {
    editorRef.current = instance;
    instance.onDidFocusEditorText(() => {
      focusedRef.current = true;
    });
    instance.onDidBlurEditorText(() => {
      focusedRef.current = false;
    });
  }, []);

  const handleChange = useCallback((next: string | undefined) => {
    const dsl = next ?? "";
    setValue(dsl);
    lastKeystrokeRef.current = Date.now();
    senderRef.current?.push(dsl);
  }, []);

  // Pull the deferred remote text into the buffer on demand (badge click).
  const adoptRemote = useCallback(() => {
    const d = diagramRef.current;
    if (!d) return;
    setValue(d.dsl);
    setRemoteChanged(false);
  }, []);

  return (
    <div className={`drawer${open ? " drawer--open" : ""}`}>
      <button
        type="button"
        className="drawer-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={open ? "Close DSL editor (⌘E)" : "Open DSL editor (⌘E)"}
        title={open ? "Close editor · ⌘E" : "Open editor · ⌘E"}
      >
        <span className="drawer-toggle__glyph" aria-hidden="true">
          {open ? "‹" : "›"}
        </span>
        <span className="drawer-toggle__text" aria-hidden="true">
          DSL
        </span>
      </button>

      <div className="drawer-panel">
        <header className="drawer-header">
          <div className="drawer-header__title">
            {diagram ? (
              <>
                <b className="drawer-header__name">{diagram.name}</b>
                <span className="drawer-header__version">v{diagram.version}</span>
              </>
            ) : (
              <span className="drawer-header__name drawer-header__name--empty">no diagram</span>
            )}
          </div>
          {remoteChanged && (
            <button
              type="button"
              className="drawer-badge"
              onClick={adoptRemote}
              title="The server has a newer version. Click to load it (discards local edits)."
            >
              remote changed · load
            </button>
          )}
        </header>

        <div className="drawer-editor">
          {everOpened && (
            <Editor
              height="100%"
              language="plaintext"
              theme={MONACO_THEME}
              value={value}
              onChange={handleChange}
              beforeMount={handleBeforeMount}
              onMount={handleMount}
              options={{
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                fontSize: 13,
                lineHeight: 20,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: "on",
                automaticLayout: true,
                padding: { top: 10, bottom: 10 },
                renderLineHighlight: "line",
                tabSize: 2,
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
