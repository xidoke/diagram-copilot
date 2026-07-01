/**
 * HTTP tests for the `/api/open` route (DGC-57/T36 diagram picker).
 *
 * Exercises `createRequestHandler` + `createOpenHandler` directly against a
 * bare `node:http` server — the same shape `createServer` (server.ts) wires
 * internally, but built here so this test stays scoped to `http.ts` without
 * touching any other server module. The workspace behind it is a real
 * `createWorkspaceWatcher` pointed at a temp dir, so `open`'s
 * create-on-demand/activate behavior is exercised end to end, not mocked.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { API_OPEN_PATH, createOpenHandler, createRequestHandler } from "../src/http.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";

/** Track servers/watchers/temp dirs so every test tears down cleanly. */
const openServers = new Set<http.Server>();
const openWatchers = new Set<WorkspaceWatcher>();
const openDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...openWatchers].map((watcher) => watcher.stop()));
  openWatchers.clear();
  await Promise.all(
    [...openServers].map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  openServers.clear();
  for (const dir of openDirs) rmSync(dir, { recursive: true, force: true });
  openDirs.clear();
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-http-open-"));
  openDirs.add(dir);
  return dir;
}

/** Start a watcher (optional — omit to exercise the "not ready" 503 path) plus an HTTP server wired to it. */
async function startServer(options?: { withWatcher?: boolean }): Promise<{ url: string; watcher: WorkspaceWatcher | null; dir: string }> {
  const dir = makeTempDir();
  let watcher: WorkspaceWatcher | null = null;

  if (options?.withWatcher !== false) {
    watcher = createWorkspaceWatcher({ dir, broadcast: () => {} });
    openWatchers.add(watcher);
    await watcher.start();
  }

  // Same mutable-watcher-ref pattern the CLI entry uses for mcpHandler/getWelcome.
  const getWorkspace = () => watcher;
  const handler = createRequestHandler(undefined, undefined, undefined, createOpenHandler(getWorkspace));
  const server = http.createServer(handler);
  openServers.add(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, watcher, dir };
}

function postOpen(url: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return fetch(`${url}${API_OPEN_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
}

describe("POST /api/open", () => {
  it("creates and activates a brand-new diagram", async () => {
    const { url, dir } = await startServer();

    const { status, json } = await postOpen(url, { name: "news-feed" });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, created: true, name: "news-feed", version: 1 });
    // Actually landed on disk under the watched workspace.
    const onDisk = readFileSync(path.join(dir, "news-feed.arch"), "utf8");
    expect(onDisk).toContain("news-feed");
  });

  it("activates an existing diagram without recreating it", async () => {
    const { url } = await startServer();
    await postOpen(url, { name: "alpha" });

    const { status, json } = await postOpen(url, { name: "alpha" });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, created: false, name: "alpha" });
  });

  it("reports the now-active diagram after opening a second one", async () => {
    const { url, watcher } = await startServer();
    await postOpen(url, { name: "first" });

    await postOpen(url, { name: "second" });

    expect(watcher?.getState().active).toBe("second");
  });

  it.each([
    ["path separator", "../escape"],
    ["empty after trim", "   "],
    ["dot-dot", ".."],
  ])("rejects an invalid name (%s) with ok:false", async (_label, name) => {
    const { url } = await startServer();

    const { status, json } = await postOpen(url, { name });

    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
    expect((json as { error?: string }).error).toBeTruthy();
  });

  it("rejects a missing/non-string name with 400", async () => {
    const { url } = await startServer();

    const { status, json } = await postOpen(url, {});

    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });

  it("rejects malformed JSON with 400", async () => {
    const { url } = await startServer();

    const { status, json } = await postOpen(url, "not json");

    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });

  it("rejects non-POST methods with 405", async () => {
    const { url } = await startServer();

    const res = await fetch(`${url}${API_OPEN_PATH}`, { method: "GET" });

    expect(res.status).toBe(405);
  });

  it("responds 503 when the watcher has not started yet", async () => {
    const { url } = await startServer({ withWatcher: false });

    const { status, json } = await postOpen(url, { name: "demo" });

    expect(status).toBe(503);
    expect(json).toMatchObject({ ok: false, name: "demo" });
  });

  it("does not interfere with the /mcp route when both handlers are wired", async () => {
    // Not exercising a real MCP transport here — just confirming the router
    // dispatches by pathname rather than one handler swallowing the other.
    const dir = makeTempDir();
    const watcher = createWorkspaceWatcher({ dir, broadcast: () => {} });
    openWatchers.add(watcher);
    await watcher.start();

    let mcpCalls = 0;
    const mcpHandler = async (_req: unknown, res: import("node:http").ServerResponse) => {
      mcpCalls += 1;
      res.writeHead(200);
      res.end("mcp");
    };
    const handler = createRequestHandler(undefined, mcpHandler, undefined, createOpenHandler(() => watcher));
    const server = http.createServer(handler);
    openServers.add(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${port}`;

    const openResult = await postOpen(url, { name: "demo" });
    expect(openResult.status).toBe(200);
    expect(mcpCalls).toBe(0);

    const mcpRes = await fetch(`${url}/mcp`, { method: "POST" });
    expect(await mcpRes.text()).toBe("mcp");
    expect(mcpCalls).toBe(1);
  });
});
