/**
 * Tests for the headless-fallback RETRY after a broker timeout (DGC-84).
 *
 * The DGC-82 fallback only fired when `clientCount() === 0`. Dogfooding hit a
 * gap: a stale browser tab reconnects after a server restart but is throttled
 * by macOS/Chrome (backgrounded tab), so `clientCount() > 0` — the fallback is
 * SKIPPED, the tab never answers, and the tool dies by broker timeout. The
 * caller (agent pipeline) is stuck exactly as before DGC-82.
 *
 * Fix: after the broker times out, if a headless `ensureClient` is wired, bring
 * up the hidden canvas and retry EXACTLY ONCE with a fresh request id. This
 * file drives the two tools over real JSON-RPC (like headless-fallback.test.ts)
 * with a genuinely SILENT `ws` client connected so `clientCount() > 0`, and an
 * `ensureClient` fake that connects a second `ws` canvas which does answer —
 * standing in for the hidden headless-Chrome page.
 */
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import {
  parseServerMessage,
  serializeMessage,
  type SnapshotResponseMessage,
} from "@diagram-copilot/core";
import { createMcpHandler, type McpInfo } from "../src/mcp/handler.js";
import { createSnapshotBroker } from "../src/mcp/snapshot-broker.js";
import type { SnapshotOps } from "../src/mcp/tools/snapshot.js";
import type { WorkspaceOps } from "../src/workspace/watcher.js";
import { createServer, WS_PATH, type ServerHandle } from "../src/server.js";

/** A real 1×1 PNG so IHDR sniffing and byte-writing have something true to read. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

const TEST_TIMEOUT_MS = 300;

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

function mktemp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dgc-headless-retry-"));
  tempDirs.add(dir);
  return dir;
}

/** A stub workspace that only answers `read` (export uses it for the version). */
const stubWorkspace = { read: () => ({ ok: true, version: 7 }) } as unknown as WorkspaceOps;

/** Server wired like the CLI entry, plus the injected `ensureClient` fake. */
async function startServer(opts: {
  ensureClient?: SnapshotOps["ensureClient"];
  exportDir?: string;
}): Promise<{ port: number }> {
  const broker = createSnapshotBroker();
  const server: ServerHandle = createServer({
    port: 0,
    mcpHandler: createMcpHandler({
      getInfo: () => TEST_INFO,
      getWorkspace: () => stubWorkspace,
      snapshot: {
        broker,
        broadcast: (message) => server.broadcast(message),
        clientCount: () => server.clients.size,
        getActive: () => TEST_INFO.active,
        timeoutMs: TEST_TIMEOUT_MS,
        ensureClient: opts.ensureClient,
      },
      exportPaths: opts.exportDir ? { dir: opts.exportDir, roots: [] } : undefined,
    }),
    onSnapshotResponse: (message) => void broker.resolve(message),
  });
  openServers.add(server);
  const { port } = await server.start();
  return { port };
}

/**
 * Connect a real WS client that stays SILENT — it makes `clientCount() > 0`
 * but never answers a `snapshot-request`, exactly like the throttled zombie
 * tab from the dogfood repro.
 */
async function connectSilentClient(port: number): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  openSockets.add(socket);
  // Deliberately no "message" handler — receive frames and ignore them.
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
}

/** Connect a real WS canvas that answers snapshot-requests for `showing`. */
async function connectCanvas(port: number, showing: string): Promise<void> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  openSockets.add(socket);
  socket.on("message", (data) => {
    const result = parseServerMessage(data.toString());
    if (!result.ok || result.message.kind !== "snapshot-request") return;
    if (result.message.name !== showing) return;
    const response: SnapshotResponseMessage = {
      kind: "snapshot-response",
      id: result.message.id,
      name: result.message.name,
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

async function callTool(port: number, name: string, args: Record<string, unknown> = {}) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.result as { isError?: boolean; content: Array<{ type: string; text?: string }> };
}

describe("get_snapshot headless retry after broker timeout (DGC-84)", () => {
  it("retries via headless EXACTLY ONCE when a connected client stays silent", async () => {
    let port = 0;
    const ensureClient = vi.fn(async (target: string) => {
      await connectCanvas(port, target); // the hidden headless page appears + answers
      return { ok: true as const };
    });
    ({ port } = await startServer({ ensureClient }));
    await connectSilentClient(port); // zombie tab: clientCount>0 but never answers

    const result = await callTool(port, "get_snapshot");

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: "image" });
    // Exactly one retry — ensureClient invoked once, never looped.
    expect(ensureClient).toHaveBeenCalledTimes(1);
    expect(ensureClient).toHaveBeenCalledWith("demo");
  });

  it("keeps the old timeout error verbatim when a silent client is connected but NO fallback is wired", async () => {
    const { port } = await startServer({}); // ensureClient absent
    await connectSilentClient(port);

    const result = await callTool(port, "get_snapshot");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(new RegExp(`${TEST_TIMEOUT_MS}ms`));
    expect(result.content[0].text).toContain("http://localhost:4747");
  });

  it("fails with a headless-tried error and does NOT loop when the retry also times out", async () => {
    let port = 0;
    // "Launches" successfully but connects no answering canvas → retry also times out.
    const ensureClient = vi.fn(async () => ({ ok: true as const }));
    ({ port } = await startServer({ ensureClient }));
    await connectSilentClient(port);

    const result = await callTool(port, "get_snapshot");

    expect(result.isError).toBe(true);
    expect(ensureClient).toHaveBeenCalledTimes(1); // one retry, no loop
    expect(result.content[0].text).toMatch(/headless/i);
    expect(result.content[0].text).toContain("validate_dsl");
  });

  it("surfaces the fallback's own error when ensureClient fails after a silent timeout", async () => {
    let port = 0;
    const ensureClient = vi.fn(async () => ({
      ok: false as const,
      error: "Cannot render headlessly: no Chrome, Chromium or Edge executable was found.",
    }));
    ({ port } = await startServer({ ensureClient }));
    await connectSilentClient(port);

    const result = await callTool(port, "get_snapshot");

    expect(result.isError).toBe(true);
    expect(ensureClient).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain("no Chrome");
  });

  it("takes the fast path (no ensureClient) when a connected client answers in time", async () => {
    let port = 0;
    const ensureClient = vi.fn(async () => ({ ok: true as const }));
    ({ port } = await startServer({ ensureClient }));
    await connectCanvas(port, "demo"); // real, responsive client

    const result = await callTool(port, "get_snapshot");

    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: "image" });
    expect(ensureClient).not.toHaveBeenCalled();
  });
});

describe("export_diagram headless retry after broker timeout (DGC-84)", () => {
  it("retries via headless and writes the PNG when a connected client stays silent", async () => {
    const exportDir = mktemp();
    let port = 0;
    const ensureClient = vi.fn(async (target: string) => {
      await connectCanvas(port, target);
      return { ok: true as const };
    });
    ({ port } = await startServer({ ensureClient, exportDir }));
    await connectSilentClient(port);

    const result = await callTool(port, "export_diagram");

    expect(result.isError).toBeFalsy();
    const expected = path.join(exportDir, "demo-v7.png");
    expect(result.content[0].text).toContain(expected);
    expect(existsSync(expected)).toBe(true);
    expect(ensureClient).toHaveBeenCalledTimes(1);
    expect(ensureClient).toHaveBeenCalledWith("demo");
  });

  it("keeps the old timeout error verbatim when a silent client is connected but NO fallback is wired", async () => {
    const { port } = await startServer({ exportDir: mktemp() });
    await connectSilentClient(port);

    const result = await callTool(port, "export_diagram");

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(new RegExp(`${TEST_TIMEOUT_MS}ms`));
    expect(result.content[0].text).toContain("http://localhost:4747");
  });

  it("fails with a headless-tried error and does NOT loop when the retry also times out", async () => {
    let port = 0;
    const ensureClient = vi.fn(async () => ({ ok: true as const }));
    ({ port } = await startServer({ ensureClient, exportDir: mktemp() }));
    await connectSilentClient(port);

    const result = await callTool(port, "export_diagram");

    expect(result.isError).toBe(true);
    expect(ensureClient).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toMatch(/headless/i);
    expect(result.content[0].text).toContain("validate_dsl");
  });
});
