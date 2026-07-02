/**
 * HTTP tests for `POST /api/edit` (DGC-78 visual editing p1).
 *
 * Exercises `createRequestHandler` + `createEditApiHandler` against a bare
 * `node:http` server — the same shape `createServer` wires internally — with
 * a real workspace watcher on a temp dir, so the write path (version bump +
 * broadcast) is end to end, not mocked. The heart of these tests mirrors
 * `edit-tool.test.ts`: after a surgical op, every line the op did not touch
 * (including Vietnamese comments) must survive byte-for-byte on disk, and a
 * failing op in a batch must leave the file completely unchanged.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@diagram-copilot/core";
import { createRequestHandler } from "../src/http.js";
import { EDIT_PATH, createEditApiHandler } from "../src/edit-executor.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";

/** A diagram full of the user's own comments and spacing — they must survive edits. */
const COMMENTED_DSL = [
  "// Sơ đồ kiến trúc — chú thích của Đô, đừng xoá!",
  "direction right",
  "",
  "Client [icon: monitor]   // máy người dùng",
  "VPC [color: gray] {",
  "  API [icon: server]",
  "  DB [icon: postgresql]  // dữ liệu chính",
  "}",
  "",
  "Client > API: HTTPS      // đi qua CDN",
  "API > DB: reads",
].join("\n");

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

/** Seed `demo.arch`, start a watcher + bare HTTP server wired like `createServer`. */
async function startServer(options?: { withWatcher?: boolean }): Promise<{
  url: string;
  dir: string;
  filePath: string;
  watcher: WorkspaceWatcher | null;
  messages: ServerMessage[];
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-http-edit-"));
  openDirs.add(dir);
  const filePath = path.join(dir, "demo.arch");
  writeFileSync(filePath, COMMENTED_DSL);

  const messages: ServerMessage[] = [];
  let watcher: WorkspaceWatcher | null = null;
  if (options?.withWatcher !== false) {
    watcher = createWorkspaceWatcher({ dir, broadcast: (m) => messages.push(m) });
    openWatchers.add(watcher);
    await watcher.start();
  }

  const handler = createRequestHandler(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    createEditApiHandler(() => watcher),
  );
  const server = http.createServer(handler);
  openServers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, dir, filePath, watcher, messages };
}

function postEdit(url: string, body: unknown): Promise<{ status: number; json: any }> {
  return fetch(`${url}${EDIT_PATH}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json() }));
}

describe("POST /api/edit", () => {
  it("remove: deletes a node plus its edges, preserving every untouched byte", async () => {
    const { url, filePath, watcher } = await startServer();
    const before = readFileSync(filePath, "utf8").split("\n");

    const { status, json } = await postEdit(url, { name: "demo", ops: [{ op: "remove", id: "DB" }] });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, name: "demo", version: 2, applied: ['remove "DB"'] });
    const after = readFileSync(filePath, "utf8");
    expect(after).not.toContain("DB [icon: postgresql]");
    expect(after).not.toContain("API > DB");
    // Untouched lines (comments included) survive byte-for-byte.
    for (const line of before.filter((l) => !l.includes("DB"))) {
      expect(after.split("\n")).toContain(line);
    }
    expect(watcher?.getState().versions.get("demo")).toBe(2);
  });

  it("remove_edge: deletes one edge by endpoints, keeping both nodes", async () => {
    const { url, filePath } = await startServer();

    const { status, json } = await postEdit(url, {
      name: "demo",
      ops: [{ op: "remove_edge", from: "API", to: "DB" }],
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, applied: ["remove_edge API > DB"] });
    const after = readFileSync(filePath, "utf8");
    expect(after).not.toContain("API > DB: reads");
    expect(after).toContain("  DB [icon: postgresql]  // dữ liệu chính");
    expect(after).toContain("Client > API: HTTPS      // đi qua CDN");
  });

  it("rename: rewrites the declaration and every referencing edge", async () => {
    const { url, filePath } = await startServer();

    const { status, json } = await postEdit(url, {
      name: "demo",
      ops: [{ op: "rename", id: "API", new_name: "Core API" }],
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, version: 2, applied: ['rename "API" -> "Core API"'] });
    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("Client > Core API: HTTPS      // đi qua CDN");
    expect(after).toContain("Core API > DB: reads");
    // The old declaration line is gone, replaced in place by the new name.
    expect(after.split("\n")).not.toContain("  API [icon: server]");
    expect(after.split("\n")).toContain("  Core API [icon: server]");
  });

  it("covers add_node, add_edge, set_attr, and move_to_group in one batch", async () => {
    const { url, filePath } = await startServer();

    const { status, json } = await postEdit(url, {
      name: "demo",
      ops: [
        { op: "add_node", name: "Cache", icon: "redis", group: "VPC" },
        { op: "add_edge", from: "API", to: "Cache", label: "hot keys" },
        { op: "set_attr", id: "Client", key: "color", value: "blue" },
        { op: "move_to_group", id: "Client", group: "VPC" },
      ],
    });

    expect(status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.applied).toHaveLength(4);
    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("Cache [icon: redis]");
    expect(after).toContain("API > Cache: hot keys");
    expect(after).toContain("color: blue");
  });

  it("is all-or-nothing: a failing op aborts the batch with its index, file untouched", async () => {
    const { url, filePath, watcher, messages } = await startServer();
    const editBroadcastsBefore = messages.filter((m) => m.kind === "diagram").length;

    const { status, json } = await postEdit(url, {
      name: "demo",
      ops: [
        { op: "add_node", name: "Cache" }, // would succeed
        { op: "rename", id: "Ghost", new_name: "Phantom" }, // unknown id → fails
        { op: "remove", id: "DB" }, // never reached
      ],
    });

    expect(status).toBe(422);
    expect(json).toMatchObject({ ok: false, opIndex: 1 });
    expect(json.error).toContain('no node or group with id "Ghost"');
    // Disk bytes, version, and broadcasts are all untouched.
    expect(readFileSync(filePath, "utf8")).toBe(COMMENTED_DSL);
    expect(watcher?.getState().versions.get("demo")).toBe(1);
    expect(messages.filter((m) => m.kind === "diagram")).toHaveLength(editBroadcastsBefore);
  });

  it("rejects a duplicate-name rename with the primitive's receipt", async () => {
    const { url, filePath } = await startServer();

    const { status, json } = await postEdit(url, {
      name: "demo",
      ops: [{ op: "rename", id: "API", new_name: "DB" }],
    });

    expect(status).toBe(422);
    expect(json).toMatchObject({ ok: false, opIndex: 0 });
    expect(json.error).toContain('"DB" already exists');
    expect(readFileSync(filePath, "utf8")).toBe(COMMENTED_DSL);
  });

  it("reports a pure no-op (rename to same name) without bumping the version", async () => {
    const { url, filePath, watcher } = await startServer();

    const { status, json } = await postEdit(url, {
      name: "demo",
      ops: [{ op: "rename", id: "DB", new_name: "DB" }],
    });

    expect(status).toBe(200);
    expect(json).toMatchObject({ ok: true, version: 1 });
    expect(readFileSync(filePath, "utf8")).toBe(COMMENTED_DSL);
    expect(watcher?.getState().versions.get("demo")).toBe(1);
  });

  it("returns 404 for an unknown diagram name", async () => {
    const { url } = await startServer();

    const { status, json } = await postEdit(url, {
      name: "nope",
      ops: [{ op: "remove", id: "DB" }],
    });

    expect(status).toBe(404);
    expect(json).toMatchObject({ ok: false, name: "nope" });
    expect(json.error).toBeTruthy();
  });

  it.each([
    ["missing name", { ops: [{ op: "remove", id: "DB" }] }],
    ["missing ops", { name: "demo" }],
    ["empty ops", { name: "demo", ops: [] }],
    ["unknown op kind", { name: "demo", ops: [{ op: "explode", id: "DB" }] }],
    ["malformed op shape", { name: "demo", ops: [{ op: "rename", id: "DB" }] }],
  ])("rejects an invalid body (%s) with 400", async (_label, body) => {
    const { url, filePath } = await startServer();

    const { status, json } = await postEdit(url, body);

    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
    expect(readFileSync(filePath, "utf8")).toBe(COMMENTED_DSL);
  });

  it("rejects malformed JSON with 400", async () => {
    const { url } = await startServer();

    const { status, json } = await postEdit(url, "not json");

    expect(status).toBe(400);
    expect(json).toMatchObject({ ok: false });
  });

  it("rejects non-POST methods with 405", async () => {
    const { url } = await startServer();

    const res = await fetch(`${url}${EDIT_PATH}`, { method: "GET" });

    expect(res.status).toBe(405);
  });

  it("responds 503 when the watcher has not started yet", async () => {
    const { url } = await startServer({ withWatcher: false });

    const { status, json } = await postEdit(url, {
      name: "demo",
      ops: [{ op: "remove", id: "DB" }],
    });

    expect(status).toBe(503);
    expect(json).toMatchObject({ ok: false });
  });

  it("broadcasts the accepted edit as a diagram frame (origin mcp) so the canvas refreshes", async () => {
    const { url, messages } = await startServer();

    await postEdit(url, { name: "demo", ops: [{ op: "remove", id: "Client" }] });

    const frame = messages.find((m) => m.kind === "diagram" && m.version === 2);
    expect(frame).toBeTruthy();
    expect(frame).toMatchObject({ name: "demo", origin: "mcp" });
  });
});
