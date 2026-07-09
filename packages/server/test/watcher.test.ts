import { mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import type { ServerMessage } from "@diagram-copilot/core";
import type { BroadcastOptions } from "../src/server.js";
import {
  buildWelcomeMessages,
  createWorkspaceWatcher,
  type WorkspaceWatcher,
} from "../src/workspace/watcher.js";

const VALID_DEMO_DSL = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");
const OTHER_VALID_DSL = ["Alpha", "Beta", "", "Alpha > Beta"].join("\n");
const INVALID_DSL = "Client >";

// Several tests below wait on a real debounced chokidar fs event via
// waitForMessage() (see collector()), whose own safety-net timeout defaults
// to 10s. Vitest's default 5s testTimeout would otherwise kill the test
// before that wait gets a chance to resolve under load — raise the file's
// default so it can never truncate the wait first (DGC-83). Harmless for the
// many synchronous tests in this file: it only raises the ceiling, it does
// not slow anything down.
vi.setConfig({ testTimeout: 15000 });

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

/**
 * A `broadcast` collector: every message the watcher would have sent, in
 * order, plus `waitForMessage` to await a specific future one.
 *
 * `waitForMessage` is event-driven, not polled: it resolves the instant a
 * matching message is broadcast (synchronously, from inside the watcher's own
 * debounced fs-event handler), rather than racing a fixed poll interval
 * against a fixed timeout. That distinction matters under load — chokidar's
 * fs-event delivery plus the watcher's DEBOUNCE_MS can legitimately take
 * longer than a tight poll timeout allows, which made assertions that polled
 * `getState()`/`messages` on a short clock (e.g. the sticky-fallback test,
 * DGC-83) flaky on a busy machine even though the watcher was working
 * correctly, just slower to observe. `timeoutMs` here is a generous safety
 * net for a genuinely stuck watcher, not a race budget, so it costs nothing
 * on a passing run and only matters when something is actually wrong.
 *
 * Deliberately only matches broadcasts that happen AFTER `waitForMessage` is
 * called, ignoring anything already in `messages` — every caller in this
 * suite wants "the next matching event", and some target states (e.g.
 * `active: "demo"`) also describe the watcher's very first broadcast, which
 * would otherwise resolve immediately on stale history instead of waiting
 * for the fs event under test.
 */
function collector(): {
  messages: ServerMessage[];
  broadcast: (message: ServerMessage) => void;
  waitForMessage: (predicate: (message: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
} {
  const messages: ServerMessage[] = [];
  const waiters: Array<{ predicate: (message: ServerMessage) => boolean; settle: (message: ServerMessage) => void }> =
    [];

  const broadcast = (message: ServerMessage): void => {
    messages.push(message);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.predicate(message)) {
        const [waiter] = waiters.splice(i, 1);
        waiter!.settle(message);
      }
    }
  };

  function waitForMessage(
    predicate: (message: ServerMessage) => boolean,
    timeoutMs = 10000,
  ): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        settle: (message: ServerMessage) => {
          clearTimeout(timer);
          resolve(message);
        },
      };
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error(`waitForMessage: no matching broadcast within ${timeoutMs}ms`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return { messages, broadcast, waitForMessage };
}

async function watch(dir: string, broadcast: (message: ServerMessage) => void): Promise<WorkspaceWatcher> {
  const watcher = createWorkspaceWatcher({ dir, broadcast });
  openWatchers.add(watcher);
  await watcher.start();
  return watcher;
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
    const { messages, broadcast, waitForMessage } = collector();
    const watcher = await watch(dir, broadcast);
    expect(messages).toHaveLength(2); // initial workspace + diagram

    writeFileSync(filePath, OTHER_VALID_DSL);

    await waitForMessage((m) => m.kind === "diagram" && m.name === "demo" && m.version === 2);
    expect(messages).toHaveLength(3);
    expect(messages[2]).toMatchObject({ kind: "diagram", name: "demo", version: 2, origin: "file" });
    expect(watcher.getState().versions.get("demo")).toBe(2);
  });

  it("broadcasts diagram-error without bumping version on invalid content", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "demo.arch");
    writeFileSync(filePath, VALID_DEMO_DSL);
    const { messages, broadcast, waitForMessage } = collector();
    const watcher = await watch(dir, broadcast);
    expect(watcher.getState().versions.get("demo")).toBe(1);

    writeFileSync(filePath, INVALID_DSL);

    await waitForMessage((m) => m.kind === "diagram-error" && m.name === "demo");
    expect(messages).toHaveLength(3);
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
    const { messages, broadcast, waitForMessage } = collector();
    const watcher = await watch(dir, broadcast);
    expect(messages).toHaveLength(2);

    writeFileSync(path.join(dir, "other.arch"), OTHER_VALID_DSL);

    await waitForMessage((m) => m.kind === "workspace" && m.diagrams.includes("other"));
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ kind: "workspace", diagrams: ["demo", "other"], active: "demo" });
    // Non-active file content is never parsed/broadcast as a diagram message.
    expect(messages.some((m) => m.kind === "diagram" && m.name === "other")).toBe(false);
    expect(watcher.getState().diagrams).toEqual(["demo", "other"]);
  });

  it("broadcasts a workspace update when a non-active file is removed", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "other.arch"), OTHER_VALID_DSL);
    const { messages, broadcast, waitForMessage } = collector();
    const watcher = await watch(dir, broadcast);
    expect(messages).toHaveLength(2);

    unlinkSync(path.join(dir, "other.arch"));

    await waitForMessage((m) => m.kind === "workspace" && !m.diagrams.includes("other"));
    expect(messages).toHaveLength(3);
    expect(messages[2]).toEqual({ kind: "workspace", diagrams: ["demo"], active: "demo" });
    expect(watcher.getState().diagrams).toEqual(["demo"]);
    expect(watcher.getState().active).toBe("demo");
  });

  it("falls back to the next diagram and re-broadcasts it when the active file is deleted", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { messages, broadcast, waitForMessage } = collector();
    const watcher = await watch(dir, broadcast);
    expect(watcher.getState().active).toBe("demo");

    unlinkSync(path.join(dir, "demo.arch"));

    const diagramUpdate = await waitForMessage((m) => m.kind === "diagram" && m.name === "alpha");
    expect(diagramUpdate).toMatchObject({ kind: "diagram", name: "alpha", version: 1 });
    expect(watcher.getState().active).toBe("alpha");
    const workspaceUpdate = messages.find(
      (m, i) => i > 1 && m.kind === "workspace" && m.active === "alpha",
    );
    expect(workspaceUpdate).toBeDefined();
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

describe("createWorkspaceWatcher — setActive (sticky)", () => {
  it("makes a non-default diagram sticky-active over the automatic pick", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { messages, broadcast, waitForMessage } = collector();
    const watcher = await watch(dir, broadcast);
    expect(watcher.getState().active).toBe("demo"); // demo wins by default

    watcher.setActive("alpha");
    expect(watcher.getState().active).toBe("alpha");
    // setActive broadcasts a workspace update + the newly active diagram.
    expect(messages.at(-1)).toMatchObject({ kind: "diagram", name: "alpha", version: 1 });

    // Adding another file must NOT steal active back from the sticky choice.
    writeFileSync(path.join(dir, "beta.arch"), OTHER_VALID_DSL);
    await waitForMessage((m) => m.kind === "workspace" && m.diagrams.includes("beta"));
    expect(watcher.getState().active).toBe("alpha");
  });

  it("falls back to the automatic pick when the sticky-active file is deleted", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { broadcast, waitForMessage } = collector();
    const watcher = await watch(dir, broadcast);

    watcher.setActive("alpha");
    expect(watcher.getState().active).toBe("alpha");

    unlinkSync(path.join(dir, "alpha.arch"));
    // Sticky choice is gone → auto-select resumes and prefers demo. Wait for
    // the broadcast that carries this (event-driven), not a poll of
    // getState() racing a fixed timeout — see collector()'s waitForMessage
    // doc comment for why (DGC-83).
    await waitForMessage((m) => m.kind === "workspace" && m.active === "demo");
    expect(watcher.getState().active).toBe("demo");
  });
});

describe("createWorkspaceWatcher — createDiagram", () => {
  it("writes the template, makes it active, and broadcasts a valid diagram", async () => {
    const dir = makeTempDir();
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const result = watcher.createDiagram("news-feed");
    expect(result).toEqual({ ok: true, name: "news-feed" });

    const onDisk = readFileSync(path.join(dir, "news-feed.arch"), "utf8");
    expect(onDisk).toBe("// news-feed\ndirection right\n");

    expect(watcher.getState().active).toBe("news-feed");
    const diagram = messages.find((m) => m.kind === "diagram" && m.name === "news-feed");
    expect(diagram).toMatchObject({ kind: "diagram", name: "news-feed" });
  });

  it("accepts a name that already carries the .arch extension", async () => {
    const dir = makeTempDir();
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const result = watcher.createDiagram("orders.arch");
    expect(result).toEqual({ ok: true, name: "orders" });
    expect(readdirSync(dir)).toContain("orders.arch");
    expect(readdirSync(dir)).not.toContain("orders.arch.arch");
  });

  it("refuses to overwrite an existing diagram file", async () => {
    const dir = makeTempDir();
    const existing = "// hand written\ndirection right\n";
    writeFileSync(path.join(dir, "keep.arch"), existing);
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const result = watcher.createDiagram("keep");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
    // Original content is untouched.
    expect(readFileSync(path.join(dir, "keep.arch"), "utf8")).toBe(existing);
  });

  it("rejects path-traversal names without writing anything", async () => {
    const dir = makeTempDir();
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    for (const bad of ["../evil", "nested/child", ""]) {
      const result = watcher.createDiagram(bad);
      expect(result.ok).toBe(false);
      expect(result.error).toBeDefined();
    }
    // Nothing escaped into the workspace, and no traversal file landed there.
    expect(readdirSync(dir).filter((f) => f.endsWith(".arch"))).toEqual([]);
  });
});

describe("createWorkspaceWatcher — list / open", () => {
  it("lists diagrams sorted, with versions and the active flag", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    // demo is active (parsed → v1); alpha has never been parsed (→ v0).
    expect(watcher.list()).toEqual([
      { name: "alpha", version: 0, active: false },
      { name: "demo", version: 1, active: true },
    ]);
  });

  it("open() activates an existing diagram and parses it on first activation", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const result = watcher.open("alpha");
    expect(result).toEqual({ ok: true, created: false, name: "alpha", version: 1 });
    expect(watcher.getState().active).toBe("alpha");
  });

  it("open() creates a diagram when it does not exist", async () => {
    const dir = makeTempDir();
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const result = watcher.open("fresh");
    expect(result).toMatchObject({ ok: true, created: true, name: "fresh" });
    expect(readdirSync(dir)).toContain("fresh.arch");
    expect(watcher.getState().active).toBe("fresh");
  });

  it("open() reports a validation error for a bad name", async () => {
    const dir = makeTempDir();
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const result = watcher.open("../escape");
    expect(result.ok).toBe(false);
    expect(result.created).toBe(false);
    expect(result.error).toContain("path separators");
  });
});

describe("createWorkspaceWatcher — read", () => {
  it("returns the on-disk DSL and version for an existing diagram", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    expect(watcher.read("demo")).toEqual({ ok: true, dsl: VALID_DEMO_DSL, version: 1 });
  });

  it("fails for a diagram that does not exist", async () => {
    const dir = makeTempDir();
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const result = watcher.read("missing");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  it("rejects a path-traversal name", async () => {
    const dir = makeTempDir();
    const { broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    const result = watcher.read("../escape");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("path separators");
  });
});

describe("createWorkspaceWatcher — update", () => {
  it("writes the DSL, bumps the version, and broadcasts a diagram frame with origin mcp", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "demo.arch");
    writeFileSync(filePath, VALID_DEMO_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);
    const before = messages.length;

    const result = watcher.update("demo", OTHER_VALID_DSL);
    expect(result).toMatchObject({ ok: true, name: "demo", version: 2 });
    expect(result.doc?.nodes.map((n) => n.id)).toEqual(["Alpha", "Beta"]);

    // Exactly one new frame (the mcp diagram); demo was already active so no
    // extra workspace message.
    expect(messages).toHaveLength(before + 1);
    expect(messages.at(-1)).toMatchObject({
      kind: "diagram",
      name: "demo",
      version: 2,
      origin: "mcp",
      dsl: OTHER_VALID_DSL,
    });
    // File on disk reflects the write, and the version bumped.
    expect(readFileSync(filePath, "utf8")).toBe(OTHER_VALID_DSL);
    expect(watcher.getState().versions.get("demo")).toBe(2);
  });

  it("refuses to write invalid DSL and leaves the file + version untouched", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "demo.arch");
    writeFileSync(filePath, VALID_DEMO_DSL);
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);
    const before = messages.length;

    const result = watcher.update("demo", INVALID_DSL);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("parse");
    expect(readFileSync(filePath, "utf8")).toBe(VALID_DEMO_DSL);
    expect(watcher.getState().versions.get("demo")).toBe(1);
    expect(messages).toHaveLength(before);
  });

  it("suppresses the fs echo of its own write (no double-bump, no duplicate frame)", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "demo.arch");
    writeFileSync(filePath, VALID_DEMO_DSL);
    const { messages, broadcast, waitForMessage } = collector();
    const watcher = await watch(dir, broadcast);

    watcher.update("demo", OTHER_VALID_DSL);
    const afterUpdate = messages.length;

    // update()'s own writeFileSync fires a chokidar "change"; a redundant
    // re-save of the identical content fires another. Both echo our last
    // broadcast, so neither should bump the version or add a frame.
    writeFileSync(filePath, OTHER_VALID_DSL);
    await new Promise((r) => setTimeout(r, 400));

    expect(messages).toHaveLength(afterUpdate);
    expect(watcher.getState().versions.get("demo")).toBe(2);

    // A genuinely different edit still comes through as a normal file change.
    writeFileSync(filePath, VALID_DEMO_DSL);
    await waitForMessage((m) => m.kind === "diagram" && m.name === "demo" && m.version === 3);
    expect(watcher.getState().versions.get("demo")).toBe(3);
    expect(messages.at(-1)).toMatchObject({ kind: "diagram", name: "demo", version: 3, origin: "file" });
  });

  it("tags the broadcast with a caller-supplied origin and forwards excludeSocket", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const calls: Array<{ message: ServerMessage; options?: BroadcastOptions }> = [];
    const watcher = createWorkspaceWatcher({
      dir,
      broadcast: (message, options) => calls.push({ message, options }),
    });
    openWatchers.add(watcher);
    await watcher.start();
    const before = calls.length;

    // The watcher treats the socket as an opaque token — a sentinel suffices.
    const sender = { sentinel: true } as unknown as WebSocket;
    const result = watcher.update("demo", OTHER_VALID_DSL, { origin: "drawer", excludeSocket: sender });
    expect(result.ok).toBe(true);

    expect(calls).toHaveLength(before + 1);
    const last = calls.at(-1)!;
    expect(last.message).toMatchObject({ kind: "diagram", name: "demo", version: 2, origin: "drawer" });
    expect(last.options?.excludeOrigin).toBe(sender);
  });

  it("never excludes the originator from the workspace frame when active changes", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const calls: Array<{ message: ServerMessage; options?: BroadcastOptions }> = [];
    const watcher = createWorkspaceWatcher({
      dir,
      broadcast: (message, options) => calls.push({ message, options }),
    });
    openWatchers.add(watcher);
    await watcher.start();
    expect(watcher.getState().active).toBe("demo");
    const before = calls.length;

    const sender = { sentinel: true } as unknown as WebSocket;
    watcher.update("alpha", VALID_DEMO_DSL, { origin: "canvas", excludeSocket: sender });

    // Active switched demo → alpha: a workspace frame for EVERYONE (shared
    // state, no exclusion) followed by the diagram frame minus the sender.
    expect(calls).toHaveLength(before + 2);
    const [workspaceCall, diagramCall] = calls.slice(before);
    expect(workspaceCall.message).toMatchObject({ kind: "workspace", active: "alpha" });
    expect(workspaceCall.options?.excludeOrigin).toBeUndefined();
    expect(diagramCall.message).toMatchObject({ kind: "diagram", name: "alpha", origin: "canvas" });
    expect(diagramCall.options?.excludeOrigin).toBe(sender);
  });

  it("does not double-bump createDiagram when the watcher's own add event lands", async () => {
    const dir = makeTempDir();
    const { messages, broadcast } = collector();
    const watcher = await watch(dir, broadcast);

    watcher.createDiagram("fresh");
    expect(watcher.getState().versions.get("fresh")).toBe(1);
    const freshFrames = () => messages.filter((m) => m.kind === "diagram" && m.name === "fresh");
    expect(freshFrames()).toHaveLength(1);

    // Give the debounced "add" echo time to fire; it must be suppressed.
    await new Promise((r) => setTimeout(r, 400));
    expect(watcher.getState().versions.get("fresh")).toBe(1);
    expect(freshFrames()).toHaveLength(1);
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
