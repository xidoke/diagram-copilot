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
 * (`./tools/workspace.ts`, T22), `get_diagram`/`set_diagram`
 * (`./tools/diagram.ts`, T20) and `snapshot_diagram`
 * (`./tools/snapshot-steps.ts`, T37), which additionally read/act on live
 * workspace state via {@link McpHandlerOptions.getWorkspace}.
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
import { registerEditDiagramTool } from "./tools/edit.js";
import { registerDiffDiagramTool } from "./tools/diff.js";
import { registerSnapshotDiagramTool } from "./tools/snapshot-steps.js";
import { registerSnapshotTool, type SnapshotOps } from "./tools/snapshot.js";
import { registerHistoryTools } from "./tools/history.js";
import { registerNotesTools } from "./tools/notes.js";
import type { NotesStore } from "../notes.js";
import { registerValidateDslTool } from "./tools/validate.js";
import { registerExportDiagramTool } from "./tools/export-file.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import type { LifecycleOps } from "../workspace/lifecycle.js";

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
   * Live wiring for `get_snapshot` (T24): the shared snapshot broker plus the
   * hub's broadcast/client-count and the active diagram name. Omit for a
   * server without a WS hub (the tool is then not registered).
   */
  snapshot?: SnapshotOps;
  /**
   * Live history store for `undo_diagram` / `redo_diagram` (T31). Wire to the
   * shared {@link createHistoryStore} instance, returning `null` before it is
   * ready. Registered only alongside a workspace; omit to leave the history
   * tools out entirely.
   */
  getHistory?: () => HistoryStore | null;
  /**
   * Read/write store for `get_notes` / `set_notes` (DGC-63) — the shared
   * {@link createNotesStore} instance bound to the workspace dir. The
   * workspace path is fixed at startup, so this is a plain store rather than a
   * getter. Registered only alongside a workspace; omit to leave the notes
   * tools out entirely.
   */
  notes?: NotesStore;
  /**
   * Live lifecycle ops for `rename_diagram` / `delete_diagram` / `list_trash` /
   * `restore_diagram` (DGC-65). Wire to the shared {@link createLifecycleOps}
   * instance, returning `null` before the watcher is ready. Registered only
   * alongside a workspace; omit to leave the lifecycle tools out entirely.
   */
  getLifecycle?: () => LifecycleOps | null;
  /**
   * On-disk destination config for `export_diagram` (F2): the default
   * `--export-dir` plus the whitelisted `--export-root` directories a caller
   * `path` may write into. Registered only alongside `snapshot` + `getWorkspace`
   * (rendering needs the WS hub, the version stamp needs the workspace); omit to
   * leave `export_diagram` out entirely.
   */
  exportPaths?: { dir: string; roots: string[] };
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
  // Stateless dry-run DSL check (F1) — pure function of its input, like the
  // guide/icons reference tools, so it needs no wiring.
  registerValidateDslTool(server);

  // Workspace + diagram tools plug in only when the server is wired with a
  // workspace (a bare ping-only server omits them).
  if (options.getWorkspace !== undefined) {
    registerWorkspaceTools(server, options.getWorkspace);
    registerDiagramTools(server, options.getWorkspace);
    registerEditDiagramTool(server, options.getWorkspace);
    registerSnapshotDiagramTool(server, options.getWorkspace);
    // History (undo/redo) tools plug in only when a history store is also wired.
    if (options.getHistory !== undefined) {
      registerHistoryTools(server, options.getWorkspace, options.getHistory);
    }
    // Notes (get_notes/set_notes, DGC-63) plug in only when a notes store is wired.
    if (options.notes !== undefined) {
      registerNotesTools(server, options.getWorkspace, options.notes);
    }
    // Lifecycle (rename/delete/list_trash/restore, DGC-65) plug in only when
    // lifecycle ops are wired.
    if (options.getLifecycle !== undefined) {
      registerLifecycleTools(server, options.getLifecycle);
    }
    // diff_diagram (DGC-74) — read-only structural diff of two saved diagrams;
    // needs only the workspace to read/parse both, so no extra wiring.
    registerDiffDiagramTool(server, options.getWorkspace);
  }

  // Canvas-rendered PNG snapshots (T24) — needs the WS hub, so it plugs in
  // only when the server was wired with snapshot ops.
  if (options.snapshot !== undefined) registerSnapshotTool(server, options.snapshot);

  // Render-to-file export (F2) — needs the WS hub (rendering) AND the workspace
  // (version stamp) AND a destination config, so it plugs in only when all three
  // are wired.
  if (
    options.snapshot !== undefined &&
    options.getWorkspace !== undefined &&
    options.exportPaths !== undefined
  ) {
    registerExportDiagramTool(server, {
      snapshot: options.snapshot,
      getWorkspace: options.getWorkspace,
      exportDir: options.exportPaths.dir,
      roots: options.exportPaths.roots,
    });
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
