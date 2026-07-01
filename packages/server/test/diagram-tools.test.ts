/**
 * Diagram MCP tools (`get_diagram`, `set_diagram`) driven over the real
 * `node:http` + Streamable HTTP transport, wired to a real workspace watcher on
 * a temp dir. Mirrors `workspace-tools.test.ts` but captures the watcher's
 * broadcasts so the origin-`mcp` frame from a write can be asserted end-to-end.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@diagram-copilot/core";
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
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-diagram-tools-"));
  openDirs.add(dir);
  return dir;
}

/** Start a real watcher + server on `dir`, capturing every broadcast message. */
async function startServer(
  dir: string,
): Promise<{ port: number; watcher: WorkspaceWatcher; messages: ServerMessage[] }> {
  const messages: ServerMessage[] = [];
  const watcher = createWorkspaceWatcher({ dir, broadcast: (m) => messages.push(m) });
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
  return { port, watcher, messages };
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

describe("diagram tools over /mcp", () => {
  it("advertises get_diagram and set_diagram in tools/list", async () => {
    const { port } = await startServer(makeTempDir());

    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("get_diagram");
    expect(names).toContain("set_diagram");
  });

  it("round-trips get → set → get: version bumps, disk changes, mcp frame broadcast", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "demo.arch");
    writeFileSync(filePath, VALID_DEMO_DSL);
    const { port, messages } = await startServer(dir);

    // get_diagram (active) shows the initial DSL at v1.
    const first = await callTool(port, "get_diagram");
    expect(first.isError).toBeFalsy();
    expect(first.content[0].text).toContain("(v1)");
    expect(first.content[0].text).toContain("Client > Server");

    // set_diagram (no name → active) writes new content.
    const applied = await callTool(port, "set_diagram", { dsl: OTHER_VALID_DSL });
    expect(applied.isError).toBeFalsy();
    expect(applied.content[0].text).toBe("Applied — demo is now v2 (2 nodes, 0 groups, 1 edge).");

    // Disk changed, and a diagram frame with origin "mcp" was broadcast.
    expect(readFileSync(filePath, "utf8")).toBe(OTHER_VALID_DSL);
    const mcpFrame = messages.find((m) => m.kind === "diagram" && m.origin === "mcp");
    expect(mcpFrame).toMatchObject({ kind: "diagram", name: "demo", version: 2, origin: "mcp" });

    // get_diagram now returns the new DSL at the bumped version.
    const second = await callTool(port, "get_diagram");
    expect(second.content[0].text).toContain("(v2)");
    expect(second.content[0].text).toContain("Alpha > Beta");
  });

  it("set_diagram with a syntax error writes nothing and lists each error", async () => {
    const dir = makeTempDir();
    const filePath = path.join(dir, "demo.arch");
    writeFileSync(filePath, VALID_DEMO_DSL);
    const { port, watcher } = await startServer(dir);

    const result = await callTool(port, "set_diagram", { dsl: "Client >" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("line ");
    expect(result.content[0].text).toContain("Fix the DSL and call set_diagram again.");

    // File untouched, version untouched.
    expect(readFileSync(filePath, "utf8")).toBe(VALID_DEMO_DSL);
    expect(watcher.getState().versions.get("demo")).toBe(1);
  });

  it("set_diagram creates a new named diagram then applies the DSL", async () => {
    const dir = makeTempDir();
    const { port, watcher } = await startServer(dir);

    const result = await callTool(port, "set_diagram", { name: "checkout", dsl: OTHER_VALID_DSL });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Applied — checkout is now v");
    expect(result.content[0].text).toContain("2 nodes");

    expect(readdirSync(dir)).toContain("checkout.arch");
    expect(readFileSync(path.join(dir, "checkout.arch"), "utf8")).toBe(OTHER_VALID_DSL);
    expect(watcher.getState().active).toBe("checkout");
  });

  it("get_diagram reports an empty workspace with an open_diagram hint", async () => {
    const { port } = await startServer(makeTempDir());

    const result = await callTool(port, "get_diagram");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No diagram is open");
    expect(result.content[0].text).toContain("open_diagram");
  });

  it("set_diagram does not re-broadcast when the fs echo of its own write lands", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { port, messages } = await startServer(dir);

    await callTool(port, "set_diagram", { dsl: OTHER_VALID_DSL });
    const mcpFrames = () => messages.filter((m) => m.kind === "diagram" && m.origin === "mcp");
    expect(mcpFrames()).toHaveLength(1);
    // Count all demo frames now (initial v1 file scan + this v2 mcp write) so we
    // can prove the fs echo adds nothing.
    const framesAfterSet = messages.filter((m) => m.kind === "diagram" && m.name === "demo").length;

    // Wait past the fs-watcher debounce; the echo of set_diagram's own write
    // must be suppressed (no extra frame, no version drift).
    await new Promise((r) => setTimeout(r, 400));
    expect(mcpFrames()).toHaveLength(1);
    expect(messages.filter((m) => m.kind === "diagram" && m.name === "demo").length).toBe(framesAfterSet);
  });
});
