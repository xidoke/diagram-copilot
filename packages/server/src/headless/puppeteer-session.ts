/**
 * The puppeteer-core half of the headless render fallback (DGC-82): launch a
 * SYSTEM Chrome/Chromium/Edge (never a bundled download — `puppeteer-core`
 * ships no browser, keeping `npx` installs light) in headless mode, point it
 * at the server's own web app, and expose the small
 * {@link HeadlessCanvasPage} surface `renderer.ts` manages.
 *
 * This file is deliberately thin I/O glue: all policy (reuse, idle reaping,
 * failure routing) lives in `renderer.ts` behind an injected factory, and
 * all discovery logic is in `chrome.ts` — both unit-tested. This module is
 * exercised by the real E2E run instead.
 *
 * `puppeteer-core` is imported dynamically so the dependency is only loaded
 * on the first actual fallback, keeping server startup untouched.
 */
import type { Browser, Page } from "puppeteer-core";
import { CHROME_OVERRIDE_ENV, findChromeExecutable } from "./chrome.js";
import type { HeadlessCanvasPage } from "./renderer.js";

/**
 * Window size for the hidden canvas. Captures are sized from the diagram's
 * node bounds (`computeExportRect`) with `pixelRatio` pinned to 1, NOT from
 * the window — so this only needs to be big enough for the app to lay out
 * comfortably; it does not affect the exported pixels.
 */
const VIEWPORT = { width: 1440, height: 900, deviceScaleFactor: 1 } as const;

/** React Flow node elements — presence + stable transforms ⇒ layout settled. */
const NODE_SELECTOR = ".react-flow__node";

/** Consecutive identical samples required to call the layout settled. */
const STABLE_SAMPLES = 2;

/** Gap between layout-stability samples. */
const SAMPLE_INTERVAL_MS = 150;

/** Page-load budget for the app shell itself (bundle is served locally). */
const PAGE_LOAD_TIMEOUT_MS = 15_000;

/**
 * In-page snippet: one string fingerprint of the rendered graph — node ids,
 * inline transforms AND measured sizes — or `null` before any node exists.
 * ELK layout is async (nodes appear, then move) and node metrics shift again
 * when webfonts land, so "rendered" = non-null AND unchanged across
 * consecutive samples; sizes are included because the capture rect comes
 * from React Flow's measured bounds, not just positions. A string (not a
 * function) because this package compiles WITHOUT the DOM lib; the snippet
 * runs in the browser, never here.
 */
const SIGNATURE_SNIPPET = `(() => {
  const nodes = document.querySelectorAll(${JSON.stringify(NODE_SELECTOR)});
  if (nodes.length === 0) return null;
  return Array.from(nodes)
    .map((node) =>
      (node.getAttribute("data-id") ?? "") + "@" + node.style.transform +
      "#" + node.offsetWidth + "x" + node.offsetHeight,
    )
    .join("|");
})()`;

/** In-page snippet: resolves once webfonts have landed (see usage below). */
const FONTS_READY_SNIPPET = "document.fonts.ready.then(() => undefined)";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Launch a hidden system-Chrome page at `url` (the server's own web app). The
 * page connects to `/ws` like any browser tab and starts answering
 * `snapshot-request` broadcasts for the active diagram.
 *
 * Throws with actionable guidance when no Chromium-based browser exists —
 * the deliberate degrade path, surfaced verbatim as the tool error.
 */
export async function openHeadlessCanvas(url: string): Promise<HeadlessCanvasPage> {
  const executablePath = findChromeExecutable();
  if (executablePath === null) {
    throw new Error(
      "Cannot render headlessly: no Chrome, Chromium or Edge executable was found on this machine. " +
        "Two ways out: (1) install Google Chrome (or set " +
        `${CHROME_OVERRIDE_ENV} to a Chromium-based browser executable), or (2) open ${url} ` +
        "in any browser and call the tool again — an open canvas renders the image as before.",
    );
  }

  const { default: puppeteer } = await import("puppeteer-core");
  const browser: Browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ["--hide-scrollbars", "--mute-audio"],
  });

  let page: Page;
  try {
    page = await browser.newPage();
    await page.setViewport(VIEWPORT);
    await page.goto(url, { waitUntil: "load", timeout: PAGE_LOAD_TIMEOUT_MS });
  } catch (error) {
    await browser.close().catch(() => {});
    throw new Error(
      `Headless ${executablePath.includes("Edge") ? "Edge" : "Chrome"} launched but could not load the canvas at ${url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return {
    async waitForDiagramRendered(timeoutMs: number): Promise<boolean> {
      const deadline = Date.now() + timeoutMs;
      let previous: string | null = null;
      let stableRuns = 0;

      // Fonts FIRST: node text metrics (and therefore measured sizes, which
      // feed the capture bounds) shift when webfonts land — sampling before
      // that settles could bless a layout that is about to change.
      await page.evaluate(FONTS_READY_SNIPPET).catch(() => {});

      while (Date.now() < deadline) {
        let signature: string | null;
        try {
          signature = (await page.evaluate(SIGNATURE_SNIPPET)) as string | null;
        } catch {
          return false; // page/browser went away mid-poll
        }

        if (signature !== null && signature === previous) {
          stableRuns += 1;
          if (stableRuns >= STABLE_SAMPLES - 1) {
            return true;
          }
        } else {
          stableRuns = 0;
        }
        previous = signature;
        await sleep(SAMPLE_INTERVAL_MS);
      }
      return false;
    },

    isOpen(): boolean {
      try {
        return browser.connected && !page.isClosed();
      } catch {
        return false;
      }
    },

    async close(): Promise<void> {
      await browser.close().catch(() => {});
    },
  };
}
