/**
 * Headless render fallback (DGC-82) — lifecycle manager for the hidden
 * canvas that lets `get_snapshot` / `export_diagram` work with NO browser
 * tab open (agent pipelines, cron).
 *
 * Design: rather than teaching the server to rasterize, the fallback spawns
 * a headless system Chrome page pointed at the server's OWN web app. That
 * page registers as a perfectly normal WS client and answers the existing
 * `snapshot-request` broadcast, so the render path — and therefore the
 * pixels — are identical to an open canvas by construction.
 *
 * This module owns POLICY only (when to launch, reuse, reap); the
 * puppeteer-core mechanics live in `puppeteer-session.ts`, injected via
 * {@link HeadlessRendererOptions.openPage} so everything here is unit-tested
 * with fakes (test/headless-renderer.test.ts).
 *
 * Reuse: the browser+page persist across calls and are reaped after
 * {@link HEADLESS_IDLE_TIMEOUT_MS} of snapshot inactivity. While the page is
 * connected it counts as a regular client, so subsequent tool calls take the
 * normal fast path and never re-enter `ensureClient` — the CLI therefore
 * wires {@link HeadlessRenderer.touch} to every inbound `snapshot-response`
 * to keep the idle clock honest.
 */

/** How long the hidden canvas survives without snapshot traffic. */
export const HEADLESS_IDLE_TIMEOUT_MS = 60_000;

/** How long to wait for the page to finish rendering the diagram. */
export const HEADLESS_READY_TIMEOUT_MS = 15_000;

/**
 * The slice of a live headless page the renderer manages. Implemented for
 * real by `openHeadlessCanvas` (puppeteer-session.ts); faked in tests.
 */
export interface HeadlessCanvasPage {
  /**
   * Resolve `true` once the canvas has rendered at least one node and the
   * layout has settled (positions stable); `false` when `timeoutMs` elapses
   * first or the page goes away.
   */
  waitForDiagramRendered(timeoutMs: number): Promise<boolean>;
  /** `false` once the page/browser has closed or crashed. */
  isOpen(): boolean;
  close(): Promise<void>;
}

export type EnsureClientResult = { ok: true } | { ok: false; error: string };

export interface HeadlessRendererOptions {
  /** The server's own base URL — read lazily (the port binds after startup). */
  url: () => string;
  /** Active diagram name — the hidden canvas can only render this one. */
  getActive: () => string | null;
  /**
   * Page factory — defaults to the puppeteer-core session, imported lazily
   * so the dependency is only loaded when the fallback actually fires.
   * Injected by tests.
   */
  openPage?: (url: string) => Promise<HeadlessCanvasPage>;
  /** Idle reap override — defaults to {@link HEADLESS_IDLE_TIMEOUT_MS}. */
  idleTimeoutMs?: number;
  /** Render wait override — defaults to {@link HEADLESS_READY_TIMEOUT_MS}. */
  readyTimeoutMs?: number;
  /** Diagnostic sink (the CLI logs these); defaults to silent. */
  log?: (line: string) => void;
}

export interface HeadlessRenderer {
  /**
   * Make sure a WS client rendering `target` exists, launching the hidden
   * canvas if needed. Wired into `SnapshotOps.ensureClient`; the tools call
   * it only when `clientCount() === 0`. `ok: false` carries the user-facing
   * error (target not active, no Chrome installed, render never settled).
   */
  ensureClient(target: string): Promise<EnsureClientResult>;
  /** Reset the idle clock — call on any snapshot traffic. No-op without a page. */
  touch(): void;
  /** Shutdown: reap the page and refuse further launches. */
  close(): Promise<void>;
  /** `true` while a hidden canvas is believed open (introspection/tests). */
  readonly hasPage: boolean;
}

/** Create the singleton renderer the CLI wires into the MCP snapshot ops. */
export function createHeadlessRenderer(options: HeadlessRendererOptions): HeadlessRenderer {
  const idleTimeoutMs = options.idleTimeoutMs ?? HEADLESS_IDLE_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? HEADLESS_READY_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const openPage =
    options.openPage ??
    (async (url: string) => (await import("./puppeteer-session.js")).openHeadlessCanvas(url));

  let page: HeadlessCanvasPage | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let inFlight: Promise<EnsureClientResult> | null = null;
  let closed = false;

  function clearIdleTimer(): void {
    if (idleTimer !== null) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  }

  function scheduleIdleReap(): void {
    clearIdleTimer();
    idleTimer = setTimeout(() => void closePage("idle"), idleTimeoutMs);
    // Never keep the process alive just to reap a hidden canvas.
    idleTimer.unref?.();
  }

  async function closePage(reason: string): Promise<void> {
    const current = page;
    page = null;
    clearIdleTimer();
    if (current !== null) {
      log(`closing hidden canvas (${reason})`);
      try {
        await current.close();
      } catch {
        // Already gone (crash, external kill) — nothing to release.
      }
    }
  }

  async function ensure(target: string): Promise<EnsureClientResult> {
    if (page !== null && !page.isOpen()) {
      // Browser died behind our back — forget it and relaunch below.
      page = null;
      clearIdleTimer();
    }

    if (page === null) {
      const url = options.url();
      log(`no web client connected — launching hidden canvas at ${url}`);
      try {
        page = await openPage(url);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }

    // Wait for the canvas to settle before the tool broadcasts its
    // snapshot-request: the web responder answers instantly with whatever is
    // on screen, so capturing mid-layout would return a half-drawn diagram.
    // Cheap when already stable (two ~150ms samples).
    const rendered = await page.waitForDiagramRendered(readyTimeoutMs);
    if (!rendered) {
      await closePage("render never settled");
      return {
        ok: false,
        error:
          `A hidden canvas was opened but "${target}" did not finish rendering within ${readyTimeoutMs}ms. ` +
          `The diagram may be empty or failing to parse — check it with validate_dsl, or open ${options.url()} in a browser to see what the canvas shows.`,
      };
    }

    scheduleIdleReap();
    log("hidden canvas ready");
    return { ok: true };
  }

  return {
    async ensureClient(target: string): Promise<EnsureClientResult> {
      if (closed) {
        return { ok: false, error: "The server is shutting down — headless rendering is unavailable." };
      }
      // The web canvas renders the ACTIVE diagram (and the snapshot protocol
      // keeps clients showing anything else silent), so a non-active target
      // can never be answered — fail fast with guidance instead of burning a
      // browser launch plus a broker timeout.
      const active = options.getActive();
      if (active !== target) {
        return {
          ok: false,
          error:
            `No web client is connected, and the headless fallback renders only the ACTIVE diagram` +
            `${active !== null ? ` (currently "${active}")` : ""}. ` +
            `Call open_diagram { "name": "${target}" } first, then try again.`,
        };
      }
      // Single-flight: concurrent calls (both tools racing) share one launch.
      inFlight ??= ensure(target).finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    touch(): void {
      if (page !== null) scheduleIdleReap();
    },

    async close(): Promise<void> {
      closed = true;
      if (inFlight !== null) {
        // Let an in-progress launch finish so its browser isn't orphaned.
        try {
          await inFlight;
        } catch {
          // ensure() reports failures via the result — nothing rejects here.
        }
      }
      await closePage("shutdown");
    },

    get hasPage() {
      return page !== null;
    },
  };
}
