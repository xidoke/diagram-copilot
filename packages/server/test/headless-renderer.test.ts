/**
 * Unit tests for the headless-canvas lifecycle manager (DGC-82) — the piece
 * between the MCP tools' `ensureClient` fallback hook and the real
 * puppeteer-core session. The page factory is injected, so browser policy
 * (reuse, single-flight, idle reaping, failure paths) is tested with fakes
 * and zero Chromium.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHeadlessRenderer,
  type HeadlessCanvasPage,
  type HeadlessRendererOptions,
} from "../src/headless/renderer.js";

interface FakePage extends HeadlessCanvasPage {
  closed: boolean;
  renderedCalls: number;
}

function fakePage(rendered = true): FakePage {
  const page: FakePage = {
    closed: false,
    renderedCalls: 0,
    async waitForDiagramRendered() {
      page.renderedCalls += 1;
      return rendered;
    },
    isOpen: () => !page.closed,
    async close() {
      page.closed = true;
    },
  };
  return page;
}

function makeRenderer(overrides: Partial<HeadlessRendererOptions> = {}) {
  const pages: FakePage[] = [];
  const openPage = vi.fn(async () => {
    const page = fakePage();
    pages.push(page);
    return page;
  });
  const renderer = createHeadlessRenderer({
    url: () => "http://127.0.0.1:4842",
    getActive: () => "demo",
    openPage,
    ...overrides,
  });
  return { renderer, openPage, pages };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createHeadlessRenderer", () => {
  it("refuses a target that is not the active diagram, without launching anything", async () => {
    const { renderer, openPage } = makeRenderer({ getActive: () => "other" });

    const result = await renderer.ensureClient("demo");

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("open_diagram");
    expect(openPage).not.toHaveBeenCalled();
  });

  it("opens one page, waits for the diagram to render, and reports ok", async () => {
    const { renderer, openPage, pages } = makeRenderer();

    const result = await renderer.ensureClient("demo");

    expect(result).toEqual({ ok: true });
    expect(openPage).toHaveBeenCalledTimes(1);
    expect(openPage).toHaveBeenCalledWith("http://127.0.0.1:4842");
    expect(pages[0].renderedCalls).toBe(1);
    expect(renderer.hasPage).toBe(true);
  });

  it("reuses the open page on later calls instead of relaunching", async () => {
    const { renderer, openPage, pages } = makeRenderer();

    await renderer.ensureClient("demo");
    const again = await renderer.ensureClient("demo");

    expect(again).toEqual({ ok: true });
    expect(openPage).toHaveBeenCalledTimes(1);
    // Reuse still re-verifies the canvas has settled (active may have changed).
    expect(pages[0].renderedCalls).toBe(2);
  });

  it("single-flights concurrent calls into one launch", async () => {
    const { renderer, openPage } = makeRenderer();

    const [a, b] = await Promise.all([renderer.ensureClient("demo"), renderer.ensureClient("demo")]);

    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(openPage).toHaveBeenCalledTimes(1);
  });

  it("surfaces a launch failure (e.g. no Chrome found) as ok:false and retries next call", async () => {
    let attempts = 0;
    const page = fakePage();
    const openPage = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("no Chrome/Chromium/Edge executable was found");
      return page;
    });
    const { renderer } = makeRenderer({ openPage });

    const first = await renderer.ensureClient("demo");
    expect(first).toMatchObject({ ok: false });
    if (!first.ok) expect(first.error).toContain("no Chrome");

    const second = await renderer.ensureClient("demo");
    expect(second).toEqual({ ok: true });
    expect(openPage).toHaveBeenCalledTimes(2);
  });

  it("closes the page and reports ok:false when the diagram never renders", async () => {
    const page = fakePage(false);
    const { renderer } = makeRenderer({ openPage: async () => page, readyTimeoutMs: 123 });

    const result = await renderer.ensureClient("demo");

    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain("did not finish rendering");
    expect(page.closed).toBe(true);
    expect(renderer.hasPage).toBe(false);
  });

  it("relaunches when the previous page died behind our back", async () => {
    const { renderer, openPage, pages } = makeRenderer();

    await renderer.ensureClient("demo");
    pages[0].closed = true; // browser crashed / was killed externally

    const result = await renderer.ensureClient("demo");

    expect(result).toEqual({ ok: true });
    expect(openPage).toHaveBeenCalledTimes(2);
  });

  it("reaps the page after the idle timeout", async () => {
    const { renderer, pages } = makeRenderer({ idleTimeoutMs: 1000 });
    await renderer.ensureClient("demo");

    await vi.advanceTimersByTimeAsync(999);
    expect(pages[0].closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(pages[0].closed).toBe(true);
    expect(renderer.hasPage).toBe(false);
  });

  it("touch() defers the idle reap (snapshot traffic keeps the canvas alive)", async () => {
    const { renderer, pages } = makeRenderer({ idleTimeoutMs: 1000 });
    await renderer.ensureClient("demo");

    await vi.advanceTimersByTimeAsync(900);
    renderer.touch();
    await vi.advanceTimersByTimeAsync(900);
    expect(pages[0].closed).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(pages[0].closed).toBe(true);
  });

  it("touch() before any page exists is a harmless no-op", () => {
    const { renderer } = makeRenderer();
    expect(() => renderer.touch()).not.toThrow();
  });

  it("close() shuts the page down and refuses further ensureClient calls", async () => {
    const { renderer, pages } = makeRenderer();
    await renderer.ensureClient("demo");

    await renderer.close();

    expect(pages[0].closed).toBe(true);
    const after = await renderer.ensureClient("demo");
    expect(after).toMatchObject({ ok: false });
  });
});
