/**
 * Restart-safety acceptance (T23).
 *
 * The server keeps NO durable state of its own: the `.arch` files on disk are
 * the single source of truth, and everything the watcher tracks in memory
 * (the diagram list, the active pick, per-diagram versions) is rebuilt from a
 * fresh directory scan on every `start()`. This suite pins that guarantee down
 * as hard acceptance tests by killing a whole server+watcher stack, mutating
 * the workspace on disk while it is dead (an "external edit" — another editor,
 * a git checkout, a script), then bringing a BRAND-NEW stack up on the same
 * directory and asserting a newly-connected client is greeted with the truth
 * that is now on disk.
 *
 * Version semantics after a restart — the one piece of state that does NOT
 * survive, by design:
 * ------------------------------------------------------------------------
 * Versions are PER-PROCESS and in-memory. A fresh process starts every
 * diagram's version from 0 and the initial scan bumps the active diagram to
 * version 1 (see `parseAndBroadcastActive` in watcher.ts). So a diagram that
 * was at version 7 before the crash comes back as version 1 — the counter
 * restarts, it is NOT persisted or reconstructed. These tests assert that
 * ACTUAL current behavior rather than pretending versions are durable.
 *
 * Does this break clients? No — and it is deliberate, not an accident of this
 * test. Clients key on `name` + `version` only WITHIN a live session; a
 * reconnect after a restart is a new session that begins with a full welcome
 * (a `workspace` frame plus a fresh `diagram`/`diagram-error` at the restarted
 * version), so the client re-syncs from scratch. And a stale client that
 * survived the restart and later sends an `update` with a now-in-the-future
 * `baseVersion` is caught by the conflict path in `client-updates.ts` (see its
 * module doc: "a client from before a server restart claiming a future
 * version ... gets a fresh diagram frame of current server state"). The
 * contract already anticipates the reset; this suite does not change it. If a
 * future change ever made a client depend on monotonic-across-restart
 * versions, THAT would be the contract break to flag — not this test.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { parseServerMessage, type ServerMessage } from "@diagram-copilot/core";
import { createServer, WELCOME_WORKSPACE, WS_PATH, type ServerHandle } from "../src/server.js";
import {
  buildWelcomeMessages,
  createWorkspaceWatcher,
  type WorkspaceWatcher,
} from "../src/workspace/watcher.js";

const DEMO_V1 = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");
const DEMO_V2 = ["direction down", "", "Browser", "Api", "Db", "", "Browser > Api", "Api > Db"].join("\n");
const ALPHA_DSL = ["Alpha", "Beta", "", "Alpha > Beta"].join("\n");
const INVALID_DSL = "Client >";

/** A running server+watcher stack, wired exactly like the CLI entry (index.ts). */
interface Stack {
  server: ServerHandle;
  watcher: WorkspaceWatcher;
  port: number;
}

/** Track stacks/sockets/dirs so every test tears down cleanly even on failure. */
const openStacks = new Set<Stack>();
const openSockets = new Set<WebSocket>();
const openDirs = new Set<string>();

afterEach(async () => {
  for (const socket of openSockets) socket.close();
  openSockets.clear();
  await Promise.all([...openStacks].map((stack) => stopStack(stack)));
  openStacks.clear();
  for (const dir of openDirs) rmSync(dir, { recursive: true, force: true });
  openDirs.clear();
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-restart-"));
  openDirs.add(dir);
  return dir;
}

/**
 * Start a full stack (server on an ephemeral port + watcher) over `dir`,
 * mirroring the wiring in `index.ts`: the server's `getWelcome` reads through
 * a mutable watcher ref (created only after the port is secured) and
 * re-derives the greeting from the watcher's current state on every connect.
 */
async function startStack(dir: string): Promise<Stack> {
  let watcher: WorkspaceWatcher | undefined;
  const getWelcome = (): ServerMessage[] =>
    watcher ? buildWelcomeMessages(dir, watcher.getState()) : [WELCOME_WORKSPACE];

  const server = createServer({ port: 0, getWelcome });
  const { port } = await server.start();

  watcher = createWorkspaceWatcher({ dir, broadcast: server.broadcast });
  await watcher.start();

  const stack: Stack = { server, watcher, port };
  openStacks.add(stack);
  return stack;
}

/** Fully kill a stack — process death: watcher watchers closed, sockets terminated. */
async function stopStack(stack: Stack): Promise<void> {
  openStacks.delete(stack);
  await stack.watcher.stop();
  await stack.server.stop();
}

/**
 * Connect a client and accumulate every parsed server frame it receives (the
 * welcome frames arrive right after the socket opens). Returns the live
 * `messages` array so tests can `waitFor` the expected count.
 */
function openClient(port: number): { socket: WebSocket; messages: ServerMessage[] } {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  openSockets.add(socket);
  const messages: ServerMessage[] = [];
  socket.on("message", (data) => {
    const result = parseServerMessage(data.toString());
    if (result.ok) messages.push(result.message);
  });
  return { socket, messages };
}

/** Poll `check` until it passes or the timeout elapses. */
async function waitFor(check: () => void, timeoutMs = 2000): Promise<void> {
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

type DiagramFrame = Extract<ServerMessage, { kind: "diagram" }>;
type DiagramErrorFrame = Extract<ServerMessage, { kind: "diagram-error" }>;

describe("restart-safety — state survives process death", () => {
  it("greets a new client with the full list, demo-first active, and the active file's NEW on-disk content after a cold restart", async () => {
    const dir = makeTempDir();
    // A representative workspace: `demo` (valid, wins active by the demo-first
    // rule even though `alpha` sorts before it), a second valid file, and a
    // broken NON-active file that must not derail the scan or the restart.
    writeFileSync(path.join(dir, "demo.arch"), DEMO_V1);
    writeFileSync(path.join(dir, "alpha.arch"), ALPHA_DSL);
    writeFileSync(path.join(dir, "broken.arch"), INVALID_DSL);

    // --- Stack #1: a client sees the original state. ---
    const first = await startStack(dir);
    const c1 = openClient(first.port);
    await waitFor(() => expect(c1.messages).toHaveLength(2));

    expect(c1.messages[0]).toEqual({
      kind: "workspace",
      diagrams: ["alpha", "broken", "demo"],
      active: "demo",
    });
    expect(c1.messages[1]).toMatchObject({
      kind: "diagram",
      name: "demo",
      version: 1,
      origin: "file",
      dsl: DEMO_V1,
    });

    // --- Kill everything, then edit the active file while the server is dead. ---
    await stopStack(first);
    c1.socket.close();
    // External edit: a completely different, still-valid diagram lands on disk
    // with no running watcher to observe the change.
    writeFileSync(path.join(dir, "demo.arch"), DEMO_V2);

    // --- Stack #2: a BRAND-NEW stack + client over the same directory. ---
    const second = await startStack(dir);
    const c2 = openClient(second.port);
    await waitFor(() => expect(c2.messages).toHaveLength(2));

    // Workspace list is rebuilt in full from the scan; broken file included.
    expect(c2.messages[0]).toEqual({
      kind: "workspace",
      diagrams: ["alpha", "broken", "demo"],
      active: "demo",
    });

    const diagram = c2.messages[1] as DiagramFrame;
    expect(diagram.kind).toBe("diagram");
    expect(diagram.name).toBe("demo");
    // The greeting reflects what is on disk RIGHT NOW — the external edit — not
    // the content the previous process last broadcast.
    expect(diagram.dsl).toBe(DEMO_V2);
    expect(diagram.doc.nodes.map((n) => n.id)).toEqual(["Browser", "Api", "Db"]);

    // Version restarts from 1: it is per-process, in-memory, NOT persisted.
    // (See the module doc at the top of this file — this is the intended
    // contract, and clients re-sync from the fresh welcome.)
    expect(diagram.version).toBe(1);
    expect(second.watcher.getState().versions.get("demo")).toBe(1);
  });

  it("reports a truthful diagram-error when the active file is corrupted while the server is dead", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), DEMO_V1);

    // Stack #1: the active diagram parses cleanly.
    const first = await startStack(dir);
    const c1 = openClient(first.port);
    await waitFor(() => expect(c1.messages).toHaveLength(2));
    expect(c1.messages[1]).toMatchObject({ kind: "diagram", name: "demo", version: 1 });

    // Kill, then corrupt the active file on disk with no watcher running.
    await stopStack(first);
    c1.socket.close();
    writeFileSync(path.join(dir, "demo.arch"), INVALID_DSL);

    // Stack #2: the new client is told the honest error state, not a stale
    // "last good" diagram. Version is 0 — this process never accepted a parse.
    const second = await startStack(dir);
    const c2 = openClient(second.port);
    await waitFor(() => expect(c2.messages).toHaveLength(2));

    expect(c2.messages[0]).toMatchObject({ kind: "workspace", diagrams: ["demo"], active: "demo" });
    const err = c2.messages[1] as DiagramErrorFrame;
    expect(err.kind).toBe("diagram-error");
    expect(err.name).toBe("demo");
    expect(err.version).toBe(0);
    expect(err.dsl).toBe(INVALID_DSL);
    // Truthful parse diagnostics, not an empty/faked error.
    expect(err.parseErrors.length).toBeGreaterThan(0);
    expect(second.watcher.getState().versions.get("demo")).toBeUndefined();
  });

  it("recovers a diagram that a fresh process must now pick as active because the previous active file vanished", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), DEMO_V1);
    writeFileSync(path.join(dir, "alpha.arch"), ALPHA_DSL);

    // Stack #1: demo-first rule makes `demo` active.
    const first = await startStack(dir);
    const c1 = openClient(first.port);
    await waitFor(() => expect(c1.messages).toHaveLength(2));
    expect(c1.messages[0]).toMatchObject({ active: "demo" });

    // Kill, then delete the active file entirely while dead.
    await stopStack(first);
    c1.socket.close();
    rmSync(path.join(dir, "demo.arch"));

    // Stack #2: with no demo, the fresh scan falls back to the alphabetical
    // pick (`alpha`) and greets the client with its content at version 1.
    const second = await startStack(dir);
    const c2 = openClient(second.port);
    await waitFor(() => expect(c2.messages).toHaveLength(2));

    expect(c2.messages[0]).toEqual({ kind: "workspace", diagrams: ["alpha"], active: "alpha" });
    expect(c2.messages[1]).toMatchObject({
      kind: "diagram",
      name: "alpha",
      version: 1,
      origin: "file",
      dsl: ALPHA_DSL,
    });
  });
});

describe("restart-safety — a write killed mid-flight survives", () => {
  it("keeps an update() durable on disk when the process dies immediately after, and a fresh stack reads it back", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "demo.arch");
    writeFileSync(filePath, DEMO_V1);

    // Stack #1: connect, then perform an MCP-style update and kill the whole
    // stack the instant it returns — simulating a crash/Ctrl-C the moment
    // after the write, before any graceful flush.
    const first = await startStack(dir);
    const c1 = openClient(first.port);
    await waitFor(() => expect(c1.messages).toHaveLength(2)); // welcome (v1)

    const result = first.watcher.update("demo", DEMO_V2);
    expect(result).toMatchObject({ ok: true, name: "demo", version: 2 });

    // The update frame reached the connected client (in-process version 2)...
    await waitFor(() =>
      expect(c1.messages.at(-1)).toMatchObject({ kind: "diagram", name: "demo", version: 2, dsl: DEMO_V2 }),
    );

    // ...and the write is synchronous (writeFileSync), so death right now
    // cannot corrupt or lose it: the bytes are already fully on disk.
    await stopStack(first);
    c1.socket.close();
    expect(readFileSync(filePath, "utf8")).toBe(DEMO_V2);

    // Stack #2: the killed-mid-flight write is intact and read back correctly.
    // Version resets to 1 (per-process), but the CONTENT is exactly what the
    // dying process wrote.
    const second = await startStack(dir);
    const c2 = openClient(second.port);
    await waitFor(() => expect(c2.messages).toHaveLength(2));

    const diagram = c2.messages[1] as DiagramFrame;
    expect(diagram.kind).toBe("diagram");
    expect(diagram.name).toBe("demo");
    expect(diagram.dsl).toBe(DEMO_V2);
    expect(diagram.doc.nodes.map((n) => n.id)).toEqual(["Browser", "Api", "Db"]);
    expect(diagram.version).toBe(1);
  });
});
