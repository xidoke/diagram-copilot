/**
 * Raw DSL read API (DGC-79): `GET /api/dsl/:name` driven against a real
 * `node:http` server over a fresh temp workspace. Feeds the web's diff overlay,
 * which fetches a step's `.arch` source to diff against the one before it.
 * Mirrors `notes.test.ts`.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ARCH_EXT } from "@diagram-copilot/core";
import { createServer, type ServerHandle } from "../src/server.js";
import { createDslApiHandler } from "../src/dsl-api.js";

const openServers = new Set<ServerHandle>();
const tmpDirs = new Set<string>();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.stop()));
  openServers.clear();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs.clear();
});

function makeWorkspace(): string {
  const workspace = mkdtempSync(path.join(tmpdir(), "dgc-dsl-"));
  tmpDirs.add(workspace);
  return workspace;
}

/** Start a real server whose `/api/dsl` route reads a fresh temp workspace. */
async function startWithWorkspace(): Promise<{ base: string; workspace: string }> {
  const workspace = makeWorkspace();
  const server = createServer({ port: 0, dslHandler: createDslApiHandler(workspace) });
  openServers.add(server);
  const { url } = await server.start();
  return { base: url, workspace };
}

describe("GET /api/dsl/:name", () => {
  it("returns the raw `.arch` source as { name, dsl }", async () => {
    const { base, workspace } = await startWithWorkspace();
    const dsl = "direction right\nAPI > Cache: reads\n";
    writeFileSync(path.join(workspace, `news-feed${ARCH_EXT}`), dsl);

    const res = await fetch(`${base}/api/dsl/news-feed`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "news-feed", dsl });
  });

  it("reads a `.stepN` diagram by its full name", async () => {
    const { base, workspace } = await startWithWorkspace();
    const dsl = "API > Cache\nAPI > Search Index\n";
    writeFileSync(path.join(workspace, `news-feed.step2${ARCH_EXT}`), dsl);

    const res = await fetch(`${base}/api/dsl/news-feed.step2`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "news-feed.step2", dsl });
  });

  it("tolerates a trailing `.arch` in the requested name", async () => {
    const { base, workspace } = await startWithWorkspace();
    writeFileSync(path.join(workspace, `a${ARCH_EXT}`), "A > B\n");
    const res = await fetch(`${base}/api/dsl/${encodeURIComponent(`a${ARCH_EXT}`)}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: "a", dsl: "A > B\n" });
  });

  it("404s when no diagram of that name exists", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/dsl/ghost`);
    expect(res.status).toBe(404);
  });

  it("400s a name with path separators or `..` (never escapes the workspace)", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/dsl/${encodeURIComponent("../secret")}`);
    expect(res.status).toBe(400);
  });

  it("405s a non-GET verb", async () => {
    const { base } = await startWithWorkspace();
    const res = await fetch(`${base}/api/dsl/news-feed`, { method: "POST" });
    expect(res.status).toBe(405);
  });
});
