/**
 * History MCP tools — `undo_diagram` and `redo_diagram` (T31, spec §6).
 *
 * The AI-overwrite safety net: `undo_diagram` restores the content a diagram
 * held before the most recent change (of any origin), `redo_diagram` re-applies
 * the most recently undone one. Both act through the shared {@link HistoryStore}
 * (persisted undo ring + in-memory redo stack) and the live {@link WorkspaceOps}
 * — fetched fresh on every call — defaulting to the active diagram when no
 * `name` is given.
 *
 * Undo/redo are applied as fresh `update`s: the version counter keeps climbing;
 * they never rewind it (see the store docblock). The receipt reports both the
 * restored content's original version and the new version.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { HistoryStore } from "../../history/store.js";
import type { WorkspaceOps } from "../../workspace/watcher.js";

/** Wrap a plain string into the MCP text-content result shape. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Wrap an error string into an `isError` MCP result (so Claude sees a failure). */
function errorText(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/** Name of the active diagram, or `null` when the workspace is empty. */
function activeName(diagrams: ReturnType<WorkspaceOps["list"]>): string | null {
  return diagrams.find((d) => d.active)?.name ?? null;
}

/**
 * Register `undo_diagram` and `redo_diagram` on `server`. Called from the MCP
 * handler only when the server was wired with BOTH a workspace and a history
 * store; either accessor returning `null` (startup gap) is reported gracefully.
 */
export function registerHistoryTools(
  server: McpServer,
  getWorkspace: () => WorkspaceOps | null,
  getHistory: () => HistoryStore | null,
): void {
  const nameInput = {
    name: z
      .string()
      .optional()
      .describe("Diagram name (without the .arch extension). Defaults to the active diagram."),
  };

  server.registerTool(
    "undo_diagram",
    {
      title: "Undo diagram",
      description:
        "Restore a diagram to the content it held BEFORE the most recent change — the safety net for an unwanted overwrite. Defaults to the active diagram; pass `name` to target a specific one. Applied as a new version (the version counter is NOT rewound). Use redo_diagram to reverse an undo.",
      inputSchema: nameInput,
    },
    async ({ name }) => {
      const workspace = getWorkspace();
      const history = getHistory();
      if (workspace === null || history === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const target = name ?? activeName(workspace.list());
      if (target === null) {
        return errorText(
          "No diagram is open. Use open_diagram with a name to open one, then try again.",
        );
      }
      const result = history.undo(target, workspace);
      return result.ok ? text(result.message) : errorText(result.message);
    },
  );

  server.registerTool(
    "redo_diagram",
    {
      title: "Redo diagram",
      description:
        "Reverse the most recent undo_diagram, re-applying the content that was undone. Defaults to the active diagram; pass `name` to target a specific one. Applied as a new version. Only available until a fresh edit replaces the redo history.",
      inputSchema: nameInput,
    },
    async ({ name }) => {
      const workspace = getWorkspace();
      const history = getHistory();
      if (workspace === null || history === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const target = name ?? activeName(workspace.list());
      if (target === null) {
        return errorText(
          "No diagram is open. Use open_diagram with a name to open one, then try again.",
        );
      }
      const result = history.redo(target, workspace);
      return result.ok ? text(result.message) : errorText(result.message);
    },
  );
}
