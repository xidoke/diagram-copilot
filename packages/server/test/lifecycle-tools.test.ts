/**
 * Lifecycle MCP tools (`rename_diagram`, `delete_diagram`, `list_trash`,
 * `restore_diagram`, DGC-65) driven over the real `node:http` + Streamable
 * HTTP transport, wired to a real workspace watcher + lifecycle ops on a temp
 * dir. Mirrors the wire-level pattern of `workspace-tools.test.ts`.
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "../src/mcp/handler.js";
import { createServer, type ServerHandle } from "../src/server.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";
import { createLifecycleOps, TRASH_DIR, type LifecycleOps } from "../src/workspace/lifecycle.js";

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
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-lifecycle-tools-"));
  openDirs.add(dir);
  return dir;
}

async function startServer(dir: string): Promise<{
  port: number;
  watcher: WorkspaceWatcher;
  lifecycle: LifecycleOps;
}> {
  const watcher = createWorkspaceWatcher({ dir, broadcast: () => {} });
  openWatchers.add(watcher);
  await watcher.start();
  const lifecycle = createLifecycleOps(dir, () => watcher);

  const server = createServer({
    port: 0,
    mcpHandler: createMcpHandler({
      getInfo: () => ({ version: "1.0.0", workspaceDir: dir, active: watcher.getState().active }),
      getWorkspace: () => watcher,
      getLifecycle: () => lifecycle,
    }),
  });
  openServers.add(server);
  const { port } = await server.start();
  return { port, watcher, lifecycle };
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

describe("lifecycle tools over /mcp", () => {
  it("advertises all four lifecycle tools in tools/list", async () => {
    const { port } = await startServer(makeTempDir());

    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("rename_diagram");
    expect(names).toContain("delete_diagram");
    expect(names).toContain("list_trash");
    expect(names).toContain("restore_diagram");
  });

  it("rename_diagram renames the file, carries sidecars, and follows active", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "demo.notes.md"), "# why");
    const { port, watcher } = await startServer(dir);
    expect(watcher.getState().active).toBe("demo");

    const result = await callTool(port, "rename_diagram", { name: "demo", new_name: "renamed" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Renamed "demo" → "renamed"');
    expect(result.content[0].text).toContain(".notes.md");

    expect(readdirSync(dir)).toContain("renamed.arch");
    expect(readdirSync(dir)).toContain("renamed.notes.md");
    expect(readdirSync(dir)).not.toContain("demo.arch");
    expect(watcher.getState().active).toBe("renamed");
  });

  it("rename_diagram refuses when the new name already exists", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "taken.arch"), OTHER_VALID_DSL);
    const { port } = await startServer(dir);

    const result = await callTool(port, "rename_diagram", { name: "demo", new_name: "taken" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already exists");
  });

  it("rename_diagram rejects a path-traversal new name", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { port } = await startServer(dir);

    const result = await callTool(port, "rename_diagram", { name: "demo", new_name: "../evil" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("path separators");
  });

  it("delete_diagram moves to trash with a restore receipt, and list_trash + restore_diagram round-trip", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    writeFileSync(path.join(dir, "alpha.arch"), OTHER_VALID_DSL);
    const { port, watcher } = await startServer(dir);

    const deleted = await callTool(port, "delete_diagram", { name: "demo" });
    expect(deleted.isError).toBeFalsy();
    // The receipt says it is recoverable and names the restore tool + id.
    expect(deleted.content[0].text).toContain("recoverable");
    expect(deleted.content[0].text).toContain("restore_diagram");
    expect(watcher.getState().diagrams).toEqual(["alpha"]);
    expect(watcher.getState().active).toBe("alpha");

    const listed = await callTool(port, "list_trash");
    expect(listed.isError).toBeFalsy();
    expect(listed.content[0].text).toContain("demo");
    const idMatch = /id "([^"]+)"/.exec(listed.content[0].text);
    expect(idMatch).not.toBeNull();

    const restored = await callTool(port, "restore_diagram", { id: idMatch![1] });
    expect(restored.isError).toBeFalsy();
    expect(restored.content[0].text).toContain('Restored "demo"');
    expect(watcher.getState().diagrams).toEqual(["alpha", "demo"]);
    expect(watcher.getState().active).toBe("demo");
    expect(existsSync(path.join(dir, TRASH_DIR, idMatch![1]))).toBe(false);
  });

  it("delete_diagram errors for an unknown name", async () => {
    const { port } = await startServer(makeTempDir());
    const result = await callTool(port, "delete_diagram", { name: "ghost" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not exist");
  });

  it("list_trash reports an empty trash", async () => {
    const { port } = await startServer(makeTempDir());
    const result = await callTool(port, "list_trash");
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("empty");
  });

  it("restore_diagram errors for an unknown id", async () => {
    const { port } = await startServer(makeTempDir());
    const result = await callTool(port, "restore_diagram", { id: "nope" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Nothing in the trash");
  });
});
