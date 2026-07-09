/**
 * Tests for the CLI entry's export-root wiring (DGC-81) — configuring EXTRA
 * `export_diagram` whitelist roots via the `DIAGRAM_COPILOT_EXPORT_ROOTS` env
 * var, additive on top of `--export-root` / the Obsidian vault default.
 *
 * Two halves:
 *   - `parseExportRootsEnv` (pure): splitting/trimming/dropping-empty/`~`
 *     expansion of the env var value, in isolation.
 *   - `parseCliArgs` (env wiring): the env var's roots land in
 *     `CliOptions.exportRoots` ADDED to, never replacing, `--export-root` /
 *     the default vault root.
 *   - `resolveExportDestination` integration: an env-declared root is
 *     actually accepted as a valid `export_diagram` destination, and a path
 *     outside every root (including env-declared ones) is still refused with
 *     the full root list.
 */
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveExportDestination } from "../src/mcp/tools/export-file.js";
import {
  DEFAULT_OBSIDIAN_VAULT_ROOT,
  EXPORT_ROOTS_ENV_VAR,
  parseCliArgs,
  parseExportRootsEnv,
} from "../src/index.js";

describe("parseExportRootsEnv (pure)", () => {
  it("returns [] when the env var is unset", () => {
    expect(parseExportRootsEnv(undefined)).toEqual([]);
  });

  it("returns [] when the env var is an empty string", () => {
    expect(parseExportRootsEnv("")).toEqual([]);
  });

  it("returns [] when the env var is only whitespace", () => {
    expect(parseExportRootsEnv("   ")).toEqual([]);
  });

  it("parses a single root", () => {
    expect(parseExportRootsEnv("/tmp/one")).toEqual(["/tmp/one"]);
  });

  it("parses multiple roots separated by path.delimiter", () => {
    const value = ["/tmp/one", "/tmp/two", "/tmp/three"].join(path.delimiter);
    expect(parseExportRootsEnv(value)).toEqual(["/tmp/one", "/tmp/two", "/tmp/three"]);
  });

  it("trims whitespace around each entry", () => {
    const value = [" /tmp/one ", " /tmp/two "].join(path.delimiter);
    expect(parseExportRootsEnv(value)).toEqual(["/tmp/one", "/tmp/two"]);
  });

  it("expands a leading ~ in each entry against the home directory", () => {
    const value = ["~/cho-phien/docs/diagrams", "~", "/tmp/plain"].join(path.delimiter);
    expect(parseExportRootsEnv(value)).toEqual([
      path.join(os.homedir(), "cho-phien/docs/diagrams"),
      os.homedir(),
      "/tmp/plain",
    ]);
  });

  it("drops an empty entry between two delimiters", () => {
    const value = `/tmp/one${path.delimiter}${path.delimiter}/tmp/two`;
    expect(parseExportRootsEnv(value)).toEqual(["/tmp/one", "/tmp/two"]);
  });

  it("drops a trailing empty entry after a trailing delimiter", () => {
    const value = `/tmp/one${path.delimiter}`;
    expect(parseExportRootsEnv(value)).toEqual(["/tmp/one"]);
  });
});

describe("parseCliArgs — DIAGRAM_COPILOT_EXPORT_ROOTS wiring", () => {
  it("falls back to the default vault root when neither --export-root nor the env var is set", () => {
    const options = parseCliArgs([], {});
    expect(options.exportRoots).toEqual([DEFAULT_OBSIDIAN_VAULT_ROOT]);
  });

  it("adds env-declared roots ON TOP of the default vault root (no --export-root given)", () => {
    const options = parseCliArgs([], { [EXPORT_ROOTS_ENV_VAR]: "/tmp/cho-phien-diagrams" });
    expect(options.exportRoots).toEqual([DEFAULT_OBSIDIAN_VAULT_ROOT, "/tmp/cho-phien-diagrams"]);
  });

  it("adds env-declared roots ON TOP of explicit --export-root flags, not replacing them", () => {
    const options = parseCliArgs(
      ["--export-root", "/tmp/flag-a", "--export-root", "/tmp/flag-b"],
      { [EXPORT_ROOTS_ENV_VAR]: "/tmp/env-a" },
    );
    expect(options.exportRoots).toEqual(["/tmp/flag-a", "/tmp/flag-b", "/tmp/env-a"]);
  });

  it("supports multiple env roots and ~ expansion end-to-end", () => {
    const value = ["~/cho-phien/docs/diagrams", "/tmp/other-repo"].join(path.delimiter);
    const options = parseCliArgs(["--export-root", "/tmp/flag"], { [EXPORT_ROOTS_ENV_VAR]: value });
    expect(options.exportRoots).toEqual([
      "/tmp/flag",
      path.join(os.homedir(), "cho-phien/docs/diagrams"),
      "/tmp/other-repo",
    ]);
  });

  it("ignores an unset/empty env var and keeps only the CLI/default roots", () => {
    const withUnset = parseCliArgs(["--export-root", "/tmp/flag"], {});
    expect(withUnset.exportRoots).toEqual(["/tmp/flag"]);

    const withEmpty = parseCliArgs(["--export-root", "/tmp/flag"], { [EXPORT_ROOTS_ENV_VAR]: "" });
    expect(withEmpty.exportRoots).toEqual(["/tmp/flag"]);
  });

  it("still resolves --export-dir / --workspace / --port normally alongside the env var", () => {
    const options = parseCliArgs(
      ["--workspace", "/tmp/ws", "--port", "4841"],
      { [EXPORT_ROOTS_ENV_VAR]: "/tmp/extra" },
    );
    expect(options.workspace).toBe("/tmp/ws");
    expect(options.port).toBe(4841);
    expect(options.exportDir).toBe(path.join("/tmp/ws", "exports"));
    expect(options.exportRoots).toEqual([DEFAULT_OBSIDIAN_VAULT_ROOT, "/tmp/extra"]);
  });
});

describe("resolveExportDestination accepts env-declared roots (DGC-81 integration)", () => {
  it("accepts a path inside a root sourced from DIAGRAM_COPILOT_EXPORT_ROOTS", () => {
    const envRoots = parseExportRootsEnv("/tmp/cho-phien/docs/diagrams");
    const dest = resolveExportDestination("/tmp/cho-phien/docs/diagrams", {
      exportDir: "/tmp/exports",
      roots: envRoots,
      name: "demo",
      version: 2,
    });
    expect(dest).toEqual({
      ok: true,
      path: path.join("/tmp/cho-phien/docs/diagrams", "demo-v2.png"),
    });
  });

  it("accepts a path inside an env-declared root that used ~ expansion", () => {
    const envRoots = parseExportRootsEnv("~/cho-phien/docs/diagrams");
    const target = path.join(os.homedir(), "cho-phien/docs/diagrams/sub");
    const dest = resolveExportDestination(target, {
      exportDir: "/tmp/exports",
      roots: envRoots,
      name: "demo",
      version: 5,
    });
    expect(dest.ok).toBe(true);
    if (dest.ok) {
      expect(dest.path).toBe(path.join(target, "demo-v5.png"));
    }
  });

  it("still refuses a path outside every root, listing the env-declared root alongside the rest", () => {
    const envRoots = parseExportRootsEnv("/tmp/cho-phien/docs/diagrams");
    const dest = resolveExportDestination("/tmp/somewhere-else", {
      exportDir: "/tmp/exports",
      roots: envRoots,
      name: "demo",
      version: 1,
    });
    expect(dest.ok).toBe(false);
    if (!dest.ok) {
      expect(dest.error).toMatch(/outside the allowed export roots/i);
      expect(dest.error).toContain("/tmp/exports");
      expect(dest.error).toContain("/tmp/cho-phien/docs/diagrams");
    }
  });
});
