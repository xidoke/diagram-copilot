import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hasIcon, unregisterIconPack } from "@diagram-copilot/icons";

import { defaultIconPacksDir, loadIconPacksFromDisk } from "../src/icon-packs.js";

/** Minimal valid pack file body (same shape `pnpm icons:aws` generates). */
const PACK = {
  namespace: "testpack",
  title: "Test Pack",
  version: "1",
  license: "test terms",
  icons: { widget: { title: "Widget", svg: "<svg><rect/></svg>" } },
  aliases: { w: "widget" },
};

function makeDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-packs-"));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

afterEach(() => {
  unregisterIconPack("testpack");
});

describe("defaultIconPacksDir", () => {
  it("points at the icons package's packs/ directory", () => {
    const dir = defaultIconPacksDir();
    expect(dir).not.toBeNull();
    expect(dir).toMatch(/[/\\]icons[/\\]packs$/);
  });
});

describe("loadIconPacksFromDisk", () => {
  it("returns [] for a missing directory (no packs installed — the default)", () => {
    expect(loadIconPacksFromDisk(path.join(os.tmpdir(), "definitely-missing-packs-dir"))).toEqual([]);
  });

  it("registers every *.icons.json pack and reports it", () => {
    const dir = makeDir({ "testpack.icons.json": JSON.stringify(PACK), "notes.md": "ignored" });
    const loaded = loadIconPacksFromDisk(dir);
    expect(loaded).toEqual([{ namespace: "testpack", title: "Test Pack", version: "1", count: 1 }]);
    expect(hasIcon("testpack:widget")).toBe(true);
    expect(hasIcon("testpack:w")).toBe(true);
  });

  it("warns and skips a malformed pack without failing the rest", () => {
    const dir = makeDir({
      "aaa-broken.icons.json": "{ not json",
      "testpack.icons.json": JSON.stringify(PACK),
    });
    const warnings: string[] = [];
    const loaded = loadIconPacksFromDisk(dir, (message) => warnings.push(message));
    expect(loaded.map((p) => p.namespace)).toEqual(["testpack"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("aaa-broken.icons.json");
  });
});
