/**
 * Notes MCP tools (`get_notes`, `set_notes`, DGC-63) driven over the real
 * `node:http` + Streamable HTTP transport, wired to a real workspace watcher
 * and notes store on a temp dir. Mirrors `diagram-tools.test.ts`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler } from "../src/mcp/handler.js";
import { createServer, type ServerHandle } from "../src/server.js";
import { createNotesStore, NOTES_EXT } from "../src/notes.js";
import { createWorkspaceWatcher, type WorkspaceWatcher } from "../src/workspace/watcher.js";

const VALID_DSL = ["direction right", "", "Client", "Server", "", "Client > Server"].join("\n");

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
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-notes-tools-"));
  openDirs.add(dir);
  return dir;
}

/** Start a real watcher + server on `dir`, wired with a notes store. */
async function startServer(dir: string): Promise<{ port: number; watcher: WorkspaceWatcher }> {
  const watcher = createWorkspaceWatcher({ dir, broadcast: () => {} });
  openWatchers.add(watcher);
  await watcher.start();

  const server = createServer({
    port: 0,
    mcpHandler: createMcpHandler({
      getInfo: () => ({ version: "1.0.0", workspaceDir: dir, active: watcher.getState().active }),
      getWorkspace: () => watcher,
      notes: createNotesStore(dir),
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

describe("notes tools over /mcp", () => {
  it("advertises get_notes and set_notes in tools/list", async () => {
    const { port } = await startServer(makeTempDir());

    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("get_notes");
    expect(names).toContain("set_notes");
  });

  it("set_notes (active default) writes <name>.notes.md; get_notes reads it back", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DSL);
    const { port } = await startServer(dir);

    const saved = await callTool(port, "set_notes", { markdown: "why a queue: absorb the spike" });
    expect(saved.isError).toBeFalsy();
    expect(saved.content[0].text).toContain('Saved notes for "demo"');

    // Landed on disk as a `.notes.md` sidecar, not an `.arch` file.
    expect(readFileSync(path.join(dir, `demo${NOTES_EXT}`), "utf8")).toBe("why a queue: absorb the spike");

    const read = await callTool(port, "get_notes");
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toContain("why a queue: absorb the spike");
  });

  it("set_notes targets a named diagram; get_notes reads that same name", async () => {
    const dir = makeTempDir();
    const { port } = await startServer(dir);

    await callTool(port, "set_notes", { name: "checkout", markdown: "idempotency keys on retry" });
    expect(readFileSync(path.join(dir, `checkout${NOTES_EXT}`), "utf8")).toBe("idempotency keys on retry");

    const read = await callTool(port, "get_notes", { name: "checkout" });
    expect(read.content[0].text).toContain("idempotency keys on retry");
  });

  it("get_notes reports empty notes with a set_notes hint", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DSL);
    const { port } = await startServer(dir);

    const read = await callTool(port, "get_notes");
    expect(read.isError).toBeFalsy();
    expect(read.content[0].text).toMatch(/no notes yet/i);
    expect(read.content[0].text).toContain("set_notes");
  });

  it("does NOT surface notes files in list_diagrams", async () => {
    const dir = makeTempDir();
    writeFileSync(path.join(dir, "demo.arch"), VALID_DSL);
    const { port } = await startServer(dir);

    await callTool(port, "set_notes", { name: "demo", markdown: "some notes" });
    const listed = await callTool(port, "list_diagrams");
    // Exactly the one diagram — the `.notes.md` sidecar is not a diagram.
    expect(listed.content[0].text).toContain("demo");
    expect(listed.content[0].text).not.toContain(NOTES_EXT);
    expect(listed.content[0].text).not.toContain("notes");
  });
});
