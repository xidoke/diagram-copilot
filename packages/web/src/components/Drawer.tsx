/**
 * Slide-over DSL drawer (theme B: dark blueprint) — Layout C: it overlays the
 * left edge of the canvas rather than shrinking it, so the diagram keeps its
 * full viewport. A vertical toggle tab rides the drawer's right edge; ⌘E /
 * Ctrl+E toggles it from anywhere.
 *
 * The editor is Monaco (`@monaco-editor/react`), self-hosted (see
 * `configureSelfHostedMonaco` below — no CDN fetch, so the drawer works
 * with no network) with `arch-dsl` syntax highlighting (`dslLanguage.ts`)
 * and inline error markers (`drawerMarkers.ts`) sourced from the server's
 * `diagram-error` messages. All non-visual sync logic — deciding when a
 * remote diagram may overwrite the buffer, and debouncing outbound edits —
 * lives in the DOM-free `drawerSync.ts` so it stays unit-testable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Editor, { loader, type BeforeMount, type Monaco, type OnMount } from "@monaco-editor/react";
// Type-only — erased at compile time, so (unlike a value import) this never
// pulls the real `monaco-editor` package into the runtime module graph. See
// `configureSelfHostedMonaco` above for why that matters under vitest.
import type { editor } from "monaco-editor";
import type { ClientMessage, DiagramErrorMessage, DiagramMessage } from "@diagram-copilot/core";
import {
  KEYSTROKE_GRACE_MS,
  makeUpdateSender,
  shouldApplyRemote,
  type UpdateSender,
} from "./drawerSync.js";
import { errorsToMarkers, MARKER_OWNER } from "./drawerMarkers.js";
import {
  ARCH_DSL_LANGUAGE_ID,
  archDslThemeRules,
  archDslThemeRulesLight,
  registerArchDslLanguage,
} from "./dslLanguage.js";
import { useTheme } from "../theme.js";
import "./drawer.css";

// Deliberately no top-level `import * as monaco from "monaco-editor"` here:
// the real package touches `window`/browser globals as soon as its module
// graph is evaluated (it's a full editor, not a data module like
// `dslLanguage.ts`), which crashes under the project's plain-Node vitest
// setup the instant anything imports `Drawer.tsx` — even a test that never
// renders it, like `App.test.tsx`. `configureSelfHostedMonaco` below
// dynamically imports it instead, from inside a `useEffect` that only ever
// runs in a real mounted browser, and every other Monaco API call in this
// file goes through the `Monaco` instance `@monaco-editor/react` hands to
// `beforeMount`/`onMount` (see `monacoRef`) rather than a module-level
// reference.
let selfHostConfigured = false;

/** Shape of `monaco.Environment` (the `getWorker` case only — that's all
 *  this app needs); declared locally rather than imported from
 *  `monaco-editor` so this stays a type-only concern, not a value import. */
interface MinimalMonacoEnvironment {
  getWorker: () => Worker;
}

/**
 * Points `@monaco-editor/react`'s loader at the `monaco-editor` package
 * bundled by Vite (dynamic `import()`s — bundled locally, not fetched at
 * runtime) instead of its default cdn.jsdelivr.net fetch, and wires up the
 * editor's web worker via Vite's `?worker` import. Only
 * `editorWorkerService` is needed: `arch-dsl` has no TS/JSON/CSS language
 * services to offload to a worker. Idempotent; safe to call from every
 * `Drawer` mount (e.g. React StrictMode's double-invoke).
 */
async function configureSelfHostedMonaco(): Promise<void> {
  if (selfHostConfigured) return;
  selfHostConfigured = true;
  const [monaco, { default: EditorWorker }] = await Promise.all([
    import("monaco-editor"),
    import("monaco-editor/esm/vs/editor/editor.worker?worker"),
  ]);
  loader.config({ monaco });
  // `MonacoEnvironment` is only declared on `Window` (via monaco-editor's
  // own ambient types), not on `typeof globalThis` — cast rather than use
  // `self` directly, matching how monaco's own worker factory reads it
  // (`globalThis.MonacoEnvironment`, see `defaultWorkerFactory.js`).
  (
    globalThis as typeof globalThis & { MonacoEnvironment?: MinimalMonacoEnvironment }
  ).MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}

/** Both defined unconditionally in `handleBeforeMount` — keeps the editor
 *  background flush with the `--panel` surface so it reads as part of the
 *  drawer, not a widget. Which one is active follows the app's `useTheme()`
 *  (DGC-70) via the `<Editor theme={…}>` prop below, so it switches live. */
const MONACO_THEME_DARK = "dgc-dark";
const MONACO_THEME_LIGHT = "dgc-light";

export interface DrawerProps {
  /** Whether the drawer is slid open. */
  open: boolean;
  /** Toggle handler (also bound to ⌘E / Ctrl+E). */
  onToggle: () => void;
  /** Latest diagram from the server, or `null` before the first arrives. */
  diagram: DiagramMessage | null;
  /** Outbound sink (from `useDiagramConnection`). */
  send: (message: ClientMessage) => void;
  /** Latest parse/validation failure from the server, or `null`/`undefined`
   *  if none has arrived yet. Rendered as Monaco error markers (see
   *  `drawerMarkers.ts`) scoped to whichever diagram is currently open. */
  lastError?: DiagramErrorMessage | null;
}

export function Drawer({ open, onToggle, diagram, send, lastError }: DrawerProps) {
  // DGC-70: which Monaco theme is active follows the app theme (Toolbar's
  // ☀/🌙 toggle), kept in sync across components via `theme.ts`'s
  // subscribe/notify — see `MONACO_THEME_DARK`/`MONACO_THEME_LIGHT` above.
  const { theme } = useTheme();
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
  // Populated by `handleBeforeMount` — the one and only `Monaco` reference
  // this component uses (no module-level import; see the top of the file).
  const monacoRef = useRef<Monaco | null>(null);
  const focusedRef = useRef(false);
  const lastKeystrokeRef = useRef(0);
  // Read inside the sender's `getMeta` at flush time — always the freshest.
  const diagramRef = useRef<DiagramMessage | null>(diagram);
  // Read inside `handleMount` so an error that arrived before the editor
  // first mounted (drawer opened after the fact) still gets markers.
  const lastErrorRef = useRef<DiagramErrorMessage | null>(lastError ?? null);
  // Version of the diagram the currently-displayed markers were raised
  // against; `null` when no markers are showing. Lets the "clear on a newer
  // good diagram" effect below tell a genuinely-fixed diagram apart from an
  // unrelated/stale broadcast (spec: error.version is the last ACCEPTED
  // version, so a fix arrives with a strictly greater one).
  const errorVersionRef = useRef<number | null>(null);
  const senderRef = useRef<UpdateSender | null>(null);

  useEffect(() => {
    diagramRef.current = diagram;
  }, [diagram]);

  useEffect(() => {
    lastErrorRef.current = lastError ?? null;
  }, [lastError]);

  useEffect(() => {
    if (open) setEverOpened(true);
  }, [open]);

  // `Drawer` is always mounted by `App.tsx` (its own open/close state just
  // toggles a CSS class), so this fires as soon as the app loads — well
  // before the editor is ever lazily mounted (see `everOpened`) — ensuring
  // the loader is self-host-configured before any `<Editor>` could ask it
  // to fetch from the CDN.
  useEffect(() => {
    void configureSelfHostedMonaco();
  }, []);

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

  // Renders `err` as markers on `model` if it targets the diagram currently
  // open (or no diagram is open yet to compare against) — shared by the
  // mount handler (catches an error that arrived before the editor existed)
  // and the effect below (catches one that arrives while it's mounted).
  const applyErrorMarkers = useCallback(
    (err: DiagramErrorMessage | null, model: editor.ITextModel | null | undefined) => {
      if (!err || !model) return;
      const openDiagram = diagramRef.current;
      if (openDiagram && err.name !== openDiagram.name) return;
      monacoRef.current?.editor.setModelMarkers(
        model,
        MARKER_OWNER,
        errorsToMarkers(err.parseErrors, err.modelErrors),
      );
      errorVersionRef.current = err.version;
    },
    [],
  );

  // Server → markers. New parse/model errors land here; see
  // `applyErrorMarkers` for the "same diagram" guard.
  useEffect(() => {
    applyErrorMarkers(lastError ?? null, editorRef.current?.getModel());
  }, [lastError, applyErrorMarkers]);

  // A subsequent ACCEPTED diagram strictly newer than the one the current
  // markers were raised against means the underlying problem is fixed
  // elsewhere (another client, or this one after a round-trip) — clear them.
  // Keyed on `diagram` only, like the sync effect above.
  useEffect(() => {
    if (!diagram) return;
    if (errorVersionRef.current === null || diagram.version <= errorVersionRef.current) return;
    const model = editorRef.current?.getModel();
    if (!model) return;
    monacoRef.current?.editor.setModelMarkers(model, MARKER_OWNER, []);
    errorVersionRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [diagram]);

  const handleBeforeMount = useCallback<BeforeMount>((monacoInstance) => {
    monacoRef.current = monacoInstance;
    registerArchDslLanguage(monacoInstance);
    monacoInstance.editor.defineTheme(MONACO_THEME_DARK, {
      base: "vs-dark",
      inherit: true,
      rules: [...archDslThemeRules],
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
    // DGC-70 light theme (theme A) — same token roles, colors matching
    // tokens.css's `[data-theme="light"]` block.
    monacoInstance.editor.defineTheme(MONACO_THEME_LIGHT, {
      base: "vs",
      inherit: true,
      rules: [...archDslThemeRulesLight],
      colors: {
        "editor.background": "#ffffff", // --panel (light)
        "editor.foreground": "#2b3040", // --text (light)
        "editorLineNumber.foreground": "#b7c0d9",
        "editorLineNumber.activeForeground": "#8b93ab", // --text-dim (light)
        "editor.lineHighlightBackground": "#f0f2f8",
        "editorCursor.foreground": "#4a7dd6", // --accent (light)
        "editor.selectionBackground": "#d5dbea66", // --border (light), translucent
      },
    });
  }, []);

  const handleMount = useCallback<OnMount>(
    (instance) => {
      editorRef.current = instance;
      instance.onDidFocusEditorText(() => {
        focusedRef.current = true;
      });
      instance.onDidBlurEditorText(() => {
        focusedRef.current = false;
      });
      // Catch an error that arrived while the drawer was still closed (the
      // editor is lazily mounted — see `everOpened`).
      applyErrorMarkers(lastErrorRef.current, instance.getModel());
    },
    [applyErrorMarkers],
  );

  const handleChange = useCallback((next: string | undefined) => {
    const dsl = next ?? "";
    setValue(dsl);
    lastKeystrokeRef.current = Date.now();
    senderRef.current?.push(dsl);
    // The user is actively fixing (or diverging from) the errored text —
    // stale markers would be actively misleading, so drop them immediately
    // rather than waiting for the next server round-trip.
    if (errorVersionRef.current !== null) {
      const model = editorRef.current?.getModel();
      if (model) monacoRef.current?.editor.setModelMarkers(model, MARKER_OWNER, []);
      errorVersionRef.current = null;
    }
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
              language={ARCH_DSL_LANGUAGE_ID}
              theme={theme === "light" ? MONACO_THEME_LIGHT : MONACO_THEME_DARK}
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
