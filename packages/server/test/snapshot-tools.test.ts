/**
 * `snapshot_diagram` MCP tool (DGC-58/T37) driven over the real `node:http` +
 * Streamable HTTP transport, wired to a real workspace watcher on a temp dir.
 * Mirrors the wire-level pattern of `workspace-tools.test.ts` /
 * `diagram-tools.test.ts` (ephemeral port, JSON-RPC POSTs).
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "../src/mcp/handler.js";
import { createServer, type ServerHandle } from "../src/server.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";

const VALID_DEMO_DSL = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");

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
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-snapshot-tools-"));
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

describe("snapshot_diagram over /mcp", () => {
  it("advertises snapshot_diagram in tools/list", async () => {
    const { port } = await startServer(makeTempDir());

    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("snapshot_diagram");
  });

  it("snapshots the active diagram twice into step1/step2 with correct content, leaving active unchanged", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { port, watcher } = await startServer(dir);
    expect(watcher.getState().active).toBe("demo");

    const first = await callTool(port, "snapshot_diagram");
    expect(first.isError).toBeFalsy();
    expect(first.content[0].text).toBe('Snapshotted demo v1 → demo.step1 ("step 1")');
    expect(watcher.getState().active).toBe("demo");
    expect(readdirSync(dir)).toContain("demo.step1.arch");
    const step1 = readFileSync(path.join(dir, "demo.step1.arch"), "utf8");
    expect(step1).toBe(`// snapshot v1 — step 1\n${VALID_DEMO_DSL}`);

    const second = await callTool(port, "snapshot_diagram");
    expect(second.isError).toBeFalsy();
    expect(second.content[0].text).toMatch(/^Snapshotted demo v\d+ → demo\.step2 \("step 2"\)$/);
    expect(watcher.getState().active).toBe("demo");
    expect(readdirSync(dir)).toContain("demo.step2.arch");
    const step2 = readFileSync(path.join(dir, "demo.step2.arch"), "utf8");
    expect(step2).toMatch(/^\/\/ snapshot v\d+ — step 2\n/);
    // Source DSL body carried over verbatim (only the header line differs).
    expect(step2.slice(step2.indexOf("\n") + 1)).toBe(VALID_DEMO_DSL);

    // Both diagrams now exist in the workspace listing.
    const list = await callTool(port, "list_diagrams");
    expect(list.content[0].text).toContain("demo.step1");
    expect(list.content[0].text).toContain("demo.step2");
  });

  it("snapshotting a step chains off the same base instead of nesting", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { port, watcher } = await startServer(dir);

    const stepOne = await callTool(port, "snapshot_diagram");
    expect(stepOne.content[0].text).toContain("→ demo.step1");

    const stepTwo = await callTool(port, "snapshot_diagram", { name: "demo.step1" });
    expect(stepTwo.isError).toBeFalsy();
    expect(stepTwo.content[0].text).toBe('Snapshotted demo.step1 v1 → demo.step2 ("step 2")');
    expect(readdirSync(dir)).toContain("demo.step2.arch");
    // Active is restored to whatever was active before this call (demo), not
    // left on the just-read step nor the newly created step.
    expect(watcher.getState().active).toBe("demo");
  });

  it("records a custom label in the snapshot header comment", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { port } = await startServer(dir);

    const result = await callTool(port, "snapshot_diagram", { label: "add cache layer" });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe('Snapshotted demo v1 → demo.step1 ("add cache layer")');

    const content = readFileSync(path.join(dir, "demo.step1.arch"), "utf8");
    expect(content.split("\n")[0]).toBe("// snapshot v1 — add cache layer");
  });

  it("errors clearly when the named diagram does not exist", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DEMO_DSL);
    const { port } = await startServer(dir);

    const result = await callTool(port, "snapshot_diagram", { name: "missing" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('"missing"');
    expect(result.content[0].text).toContain("does not exist");
    expect(readdirSync(dir)).not.toContain("missing.step1.arch");
  });

  it("errors clearly when the workspace is empty and no name is given", async () => {
    const { port } = await startServer(makeTempDir());

    const result = await callTool(port, "snapshot_diagram");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No diagram is open");
  });
});
