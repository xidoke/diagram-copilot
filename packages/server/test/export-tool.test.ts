/**
 * Tests for the `export_diagram` MCP tool (F2 / DGC-62).
 *
 * E2E half: driven like snapshot-tool.test.ts — real JSON-RPC over `/mcp` plus
 * a REAL `ws` client standing in for the web canvas (it answers the broadcast
 * `snapshot-request` with a PNG data URL). The server is wired with snapshot
 * ops + a stub workspace (for the version stamp) + export destinations.
 *
 * Unit half: `resolveExportDestination` / `expandTilde` directly, covering the
 * whitelist + `~` expansion + dir-vs-file branches without touching the home
 * directory on disk.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseServerMessage,
  serializeMessage,
  type SnapshotRequestMessage,
  type SnapshotResponseMessage,
} from "@diagram-copilot/core";
import { WebSocket } from "ws";
import { createMcpHandler, type McpInfo } from "../src/mcp/handler.js";
import { createSnapshotBroker } from "../src/mcp/snapshot-broker.js";
import { expandTilde, resolveExportDestination } from "../src/mcp/tools/export-file.js";
import type { WorkspaceOps } from "../src/workspace/watcher.js";
import { createServer, WS_PATH, type ServerHandle } from "../src/server.js";

/** A real 1×1 PNG so IHDR sniffing and byte-writing have something true to read. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;
const TINY_PNG_BYTES = Buffer.from(TINY_PNG_BASE64, "base64");

const TEST_TIMEOUT_MS = 400;
const TEST_VERSION = 4;

const TEST_INFO: McpInfo = {
  version: "1.2.3",
  workspaceDir: "/tmp/dgc-workspace",
  active: "demo",
};

const openServers = new Set<ServerHandle>();
const openSockets = new Set<WebSocket>();
const tempDirs = new Set<string>();

afterEach(async () => {
  for (const socket of openSockets) socket.close();
  openSockets.clear();
  await Promise.all([...openServers].map((server) => server.stop()));
  openServers.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function mktemp(prefix = "dgc-export-"): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

/** A stub workspace that only answers `read` (the tool uses it for the version). */
function stubWorkspace(version = TEST_VERSION): WorkspaceOps {
  return {
    read: () => ({ ok: true, version }),
  } as unknown as WorkspaceOps;
}

/** Server wired like the CLI entry: shared broker, stub workspace, export config. */
async function startExportServer(opts: {
  exportDir: string;
  roots: string[];
  workspace?: WorkspaceOps | null;
}): Promise<{ port: number }> {
  const broker = createSnapshotBroker();
  const server: ServerHandle = createServer({
    port: 0,
    mcpHandler: createMcpHandler({
      getInfo: () => TEST_INFO,
      getWorkspace: () => (opts.workspace === undefined ? stubWorkspace() : opts.workspace),
      snapshot: {
        broker,
        broadcast: (message) => server.broadcast(message),
        clientCount: () => server.clients.size,
        getActive: () => TEST_INFO.active,
        timeoutMs: TEST_TIMEOUT_MS,
      },
      exportPaths: { dir: opts.exportDir, roots: opts.roots },
    }),
    onSnapshotResponse: (message) => void broker.resolve(message),
  });
  openServers.add(server);
  const { port } = await server.start();
  return { port };
}

/** A fake canvas: answers `snapshot-request` frames for `showing` with a PNG. */
async function connectCanvas(port: number, showing: string): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  openSockets.add(socket);
  socket.on("message", (data) => {
    const result = parseServerMessage(data.toString());
    if (!result.ok || result.message.kind !== "snapshot-request") return;
    const request = result.message as SnapshotRequestMessage;
    if (request.name !== showing) return; // silent — not our diagram
    const response: SnapshotResponseMessage = {
      kind: "snapshot-response",
      id: request.id,
      name: request.name,
      ok: true,
      dataUrl: TINY_PNG_DATA_URL,
    };
    socket.send(serializeMessage(response));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

async function callExport(port: number, args: Record<string, unknown> = {}) {
  const response = await post(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "export_diagram", arguments: args },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
}

describe("export_diagram over /mcp", () => {
  it("is advertised in tools/list when snapshot + workspace + export are wired", async () => {
    const { port } = await startExportServer({ exportDir: mktemp(), roots: [] });
    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("export_diagram");
  });

  it("saves to the default export dir as <name>-v<version>.png when no path is given", async () => {
    const exportDir = mktemp();
    const { port } = await startExportServer({ exportDir, roots: [] });
    await connectCanvas(port, "demo");

    const result = await callExport(port); // no name → active ("demo"), no path → default dir

    expect(result.isError).toBeFalsy();
    const expected = path.join(exportDir, `demo-v${TEST_VERSION}.png`);
    expect(result.content[0].text).toContain(expected);
    expect(existsSync(expected)).toBe(true);
    expect(readFileSync(expected)).toEqual(TINY_PNG_BYTES);
  });

  it("saves into a whitelisted custom directory", async () => {
    const exportDir = mktemp();
    const customDir = mktemp("dgc-vault-");
    const { port } = await startExportServer({ exportDir, roots: [customDir] });
    await connectCanvas(port, "demo");

    const result = await callExport(port, { path: customDir });

    expect(result.isError).toBeFalsy();
    const expected = path.join(customDir, `demo-v${TEST_VERSION}.png`);
    expect(existsSync(expected)).toBe(true);
    expect(result.content[0].text).toContain(expected);
  });

  it("uses a *.png file path verbatim when inside a whitelisted root", async () => {
    const exportDir = mktemp();
    const customDir = mktemp("dgc-vault-");
    const { port } = await startExportServer({ exportDir, roots: [customDir] });
    await connectCanvas(port, "demo");

    const file = path.join(customDir, "architecture.png");
    const result = await callExport(port, { path: file });

    expect(result.isError).toBeFalsy();
    expect(existsSync(file)).toBe(true);
    expect(result.content[0].text).toContain(file);
  });

  it("refuses a path outside every whitelisted root and writes nothing", async () => {
    const exportDir = mktemp();
    const allowed = mktemp("dgc-vault-");
    const outside = mktemp("dgc-outside-");
    const { port } = await startExportServer({ exportDir, roots: [allowed] });
    await connectCanvas(port, "demo");

    const result = await callExport(port, { path: outside });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/outside the allowed export roots/i);
    // Lists the roots (exportDir is always whitelisted, plus the explicit one).
    expect(result.content[0].text).toContain(exportDir);
    expect(result.content[0].text).toContain(allowed);
    // Nothing landed in the rejected directory.
    expect(existsSync(path.join(outside, `demo-v${TEST_VERSION}.png`))).toBe(false);
  });

  it("fails fast with an 'open the canvas' error when NO client is connected", async () => {
    const { port } = await startExportServer({ exportDir: mktemp(), roots: [] });

    const result = await callExport(port);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("http://localhost:4747");
  });

  it("surfaces a read failure (unknown diagram) as a tool error", async () => {
    const workspace = { read: () => ({ ok: false, version: 0, error: "no such diagram" }) } as unknown as WorkspaceOps;
    const { port } = await startExportServer({ exportDir: mktemp(), roots: [], workspace });
    await connectCanvas(port, "demo");

    const result = await callExport(port, { name: "ghost" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no such diagram");
  });
});

describe("resolveExportDestination (pure)", () => {
  const opts = (roots: string[]) => ({ exportDir: "/tmp/exports", roots, name: "demo", version: 3 });

  it("defaults to <exportDir>/<name>-v<version>.png when path is omitted", () => {
    const dest = resolveExportDestination(undefined, opts([]));
    expect(dest).toEqual({ ok: true, path: path.join("/tmp/exports", "demo-v3.png") });
  });

  it("expands a leading ~ against the home directory and stays inside a ~ root", () => {
    const root = "~/Documents/Vault";
    const dest = resolveExportDestination("~/Documents/Vault/sub", opts([root]));
    expect(dest.ok).toBe(true);
    if (dest.ok) {
      expect(dest.path).toBe(path.join(os.homedir(), "Documents/Vault/sub", "demo-v3.png"));
    }
  });

  it("treats a *.png path as the exact file", () => {
    const root = "/tmp/vault";
    const dest = resolveExportDestination("/tmp/vault/pic.png", opts([root]));
    expect(dest).toEqual({ ok: true, path: "/tmp/vault/pic.png" });
  });

  it("rejects a path outside every root, listing the resolved roots", () => {
    const dest = resolveExportDestination("/etc/passwd.png", opts(["/tmp/vault"]));
    expect(dest.ok).toBe(false);
    if (!dest.ok) {
      expect(dest.error).toMatch(/outside the allowed export roots/i);
      expect(dest.error).toContain("/tmp/vault");
    }
  });
});

describe("expandTilde", () => {
  it("expands ~ and ~/... to the home directory, leaving others untouched", () => {
    expect(expandTilde("~")).toBe(os.homedir());
    expect(expandTilde("~/foo/bar")).toBe(path.join(os.homedir(), "foo/bar"));
    expect(expandTilde("/absolute/path")).toBe("/absolute/path");
    expect(expandTilde("relative/path")).toBe("relative/path");
  });
});
