/**
 * Workspace MCP tools — `list_diagrams` and `open_diagram` (DGC-42).
 *
 * Both read/act through the narrow {@link WorkspaceOps} view of the workspace
 * watcher (never the watcher itself), fetched fresh on every call via
 * `getWorkspace` so answers reflect live filesystem state. Activating or
 * creating a diagram is fire-and-confirm: the tool returns a short text
 * receipt, and the actual canvas/picker update reaches the web client through
 * the watcher's existing broadcast (workspace + diagram frames).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceOps } from "../../workspace/watcher.js";

/** Wrap a plain string into the MCP text-content result shape. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Wrap an error string into an `isError` MCP result. */
function errorText(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/**
 * Register `list_diagrams` and `open_diagram` on `server`. Called from the MCP
 * handler only when the server was wired with a workspace (a bare ping-only
 * server omits these). `getWorkspace` may return `null` if the watcher has not
 * started yet, in which case the tools report that gracefully.
 */
export function registerWorkspaceTools(
  server: McpServer,
  getWorkspace: () => WorkspaceOps | null,
): void {
  server.registerTool(
    "list_diagrams",
    {
      title: "List diagrams",
      description:
        "List every diagram in the workspace with its version, marking the active one. Use before open_diagram to see what already exists.",
      inputSchema: {},
    },
    async () => {
      const workspace = getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const diagrams = workspace.list();
      if (diagrams.length === 0) {
        return text(
          'No diagrams in the workspace yet. Use open_diagram with a name (e.g. { "name": "demo" }) to create one.',
        );
      }
      const lines = diagrams.map((d) => {
        const marker = d.active ? "  * active" : "";
        return `${d.name} (v${d.version})${marker}`;
      });
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "open_diagram",
    {
      title: "Open diagram",
      description:
        "Make a diagram active on the canvas. If no diagram with that name exists, a new empty one is created and opened. The web client updates automatically.",
      inputSchema: { name: z.string().describe("Diagram name (without the .arch extension).") },
    },
    async ({ name }) => {
      const workspace = getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const result = workspace.open(name);
      if (!result.ok) {
        return errorText(result.error ?? `Could not open diagram "${name}".`);
      }
      if (result.created) {
        return text(`Created new diagram "${result.name}" (v${result.version}) and opened it.`);
      }
      return text(`Opened diagram "${result.name}" (v${result.version}).`);
    },
  );
}
