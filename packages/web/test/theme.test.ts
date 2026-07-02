/**
 * Unit tests for the DGC-70 theme module: the pure get/apply/set/subscribe
 * state (mocked `Storage`/DOM target, matching `render/layoutOptions.ts`'s
 * test convention — this package's tests run in plain Node, no jsdom) plus a
 * light-touch structural check that `tokens.css`'s light block exists and
 * carries its main keys (a full CSS parser would be overkill for a "did the
 * block get written" smoke test).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  getTheme,
  setTheme,
  subscribeTheme,
  type ThemeStorage,
  type ThemeTarget,
} from "../src/theme.js";

/** In-memory `Storage` fake — same shape as `layoutOptions.test.ts`'s. */
function makeStorage(initial: Record<string, string> = {}): ThemeStorage {
  const store = { ...initial };
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      store[key] = value;
    },
  };
}

/** Fake DOM target recording `setAttribute`/`removeAttribute` calls. */
function makeTarget(): ThemeTarget & { attrs: Record<string, string> } {
  const attrs: Record<string, string> = {};
  return {
    attrs,
    setAttribute: (name, value) => {
      attrs[name] = value;
    },
    removeAttribute: (name) => {
      delete attrs[name];
    },
  };
}

describe("getTheme", () => {
  it("defaults to dark when nothing is persisted", () => {
    expect(getTheme(makeStorage())).toBe("dark");
    expect(DEFAULT_THEME).toBe("dark");
  });

  it("defaults to dark for a malformed persisted value", () => {
    expect(getTheme(makeStorage({ [THEME_STORAGE_KEY]: "sepia" }))).toBe("dark");
  });

  it("reads back a validly persisted theme", () => {
    expect(getTheme(makeStorage({ [THEME_STORAGE_KEY]: "light" }))).toBe("light");
    expect(getTheme(makeStorage({ [THEME_STORAGE_KEY]: "dark" }))).toBe("dark");
  });
});

describe("applyTheme", () => {
  it("sets data-theme=light for the light theme", () => {
    const target = makeTarget();
    applyTheme("light", target);
    expect(target.attrs["data-theme"]).toBe("light");
  });

  it("removes the attribute for dark (the :root block is the dark default)", () => {
    const target = makeTarget();
    target.attrs["data-theme"] = "light"; // simulate a prior switch to light
    applyTheme("dark", target);
    expect(target.attrs["data-theme"]).toBeUndefined();
  });
});

describe("setTheme", () => {
  it("round-trips through storage: setTheme(theme) → getTheme() reads it back", () => {
    const storage = makeStorage();
    const target = makeTarget();
    setTheme("light", storage, target);
    expect(getTheme(storage)).toBe("light");
    expect(target.attrs["data-theme"]).toBe("light");

    setTheme("dark", storage, target);
    expect(getTheme(storage)).toBe("dark");
    expect(target.attrs["data-theme"]).toBeUndefined();
  });

  it("notifies subscribers with the new theme", () => {
    const storage = makeStorage();
    const target = makeTarget();
    const listener = vi.fn();
    const unsubscribe = subscribeTheme(listener);

    setTheme("light", storage, target);
    expect(listener).toHaveBeenCalledWith("light");

    unsubscribe();
    listener.mockClear();
    setTheme("dark", storage, target);
    expect(listener).not.toHaveBeenCalled();
  });
});

/** Read `tokens.css`'s raw text — used by the light-block check below. */
function loadTokensCss(): string {
  return readFileSync(fileURLToPath(new URL("../src/tokens.css", import.meta.url)), "utf8");
}

/**
 * Slices out the `[data-theme="light"] { … }` block's body. Deliberately a
 * plain brace-matching scan (not a real CSS parser) — this is a smoke test
 * for "the block exists and defines the tokens components rely on", not a
 * CSS validator.
 */
function extractLightBlock(css: string): string {
  const start = css.indexOf('[data-theme="light"]');
  expect(start, '`[data-theme="light"]` block not found in tokens.css').toBeGreaterThanOrEqual(0);
  const braceOpen = css.indexOf("{", start);
  let depth = 0;
  for (let i = braceOpen; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) return css.slice(braceOpen + 1, i);
    }
  }
  throw new Error("unterminated [data-theme=\"light\"] block in tokens.css");
}

describe("tokens.css light block", () => {
  const lightBlock = extractLightBlock(loadTokensCss());

  it.each([
    "--bg",
    "--panel",
    "--panel-translucent",
    "--border",
    "--text",
    "--text-dim",
    "--text-strong",
    "--accent",
    "--grid-dot",
    "--status-connected",
    "--status-connecting",
    "--status-disconnected",
    "--node-glow",
    "--group-bg",
    "--group-depth-1-tint",
    "--node-hover-border",
  ])("defines %s", (token) => {
    expect(lightBlock).toMatch(new RegExp(`${token}\\s*:`));
  });

  it("does not just repeat the dark :root values for the surface tokens", () => {
    const rootBlock = loadTokensCss().slice(0, loadTokensCss().indexOf('[data-theme="light"]'));
    const darkBg = /--bg:\s*([^;]+);/.exec(rootBlock)?.[1]?.trim();
    const lightBg = /--bg:\s*([^;]+);/.exec(lightBlock)?.[1]?.trim();
    expect(lightBg).toBeDefined();
    expect(lightBg).not.toBe(darkBg);
  });
});
