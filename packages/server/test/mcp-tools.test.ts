/**
 * Tests for the T19 MCP tools — `get_dsl_guide` and `list_icons` — driven
 * the same way as `mcp.test.ts`: real JSON-RPC requests against `/mcp`
 * over `node:http`, no Claude Code required.
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

async function callTool(port: number, name: string, args: Record<string, unknown> = {}) {
  const response = await post(port, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = await response.json();
  expect(body.result.isError).toBeFalsy();
  return body.result.content[0].text as string;
}

describe("tools/list — advertises all three tools", () => {
  it("lists ping, get_dsl_guide and list_icons", async () => {
    const port = await startMcpServer();

    const response = await post(port, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const body = await response.json();
    const tools = body.result.tools as Array<{ name: string }>;

    expect(tools).toHaveLength(3);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["get_dsl_guide", "list_icons", "ping"]);
  });
});

describe("get_dsl_guide", () => {
  it("returns a guide covering groups, one-to-many, comments and colors", async () => {
    const port = await startMcpServer();

    const text = await callTool(port, "get_dsl_guide");

    // Groups
    expect(text).toMatch(/Groups?\s*—.*\{/i);
    expect(text).toContain("{ ... }");
    // One-to-many fan-out
    expect(text.toLowerCase()).toContain("one-to-many");
    expect(text).toContain("Gateway > Auth, Users, Billing");
    // Comments
    expect(text.toLowerCase()).toContain("comment");
    expect(text).toContain("//");
    // Valid colors
    expect(text).toContain("blue, orange, green, red, purple, pink, yellow, teal, gray");
    // Points Claude at list_icons for icon ids
    expect(text).toContain("list_icons");
  });

  it("documents the get_diagram -> edit -> set_diagram self-correction workflow", async () => {
    const port = await startMcpServer();

    const text = await callTool(port, "get_dsl_guide");

    // WORKFLOW section names both tools and the read-first / retry loop.
    expect(text).toMatch(/workflow/i);
    expect(text).toContain("get_diagram");
    expect(text).toContain("set_diagram");
    // Teaches self-correction from the "line X, col Y" error shape set_diagram returns.
    expect(text).toMatch(/line X, col Y/);
  });

  it("shows a two-tier nested group and a boundary-crossing edge in the example", async () => {
    const port = await startMcpServer();

    const text = await callTool(port, "get_dsl_guide");

    // Nested-group example (a group declared inside another group).
    expect(text).toContain("Data Layer");
    expect(text).toMatch(/nested inside/i);
    // Encourages design-intent comments (e.g. a cache TTL).
    expect(text).toMatch(/cache-aside/);
  });
});

describe("list_icons", () => {
  it("returns the full registry, including postgresql, when called without a query", async () => {
    const port = await startMcpServer();

    const text = await callTool(port, "list_icons");

    expect(text).toContain("postgresql — PostgreSQL (simple-icons)");
    expect(text).toMatch(/^\d+ icon\(s\) available\./);
  });

  it("filters by a substring query ('post' matches postgresql)", async () => {
    const port = await startMcpServer();

    const text = await callTool(port, "list_icons", { query: "post" });

    expect(text).toContain("postgresql");
    expect(text).not.toContain("mysql");
  });

  it("reports no matches and suggests dropping the query for an unknown term", async () => {
    const port = await startMcpServer();

    const text = await callTool(port, "list_icons", { query: "zzz" });

    expect(text).toMatch(/no icons match/i);
    expect(text).toMatch(/without a query/i);
  });
});
