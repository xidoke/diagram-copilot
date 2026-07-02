/**
 * `edit_diagram` (DGC-72) driven over the real `node:http` + Streamable HTTP
 * transport, wired to a real workspace watcher on a temp dir — the same
 * harness as `diagram-tools.test.ts`. The heart of these tests is the
 * byte-survival assertion: after a surgical op, every line the op did not
 * touch (including Vietnamese comments) must be byte-identical on disk.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMessage } from "@diagram-copilot/core";
import { createMcpHandler } from "../src/mcp/handler.js";
import { createServer, type ServerHandle } from "../src/server.js";
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
  const dir = mkdtempSync(path.join(tmpdir(), "dgc-edit-tool-"));
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

/** Seed `demo.arch` with the commented fixture and start everything. */
async function startWithDemo() {
  const dir = makeTempDir();
  const filePath = path.join(dir, "demo.arch");
  writeFileSync(filePath, COMMENTED_DSL);
  const started = await startServer(dir);
  return { ...started, dir, filePath };
}

describe("edit_diagram over /mcp", () => {
  it("is advertised in tools/list alongside get/set_diagram", async () => {
    const { port } = await startWithDemo();

    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("edit_diagram");
  });

  it("add_node places the node inside its group and touches no other line", async () => {
    const { port, filePath } = await startWithDemo();
    const before = readFileSync(filePath, "utf8").split("\n");

    const result = await callTool(port, "edit_diagram", {
      ops: [{ op: "add_node", name: "Cache", icon: "redis", color: "red", group: "VPC" }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('Applied 1 edit to "demo" — now v2');
    expect(result.content[0].text).toContain('1. add_node "Cache" in group "VPC"');

    const after = readFileSync(filePath, "utf8").split("\n");
    // Exactly one line was inserted (inside the VPC block, before its `}`).
    expect(after).toHaveLength(before.length + 1);
    const inserted = after.indexOf("  Cache [icon: redis, color: red]");
    expect(inserted).toBeGreaterThan(after.indexOf("VPC [color: gray] {"));
    expect(inserted).toBeLessThan(after.indexOf("}"));
    // Every original line survives byte-for-byte, in order.
    expect([...after.slice(0, inserted), ...after.slice(inserted + 1)]).toEqual(before);
  });

  it("add_edge appends one edge statement and keeps the rest byte-identical", async () => {
    const { port, filePath } = await startWithDemo();
    const before = readFileSync(filePath, "utf8");

    const result = await callTool(port, "edit_diagram", {
      ops: [{ op: "add_edge", from: "API", to: "Client", label: "push" }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("1. add_edge API > Client: push");

    const after = readFileSync(filePath, "utf8");
    expect(after).toBe(`${before}\nAPI > Client: push`);
  });

  it("rename rewrites the declaration AND every referencing edge, keeping trailing comments", async () => {
    const { port, filePath } = await startWithDemo();
    const before = readFileSync(filePath, "utf8").split("\n");

    const result = await callTool(port, "edit_diagram", {
      ops: [{ op: "rename", id: "DB", new_name: "Postgres" }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('1. rename "DB" -> "Postgres"');

    const after = readFileSync(filePath, "utf8").split("\n");
    expect(after).toHaveLength(before.length);
    // The two lines mentioning DB were rewritten with the new name; the
    // declaration's Vietnamese trailing comment travels along.
    expect(after).toContain("  Postgres [icon: postgresql]  // dữ liệu chính");
    expect(after).toContain("API > Postgres: reads");
    // Every line that never mentioned DB is byte-identical, same position.
    before.forEach((line, i) => {
      if (line.includes("DB")) return;
      expect(after[i]).toBe(line);
    });
  });

  it("set_attr sets a value, and value null removes the attribute", async () => {
    const { port, filePath } = await startWithDemo();

    const set = await callTool(port, "edit_diagram", {
      ops: [{ op: "set_attr", id: "API", key: "color", value: "orange" }],
    });
    expect(set.isError).toBeFalsy();
    expect(set.content[0].text).toContain('1. set_attr "API" color = "orange"');
    expect(readFileSync(filePath, "utf8")).toContain("  API [icon: server, color: orange]");

    const clear = await callTool(port, "edit_diagram", {
      ops: [{ op: "set_attr", id: "Client", key: "icon", value: null }],
    });
    expect(clear.isError).toBeFalsy();
    expect(clear.content[0].text).toContain('1. set_attr "Client" icon removed');
    const after = readFileSync(filePath, "utf8");
    expect(after).not.toContain("icon: monitor");
    // The rewritten line keeps its trailing Vietnamese comment.
    expect(after).toContain("Client   // máy người dùng");
  });

  it("move_to_group moves into a group and back to root (group: null)", async () => {
    const { port, filePath } = await startWithDemo();

    const into = await callTool(port, "edit_diagram", {
      ops: [{ op: "move_to_group", id: "Client", group: "VPC" }],
    });
    expect(into.isError).toBeFalsy();
    expect(into.content[0].text).toContain('1. move_to_group "Client" -> "VPC"');
    let lines = readFileSync(filePath, "utf8").split("\n");
    let clientLine = lines.findIndex((l) => l.includes("Client [icon: monitor]"));
    expect(clientLine).toBeGreaterThan(lines.indexOf("VPC [color: gray] {"));
    expect(clientLine).toBeLessThan(lines.indexOf("}"));
    // The declaration's trailing comment moved with it.
    expect(lines[clientLine]).toContain("// máy người dùng");

    const toRoot = await callTool(port, "edit_diagram", {
      ops: [{ op: "move_to_group", id: "Client", group: null }],
    });
    expect(toRoot.isError).toBeFalsy();
    expect(toRoot.content[0].text).toContain('1. move_to_group "Client" -> root');
    lines = readFileSync(filePath, "utf8").split("\n");
    clientLine = lines.findIndex((l) => l.includes("Client [icon: monitor]"));
    expect(lines[clientLine]).not.toMatch(/^ /); // back at root indentation
  });

  it("remove drops the node together with every edge referencing it", async () => {
    const { port, filePath } = await startWithDemo();

    const result = await callTool(port, "edit_diagram", {
      ops: [{ op: "remove", id: "DB" }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('1. remove "DB"');
    expect(result.content[0].text).toContain("2 nodes, 1 group, 1 edge");

    const after = readFileSync(filePath, "utf8");
    expect(after).not.toContain("DB");
    expect(after).not.toContain("API > DB: reads");
    // Unrelated comment lines survive.
    expect(after).toContain("// Sơ đồ kiến trúc — chú thích của Đô, đừng xoá!");
    expect(after).toContain("Client > API: HTTPS      // đi qua CDN");
  });

  it("applies a chain of ops in order with ONE version bump and ONE mcp broadcast", async () => {
    const { port, filePath, watcher, messages } = await startWithDemo();

    const result = await callTool(port, "edit_diagram", {
      ops: [
        { op: "add_node", name: "Cache", icon: "redis", group: "VPC" },
        { op: "add_edge", from: "API", to: "Cache", label: "cache-aside" },
        { op: "set_attr", id: "Cache", key: "color", value: "red" },
        { op: "rename", id: "Cache", new_name: "Redis" },
      ],
    });
    expect(result.isError).toBeFalsy();
    const receipt = result.content[0].text;
    expect(receipt).toContain('Applied 4 edits to "demo" — now v2 (4 nodes, 1 group, 3 edges):');
    expect(receipt).toContain('1. add_node "Cache" in group "VPC"');
    expect(receipt).toContain("2. add_edge API > Cache: cache-aside");
    expect(receipt).toContain('3. set_attr "Cache" color = "red"');
    expect(receipt).toContain('4. rename "Cache" -> "Redis"');

    const after = readFileSync(filePath, "utf8");
    expect(after).toContain("  Redis [icon: redis, color: red]");
    expect(after).toContain("API > Redis: cache-aside");

    // One write: version went 1 → 2 and exactly one origin-mcp frame went out.
    expect(watcher.getState().versions.get("demo")).toBe(2);
    const mcpFrames = messages.filter((m) => m.kind === "diagram" && m.origin === "mcp");
    expect(mcpFrames).toHaveLength(1);
    expect(mcpFrames[0]).toMatchObject({ kind: "diagram", name: "demo", version: 2, origin: "mcp" });
  });

  it("is all-or-nothing: a failing middle op aborts with its index and writes NOTHING", async () => {
    const { port, filePath, watcher, messages } = await startWithDemo();

    const result = await callTool(port, "edit_diagram", {
      ops: [
        { op: "add_node", name: "Cache", group: "VPC" }, // would succeed
        { op: "rename", id: "Ghost", new_name: "Phantom" }, // unknown id → fails
        { op: "remove", id: "DB" }, // never reached
      ],
    });
    expect(result.isError).toBe(true);
    const message = result.content[0].text;
    expect(message).toContain("failed at op 2 of 3 (rename)");
    expect(message).toContain('no node or group with id "Ghost"');
    expect(message).toContain("nothing was written");
    // Unknown id → the error suggests get_diagram to list current ids.
    expect(message).toContain("get_diagram");

    // Disk bytes, version, and broadcasts are all untouched.
    expect(readFileSync(filePath, "utf8")).toBe(COMMENTED_DSL);
    expect(watcher.getState().versions.get("demo")).toBe(1);
    expect(messages.filter((m) => m.kind === "diagram" && m.origin === "mcp")).toHaveLength(0);
  });

  it("targets a diagram by name and refuses names that do not exist", async () => {
    const { port, dir } = await startWithDemo();
    const otherPath = path.join(dir, "other.arch");
    writeFileSync(otherPath, "Alpha\nBeta\n\nAlpha > Beta");
    // Let the watcher pick up the new file before editing it by name.
    await new Promise((r) => setTimeout(r, 400));

    const ok = await callTool(port, "edit_diagram", {
      name: "other",
      ops: [{ op: "add_edge", from: "Beta", to: "Alpha", label: "ack" }],
    });
    expect(ok.isError).toBeFalsy();
    expect(readFileSync(otherPath, "utf8")).toContain("Beta > Alpha: ack");

    const missing = await callTool(port, "edit_diagram", {
      name: "nope",
      ops: [{ op: "remove", id: "Alpha" }],
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain("list_diagrams");
  });

  it("reports a pure no-op (rename to the same name) without bumping the version", async () => {
    const { port, filePath, watcher } = await startWithDemo();

    const result = await callTool(port, "edit_diagram", {
      ops: [{ op: "rename", id: "DB", new_name: "DB" }],
    });
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No changes");
    expect(result.content[0].text).toContain("still v1");
    expect(readFileSync(filePath, "utf8")).toBe(COMMENTED_DSL);
    expect(watcher.getState().versions.get("demo")).toBe(1);
  });
});
