/**
 * `diff_diagram` MCP tool (DGC-74) driven over the real `node:http` + Streamable
 * HTTP transport, wired to a real workspace watcher on a temp dir holding two
 * saved diagrams. Mirrors `diagram-tools.test.ts`: it asserts the diff receipt
 * end-to-end, the `to`-defaults-to-active behavior, and the error path when a
 * side cannot be read.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "../src/mcp/handler.js";
import { createServer, type ServerHandle } from "../src/server.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";

const STEP1 = [
  "direction right",
  "",
  "Client [icon: monitor]",
  "API Server [icon: server, color: gray]",
  "",
  "Client > API Server: request",
].join("\n");

const STEP2 = [
  "direction right",
  "",
  "Client [icon: monitor]",
  "API Server [icon: server, color: blue]",
  "Redis Cache [icon: redis]",
  "",
  "Client > API Server: request",
  "API Server > Redis Cache: cache",
].join("\n");

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

/** A temp workspace with both step files written before the watcher starts. */
function makeWorkspace(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-diff-tool-"));
  openDirs.add(dir);
  writeFileSync(path.join(dir, "news-feed.step1.arch"), STEP1);
  writeFileSync(path.join(dir, "news-feed.step2.arch"), STEP2);
  return dir;
}

async function startServer(dir: string): Promise<{ port: number }> {
  const watcher = createWorkspaceWatcher({ dir, broadcast: () => {} });
  openWatchers.add(watcher);
  await watcher.start();

  const server = createServer({
    port: 0,
    mcpHandler: createMcpHandler({
      getInfo: () => ({ version: "1.0.0", workspaceDir: dir, active: watcher.getState().active }),
      getWorkspace: () => watcher,
    }),
  });
  openServers.add(server);
  const { port } = await server.start();
  return { port };
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
  const body = await response.json();
  return body.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
}

describe("diff_diagram over /mcp", () => {
  it("advertises diff_diagram in tools/list", async () => {
    const { port } = await startServer(makeWorkspace());
    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("diff_diagram");
  });

  it("renders a receipt for step1 → step2 (added node, color change, new edge)", async () => {
    const { port } = await startServer(makeWorkspace());
    const result = await callTool(port, "diff_diagram", {
      from: "news-feed.step1",
      to: "news-feed.step2",
    });
    expect(result.isError).toBeFalsy();
    const receipt = result.content[0].text;
    expect(receipt).toContain("news-feed.step1 → news-feed.step2");
    expect(receipt).toContain("+ Added: Redis Cache [redis]");
    expect(receipt).toContain("- Removed: —");
    expect(receipt).toContain("~ Changed: API Server (color: gray→blue)");
    expect(receipt).toContain("↪ Moved: —");
    expect(receipt).toContain("Edges: +1 (API Server→Redis Cache: cache)");
  });

  it("defaults `to` to the active diagram", async () => {
    const { port } = await startServer(makeWorkspace());
    // Make step2 the active diagram, then diff from step1 with no explicit `to`.
    await callTool(port, "open_diagram", { name: "news-feed.step2" });
    const result = await callTool(port, "diff_diagram", { from: "news-feed.step1" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("news-feed.step1 → news-feed.step2");
    expect(result.content[0].text).toContain("+ Added: Redis Cache [redis]");
  });

  it("reports 'No differences.' when both sides are the same diagram", async () => {
    const { port } = await startServer(makeWorkspace());
    const result = await callTool(port, "diff_diagram", {
      from: "news-feed.step1",
      to: "news-feed.step1",
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No differences.");
  });

  it("errors clearly when the `from` diagram does not exist", async () => {
    const { port } = await startServer(makeWorkspace());
    const result = await callTool(port, "diff_diagram", {
      from: "does-not-exist",
      to: "news-feed.step2",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does-not-exist");
  });
});
