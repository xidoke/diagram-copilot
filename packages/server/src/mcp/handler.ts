/**
 * MCP endpoint for Claude Code — Streamable HTTP transport mounted at `/mcp`
 * on the existing `node:http` server (no framework, per Master's decision).
 *
 * STATELESS mode (trade-off, deliberate): every POST gets a fresh
 * `McpServer` + `StreamableHTTPServerTransport` pair with
 * `sessionIdGenerator: undefined`. That means no session tracking, no
 * server→client push stream (GET) and no resumability — but zero shared
 * state between requests, no session bookkeeping/cleanup, and it is exactly
 * what a single local Claude Code client needs. If a later task needs
 * server-initiated messages (progress, sampling, subscriptions), switch to
 * stateful sessions: keep a `Map<sessionId, transport>` and pass
 * `sessionIdGenerator: () => randomUUID()`.
 *
 * Tool registration is centralized in {@link registerTools}: `ping` is
 * inline here, while each other tool lives in its own module and is wired in
 * with one `register*Tools(server)` call — `get_dsl_guide` (`./tools/guide.ts`)
 * and `list_icons` (`./tools/icons.ts`, T19); `list_diagrams`/`open_diagram`
 * (`./tools/workspace.ts`, T22) and `get_diagram`/`set_diagram`
 * (`./tools/diagram.ts`, T20), which additionally read/act on live workspace
 * state via {@link McpHandlerOptions.getWorkspace}.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerGetDslGuideTool } from "./tools/guide.js";
import { registerListIconsTool } from "./tools/icons.js";
import type { WorkspaceOps } from "../workspace/watcher.js";
import type { HistoryStore } from "../history/store.js";
import { registerWorkspaceTools } from "./tools/workspace.js";
import { registerDiagramTools } from "./tools/diagram.js";
import { registerHistoryTools } from "./tools/history.js";

/** MCP server identity advertised in the `initialize` result. */
export const MCP_SERVER_NAME = "diagram-copilot";

/** Live server facts the tools report. Read fresh on every call. */
export interface McpInfo {
  /** Package version (from `package.json`). */
  version: string;
  /** Absolute path of the watched workspace directory. */
  workspaceDir: string;
  /** Active diagram name, or `null` when the workspace is empty. */
  active: string | null;
}

export interface McpHandlerOptions {
  /**
   * Snapshot of current server state — wire this to the workspace watcher's
   * `getState()` so tools always answer from live data, never a stale copy.
   */
  getInfo: () => McpInfo;
  /**
   * Live workspace operations for `list_diagrams` / `open_diagram` (and future
   * T20 tools). Wire to the workspace watcher, returning `null` before it has
   * started. Omit entirely for a bare ping-only server (those tools are then
   * not registered).
   */
  getWorkspace?: () => WorkspaceOps | null;
  /**
   * Live history store for `undo_diagram` / `redo_diagram` (T31). Wire to the
   * shared {@link createHistoryStore} instance, returning `null` before it is
   * ready. Registered only alongside a workspace; omit to leave the history
   * tools out entirely.
   */
  getHistory?: () => HistoryStore | null;
}

/** A `node:http` request handler for the `/mcp` route. */
export type McpRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<void>;

/**
 * Register every diagram-copilot MCP tool on `server`.
 * T19/T20: add new `server.registerTool(...)` blocks here.
 */
function registerTools(server: McpServer, options: McpHandlerOptions): void {
  server.registerTool(
    "ping",
    {
      title: "Ping diagram-copilot",
      description:
        "Health check. Confirms the diagram-copilot server is reachable and reports its version, workspace directory and active diagram.",
      inputSchema: {},
    },
    async () => {
      const info = options.getInfo();
      return {
        content: [
          {
            type: "text" as const,
            text: `pong from diagram-copilot v${info.version} (workspace: ${info.workspaceDir}, active: ${info.active ?? "untitled"})`,
          },
        ],
      };
    },
  );
  registerGetDslGuideTool(server);
  registerListIconsTool(server);

  // Workspace + diagram tools plug in only when the server is wired with a
  // workspace (a bare ping-only server omits them).
  if (options.getWorkspace !== undefined) {
    registerWorkspaceTools(server, options.getWorkspace);
    registerDiagramTools(server, options.getWorkspace);
    // History (undo/redo) tools plug in only when a history store is also wired.
    if (options.getHistory !== undefined) {
      registerHistoryTools(server, options.getWorkspace, options.getHistory);
    }
  }
}

/**
 * Build a fresh, fully configured MCP server instance. One per request in
 * stateless mode (cheap: no I/O, just registrations).
 */
export function buildMcpServer(options: McpHandlerOptions): McpServer {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: options.getInfo().version,
  });
  registerTools(server, options);
  return server;
}

/**
 * Create the `/mcp` route handler. Mounted by `createServer` via
 * `CreateServerOptions.mcpHandler`; the CLI wires `getInfo` to the workspace
 * watcher so tool answers reflect live state.
 */
export function createMcpHandler(options: McpHandlerOptions): McpRequestHandler {
  return async (req, res) => {
    // Stateless mode: no standalone SSE stream to GET, no session to DELETE.
    // The Streamable HTTP spec explicitly allows 405 for both.
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method Not Allowed: stateless MCP endpoint accepts POST only" },
          id: null,
        }),
      );
      return;
    }

    const server = buildMcpServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — see module docblock for the trade-off
      // Plain JSON responses instead of an SSE stream per POST. With
      // per-request instances there is nothing to stream incrementally, and
      // JSON keeps curl/tests/Claude Code interop simple.
      enableJsonResponse: true,
    });

    // Tear the pair down when the client connection goes away so nothing
    // leaks across requests.
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      // The SDK transport reads + parses the request body itself (we pass no
      // `parsedBody`) and writes the full HTTP response, including protocol
      // errors like malformed JSON (400) or a missing Accept header (406).
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("[server] /mcp request failed:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal server error" },
            id: null,
          }),
        );
      } else {
        res.end();
      }
    }
  };
}
