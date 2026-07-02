/**
 * Icon palette (DGC-77 / T-IPAL) — browse the whole @diagram-copilot/icons set
 * without leaving the app. The 🎨 trigger lives in the Toolbar (next to ▶
 * present); clicking it opens a searchable grid of every icon rendered with its
 * real glyph. Clicking an icon copies its DSL token — `[icon: <id>]` — to the
 * clipboard and flashes a small toast.
 *
 * The panel + toast are rendered through a portal to <body> so they escape the
 * Toolbar's `z-index` stacking context and paint above the other top-right
 * chrome (the export menu sits directly beneath the toolbar). Everything themes
 * through the shared `--…` tokens (see iconPalette.css), same as the rest of the
 * floating UI.
 *
 * `filterIcons` / `buildIconEntries` are the pure, DOM-free half so they're
 * unit-testable on their own (matches the project's node-only vitest setup).
 * Diacritics handling is delegated to SearchBox's `normalize` (imported, not
 * copied) so "khong dau" queries still find accented names/aliases.
 *
 * Follow-up (out of scope here): when the Drawer's Monaco editor is open we
 * could insert the token at the cursor instead of only copying — for now every
 * click just copies to the clipboard regardless of Drawer state, which keeps
 * this component fully self-contained and leaves the Drawer untouched.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ALIASES, getIcon, listIcons, type IconSource } from "@diagram-copilot/icons";
import { normalize } from "./SearchBox.js";
import "./iconPalette.css";

/** A single browsable icon: enough to render, search, tooltip, and copy it. */
export interface IconEntry {
  /** Canonical registry id — this is what gets copied as `[icon: <id>]`. */
  id: string;
  /** Human-readable display name (e.g. "PostgreSQL"). */
  title: string;
  /** Baked `<svg>` markup; uses `currentColor` so it inherits our text color. */
  svg: string;
  /** Origin package the artwork came from. */
  source: IconSource;
  /** Aliases that resolve to this icon — searchable and shown in the tooltip. */
  aliases: string[];
  /** True only for the trailing soft-fallback entry (the generic box glyph). */
  fallback?: boolean;
}

/** Any id the registry doesn't know resolves to the generic box; "fallback"
 *  gives that entry a self-describing id/title too. */
const FALLBACK_ID = "fallback";

/** How long the "copied …" toast stays visible before auto-dismissing. */
const TOAST_MS = 1500;

/** Invert the alias table into canonical-id → the aliases pointing at it. */
function aliasesByCanonical(): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const [alias, target] of Object.entries(ALIASES)) {
    (map[target] ??= []).push(alias);
  }
  return map;
}

/**
 * Every browsable icon: the whole registry (each tagged with the aliases that
 * point at it), then — last — the generic soft-fallback box that {@link getIcon}
 * returns for any unrecognized id, flagged so the grid can label it "fallback".
 */
export function buildIconEntries(): IconEntry[] {
  const aliasMap = aliasesByCanonical();
  const entries: IconEntry[] = listIcons().map((icon) => ({
    id: icon.id,
    title: icon.title,
    svg: icon.svg,
    source: icon.source,
    aliases: aliasMap[icon.id] ?? [],
  }));
  const fb = getIcon(FALLBACK_ID);
  entries.push({ id: fb.id, title: fb.title, svg: fb.svg, source: fb.source, aliases: [], fallback: true });
  return entries;
}

/**
 * Icons whose id, title, or any alias contains `query` — matched both literally
 * (lower-cased) and with diacritics stripped (reusing SearchBox's `normalize`).
 * A blank/whitespace query returns every entry so the palette browses the full
 * set. Pure — no DOM, safe to unit-test on its own.
 */
export function filterIcons(entries: IconEntry[], query: string): IconEntry[] {
  const trimmed = query.trim();
  if (!trimmed) return entries;
  const literal = trimmed.toLowerCase();
  const stripped = normalize(trimmed);
  return entries.filter((entry) =>
    [entry.id, entry.title, ...entry.aliases].some(
      (field) => field.toLowerCase().includes(literal) || normalize(field).includes(stripped),
    ),
  );
}

/** Tooltip text for a cell: full name plus any aliases. */
function tooltipFor(entry: IconEntry): string {
  return [entry.title, entry.aliases.length ? `aliases: ${entry.aliases.join(", ")}` : null]
    .filter(Boolean)
    .join(" · ");
}

export function IconPalette() {
  const entries = useMemo(() => buildIconEntries(), []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterIcons(entries, query), [entries, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);

  // Close on outside click / Escape — the panel is portaled out of the toolbar,
  // so "outside" means outside BOTH the trigger and the panel.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as globalThis.Node;
      if (triggerRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  // Focus the search field as soon as the panel opens.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Auto-dismiss the toast.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), TOAST_MS);
    return () => window.clearTimeout(id);
  }, [toast]);

  const handleCopy = async (entry: IconEntry) => {
    const snippet = `[icon: ${entry.id}]`;
    try {
      await navigator.clipboard.writeText(snippet);
      setToast(`copied ${snippet}`);
    } catch {
      setToast(`copy failed — ${snippet}`);
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`toolbar-btn${open ? " toolbar-btn--active" : ""}`}
        title="Icon palette — browse & copy icons"
        aria-label="Icon palette"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
      >
        🎨
      </button>
      {open &&
        createPortal(
          <div className="icon-palette__panel" role="dialog" aria-label="Icon palette" ref={panelRef}>
            <div className="icon-palette__head">
              <span className="icon-palette__search-icon" aria-hidden="true">
                ⌕
              </span>
              <input
                ref={inputRef}
                type="text"
                className="icon-palette__input"
                placeholder="Tìm icon… (tên hoặc alias)"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Tìm icon theo tên hoặc alias"
              />
              <span className="icon-palette__count">{filtered.length} icons</span>
            </div>
            {filtered.length === 0 ? (
              <p className="icon-palette__empty">Không có icon khớp “{query.trim()}”.</p>
            ) : (
              <div className="icon-palette__grid">
                {filtered.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={`icon-palette__cell${entry.fallback ? " icon-palette__cell--fallback" : ""}`}
                    title={tooltipFor(entry)}
                    onClick={() => handleCopy(entry)}
                  >
                    <span
                      className="icon-palette__glyph"
                      // Baked, trusted markup from @diagram-copilot/icons (see
                      // ArchNode) — no user/network input reaches it, safe to inject.
                      dangerouslySetInnerHTML={{ __html: entry.svg }}
                    />
                    <span className="icon-palette__name">{entry.id}</span>
                    {entry.fallback && <span className="icon-palette__tag">fallback</span>}
                  </button>
                ))}
              </div>
            )}
          </div>,
          document.body,
        )}
      {toast &&
        createPortal(
          <div className="icon-palette__toast" role="status">
            {toast}
          </div>,
          document.body,
        )}
    </>
  );
}
