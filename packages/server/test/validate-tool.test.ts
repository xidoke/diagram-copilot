/**
 * E2E tests for the `validate_dsl` MCP tool (F1 / DGC-61), driven like
 * mcp-tools.test.ts: real JSON-RPC over `/mcp` on an ephemeral port. The tool
 * needs no wiring (pure function of its input), so a bare `getInfo`-only server
 * is enough.
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

async function startMcpServer(): Promise<number> {
  const server = createServer({
    port: 0,
    mcpHandler: createMcpHandler({ getInfo: () => TEST_INFO }),
  });
  openServers.add(server);
  const { port } = await server.start();
  return port;
}

function post(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
  });
}

async function callValidate(port: number, dsl: string) {
  const response = await post(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "validate_dsl", arguments: { dsl } },
  });
  expect(response.status).toBe(200);
  const body = await response.json();
  return body.result as { isError?: boolean; content: Array<{ type: string; text: string }> };
}

describe("validate_dsl over /mcp", () => {
  it("is advertised in tools/list", async () => {
    const port = await startMcpServer();
    const response = await post(port, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const body = await response.json();
    const names = (body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("validate_dsl");
  });

  it("reports OK with node/group/edge counts for valid DSL", async () => {
    const port = await startMcpServer();

    const result = await callValidate(
      port,
      `direction right
VPC {
  API [icon: server]
  DB [icon: postgresql]
}
API > DB: reads`,
    );

    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toMatch(/^Valid —/);
    // 2 nodes (API, DB), 1 group (VPC), 1 edge (API > DB).
    expect(text).toContain("2 nodes");
    expect(text).toContain("1 group");
    expect(text).toContain("1 edge");
    // Emphasizes the dry-run nature.
    expect(text).toMatch(/nothing was written/i);
  });

  it("singularizes counts for a one-node diagram", async () => {
    const port = await startMcpServer();

    const result = await callValidate(port, "Server");

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("1 node");
    expect(result.content[0].text).toContain("0 groups");
    expect(result.content[0].text).toContain("0 edges");
  });

  it("returns each syntax error as `line X, col Y: message` and writes nothing", async () => {
    const port = await startMcpServer();

    // An unknown attribute key is a parse error pinned to a line/column.
    const result = await callValidate(port, "API [foo: bar]");

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/Invalid —/);
    expect(text).toMatch(/line \d+, col \d+:/);
    expect(text).toMatch(/nothing was written/i);
  });

  it("reports the line/column of the offending line in a multi-line document", async () => {
    const port = await startMcpServer();

    const result = await callValidate(port, "Server\nAPI [foo: bar]\nDB");

    expect(result.isError).toBe(true);
    // The unknown attribute is on line 2.
    expect(result.content[0].text).toMatch(/line 2, col \d+:/);
  });
});
