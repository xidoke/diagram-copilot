/**
 * HTTP tests for the picker's diagram-lifecycle routes (DGC-65):
 * `POST /api/rename` `{ name, newName }` and `POST /api/trash` `{ name }`.
 *
 * Exercises `createRequestHandler` + `createLifecycleHttpHandler` directly
 * against a bare `node:http` server (same scoping as `http-open.test.ts`),
 * with a real watcher + lifecycle ops on a temp workspace so the rename/trash
 * behavior is end to end, not mocked.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  API_RENAME_PATH,
  API_TRASH_PATH,
  createLifecycleHttpHandler,
  createRequestHandler,
} from "../src/http.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";
import { createLifecycleOps, TRASH_DIR, type LifecycleOps } from "../src/workspace/lifecycle.js";

const VALID_DEMO_DSL = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");
const OTHER_VALID_DSL = ["Alpha", "Beta", "", "Alpha > Beta"].join("\n");

const openServers = new Set<http.Server>();
const openWatchers = new Set<WorkspaceWatcher>();
const openDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...openWatchers].map((watcher) => watcher.stop()));
  openWatchers.clear();
  await Promise.all(
    [...openServers].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  openServers.clear();
  for (const dir of openDirs) rmSync(dir, { recursive: true, force: true });
  openDirs.clear();
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-http-lifecycle-"));
  openDirs.add(dir);
  return dir;
}

async function startServer(options?: { withWatcher?: boolean }): Promise<{
  url: string;
  watcher: WorkspaceWatcher | null;
  dir: string;
}> {
  const dir = makeTempDir();
  let watcher: WorkspaceWatcher | null = null;
  let lifecycle: LifecycleOps | null = null;

  if (options?.withWatcher !== false) {
    watcher = createWorkspaceWatcher({ dir, broadcast: () => {} });
    openWatchers.add(watcher);
    await watcher.start();
    lifecycle = createLifecycleOps(dir, () => watcher);
  }

  const handler = createRequestHandler(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createLifecycleHttpHandler(() => lifecycle),
  );
  const server = http.createServer(handler);
  openServers.add(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, watcher, dir };
}

function postJson(url: string, route: string, body: unknown): Promise<{ status: number; json: unknown }> {
  return fetch(`${url}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
}

describe("POST /api/rename", () => {
  it("renames a diagram and its sidecars", async () => {
    const { url, dir, watcher } = await startServer();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "demo.layout.json"), "{}");
    watcher!.resync();

    const { status, json } = await postJson(url, API_RENAME_PATH, { name: "demo", newName: "renamed" });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, oldName: "demo", newName: "renamed" });
    expect(readdirSync(dir)).toContain("renamed.arch");
    expect(readdirSync(dir)).toContain("renamed.layout.json");
    expect(readdirSync(dir)).not.toContain("demo.arch");
    expect(watcher!.getState().diagrams).toEqual(["renamed"]);
  });

  it("refuses to rename onto an existing name with 400", async () => {
    const { url, dir, watcher } = await startServer();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "taken.arch"), OTHER_VALID_DSL);
    watcher!.resync();

    const { status, json } = await postJson(url, API_RENAME_PATH, { name: "demo", newName: "taken" });

    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
    expect((json as { error?: string }).error).toContain("already exists");
  });

  it("rejects a missing/non-string field with 400", async () => {
    const { url } = await startServer();
    const { status } = await postJson(url, API_RENAME_PATH, { name: "demo" });
    expect(status).toBe(400);
  });

  it("rejects a path-traversal new name with 400", async () => {
    const { url, dir, watcher } = await startServer();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    watcher!.resync();

    const { status, json } = await postJson(url, API_RENAME_PATH, { name: "demo", newName: "../evil" });
    expect(status).toBe(400);
    expect((json as { error?: string }).error).toContain("path separators");
  });
});

describe("POST /api/trash", () => {
  it("moves the diagram into .trash and reports the fallback active", async () => {
    const { url, dir, watcher } = await startServer();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    watcher!.resync();
    expect(watcher!.getState().active).toBe("demo");

    const { status, json } = await postJson(url, API_TRASH_PATH, { name: "demo" });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, name: "demo", active: "alpha" });
    const { id } = json as { id: string };
    expect(existsSync(path.join(dir, TRASH_DIR, id, "demo.arch"))).toBe(true);
    expect(watcher!.getState().diagrams).toEqual(["alpha"]);
    expect(watcher!.getState().active).toBe("alpha");
  });

  it("rejects an unknown diagram with 400", async () => {
    const { url } = await startServer();
    const { status, json } = await postJson(url, API_TRASH_PATH, { name: "ghost" });
    expect(status).toBe(400);
    expect((json as { error?: string }).error).toContain("does not exist");
  });

  it("rejects malformed JSON with 400", async () => {
    const { url } = await startServer();
    const { status } = await postJson(url, API_TRASH_PATH, "not json");
    expect(status).toBe(400);
  });

  it("rejects non-POST methods with 405", async () => {
    const { url } = await startServer();
    const res = await fetch(`${url}${API_TRASH_PATH}`, { method: "GET" });
    expect(res.status).toBe(405);
  });

  it("responds 503 when the watcher has not started yet", async () => {
    const { url } = await startServer({ withWatcher: false });
    const { status } = await postJson(url, API_TRASH_PATH, { name: "demo" });
    expect(status).toBe(503);
  });
});
