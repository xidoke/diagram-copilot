/**
 * Diagram lifecycle ops (DGC-65) — `createLifecycleOps` driven against a real
 * `createWorkspaceWatcher` on a temp workspace. Exercises the data-safety
 * contract end to end: a rename/trash/restore must move a diagram's WHOLE
 * footprint (`.arch` + layout/notes/history sidecars) as one unit, keep the
 * active pick + in-memory list consistent, and never hard-delete.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@diagram-copilot/core";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";
import { createLifecycleOps, TRASH_DIR, type LifecycleOps } from "../src/workspace/lifecycle.js";

const VALID_DEMO_DSL = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");
const OTHER_VALID_DSL = ["Alpha", "Beta", "", "Alpha > Beta"].join("\n");

const openWatchers = new Set<WorkspaceWatcher>();
const openDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...openWatchers].map((watcher) => watcher.stop()));
  openWatchers.clear();
  for (const dir of openDirs) rmSync(dir, { recursive: true, force: true });
  openDirs.clear();
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-lifecycle-"));
  openDirs.add(dir);
  return dir;
}

interface Harness {
  dir: string;
  watcher: WorkspaceWatcher;
  lifecycle: LifecycleOps;
  messages: ServerMessage[];
}

async function harness(dir: string): Promise<Harness> {
  const messages: ServerMessage[] = [];
  const watcher = createWorkspaceWatcher({ dir, broadcast: (m) => messages.push(m) });
  openWatchers.add(watcher);
  await watcher.start();
  const lifecycle = createLifecycleOps(dir, () => watcher);
  return { dir, watcher, lifecycle, messages };
}

/** Write a diagram's `.arch` plus every sidecar so a move can be verified as a set. */
function seedDiagramWithSidecars(dir: string, stem: string, dsl = VALID_DEMO_DSL): void {
  writeFileSync(path.join(dir, `${stem}.arch`), dsl);
  writeFileSync(path.join(dir, `${stem}.layout.json`), JSON.stringify({ Client: { x: 1, y: 2 } }));
  writeFileSync(path.join(dir, `${stem}.notes.md`), `# ${stem}\nwhy this shape`);
  mkdirSync(path.join(dir, ".history"), { recursive: true });
  writeFileSync(path.join(dir, ".history", `${stem}.jsonl`), `${JSON.stringify({ version: 0, dsl, origin: "mcp", ts: 1 })}\n`);
}

/** All sidecar file names for `stem` present at the workspace root + in `.history`. */
function footprint(dir: string, stem: string): string[] {
  const found: string[] = [];
  for (const ext of [".arch", ".layout.json", ".notes.md"]) {
    if (existsSync(path.join(dir, `${stem}${ext}`))) found.push(`${stem}${ext}`);
  }
  if (existsSync(path.join(dir, ".history", `${stem}.jsonl`))) found.push(`.history/${stem}.jsonl`);
  return found.sort();
}

describe("lifecycle.rename", () => {
  it("moves the .arch and EVERY sidecar to the new name", async () => {
    const dir = makeTempDir();
    seedDiagramWithSidecars(dir, "old-name");
    const { lifecycle } = await harness(dir);

    const result = lifecycle.rename("old-name", "new-name");
    expect(result.ok).toBe(true);
    expect(result.movedSidecars).toEqual(expect.arrayContaining([".layout.json", ".notes.md", ".jsonl"]));

    // Old footprint gone, new footprint complete.
    expect(footprint(dir, "old-name")).toEqual([]);
    expect(footprint(dir, "new-name")).toEqual([
      ".history/new-name.jsonl",
      "new-name.arch",
      "new-name.layout.json",
      "new-name.notes.md",
    ]);
    // Content is preserved, not just the names.
    expect(readFileSync(path.join(dir, "new-name.arch"), "utf8")).toBe(VALID_DEMO_DSL);
    expect(readFileSync(path.join(dir, "new-name.notes.md"), "utf8")).toContain("why this shape");
  });

  it("makes the renamed diagram active when the old name was active, broadcasting workspace + diagram", async () => {
    const dir = makeTempDir();
    seedDiagramWithSidecars(dir, "demo");
    const { lifecycle, watcher, messages } = await harness(dir);
    expect(watcher.getState().active).toBe("demo");
    const before = messages.length;

    const result = lifecycle.rename("demo", "renamed");
    expect(result.ok).toBe(true);
    expect(result.active).toBe("renamed");
    expect(watcher.getState().active).toBe("renamed");
    expect(watcher.getState().diagrams).toEqual(["renamed"]);

    const fresh = messages.slice(before);
    expect(fresh.some((m) => m.kind === "workspace" && m.active === "renamed")).toBe(true);
    expect(fresh.some((m) => m.kind === "diagram" && m.name === "renamed")).toBe(true);
  });

  it("leaves the active pick untouched when renaming a non-active diagram", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    const { lifecycle, watcher } = await harness(dir);
    expect(watcher.getState().active).toBe("demo");

    const result = lifecycle.rename("alpha", "gamma");
    expect(result.ok).toBe(true);
    expect(watcher.getState().active).toBe("demo");
    expect(watcher.getState().diagrams).toEqual(["demo", "gamma"]);
  });

  it("refuses to overwrite an existing diagram, leaving both files untouched", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "keep.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "target.arch"), OTHER_VALID_DSL);
    const { lifecycle, watcher } = await harness(dir);

    const result = lifecycle.rename("keep", "target");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
    // Neither file moved.
    expect(readFileSync(path.join(dir, "keep.arch"), "utf8")).toBe(VALID_DEMO_DSL);
    expect(readFileSync(path.join(dir, "target.arch"), "utf8")).toBe(OTHER_VALID_DSL);
    expect(watcher.getState().diagrams).toEqual(["keep", "target"]);
  });

  it("rejects a path-traversal new name without touching disk", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { lifecycle } = await harness(dir);

    const result = lifecycle.rename("demo", "../escape");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path separators");
    expect(existsSync(path.join(dir, "demo.arch"))).toBe(true);
  });

  it("rejects renaming a diagram that does not exist", async () => {
    const dir = makeTempDir();
    const { lifecycle } = await harness(dir);

    const result = lifecycle.rename("ghost", "whatever");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
  });
});

describe("lifecycle.trash", () => {
  it("moves the whole footprint into .trash/<id>/ and drops it from the list", async () => {
    const dir = makeTempDir();
    seedDiagramWithSidecars(dir, "demo");
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    const { lifecycle, watcher } = await harness(dir);

    const result = lifecycle.trash("demo");
    expect(result.ok).toBe(true);
    expect(result.id).toBeDefined();

    // Gone from the workspace root + the live list.
    expect(footprint(dir, "demo")).toEqual([]);
    expect(watcher.getState().diagrams).toEqual(["alpha"]);

    // Physically present inside the trash folder, sidecars intact.
    const trashDir = path.join(dir, TRASH_DIR, result.id!);
    expect(existsSync(path.join(trashDir, "demo.arch"))).toBe(true);
    expect(existsSync(path.join(trashDir, "demo.layout.json"))).toBe(true);
    expect(existsSync(path.join(trashDir, "demo.notes.md"))).toBe(true);
    expect(existsSync(path.join(trashDir, ".history", "demo.jsonl"))).toBe(true);
    expect(readFileSync(path.join(trashDir, "demo.arch"), "utf8")).toBe(VALID_DEMO_DSL);
  });

  it("falls back to another diagram as active when the active one is trashed", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    const { lifecycle, watcher, messages } = await harness(dir);
    expect(watcher.getState().active).toBe("demo");
    const before = messages.length;

    const result = lifecycle.trash("demo");
    expect(result.ok).toBe(true);
    expect(result.active).toBe("alpha");
    expect(watcher.getState().active).toBe("alpha");

    const fresh = messages.slice(before);
    expect(fresh.some((m) => m.kind === "workspace" && m.active === "alpha")).toBe(true);
    expect(fresh.some((m) => m.kind === "diagram" && m.name === "alpha")).toBe(true);
  });

  it("leaves the workspace with no active diagram when the last one is trashed", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "solo.arch"), VALID_DEMO_DSL);
    const { lifecycle, watcher } = await harness(dir);

    const result = lifecycle.trash("solo");
    expect(result.ok).toBe(true);
    expect(result.active).toBeNull();
    expect(watcher.getState().diagrams).toEqual([]);
    expect(watcher.getState().active).toBeNull();
  });

  it("rejects trashing a diagram that does not exist", async () => {
    const dir = makeTempDir();
    const { lifecycle } = await harness(dir);
    const result = lifecycle.trash("ghost");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
  });
});

describe("lifecycle.listTrash + restore", () => {
  it("lists trashed diagrams and restores the whole footprint back, active + visible again", async () => {
    const dir = makeTempDir();
    seedDiagramWithSidecars(dir, "demo");
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    const { lifecycle, watcher } = await harness(dir);

    const trashed = lifecycle.trash("demo");
    expect(trashed.ok).toBe(true);

    const list = lifecycle.listTrash();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: trashed.id, name: "demo" });
    expect(typeof list[0].trashedAt).toBe("string");

    const restored = lifecycle.restore(trashed.id!);
    expect(restored).toMatchObject({ ok: true, name: "demo" });

    // Footprint back in place, list shows it, it is active, trash folder cleaned up.
    expect(footprint(dir, "demo")).toEqual([
      ".history/demo.jsonl",
      "demo.arch",
      "demo.layout.json",
      "demo.notes.md",
    ]);
    expect(watcher.getState().diagrams).toEqual(["alpha", "demo"]);
    expect(watcher.getState().active).toBe("demo");
    expect(existsSync(path.join(dir, TRASH_DIR, trashed.id!))).toBe(false);
    expect(lifecycle.listTrash()).toEqual([]);
  });

  it("lists newest-first when several diagrams are trashed", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "one.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "two.arch"), OTHER_VALID_DSL);
    const { lifecycle } = await harness(dir);

    const first = lifecycle.trash("one");
    // Force a distinct, later timestamp so the ids sort deterministically.
    await new Promise((r) => setTimeout(r, 5));
    const second = lifecycle.trash("two");

    const ids = lifecycle.listTrash().map((e) => e.id);
    expect(ids).toEqual([second.id, first.id]);
  });

  it("refuses to restore over a diagram recreated since it was trashed", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { lifecycle } = await harness(dir);

    const trashed = lifecycle.trash("demo");
    // Recreate a diagram with the same name.
    writeFileSync(path.join(dir, "demo.arch"), OTHER_VALID_DSL);

    const restored = lifecycle.restore(trashed.id!);
    expect(restored.ok).toBe(false);
    expect(restored.error).toContain("already exists");
    // The trash copy is left intact for a later restore.
    expect(existsSync(path.join(dir, TRASH_DIR, trashed.id!, "demo.arch"))).toBe(true);
  });

  it("rejects an unknown or path-traversal trash id", async () => {
    const dir = makeTempDir();
    const { lifecycle } = await harness(dir);

    expect(lifecycle.restore("does-not-exist").ok).toBe(false);
    const traversal = lifecycle.restore("../escape");
    expect(traversal.ok).toBe(false);
    expect(traversal.error).toContain("path separators");
  });

  it("returns an empty list when there is no trash yet", async () => {
    const dir = makeTempDir();
    const { lifecycle } = await harness(dir);
    expect(lifecycle.listTrash()).toEqual([]);
    // No `.trash` directory was conjured just by listing.
    expect(readdirSync(dir).includes(TRASH_DIR)).toBe(false);
  });
});
