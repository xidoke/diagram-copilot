/**
 * Theme mode (dark "theme B", default, / light "theme A" — DGC-70). A single
 * `data-theme` attribute on `<html>` selects which block of `tokens.css`
 * wins; every component style already reads its colors through a `var(--…)`
 * token, so flipping the attribute is the entire theme switch — no
 * component CSS needs to know a light theme exists.
 *
 * Pure state (`getTheme`/`applyTheme`/`setTheme`/`subscribeTheme`) is kept
 * DOM/storage-injectable, mirroring `render/layoutOptions.ts`'s
 * `PrefsStorage` pattern, so it's unit-testable without a real browser (this
 * package's tests run in plain Node — see `Drawer.tsx`'s module docstring).
 * `useTheme` is the one React binding every themed component should use;
 * nothing else should touch `localStorage`'s theme key or the `data-theme`
 * attribute directly.
 *
 * Multiple components render `useTheme()` independently (Toolbar owns the
 * ☀/🌙 toggle, Drawer listens to switch Monaco's theme) — each is its own
 * `useState`, so a toggle in one wouldn't be seen by the other without the
 * `subscribeTheme` pub/sub below fanning `setTheme` out to every mounted
 * instance.
 */
import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

/** Default theme when nothing is persisted yet (theme B, dark blueprint). */
export const DEFAULT_THEME: Theme = "dark";

/** `localStorage` key the theme is persisted under. */
export const THEME_STORAGE_KEY = "dgc.theme";

/** `data-theme` attribute set on `documentElement` — see `tokens.css`. */
const THEME_ATTR = "data-theme";

/** Minimal slice of `Storage` this module needs — narrows the test surface. */
export type ThemeStorage = Pick<Storage, "getItem" | "setItem">;

/** Minimal slice of the DOM element this module needs — narrows the test surface. */
export type ThemeTarget = Pick<HTMLElement, "setAttribute" | "removeAttribute">;

function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

/**
 * Read the persisted theme. Defaults to `window.localStorage`; pass a mock
 * `Storage` in tests. Falls back to {@link DEFAULT_THEME} when nothing (or
 * something malformed) is stored.
 */
export function getTheme(storage: ThemeStorage = window.localStorage): Theme {
  const raw = storage.getItem(THEME_STORAGE_KEY);
  return isTheme(raw) ? raw : DEFAULT_THEME;
}

/**
 * Apply `theme` to `target` (defaults to `document.documentElement`) —
 * DOM-only, no storage write and no listener notification (see `setTheme`
 * for the full write path). `data-theme="light"` selects `tokens.css`'s
 * light block; the attribute is removed entirely for dark, since the
 * un-prefixed `:root` block already *is* the dark theme.
 */
export function applyTheme(theme: Theme, target: ThemeTarget = document.documentElement): void {
  if (theme === "light") {
    target.setAttribute(THEME_ATTR, "light");
  } else {
    target.removeAttribute(THEME_ATTR);
  }
}

type ThemeListener = (theme: Theme) => void;
const listeners = new Set<ThemeListener>();

/**
 * Persist + apply `theme`, then notify every subscriber (every mounted
 * `useTheme()` instance) so they can't drift out of sync with each other.
 * Defaults to the real `window.localStorage` / `document.documentElement`;
 * pass mocks in tests.
 */
export function setTheme(
  theme: Theme,
  storage: ThemeStorage = window.localStorage,
  target: ThemeTarget = document.documentElement,
): void {
  storage.setItem(THEME_STORAGE_KEY, theme);
  applyTheme(theme, target);
  for (const listener of listeners) listener(theme);
}

/**
 * Subscribe to theme changes made via `setTheme` (e.g. another component's
 * toggle). Returns an unsubscribe function.
 */
export function subscribeTheme(listener: ThemeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * React binding: current theme + a toggle. On mount, applies the persisted
 * theme to `documentElement` (covers a hard refresh, where the attribute
 * isn't set yet) and subscribes to updates from any other `useTheme()`
 * instance's toggle.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  useEffect(() => {
    applyTheme(theme);
    return subscribeTheme(setThemeState);
    // Deliberately mount-only: `theme` here is just the initial snapshot
    // used to sync the DOM once; subsequent changes flow through the
    // subscription, not this effect re-running.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [theme]);

  return { theme, toggleTheme };
}
