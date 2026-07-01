/**
 * Workspace MCP tools (`list_diagrams`, `open_diagram`) driven over the real
 * `node:http` + Streamable HTTP transport, wired to a real workspace watcher on
 * a temp dir. Mirrors the wire-level pattern of `mcp.test.ts` (ephemeral port,
 * JSON-RPC POSTs) but with a live workspace instead of a static `McpInfo`.
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "../src/mcp/handler.js";
import { createServer, type ServerHandle } from "../src/server.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";

const VALID_DEMO_DSL = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");
const OTHER_VALID_DSL = ["Alpha", "Beta", "", "Alpha > Beta"].join("\n");

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
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-ws-tools-"));
  openDirs.add(dir);
  return dir;
}

/** Start a real watcher + server on `dir`, returning the ephemeral port + watcher. */
async function startServer(dir: string): Promise<{ port: number; watcher: WorkspaceWatcher }> {
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
  return { port, watcher };
}

function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

/** tools/call over the wire, returning the JSON-RPC `result`. */
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

describe("workspace tools over /mcp", () => {
  it("advertises list_diagrams and open_diagram in tools/list", async () => {
    const { port } = await startServer(makeTempDir());

    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("list_diagrams");
    expect(names).toContain("open_diagram");
  });

  it("list_diagrams reports an empty workspace with a create hint", async () => {
    const { port } = await startServer(makeTempDir());

    const result = await callTool(port, "list_diagrams");
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No diagrams");
    expect(result.content[0].text).toContain("open_diagram");
  });

  it("list_diagrams lists diagrams with versions and marks the active one", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { port } = await startServer(dir);

    const result = await callTool(port, "list_diagrams");
    const text = result.content[0].text;
    expect(text).toContain("alpha (v0)");
    expect(text).toMatch(/demo \(v1\)\s+\* active/);
  });

  it("open_diagram activates an existing diagram", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { port, watcher } = await startServer(dir);
    expect(watcher.getState().active).toBe("demo");

    const result = await callTool(port, "open_diagram", { name: "alpha" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Opened diagram "alpha" (v1).');
    expect(watcher.getState().active).toBe("alpha");
  });

  it("open_diagram creates a new diagram when it does not exist", async () => {
    const dir = makeTempDir();
    const { port, watcher } = await startServer(dir);

    const result = await callTool(port, "open_diagram", { name: "checkout" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Created new diagram");
    expect(result.content[0].text).toContain("checkout");
    expect(readdirSync(dir)).toContain("checkout.arch");
    expect(watcher.getState().active).toBe("checkout");
  });

  it("open_diagram rejects a path-traversal name", async () => {
    const { port } = await startServer(makeTempDir());

    const result = await callTool(port, "open_diagram", { name: "../evil" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path separators");
  });
});
