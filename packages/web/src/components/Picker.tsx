/**
 * Diagram picker (DGC-57 / T36) — click the top-left "diagram-info" badge to
 * open a dropdown listing every diagram in the workspace (from
 * `workspace.diagrams`), the active one marked with ✓. Snapshot "steps"
 * (`news-feed.step2`) are grouped and indented under their root diagram. A
 * "New diagram…" input at the bottom lets you type a name and open it —
 * the server creates it if it doesn't exist yet (same as `open_diagram`).
 *
 * Picking a diagram (or creating one) just closes the dropdown; the canvas
 * itself updates via the existing WS `workspace`/`diagram` broadcast once the
 * server activates it, so this component owns no diagram-rendering state.
 *
 * `groupDiagrams` is the pure half — kept separate from JSX so it's testable
 * without rendering (no DOM needed, matches the project's node-only vitest
 * setup; see StatusPill.tsx/EmptyState.tsx).
 */
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { WorkspaceMessage } from "@diagram-copilot/core";
import "./picker.css";

/** One diagram (or step-group root) row in the dropdown. */
export interface DiagramGroup {
  /** Root diagram name — always a real, openable name (may or may not itself exist yet). */
  root: string;
  /** Snapshot step names under `root` (`news-feed.step1`, …), sorted by step number ascending. */
  steps: string[];
}

/** Matches a snapshot step name: `<root>.step<N>`. */
const STEP_PATTERN = /^(.+)\.step(\d+)$/;

/**
 * Group a flat diagram name list into roots with their `.stepN` children
 * indented underneath, both sorted (roots alphabetically, steps numerically).
 * Pure — no DOM, no network — so it's unit-testable on its own.
 */
export function groupDiagrams(names: string[]): DiagramGroup[] {
  const roots = new Set<string>();
  const stepsByRoot = new Map<string, Array<{ name: string; step: number }>>();

  for (const name of names) {
    const match = STEP_PATTERN.exec(name);
    if (match) {
      const [, root, stepText] = match;
      roots.add(root);
      const list = stepsByRoot.get(root) ?? [];
      list.push({ name, step: Number(stepText) });
      stepsByRoot.set(root, list);
    } else {
      roots.add(name);
    }
  }

  return [...roots].sort((a, b) => a.localeCompare(b)).map((root) => ({
    root,
    steps: (stepsByRoot.get(root) ?? [])
      .sort((a, b) => a.step - b.step)
      .map((entry) => entry.name),
  }));
}

/** REST endpoint for activating/creating a diagram. Relative: same-origin in
 *  production, forwarded to :4747 by the vite dev proxy (an absolute
 *  cross-origin URL gets CORS-blocked — found in T25 e2e). */
const API_OPEN_URL = "/api/open";

/** Shape returned by `POST /api/open` — structurally mirrors the server's `OpenResult`. */
interface OpenApiResult {
  ok: boolean;
  created: boolean;
  name: string;
  version: number;
  error?: string;
}

async function requestOpen(name: string): Promise<OpenApiResult> {
  const res = await fetch(API_OPEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const parsed = (await res.json().catch(() => null)) as OpenApiResult | null;
  if (!parsed) {
    return { ok: false, created: false, name, version: 0, error: `Unexpected response (HTTP ${res.status}).` };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// "New from template ▸" (DGC-66 / F6) — a submenu under the picker dropdown
// listing the fixture templates shipped with the server (`GET
// /api/templates`), fetched lazily the first time the submenu is opened.
// Picking one prompts for a diagram name (default: the template id) and
// POSTs `{ id, name }` to `/api/templates/use`, which seeds a new diagram
// with the fixture's DSL and activates it — same close-on-success behavior
// as the plain "New diagram…" input above. Kept as its own block (state,
// pure helpers, JSX) so it stays easy to lift/merge independently of the
// rest of the dropdown.
// ---------------------------------------------------------------------------

/** REST endpoint listing the template gallery. */
const TEMPLATES_LIST_URL = "/api/templates";
/** REST endpoint that creates+activates a diagram from a template. */
const TEMPLATES_USE_URL = "/api/templates/use";

/** One template entry — structurally mirrors the server's `TemplateSummary`. */
export interface TemplateSummary {
  id: string;
  title: string;
  nodeCount: number;
}

/** Shape returned by `POST /api/templates/use` — mirrors `OpenApiResult` minus `created`. */
interface UseTemplateApiResult {
  ok: boolean;
  name: string;
  version: number;
  error?: string;
}

/**
 * Menu label for a template entry, e.g. `"News Feed · 12 nodes"`. Pure — no
 * DOM — so it's testable without rendering (matches `groupDiagrams` /
 * `statusPillContent`'s split).
 */
export function formatTemplateLabel(template: TemplateSummary): string {
  const nodeWord = template.nodeCount === 1 ? "node" : "nodes";
  return `${template.title} · ${template.nodeCount} ${nodeWord}`;
}

async function requestTemplates(): Promise<TemplateSummary[]> {
  const res = await fetch(TEMPLATES_LIST_URL);
  if (!res.ok) throw new Error(`Could not load templates (HTTP ${res.status}).`);
  const parsed = (await res.json().catch(() => null)) as { templates?: TemplateSummary[] } | null;
  return parsed?.templates ?? [];
}

async function requestUseTemplate(id: string, name: string): Promise<UseTemplateApiResult> {
  const res = await fetch(TEMPLATES_USE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, name }),
  });
  const parsed = (await res.json().catch(() => null)) as UseTemplateApiResult | null;
  if (!parsed) {
    return { ok: false, name, version: 0, error: `Unexpected response (HTTP ${res.status}).` };
  }
  return parsed;
}

/** How long an error toast stays visible before auto-clearing (matches ExportMenu's STATUS_TIMEOUT_MS). */
const ERROR_TIMEOUT_MS = 2500;

export interface PickerProps {
  /** Current workspace listing (diagrams + active) — `null` until the first WS frame arrives. */
  workspace: WorkspaceMessage | null;
  /** Name shown on the trigger badge — the active diagram currently on canvas. */
  name: string;
  /** Version shown on the trigger badge. */
  version: number;
}

export function Picker({ workspace, name, version }: PickerProps) {
  const [open, setOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "New from template ▸" submenu state — separate from the plain
  // "New diagram…" input above (see the block comment near the top of this
  // file). `templates: null` means "not fetched yet"; fetched lazily on
  // first expand, not eagerly with the rest of the dropdown.
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(null);
  const [templatesLoading, setTemplatesLoading] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape — same behavior as ExportMenu's dropdown.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as globalThis.Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  // Reset transient state whenever the dropdown closes, so a stale error/typed
  // name doesn't linger the next time it's reopened.
  useEffect(() => {
    if (!open) {
      setNewName("");
      setError(null);
      setTemplatesOpen(false);
      setTemplates(null);
    }
  }, [open]);

  // Auto-clear the error toast (matches ExportMenu's status auto-clear).
  useEffect(() => {
    if (!error) return;
    const id = window.setTimeout(() => setError(null), ERROR_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [error]);

  const handleOpen = useCallback(
    async (target: string) => {
      const trimmed = target.trim();
      if (!trimmed || busy) return;
      setBusy(true);
      setError(null);
      try {
        const result = await requestOpen(trimmed);
        if (!result.ok) {
          setError(result.error ?? `Could not open "${trimmed}".`);
          return;
        }
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const handleCreateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void handleOpen(newName);
  };

  // Toggle the "New from template ▸" submenu, fetching the gallery lazily on
  // first expand (not eagerly with the rest of the dropdown, per the fetch
  // being scoped to when the submenu is actually opened).
  const handleToggleTemplates = useCallback(() => {
    setTemplatesOpen((wasOpen) => {
      const nowOpen = !wasOpen;
      if (nowOpen && templates === null && !templatesLoading) {
        setTemplatesLoading(true);
        setError(null);
        requestTemplates()
          .then((list) => setTemplates(list))
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setTemplatesLoading(false));
      }
      return nowOpen;
    });
  }, [templates, templatesLoading]);

  const handleUseTemplate = useCallback(
    async (template: TemplateSummary) => {
      if (busy) return;
      const typed = window.prompt(`Diagram name for "${template.title}":`, template.id);
      if (typed === null) return; // user cancelled the prompt
      const trimmed = typed.trim();
      if (!trimmed) return;
      setBusy(true);
      setError(null);
      try {
        const result = await requestUseTemplate(template.id, trimmed);
        if (!result.ok) {
          setError(result.error ?? `Could not create "${trimmed}" from "${template.id}".`);
          return;
        }
        setOpen(false);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const groups = groupDiagrams(workspace?.diagrams ?? []);
  const active = workspace?.active;

  return (
    <div className="picker" ref={containerRef}>
      <button
        type="button"
        className="picker__trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <b>{name}</b> · v{version}
      </button>
      {open && (
        <div className="picker__panel" role="menu">
          {groups.length === 0 ? (
            <div className="picker__empty">Chưa có sơ đồ nào.</div>
          ) : (
            <div className="picker__list">
              {groups.map((group) => (
                <div key={group.root} className="picker__group">
                  <button
                    type="button"
                    role="menuitem"
                    className="picker__item"
                    disabled={busy}
                    onClick={() => void handleOpen(group.root)}
                  >
                    <span className="picker__check">{group.root === active ? "✓" : ""}</span>
                    <span className="picker__name">{group.root}</span>
                  </button>
                  {group.steps.map((step) => (
                    <button
                      key={step}
                      type="button"
                      role="menuitem"
                      className="picker__item picker__item--step"
                      disabled={busy}
                      onClick={() => void handleOpen(step)}
                    >
                      <span className="picker__check">{step === active ? "✓" : ""}</span>
                      <span className="picker__name">{step}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
          <form className="picker__new" onSubmit={handleCreateSubmit}>
            <input
              type="text"
              className="picker__new-input"
              placeholder="New diagram…"
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              disabled={busy}
            />
          </form>
          {/* "New from template ▸" (DGC-66/F6) — separate block from the plain
              "New diagram…" form above; see the block comment near the top of
              this file for why it's split out this way. */}
          <div className="picker__templates">
            <button
              type="button"
              className="picker__templates-toggle"
              aria-haspopup="menu"
              aria-expanded={templatesOpen}
              disabled={busy}
              onClick={handleToggleTemplates}
            >
              New from template {templatesOpen ? "▾" : "▸"}
            </button>
            {templatesOpen && (
              <div className="picker__templates-list" role="menu">
                {templatesLoading && <div className="picker__empty">Loading templates…</div>}
                {!templatesLoading && templates !== null && templates.length === 0 && (
                  <div className="picker__empty">No templates available.</div>
                )}
                {!templatesLoading &&
                  templates?.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      role="menuitem"
                      className="picker__item"
                      disabled={busy}
                      onClick={() => void handleUseTemplate(template)}
                    >
                      <span className="picker__name">{formatTemplateLabel(template)}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
          {error && (
            <div className="picker__status picker__status--error" role="status">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
