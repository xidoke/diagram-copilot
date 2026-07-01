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

/** REST endpoint for activating/creating a diagram — same host:port the WS default points at. */
const API_OPEN_URL = "http://localhost:4747/api/open";

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
