/**
 * Node search (DGC-64 / F4) — ⌘F / Ctrl+F opens a small top-center box that
 * finds a node by label as you type and jumps the viewport to it.
 *
 * The shortcut is only intercepted while focus is on the canvas or the
 * search box itself — anywhere else editable (Monaco, the notes textarea,
 * the picker's "new diagram" input, …) keeps the browser's native find,
 * same guard `isEditableTarget` already provides for ⌘Z (UndoButton.tsx)
 * and ←/→ (StepsNav.tsx).
 *
 * `matchNodes` (and the diacritics-stripping `normalize` it's built on) is
 * the pure half — no DOM, no React Flow — so it's unit-testable on its own
 * (matches the project's node-only vitest setup). Vietnamese labels are
 * common in diagrams (see `examples/rate-limiter.arch`'s "Người dùng"), so
 * a plain-ASCII query like "nguoi dung" needs to find them too: `normalize`
 * NFD-decomposes and strips combining marks, plus handles `đ`/`Đ` (which
 * NFD does *not* decompose). Matching checks both the literal
 * lower-cased strings and the fully normalized ones, so an accented query
 * still matches an accented label exactly, and a bare-ASCII query still
 * finds it too.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import { isEditableTarget } from "./UndoButton.js";
import "./search.css";

/** Minimal shape `matchNodes` needs — real callers pass React Flow nodes
 *  mapped down to `{ id, label }`. */
export interface SearchableNode {
  id: string;
  label: string;
}

const COMBINING_MARKS = /[\u0300-\u036f]/g;

/** Lowercase + strip diacritics (NFD combining marks, plus `đ`/`Đ` which NFD
 *  leaves alone since it's a distinct base letter, not a composed one). */
export function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * Nodes whose label contains `query` — case-insensitively, and matched both
 * literally and with diacritics stripped from both sides (so "nguoi dung"
 * finds "Người dùng"). Blank/whitespace-only queries match nothing. Pure —
 * safe to unit-test without mounting anything.
 */
export function matchNodes<T extends SearchableNode>(nodes: T[], query: string): T[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const literal = trimmed.toLowerCase();
  const stripped = normalize(trimmed);
  return nodes.filter((n) => n.label.toLowerCase().includes(literal) || normalize(n.label).includes(stripped));
}

/** CSS class applied to a found node's `.react-flow__node` wrapper for a
 *  brief glow (see search.css); matches the animation's own duration. */
export const FOUND_CLASS = "arch-node--found";
const HIGHLIGHT_MS = 2000;

export interface SearchBoxProps {
  /** Searchable nodes on the current canvas — id + label only. */
  nodes: SearchableNode[];
}

export function SearchBox({ nodes }: SearchBoxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const highlightRef = useRef<{ el: Element; timer: number } | null>(null);
  const { setCenter, getNodesBounds } = useReactFlow();

  const matches = useMemo(() => matchNodes(nodes, query), [nodes, query]);

  const clearHighlight = useCallback(() => {
    if (!highlightRef.current) return;
    window.clearTimeout(highlightRef.current.timer);
    highlightRef.current.el.classList.remove(FOUND_CLASS);
    highlightRef.current = null;
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActiveIndex(0);
  }, []);

  // ⌘F / Ctrl+F: open (or refocus) the box, unless focus is on some *other*
  // editable surface — then leave the browser's native find alone.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "f") return;
      if (isEditableTarget(e.target) && e.target !== inputRef.current) return;
      e.preventDefault();
      setOpen(true);
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  useEffect(() => () => clearHighlight(), [clearHighlight]);

  const goToIndex = useCallback(
    (index: number) => {
      const match = matches[index];
      if (!match) return;
      const rect = getNodesBounds([match.id]);
      if (rect.width === 0 && rect.height === 0) return; // not mounted — safety net
      void setCenter(rect.x + rect.width / 2, rect.y + rect.height / 2, { zoom: 1.2, duration: 300 });

      clearHighlight();
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(match.id)}"]`);
      if (el) {
        el.classList.add(FOUND_CLASS);
        const timer = window.setTimeout(() => {
          el.classList.remove(FOUND_CLASS);
          highlightRef.current = null;
        }, HIGHLIGHT_MS);
        highlightRef.current = { el, timer };
      }
    },
    [matches, getNodesBounds, setCenter, clearHighlight],
  );

  // First match jumps into view as soon as it appears/changes, so typing
  // alone (no Enter needed) already centers the top hit. Keyed off the top
  // match's *id* rather than the `matches` array itself — `nodes` gets a new
  // array reference on every unrelated drag/layout tick while the box is
  // open, and re-centering the viewport on those would be jarring.
  const topMatchId = matches[0]?.id;
  useEffect(() => {
    if (topMatchId !== undefined) goToIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topMatchId]);

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || (e.key === "Enter" && !e.shiftKey)) {
      e.preventDefault();
      if (matches.length === 0) return;
      const next = (activeIndex + 1) % matches.length;
      setActiveIndex(next);
      goToIndex(next);
    } else if (e.key === "ArrowUp" || (e.key === "Enter" && e.shiftKey)) {
      e.preventDefault();
      if (matches.length === 0) return;
      const next = (activeIndex - 1 + matches.length) % matches.length;
      setActiveIndex(next);
      goToIndex(next);
    }
  };

  if (!open) return null;

  return (
    <div className="search-box" role="search">
      <span className="search-box__icon">⌕</span>
      <input
        ref={inputRef}
        type="text"
        className="search-box__input"
        placeholder="Tìm node… (Esc để đóng)"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onInputKeyDown}
        aria-label="Tìm node theo tên"
      />
      <span className="search-box__count">
        {matches.length > 0 ? `${activeIndex + 1}/${matches.length}` : query.trim() ? "0/0" : ""}
      </span>
      <button type="button" className="search-box__close" aria-label="Đóng tìm kiếm" onClick={close}>
        ✕
      </button>
    </div>
  );
}
