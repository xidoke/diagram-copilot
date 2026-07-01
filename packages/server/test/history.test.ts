/**
 * Undo/redo history (T31) — the AI-overwrite safety net.
 *
 * Drives the real {@link createHistoryStore} against a real workspace watcher on
 * a temp dir (wired through the `onApplied` hook), then exercises undo/redo, the
 * empty-stack edges, jsonl persistence across a "restart", the `POST /api/undo`
 * HTTP route, and the `undo_diagram` / `redo_diagram` MCP tools end-to-end.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@diagram-copilot/core";
import { createHistoryStore, type HistoryStore } from "../src/history/store.js";
import { createUndoApiHandler } from "../src/history/http.js";
import { createMcpHandler } from "../src/mcp/handler.js";
import { createServer, type ServerHandle } from "../src/server.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";

// Four distinct, individually-valid arch-dsl documents.
const A = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");
const B = ["Alpha", "Beta", "", "Alpha > Beta"].join("\n");
const C = ["One", "Two", "", "One > Two"].join("\n");
const D = ["Uno", "Dos", "", "Uno > Dos"].join("\n");

const openServers = new Set<ServerHandle>();
const openWatchers = new Set<WorkspaceWatcher>();
const openDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.stop()));
  await Promise.all([...openWatchers].map((watcher) => watcher.stop()));
  openServers.clear();
  openWatchers.clear();
  for (const dir of openDirs) rmSync(dir, { recursive: true, force: true });
  openDirs.clear();
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-history-"));
  openDirs.add(dir);
  return dir;
}

/** Start a watcher wired to a fresh history store on `dir`. */
async function startWatcher(
  dir: string,
): Promise<{ history: HistoryStore; watcher: WorkspaceWatcher; messages: ServerMessage[] }> {
  const history = createHistoryStore({ dir });
  const messages: ServerMessage[] = [];
  const watcher = createWorkspaceWatcher({
    dir,
    broadcast: (message) => messages.push(message),
    onApplied: history.onApplied,
  });
  openWatchers.add(watcher);
  await watcher.start();
  return { history, watcher, messages };
}

function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

async function callTool(port: number, name: string, args: Record<string, unknown> = {}) {
  const response = await post(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  expect(response.status).toBe(200);
  const json = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ type: string; text: string }> };
  };
  return json.result;
}

describe("history store — undo / redo", () => {
  it("undo restores the previous content as a NEW (higher) version; redo reverses it", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), A);
    const { history, watcher } = await startWatcher(dir);
    expect(watcher.getState().versions.get("demo")).toBe(1);

    watcher.update("demo", B); // v2 — records A@1
    watcher.update("demo", C); // v3 — records B@2
    watcher.update("demo", D); // v4 — records C@3
    expect(watcher.read("demo")).toMatchObject({ dsl: D, version: 4 });

    const undo1 = history.undo("demo", watcher);
    expect(undo1).toMatchObject({ ok: true, fromVersion: 3, toVersion: 5 });
    expect(undo1.message).toBe('Reverted "demo" to v3 content (now v5).');
    // Content stepped back to C, but the version CLIMBED (undo is a fresh update).
    expect(watcher.read("demo").dsl).toBe(C);
    expect(watcher.getState().versions.get("demo")).toBe(5);

    const undo2 = history.undo("demo", watcher);
    expect(undo2.ok).toBe(true);
    expect(watcher.read("demo").dsl).toBe(B); // now v6

    const redo1 = history.redo("demo", watcher);
    expect(redo1.ok).toBe(true);
    expect(redo1.message).toContain("Redid");
    expect(watcher.read("demo").dsl).toBe(C); // redo re-applies C, now v7
    expect(watcher.getState().versions.get("demo")).toBe(7);
  });

  it("reports nothing to undo once the ring is exhausted", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), A);
    const { history, watcher } = await startWatcher(dir);

    watcher.update("demo", B); // one recorded snapshot: A@1
    expect(history.undo("demo", watcher).ok).toBe(true); // restores A
    const none = history.undo("demo", watcher);
    expect(none.ok).toBe(false);
    expect(none.message).toContain("Nothing to undo");
    // The failed undo left the (already-restored) content untouched.
    expect(watcher.read("demo").dsl).toBe(A);
  });

  it("reports nothing to redo before any undo", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), A);
    const { history, watcher } = await startWatcher(dir);
    watcher.update("demo", B);

    const none = history.redo("demo", watcher);
    expect(none.ok).toBe(false);
    expect(none.message).toContain("Nothing to redo");
  });

  it("a fresh edit after an undo clears the redo future", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), A);
    const { history, watcher } = await startWatcher(dir);

    watcher.update("demo", B); // records A@1
    watcher.update("demo", C); // records B@2
    expect(history.undo("demo", watcher).ok).toBe(true); // back to B, redo now holds C
    watcher.update("demo", D); // fresh edit → redo cleared

    const redo = history.redo("demo", watcher);
    expect(redo.ok).toBe(false);
    expect(redo.message).toContain("Nothing to redo");
  });
});

describe("history store — persistence across restart", () => {
  it("loads history from the jsonl log after the process is torn down", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), A);

    const first = await startWatcher(dir);
    first.watcher.update("demo", B); // records A@1
    first.watcher.update("demo", C); // records B@2
    first.watcher.update("demo", D); // records C@3
    await first.watcher.stop();
    openWatchers.delete(first.watcher);

    // History was persisted append-only under .history/.
    expect(readdirSync(path.join(dir, ".history"))).toContain("demo.jsonl");

    // "Restart": a brand-new store + watcher over the same dir (empty in-memory).
    const second = await startWatcher(dir);
    expect(second.watcher.read("demo").dsl).toBe(D); // disk content unchanged

    const undo = second.history.undo("demo", second.watcher);
    expect(undo.ok).toBe(true);
    expect(second.watcher.read("demo").dsl).toBe(C); // restored from the loaded log
  });
});

describe("history — POST /api/undo", () => {
  it("restores the previous content over HTTP and returns the receipt", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), A);
    const { history, watcher } = await startWatcher(dir);
    watcher.update("demo", B); // records A@1

    const server = createServer({
      port: 0,
      undoHandler: createUndoApiHandler(() => watcher, () => history),
    });
    openServers.add(server);
    const { port } = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "demo" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "demo", fromVersion: 1 });
    expect(watcher.read("demo").dsl).toBe(A);
  });

  it("defaults to the active diagram and 409s when there is nothing to undo", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), A);
    const { history, watcher } = await startWatcher(dir);

    const server = createServer({
      port: 0,
      undoHandler: createUndoApiHandler(() => watcher, () => history),
    });
    openServers.add(server);
    const { port } = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/undo`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(false);
    expect(body.message).toContain("Nothing to undo");
  });

  it("rejects non-POST methods", async () => {
    const dir = makeTempDir();
    const { history, watcher } = await startWatcher(dir);
    const server = createServer({
      port: 0,
      undoHandler: createUndoApiHandler(() => watcher, () => history),
    });
    openServers.add(server);
    const { port } = await server.start();

    const res = await fetch(`http://127.0.0.1:${port}/api/undo`, { method: "GET" });
    expect(res.status).toBe(405);
  });
});

describe("history — undo_diagram / redo_diagram over /mcp", () => {
  it("advertises both tools and restores/reverses content", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), A);
    const { history, watcher } = await startWatcher(dir);

    const server = createServer({
      port: 0,
      mcpHandler: createMcpHandler({
        getInfo: () => ({ version: "1.0.0", workspaceDir: dir, active: watcher.getState().active }),
        getWorkspace: () => watcher,
        getHistory: () => history,
      }),
    });
    openServers.add(server);
    const { port } = await server.start();

    watcher.update("demo", B); // records A@1

    const listRes = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const names = ((await listRes.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map(
      (t) => t.name,
    );
    expect(names).toContain("undo_diagram");
    expect(names).toContain("redo_diagram");

    const undo = await callTool(port, "undo_diagram", {});
    expect(undo.isError).toBeFalsy();
    expect(undo.content[0].text).toContain("Reverted");
    expect(watcher.read("demo").dsl).toBe(A);

    const redo = await callTool(port, "redo_diagram", {});
    expect(redo.isError).toBeFalsy();
    expect(redo.content[0].text).toContain("Redid");
    expect(watcher.read("demo").dsl).toBe(B);
  });

  it("undo_diagram reports gracefully when there is nothing to undo", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), A);
    const { history, watcher } = await startWatcher(dir);
    const server = createServer({
      port: 0,
      mcpHandler: createMcpHandler({
        getInfo: () => ({ version: "1.0.0", workspaceDir: dir, active: watcher.getState().active }),
        getWorkspace: () => watcher,
        getHistory: () => history,
      }),
    });
    openServers.add(server);
    const { port } = await server.start();

    const undo = await callTool(port, "undo_diagram", {});
    expect(undo.isError).toBe(true);
    expect(undo.content[0].text).toContain("Nothing to undo");
  });
});
