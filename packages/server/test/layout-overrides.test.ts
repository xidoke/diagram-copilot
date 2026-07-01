import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { layoutSidecarPath } from "@diagram-copilot/core";
import { createServer, type ServerHandle } from "../src/server.js";
import { createLayoutApiHandler } from "../src/layout-overrides.js";

const openServers = new Set<ServerHandle>();
const tmpDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.stop()));
  openServers.clear();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.clear();
});

/** Start a real server whose `/api/layout` routes read/write a fresh temp workspace. */
async function startWithWorkspace(): Promise<{ base: string; workspace: string }> {
  const workspace = mkdtempSync(path.join(tmpdir(), "dgc-layout-"));
  tmpDirs.add(workspace);
  const server = createServer({ port: 0, apiHandler: createLayoutApiHandler(workspace) });
  openServers.add(server);
  const { url } = await server.start();
  return { base: url, workspace };
}

describe("/api/layout/:name — round-trip", () => {
  it("GET returns {} when no sidecar exists yet", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/layout/news-feed`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
  });

  it("PUT persists overrides to <name>.layout.json and GET reads them back", async () => {
    const { base, workspace } = await startWithWorkspace();
    const overrides = { API: { x: 120, y: 40 }, Client: { x: -10, y: 200.5 } };

    const put = await fetch(`${base}/api/layout/news-feed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(overrides),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(overrides);

    // Written to the expected sidecar path in the workspace.
    const sidecar = path.join(workspace, layoutSidecarPath("news-feed"));
    expect(existsSync(sidecar)).toBe(true);
    expect(JSON.parse(readFileSync(sidecar, "utf8"))).toEqual(overrides);

    const get = await fetch(`${base}/api/layout/news-feed`);
    expect(await get.json()).toEqual(overrides);
  });

  it("DELETE removes the sidecar; a later GET is {} again", async () => {
    const { base, workspace } = await startWithWorkspace();
    const sidecar = path.join(workspace, layoutSidecarPath("news-feed"));
    writeFileSync(sidecar, JSON.stringify({ API: { x: 1, y: 2 } }));

    const del = await fetch(`${base}/api/layout/news-feed`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(sidecar)).toBe(false);

    const get = await fetch(`${base}/api/layout/news-feed`);
    expect(await get.json()).toEqual({});
  });

  it("DELETE is idempotent when no sidecar exists", async () => {
    const { base } = await startWithWorkspace();
    const del = await fetch(`${base}/api/layout/never-saved`, { method: "DELETE" });
    expect(del.status).toBe(200);
  });
});

describe("/api/layout/:name — validation", () => {
  it("rejects a body that is not a valid LayoutOverrides with 400", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/layout/news-feed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ API: { x: "nope", y: 3 } }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });

  it("rejects malformed JSON with 400", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/layout/news-feed`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    expect(res.status).toBe(400);
  });

  it("rejects a path-traversal name with 400 and writes nothing outside the workspace", async () => {
    const { base, workspace } = await startWithWorkspace();
    const res = await fetch(`${base}/api/layout/${encodeURIComponent("../escape")}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ A: { x: 0, y: 0 } }),
    });
    expect(res.status).toBe(400);
    // The parent of the workspace must not have gained an escape sidecar.
    expect(existsSync(path.join(path.dirname(workspace), layoutSidecarPath("escape")))).toBe(false);
  });
});
