/**
 * Chrome/Chromium executable discovery for the headless render fallback
 * (DGC-82). Pure: platform, env, existence probe and home dir are all
 * injectable, so the whole decision table is unit-tested without touching
 * the real disk (see test/chrome-discovery.test.ts).
 *
 * Policy:
 *   - {@link CHROME_OVERRIDE_ENV} (our own env var) is EXPLICIT config —
 *     returned verbatim without an existence check, so a wrong value fails
 *     loudly at launch time (naming the bad path) instead of being silently
 *     ignored.
 *   - `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` are AMBIENT (often set
 *     globally for other tools) — honored only when the file actually
 *     exists, so a stale value cannot break otherwise-working discovery.
 *   - Then the platform's well-known install locations, in preference order
 *     (Chrome → Chromium → Edge → Brave). Unknown platforms scan the
 *     Linux-style locations.
 */
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Explicit executable override — trusted verbatim (see module doc). */
export const CHROME_OVERRIDE_ENV = "DIAGRAM_COPILOT_CHROME";

/** Ambient env vars — honored only when the file exists (see module doc). */
const AMBIENT_ENV_VARS = ["PUPPETEER_EXECUTABLE_PATH", "CHROME_PATH"] as const;

/** macOS app-bundle-relative executable paths, in preference order. */
const DARWIN_APPS = [
  "Google Chrome.app/Contents/MacOS/Google Chrome",
  "Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "Chromium.app/Contents/MacOS/Chromium",
  "Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "Brave Browser.app/Contents/MacOS/Brave Browser",
];

/** Linux (and unknown-platform) well-known locations, in preference order. */
const LINUX_CANDIDATES = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/opt/google/chrome/chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/usr/bin/microsoft-edge",
  "/usr/bin/brave-browser",
];

/** Windows install-base-relative executable paths, in preference order. */
const WIN32_RELATIVE = [
  "Google\\Chrome\\Application\\chrome.exe",
  "Chromium\\Application\\chrome.exe",
  "Microsoft\\Edge\\Application\\msedge.exe",
];

export interface ChromeDiscoveryOptions {
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Existence probe — defaults to `fs.existsSync`. */
  exists?: (candidate: string) => boolean;
  /** Defaults to `os.homedir()`. */
  home?: string;
}

/**
 * The platform's well-known executable locations, in preference order.
 * Exported for tests; {@link findChromeExecutable} is the real entry point.
 */
export function chromeCandidates(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  if (platform === "darwin") {
    // System-wide /Applications first, then a per-user ~/Applications install.
    return DARWIN_APPS.flatMap((app) => [
      path.join("/Applications", app),
      path.join(home, "Applications", app),
    ]);
  }
  if (platform === "win32") {
    const bases = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter(
      (base): base is string => typeof base === "string" && base !== "",
    );
    return bases.flatMap((base) => WIN32_RELATIVE.map((rel) => `${base}\\${rel}`));
  }
  return LINUX_CANDIDATES;
}

/**
 * Locate a Chromium-based browser executable for `puppeteer-core`, or `null`
 * when none can be found (the caller then degrades with guidance instead of
 * crashing — see `puppeteer-session.ts`).
 */
export function findChromeExecutable(options: ChromeDiscoveryOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const home = options.home ?? os.homedir();

  const override = env[CHROME_OVERRIDE_ENV]?.trim();
  if (override) return override;

  for (const name of AMBIENT_ENV_VARS) {
    const candidate = env[name]?.trim();
    if (candidate && exists(candidate)) return candidate;
  }

  for (const candidate of chromeCandidates(platform, env, home)) {
    if (exists(candidate)) return candidate;
  }
  return null;
}
