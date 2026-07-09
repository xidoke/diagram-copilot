/**
 * Unit tests for the pure Chrome/Chromium discovery half of the headless
 * render fallback (DGC-82). Everything is injected (platform, env, exists,
 * home), so these run identically on any OS without touching the real disk.
 */
import { describe, expect, it } from "vitest";
import {
  CHROME_OVERRIDE_ENV,
  chromeCandidates,
  findChromeExecutable,
} from "../src/headless/chrome.js";

const NOWHERE = () => false;

describe("findChromeExecutable", () => {
  it("returns the DIAGRAM_COPILOT_CHROME override verbatim WITHOUT an existence check", () => {
    // Explicit config wins and fails loudly at launch time if wrong — a
    // silent fall-through would mask the user's own setting.
    const found = findChromeExecutable({
      platform: "darwin",
      env: { [CHROME_OVERRIDE_ENV]: "/custom/chrome" },
      exists: NOWHERE,
      home: "/Users/u",
    });
    expect(found).toBe("/custom/chrome");
  });

  it("ignores a blank DIAGRAM_COPILOT_CHROME override", () => {
    const found = findChromeExecutable({
      platform: "linux",
      env: { [CHROME_OVERRIDE_ENV]: "   " },
      exists: NOWHERE,
      home: "/home/u",
    });
    expect(found).toBeNull();
  });

  it("honors PUPPETEER_EXECUTABLE_PATH only when the file exists", () => {
    // Ambient env vars (often set globally for other tools) must not break
    // discovery when stale — unlike our own explicit override above.
    const env = { PUPPETEER_EXECUTABLE_PATH: "/stale/chromium" };
    expect(
      findChromeExecutable({ platform: "linux", env, exists: NOWHERE, home: "/home/u" }),
    ).toBeNull();
    expect(
      findChromeExecutable({
        platform: "linux",
        env,
        exists: (p) => p === "/stale/chromium",
        home: "/home/u",
      }),
    ).toBe("/stale/chromium");
  });

  it("honors CHROME_PATH only when the file exists", () => {
    expect(
      findChromeExecutable({
        platform: "linux",
        env: { CHROME_PATH: "/opt/thorium" },
        exists: (p) => p === "/opt/thorium",
        home: "/home/u",
      }),
    ).toBe("/opt/thorium");
  });

  it("finds the standard macOS Chrome install", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const found = findChromeExecutable({
      platform: "darwin",
      env: {},
      exists: (p) => p === chrome,
      home: "/Users/u",
    });
    expect(found).toBe(chrome);
  });

  it("falls back to a home-directory macOS install and to Edge", () => {
    const homeEdge = "/Users/u/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    const found = findChromeExecutable({
      platform: "darwin",
      env: {},
      exists: (p) => p === homeEdge,
      home: "/Users/u",
    });
    expect(found).toBe(homeEdge);
  });

  it("prefers Chrome over Edge when both exist (candidate order is preference order)", () => {
    const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    const edge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    const found = findChromeExecutable({
      platform: "darwin",
      env: {},
      exists: (p) => p === chrome || p === edge,
      home: "/Users/u",
    });
    expect(found).toBe(chrome);
  });

  it("finds a Linux chromium from the well-known paths", () => {
    const found = findChromeExecutable({
      platform: "linux",
      env: {},
      exists: (p) => p === "/usr/bin/chromium-browser",
      home: "/home/u",
    });
    expect(found).toBe("/usr/bin/chromium-browser");
  });

  it("builds Windows candidates from the Program Files env vars", () => {
    const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    const found = findChromeExecutable({
      platform: "win32",
      env: {
        PROGRAMFILES: "C:\\Program Files",
        "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
      },
      exists: (p) => p === chrome,
      home: "C:\\Users\\u",
    });
    expect(found).toBe(chrome);
  });

  it("returns null when nothing is installed anywhere", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(
        findChromeExecutable({ platform, env: {}, exists: NOWHERE, home: "/home/u" }),
      ).toBeNull();
    }
  });
});

describe("chromeCandidates", () => {
  it("never yields an undefined-based path when Windows env vars are missing", () => {
    const candidates = chromeCandidates("win32", {}, "C:\\Users\\u");
    expect(candidates.every((c) => !c.includes("undefined"))).toBe(true);
  });

  it("treats unknown platforms like linux (PATH-style well-known locations)", () => {
    expect(chromeCandidates("freebsd", {}, "/home/u")).toContain("/usr/bin/chromium");
  });
});
