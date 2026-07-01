/**
 * MCP endpoint tests: drive the real `node:http` server over the wire with
 * JSON-RPC requests per the MCP Streamable HTTP spec — no Claude Code
 * required. Covers initialize, tools/list, tools/call ping, method policy
 * and the unmounted-route fallback.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createMcpHandler, type McpInfo } from "../src/mcp/handler.js";
import { createServer, type ServerHandle } from "../src/server.js";

const openServers = new Set<ServerHandle>();

afterEach(async () => {
  await Promise.all([...openServers].map((server) => server.stop()));
  openServers.clear();
});

const TEST_INFO: McpInfo = {
  version: "1.2.3",
  workspaceDir: "/tmp/dgc-workspace",
  active: "demo",
};

async function startMcpServer(info: McpInfo = TEST_INFO): Promise<number> {
  const server = createServer({
    port: 0,
    mcpHandler: createMcpHandler({ getInfo: () => info }),
  });
  openServers.add(server);
  const { port } = await server.start();
  return port;
}

/** POST a JSON-RPC message to `/mcp` with the Accept header the spec requires. */
function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
}

function initializeRequest(id = 1) {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0.0.0" },
    },
  };
}

describe("/mcp — streamable http endpoint", () => {
  it("answers initialize with the diagram-copilot server identity", async () => {
    const port = await startMcpServer();

    const response = await post(port, initializeRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    // Stateless mode: no session is created, so no session header either.
    expect(response.headers.get("mcp-session-id")).toBeNull();

    const body = await response.json();
    expect(body.id).toBe(1);
    expect(body.error).toBeUndefined();
    expect(body.result.serverInfo).toMatchObject({ name: "diagram-copilot", version: "1.2.3" });
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("lists the ping tool via tools/list", async () => {
    const port = await startMcpServer();

    // Stateless: no prior initialize needed — each POST gets a fresh server.
    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect(response.status).toBe(200);

    const body = await response.json();
    const tools = body.result.tools as Array<{ name: string; inputSchema: unknown }>;
    const ping = tools.find((tool) => tool.name === "ping");
    expect(ping).toBeDefined();
    expect(ping?.inputSchema).toMatchObject({ type: "object" });
  });

  it("answers tools/call ping with live workspace state", async () => {
    const port = await startMcpServer();

    const response = await post(port, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content).toEqual([
      {
        type: "text",
        text: "pong from diagram-copilot v1.2.3 (workspace: /tmp/dgc-workspace, active: demo)",
      },
    ]);
  });

  it("reports the untitled placeholder when the workspace is empty", async () => {
    const port = await startMcpServer({ version: "1.2.3", workspaceDir: "/tmp/empty", active: null });

    const response = await post(port, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "ping", arguments: {} },
    });

    const body = await response.json();
    expect(body.result.content[0].text).toBe(
      "pong from diagram-copilot v1.2.3 (workspace: /tmp/empty, active: untitled)",
    );
  });

  it("rejects GET and DELETE with 405 (stateless: POST only)", async () => {
    const port = await startMcpServer();

    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      const body = await response.json();
      expect(body.error.code).toBe(-32000);
    }
  });

  it("falls through to the static pipeline when no mcp handler is mounted", async () => {
    const server = createServer({ port: 0 });
    openServers.add(server);
    const { port } = await server.start();

    // GET /mcp without a handler hits the SPA fallback (200 html), and a
    // POST hits the static pipeline's 405 — either way, not JSON-RPC.
    const response = await fetch(`http://127.0.0.1:${port}/mcp`);
    expect(response.headers.get("content-type")).toContain("text/html");
  });
});
