import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@diagram-copilot/core";
import {
  buildWelcomeMessages,
  createWorkspaceWatcher,
  type WorkspaceWatcher,
} from "../src/workspace/watcher.js";

const VALID_DEMO_DSL = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");
const OTHER_VALID_DSL = ["Alpha", "Beta", "", "Alpha > Beta"].join("\n");
const INVALID_DSL = "Client >";

/** Track watchers/temp dirs so every test tears down cleanly. */
const openWatchers = new Set<WorkspaceWatcher>();
const openDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...openWatchers].map((watcher) => watcher.stop()));
  openWatchers.clear();
  for (const dir of openDirs) rmSync(dir, { recursive: true, force: true });
  openDirs.clear();
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-workspace-"));
  openDirs.add(dir);
  return dir;
}

/** A `broadcast` collector: every message the watcher would have sent, in order. */
function collector(): { messages: ServerMessage[]; broadcast: (message: ServerMessage) => void } {
  const messages: ServerMessage[] = [];
  return { messages, broadcast: (message) => messages.push(message) };
}

async function watch(dir: string, broadcast: (message: ServerMessage) => void): Promise<WorkspaceWatcher> {
  const watcher = createWorkspaceWatcher({ dir, broadcast });
  openWatchers.add(watcher);
  await watcher.start();
  return watcher;
}

/** Poll `check` until it passes or the timeout elapses, for debounced async assertions. */
async function waitFor(check: () => void, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

describe("createWorkspaceWatcher — initial scan", () => {
  it("creates the workspace dir if missing", async () => {
    const dir = path.join(makeTempDir(), "nested", "workspace");
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);
    expect(watcher.getState()).toEqual({ diagrams: [], active: null, versions: new Map() });
  });

  it("broadcasts an empty workspace message when no files exist", async () => {
    const dir = makeTempDir();
    const { messages, broadcast } = collector();
    await watch(dir, broadcast);

    expect(messages).toEqual([{ kind: "workspace", diagrams: [], active: "untitled" }]);
  });

  it("scans an existing demo.arch and broadcasts workspace + diagram", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({ kind: "workspace", diagrams: ["demo"], active: "demo" });
    expect(messages[1]).toMatchObject({
      kind: "diagram",
      name: "demo",
      version: 1,
      origin: "file",
      dsl: VALID_DEMO_DSL,
    });
    const diagramMessage = messages[1] as Extract<ServerMessage, { kind: "diagram" }>;
    expect(diagramMessage.doc.nodes.map((n) => n.id)).toEqual(["Client", "Server"]);

    expect(watcher.getState()).toEqual({
      diagrams: ["demo"],
      active: "demo",
      versions: new Map([["demo", 1]]),
    });
  });

  it("prefers demo as active even if it is not first alphabetically", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { messages, broadcast } = collector();
    await watch(dir, broadcast);

    expect(messages[0]).toMatchObject({ kind: "workspace", diagrams: ["alpha", "demo"], active: "demo" });
  });

  it("picks the first name alphabetically when there is no demo", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "zeta.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    const { messages, broadcast } = collector();
    await watch(dir, broadcast);

    expect(messages[0]).toMatchObject({ active: "alpha" });
  });

  it("broadcasts diagram-error with version 0 when the initial active file is invalid", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), INVALID_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    expect(messages[1]).toMatchObject({ kind: "diagram-error", name: "demo", version: 0 });
    expect(watcher.getState().versions.get("demo")).toBeUndefined();
  });
});

describe("createWorkspaceWatcher — file changes", () => {
  it("re-parses and rebroadcasts the active diagram on change, bumping version", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "demo.arch");
    writeFileSync(filePath, VALID_DEMO_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);
    expect(messages).toHaveLength(2); // initial workspace + diagram

    writeFileSync(filePath, OTHER_VALID_DSL);

    await waitFor(() => expect(messages).toHaveLength(3), 500);
    expect(messages[2]).toMatchObject({ kind: "diagram", name: "demo", version: 2, origin: "file" });
    expect(watcher.getState().versions.get("demo")).toBe(2);
  });

  it("broadcasts diagram-error without bumping version on invalid content", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "demo.arch");
    writeFileSync(filePath, VALID_DEMO_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);
    expect(watcher.getState().versions.get("demo")).toBe(1);

    writeFileSync(filePath, INVALID_DSL);

    await waitFor(() => expect(messages).toHaveLength(3), 500);
    expect(messages[2]).toMatchObject({
      kind: "diagram-error",
      name: "demo",
      version: 1,
      dsl: INVALID_DSL,
    });
    expect(watcher.getState().versions.get("demo")).toBe(1);
  });

  it("broadcasts a workspace message when a second (non-active) file is added", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);
    expect(messages).toHaveLength(2);

    writeFileSync(path.join(dir, "other.arch"), OTHER_VALID_DSL);

    await waitFor(() => expect(messages).toHaveLength(3), 500);
    expect(messages[2]).toEqual({ kind: "workspace", diagrams: ["demo", "other"], active: "demo" });
    // Non-active file content is never parsed/broadcast as a diagram message.
    expect(messages.some((m) => m.kind === "diagram" && m.name === "other")).toBe(false);
    expect(watcher.getState().diagrams).toEqual(["demo", "other"]);
  });

  it("broadcasts a workspace update when a non-active file is removed", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "other.arch"), OTHER_VALID_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);
    expect(messages).toHaveLength(2);

    unlinkSync(path.join(dir, "other.arch"));

    await waitFor(() => expect(messages).toHaveLength(3), 500);
    expect(messages[2]).toEqual({ kind: "workspace", diagrams: ["demo"], active: "demo" });
    expect(watcher.getState().diagrams).toEqual(["demo"]);
    expect(watcher.getState().active).toBe("demo");
  });

  it("falls back to the next diagram and re-broadcasts it when the active file is deleted", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);
    expect(watcher.getState().active).toBe("demo");

    unlinkSync(path.join(dir, "demo.arch"));

    await waitFor(() => expect(watcher.getState().active).toBe("alpha"), 500);
    const workspaceUpdate = messages.find(
      (m, i) => i > 1 && m.kind === "workspace" && m.active === "alpha",
    );
    expect(workspaceUpdate).toBeDefined();
    const diagramUpdate = messages.find((m) => m.kind === "diagram" && m.name === "alpha");
    expect(diagramUpdate).toMatchObject({ kind: "diagram", name: "alpha", version: 1 });
  });

  it("ignores non-.arch files entirely", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);
    expect(messages).toHaveLength(2);

    writeFileSync(path.join(dir, "notes.txt"), "hello");
    writeFileSync(path.join(dir, "demo.layout.json"), "{}");

    // Give the watcher a beat to (not) react, then confirm nothing changed.
    await new Promise((r) => setTimeout(r, 400));
    expect(messages).toHaveLength(2);
    expect(watcher.getState().diagrams).toEqual(["demo"]);
  });
});

describe("buildWelcomeMessages", () => {
  it("returns only a workspace message when there is no active diagram", () => {
    const dir = makeTempDir();
    const result = buildWelcomeMessages(dir, { diagrams: [], active: null, versions: new Map() });
    expect(result).toEqual([{ kind: "workspace", diagrams: [], active: "untitled" }]);
  });

  it("returns workspace + diagram messages reflecting current watcher state", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const welcome = buildWelcomeMessages(dir, watcher.getState());
    expect(welcome).toHaveLength(2);
    expect(welcome[0]).toEqual({ kind: "workspace", diagrams: ["demo"], active: "demo" });
    expect(welcome[1]).toMatchObject({ kind: "diagram", name: "demo", version: 1, dsl: VALID_DEMO_DSL });
  });

  it("returns a diagram-error welcome when the active file currently fails to parse", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), INVALID_DSL);
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const welcome = buildWelcomeMessages(dir, watcher.getState());
    expect(welcome[1]).toMatchObject({ kind: "diagram-error", name: "demo", version: 0 });
  });
});
