/**
 * E2E tests for the `get_snapshot` MCP tool (T24 / DGC-44), driven the same
 * way as mcp-tools.test.ts — real JSON-RPC over `/mcp` on an ephemeral port —
 * plus REAL `ws` clients standing in for the web canvas: they receive the
 * broadcast `snapshot-request` and answer with a `snapshot-response`, which
 * the hub routes to the shared broker exactly like the CLI wiring.
 */
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import {
  parseServerMessage,
  serializeMessage,
  type SnapshotRequestMessage,
  type SnapshotResponseMessage,
} from "@diagram-copilot/core";
import { createMcpHandler, type McpInfo } from "../src/mcp/handler.js";
import { createSnapshotBroker, type SnapshotBroker } from "../src/mcp/snapshot-broker.js";
import { pngDimensions } from "../src/mcp/tools/snapshot.js";
import { createServer, WS_PATH, type ServerHandle } from "../src/server.js";

/** A real 1×1 PNG so the tool's IHDR sniffing has something true to read. */
const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

/** Short broker timeout so the timeout test doesn't wait out the real 5s. */
const TEST_TIMEOUT_MS = 400;

const TEST_INFO: McpInfo = {
  version: "1.2.3",
  workspaceDir: "/tmp/dgc-workspace",
  active: "demo",
};

const openServers = new Set<ServerHandle>();
const openSockets = new Set<WebSocket>();

afterEach(async () => {
  for (const socket of openSockets) socket.close();
  openSockets.clear();
  await Promise.all([...openServers].map((server) => server.stop()));
  openServers.clear();
});

/** Server wired exactly like the CLI entry: broker shared between the MCP tool and the hub route. */
async function startSnapshotServer(): Promise<{ port: number; broker: SnapshotBroker }> {
  const broker = createSnapshotBroker();
  const server: ServerHandle = createServer({
    port: 0,
    mcpHandler: createMcpHandler({
      getInfo: () => TEST_INFO,
      snapshot: {
        broker,
        broadcast: (message) => server.broadcast(message),
        clientCount: () => server.clients.size,
        getActive: () => TEST_INFO.active,
        timeoutMs: TEST_TIMEOUT_MS,
      },
    }),
    onSnapshotResponse: (message) => void broker.resolve(message),
  });
  openServers.add(server);
  const { port } = await server.start();
  return { port, broker };
}

/**
 * A fake canvas client: connects over real WS and mimics the web
 * snapshotResponder — answers `snapshot-request` frames for `showing` (and
 * stays SILENT for any other name, per protocol contract), using `reply` to
 * shape the response. Records every request it saw.
 */
async function connectCanvas(
  port: number,
  showing: string,
  reply: (request: SnapshotRequestMessage) => Partial<SnapshotResponseMessage> = () => ({
    ok: true,
    dataUrl: TINY_PNG_DATA_URL,
  }),
): Promise<{ requests: SnapshotRequestMessage[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}${WS_PATH}`);
  openSockets.add(socket);
  const requests: SnapshotRequestMessage[] = [];
  socket.on("message", (data) => {
    const result = parseServerMessage(data.toString());
    if (!result.ok || result.message.kind !== "snapshot-request") return;
    const request = result.message;
    requests.push(request);
    if (request.name !== showing) return; // silent — not our diagram
    socket.send(
      serializeMessage({
        kind: "snapshot-response",
        id: request.id,
        name: request.name,
        ok: true,
        dataUrl: TINY_PNG_DATA_URL,
        ...reply(request),
      }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { requests };
}

function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

interface ToolContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** tools/call over the wire, returning the raw JSON-RPC `result`. */
async function callGetSnapshot(port: number, args: Record<string, unknown> = {}) {
  const response = await post(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "get_snapshot", arguments: args },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.result as { isError?: boolean; content: ToolContent[] };
}

describe("get_snapshot over /mcp", () => {
  it("is advertised in tools/list when snapshot ops are wired", async () => {
    const { port } = await startSnapshotServer();

    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);

    expect(names).toContain("get_snapshot");
  });

  it("returns the canvas-rendered PNG as MCP image content plus a text receipt", async () => {
    const { port, broker } = await startSnapshotServer();
    const canvas = await connectCanvas(port, "demo");

    const result = await callGetSnapshot(port); // no name → active ("demo")

    expect(result.isError).toBeFalsy();
    const [image, text] = result.content;
    expect(image).toMatchObject({ type: "image", data: TINY_PNG_BASE64, mimeType: "image/png" });
    expect(text.type).toBe("text");
    expect(text.text).toContain('"demo"');
    expect(text.text).toContain("1×1px"); // IHDR of the real 1×1 PNG
    // The broadcast carried the correlation id + resolved active name.
    expect(canvas.requests).toHaveLength(1);
    expect(canvas.requests[0]).toMatchObject({ kind: "snapshot-request", name: "demo" });
    expect(canvas.requests[0].id).not.toBe("");
    // Nothing left pending after settlement (leak check, resolution path).
    expect(broker.pendingCount).toBe(0);
  });

  it("targets a specific diagram when `name` is passed", async () => {
    const { port } = await startSnapshotServer();
    const canvas = await connectCanvas(port, "other");

    const result = await callGetSnapshot(port, { name: "other" });

    expect(result.isError).toBeFalsy();
    expect(canvas.requests[0]).toMatchObject({ name: "other" });
    expect(result.content[1].text).toContain('"other"');
  });

  it("fails fast with an 'open the canvas' error when NO client is connected", async () => {
    const { port } = await startSnapshotServer();

    const result = await callGetSnapshot(port);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("http://localhost:4747");
  });

  it("times out with a clear error when no client is showing the requested diagram", async () => {
    const { port, broker } = await startSnapshotServer();
    await connectCanvas(port, "something-else"); // connected, but stays silent

    const result = await callGetSnapshot(port);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(new RegExp(`${TEST_TIMEOUT_MS}ms`));
    expect(result.content[0].text).toContain("http://localhost:4747");
    // Nothing left pending after the timeout (leak check, timeout path).
    expect(broker.pendingCount).toBe(0);
  });

  it("surfaces a client-side capture failure as a tool error", async () => {
    const { port } = await startSnapshotServer();
    await connectCanvas(port, "demo", () => ({
      ok: false,
      dataUrl: undefined,
      error: "canvas viewport not found",
    }));

    const result = await callGetSnapshot(port);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("canvas viewport not found");
  });

  it("first response wins when two clients show the same diagram", async () => {
    const { port } = await startSnapshotServer();
    await connectCanvas(port, "demo");
    await connectCanvas(port, "demo");

    const result = await callGetSnapshot(port);

    // One of the two answered first; the duplicate was dropped by the broker
    // without disturbing the settled result.
    expect(result.isError).toBeFalsy();
    expect(result.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
  });
});

describe("pngDimensions", () => {
  it("reads width×height from a real PNG IHDR", () => {
    expect(pngDimensions(TINY_PNG_BASE64)).toEqual({ width: 1, height: 1 });
  });

  it("returns null for non-PNG bytes", () => {
    expect(pngDimensions(Buffer.from("definitely not a png").toString("base64"))).toBeNull();
    expect(pngDimensions("")).toBeNull();
  });
});
