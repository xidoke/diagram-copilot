/**
 * T21 end-to-end invariant matrix (origin × recipient), over a REAL wired
 * stack: `createServer` + `createWorkspaceWatcher` + `createClientUpdateHandler`
 * on an ephemeral port with genuine `ws` clients — the same wiring as the CLI
 * entry (`index.ts`).
 *
 * | change source            | originator receives      | other client receives  | disk / version    |
 * |--------------------------|---------------------------|------------------------|-------------------|
 * | drawer/canvas update     | nothing (echo exclusion)  | diagram, client origin | written, +1       |
 * | MCP set_diagram          | n/a (no WS originator)    | diagram, origin mcp    | written, +1       |
 * | external file edit       | n/a                       | diagram, origin file   | as edited, +1     |
 * | update with invalid DSL  | diagram-error (private)   | nothing                | untouched         |
 * | update with stale base   | current diagram (re-sync) | nothing                | untouched         |
 * | update for unknown name  | diagram-error (private)   | nothing                | nothing created   |
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  parseServerMessage,
  serializeMessage,
  type ClientOrigin,
  type DiagramErrorMessage,
  type DiagramMessage,
  type ServerMessage,
  type UpdateMessage,
} from "@diagram-copilot/core";
import { createServer, WELCOME_WORKSPACE, WS_PATH, type ServerHandle } from "../src/server.js";
import { createClientUpdateHandler } from "../src/client-updates.js";
import {
  buildWelcomeMessages,
  createWorkspaceWatcher,
  type WorkspaceWatcher,
} from "../src/workspace/watcher.js";

const VALID_DEMO_DSL = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");
const OTHER_VALID_DSL = ["Alpha", "Beta", "", "Alpha > Beta"].join("\n");
const THIRD_VALID_DSL = ["Gamma", "Delta", "", "Gamma > Delta"].join("\n");
const INVALID_DSL = "Client >";

/** Track resources so every test tears down cleanly. */
const openServers = new Set<ServerHandle>();
const openWatchers = new Set<WorkspaceWatcher>();
const openSockets = new Set<WebSocket>();
const openDirs = new Set<string>();

afterEach(async () => {
  for (const socket of openSockets) socket.close();
  openSockets.clear();
  await Promise.all([...openWatchers].map((watcher) => watcher.stop()));
  openWatchers.clear();
  await Promise.all([...openServers].map((server) => server.stop()));
  openServers.clear();
  for (const dir of openDirs) rmSync(dir, { recursive: true, force: true });
  openDirs.clear();
});

/** Poll `check` until it passes or the timeout elapses (debounced fs events need slack). */
async function waitFor(check: () => void, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Settle window for negative assertions: longer than the watcher debounce
 * (150ms) plus fs-event latency, so "nothing arrived" means suppressed/private,
 * not merely "not yet".
 */
const SETTLE_MS = 500;

interface Wired {
  dir: string;
  server: ServerHandle;
  watcher: WorkspaceWatcher;
  port: number;
}

/** Wire server + watcher + client-update handler exactly like the CLI entry. */
async function startWired(files: Record<string, string>): Promise<Wired> {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-client-updates-"));
  openDirs.add(dir);
  for (const [name, dsl] of Object.entries(files)) {
    writeFileSync(path.join(dir, `${name}.arch`), dsl);
  }

  let watcher: WorkspaceWatcher | undefined;
  const server = createServer({
    port: 0,
    getWelcome: () =>
      watcher ? buildWelcomeMessages(dir, watcher.getState()) : [WELCOME_WORKSPACE],
    onClientUpdate: createClientUpdateHandler(() => watcher ?? null),
  });
  openServers.add(server);
  const { port } = await server.start();

  watcher = createWorkspaceWatcher({ dir, broadcast: server.broadcast });
  openWatchers.add(watcher);
  await watcher.start();

  return { dir, server, watcher, port };
}

interface TestClient {
  socket: WebSocket;
  /** Every frame received AFTER the welcome exchange, in order. */
  frames: ServerMessage[];
  send(message: UpdateMessage): void;
}

/**
 * Connect a real WS client, absorb its welcome frames (`workspace` +
 * `diagram`, since every test seeds an active diagram), and record every
 * subsequent frame — so tests assert exact deltas per recipient.
 */
async function connectClient(port: number): Promise<TestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  openSockets.add(socket);
  const frames: ServerMessage[] = [];
  socket.on("message", (data) => {
    const result = parseServerMessage(data.toString());
    if (!result.ok) throw new Error(`client received invalid frame: ${result.error}`);
    frames.push(result.message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  await waitFor(() => expect(frames.length).toBeGreaterThanOrEqual(2));
  frames.length = 0; // drop the welcome; tests only care about deltas
  return { socket, frames, send: (message) => socket.send(serializeMessage(message)) };
}

describe("client updates — origin × recipient matrix", () => {
  for (const origin of ["drawer", "canvas"] as ClientOrigin[]) {
    it(`${origin} update: excluded from originator, delivered to others with origin ${origin}, written once`, async () => {
      const { dir, watcher, port } = await startWired({ demo: VALID_DEMO_DSL });
      const a = await connectClient(port);
      const b = await connectClient(port);

      a.send({ kind: "update", name: "demo", dsl: OTHER_VALID_DSL, origin, baseVersion: 1 });

      await waitFor(() => expect(b.frames).toHaveLength(1));
      expect(b.frames[0]).toMatchObject({
        kind: "diagram",
        name: "demo",
        version: 2,
        origin,
        dsl: OTHER_VALID_DSL,
      });
      expect((b.frames[0] as DiagramMessage).doc.nodes.map((n) => n.id)).toEqual(["Alpha", "Beta"]);

      // The write landed on disk and bumped the version exactly once.
      expect(readFileSync(path.join(dir, "demo.arch"), "utf8")).toBe(OTHER_VALID_DSL);
      expect(watcher.getState().versions.get("demo")).toBe(2);

      // Anti-echo, both layers: past the chokidar debounce window, the
      // originator has received NOTHING, the other client got no duplicate
      // (fs echo of our own write is suppressed), and no double version bump.
      await sleep(SETTLE_MS);
      expect(a.frames).toEqual([]);
      expect(b.frames).toHaveLength(1);
      expect(watcher.getState().versions.get("demo")).toBe(2);
    });
  }

  it("MCP set_diagram path: every WS client receives the diagram with origin mcp", async () => {
    const { watcher, port } = await startWired({ demo: VALID_DEMO_DSL });
    const a = await connectClient(port);
    const b = await connectClient(port);

    // What the set_diagram MCP tool calls (T20) — no opts, so origin stays mcp.
    const result = watcher.update("demo", OTHER_VALID_DSL);
    expect(result.ok).toBe(true);

    for (const client of [a, b]) {
      await waitFor(() => expect(client.frames).toHaveLength(1));
      expect(client.frames[0]).toMatchObject({
        kind: "diagram",
        name: "demo",
        version: 2,
        origin: "mcp",
        dsl: OTHER_VALID_DSL,
      });
    }
  });

  it("external file edit: every WS client receives the diagram with origin file", async () => {
    const { dir, port } = await startWired({ demo: VALID_DEMO_DSL });
    const a = await connectClient(port);
    const b = await connectClient(port);

    // Simulate an out-of-band edit (git checkout, another editor, …).
    writeFileSync(path.join(dir, "demo.arch"), OTHER_VALID_DSL);

    for (const client of [a, b]) {
      await waitFor(() => expect(client.frames).toHaveLength(1));
      expect(client.frames[0]).toMatchObject({
        kind: "diagram",
        name: "demo",
        version: 2,
        origin: "file",
        dsl: OTHER_VALID_DSL,
      });
    }
  });

  it("syntactically invalid update: diagram-error to the sender only, file and version untouched", async () => {
    const { dir, watcher, port } = await startWired({ demo: VALID_DEMO_DSL });
    const a = await connectClient(port);
    const b = await connectClient(port);

    a.send({ kind: "update", name: "demo", dsl: INVALID_DSL, origin: "drawer", baseVersion: 1 });

    await waitFor(() => expect(a.frames).toHaveLength(1));
    expect(a.frames[0]).toMatchObject({
      kind: "diagram-error",
      name: "demo",
      version: 1, // last accepted version, unchanged by the failure
      origin: "drawer",
      dsl: INVALID_DSL,
    });
    expect((a.frames[0] as DiagramErrorMessage).parseErrors.length).toBeGreaterThan(0);

    // One client's half-typed DSL is not another client's problem.
    await sleep(SETTLE_MS);
    expect(b.frames).toEqual([]);
    expect(readFileSync(path.join(dir, "demo.arch"), "utf8")).toBe(VALID_DEMO_DSL);
    expect(watcher.getState().versions.get("demo")).toBe(1);
  });

  it("stale baseVersion: sender alone is re-synced with current state, nothing is overwritten", async () => {
    const { dir, watcher, port } = await startWired({ demo: VALID_DEMO_DSL });
    const a = await connectClient(port);
    const b = await connectClient(port);

    // Someone else moves the diagram to v2 first (MCP write).
    watcher.update("demo", OTHER_VALID_DSL);
    await waitFor(() => expect(a.frames).toHaveLength(1));
    await waitFor(() => expect(b.frames).toHaveLength(1));
    a.frames.length = 0;
    b.frames.length = 0;

    // A submits an edit still based on v1 → server wins, no blind overwrite.
    a.send({ kind: "update", name: "demo", dsl: THIRD_VALID_DSL, origin: "drawer", baseVersion: 1 });

    await waitFor(() => expect(a.frames).toHaveLength(1));
    expect(a.frames[0]).toMatchObject({
      kind: "diagram",
      name: "demo",
      version: 2, // current server state, not a new version
      origin: "file", // re-sync convention: same origin as a disk re-read
      dsl: OTHER_VALID_DSL, // current content, not A's stale edit
    });

    await sleep(SETTLE_MS);
    expect(b.frames).toEqual([]);
    expect(readFileSync(path.join(dir, "demo.arch"), "utf8")).toBe(OTHER_VALID_DSL);
    expect(watcher.getState().versions.get("demo")).toBe(2);
  });

  it("update for a diagram that does not exist: diagram-error to the sender only, nothing created", async () => {
    const { dir, watcher, port } = await startWired({ demo: VALID_DEMO_DSL });
    const a = await connectClient(port);
    const b = await connectClient(port);

    a.send({ kind: "update", name: "ghost", dsl: OTHER_VALID_DSL, origin: "canvas", baseVersion: 0 });

    await waitFor(() => expect(a.frames).toHaveLength(1));
    expect(a.frames[0]).toMatchObject({
      kind: "diagram-error",
      name: "ghost",
      version: 0,
      origin: "canvas",
      dsl: OTHER_VALID_DSL,
    });
    const error = a.frames[0] as DiagramErrorMessage;
    expect(error.parseErrors).toEqual([]);
    expect(error.modelErrors[0]?.message).toContain("does not exist");

    await sleep(SETTLE_MS);
    expect(b.frames).toEqual([]);
    expect(readdirSync(dir)).not.toContain("ghost.arch");
    expect(watcher.getState().diagrams).toEqual(["demo"]);
  });

  it("two clients racing on the same base: first write wins, second is re-synced", async () => {
    const { dir, watcher, port } = await startWired({ demo: VALID_DEMO_DSL });
    const a = await connectClient(port);
    const b = await connectClient(port);

    // Both edit on top of v1 and submit back-to-back. Message handling is
    // synchronous on the event loop, so whichever frame arrives first commits
    // v2 and the other MUST take the conflict path — never a silent clobber.
    a.send({ kind: "update", name: "demo", dsl: OTHER_VALID_DSL, origin: "drawer", baseVersion: 1 });
    b.send({ kind: "update", name: "demo", dsl: THIRD_VALID_DSL, origin: "canvas", baseVersion: 1 });

    // Deterministic outcome regardless of arrival order: exactly one write
    // was accepted (v2), and the loser got a re-sync of the winner's state.
    await waitFor(() => {
      expect(a.frames.length + b.frames.length).toBeGreaterThanOrEqual(2);
    });
    await sleep(SETTLE_MS);

    expect(watcher.getState().versions.get("demo")).toBe(2);
    const onDisk = readFileSync(path.join(dir, "demo.arch"), "utf8");
    expect([OTHER_VALID_DSL, THIRD_VALID_DSL]).toContain(onDisk);

    // Sort out roles by who owns the on-disk content.
    const [winner, loser] = onDisk === OTHER_VALID_DSL ? [a, b] : [b, a];
    // Loser: the winner's accepted update (broadcast — only the winner is
    // excluded from it) followed by its own private re-sync. Both frames
    // carry the same v2 winning state, so the loser converges either way.
    expect(loser.frames).toHaveLength(2);
    expect(loser.frames[0]).toMatchObject({ kind: "diagram", name: "demo", version: 2, dsl: onDisk });
    expect(loser.frames[1]).toMatchObject({ kind: "diagram", version: 2, dsl: onDisk, origin: "file" });
    // Winner: never sees its own edit come back, and the loser's write was
    // rejected (private re-sync only) — so zero frames.
    expect(winner.frames).toEqual([]);
  });
});
