/**
 * Diagram lifecycle MCP tools — `rename_diagram`, `delete_diagram`,
 * `list_trash`, `restore_diagram` (DGC-65).
 *
 * These act through the narrow {@link LifecycleOps} view of the workspace
 * (fetched fresh on every call via `getLifecycle` so answers reflect live
 * state). Every op moves a diagram's whole footprint — `.arch` plus its
 * layout / notes / history sidecars — as one unit, and `delete_diagram` moves
 * (never hard-removes) into the trash, so the receipt always tells the caller
 * exactly how to get the diagram back.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { LifecycleOps } from "../../workspace/lifecycle.js";

/** Wrap a plain string into the MCP text-content result shape. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Wrap an error string into an `isError` MCP result (so Claude sees a failure). */
function errorText(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/**
 * Register the lifecycle tools on `server`. Called from the MCP handler only
 * when the server was wired with lifecycle ops. `getLifecycle` may return
 * `null` before the watcher has started, in which case the tools report that
 * gracefully.
 */
export function registerLifecycleTools(
  server: McpServer,
  getLifecycle: () => LifecycleOps | null,
): void {
  server.registerTool(
    "rename_diagram",
    {
      title: "Rename diagram",
      description:
        "Rename a diagram, moving its whole footprint — the .arch source plus its layout, notes and undo-history sidecars — to the new name. Refuses if a diagram with the new name already exists. The web client updates automatically.",
      inputSchema: {
        name: z.string().describe("Current diagram name (without the .arch extension)."),
        new_name: z.string().describe("New diagram name (without the .arch extension)."),
      },
    },
    async ({ name, new_name }) => {
      const lifecycle = getLifecycle();
      if (lifecycle === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const result = lifecycle.rename(name, new_name);
      if (!result.ok) {
        return errorText(result.error ?? `Could not rename "${name}".`);
      }
      const moved = result.movedSidecars ?? [];
      const suffix = moved.length > 0 ? ` (moved ${moved.join(", ")} alongside it)` : "";
      return text(`Renamed "${result.oldName}" → "${result.newName}"${suffix}.`);
    },
  );

  server.registerTool(
    "delete_diagram",
    {
      title: "Delete diagram",
      description:
        "Move a diagram (and its layout / notes / history sidecars) into the workspace trash. This is fully recoverable — nothing is hard-deleted. Restore it later with restore_diagram, or list_trash to see everything recoverable.",
      inputSchema: {
        name: z.string().describe("Diagram name to delete (without the .arch extension)."),
      },
    },
    async ({ name }) => {
      const lifecycle = getLifecycle();
      if (lifecycle === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const result = lifecycle.trash(name);
      if (!result.ok || result.id === undefined) {
        return errorText(result.error ?? `Could not delete "${name}".`);
      }
      const nowActive = result.active ? ` Active diagram is now "${result.active}".` : "";
      return text(
        `Moved "${result.name}" to the trash — recoverable, nothing was hard-deleted. ` +
          `Restore it with restore_diagram { "id": "${result.id}" }, or list_trash to see everything recoverable.${nowActive}`,
      );
    },
  );

  server.registerTool(
    "list_trash",
    {
      title: "List trash",
      description:
        "List every deleted diagram still recoverable from the workspace trash, newest first, with the id restore_diagram needs.",
      inputSchema: {},
    },
    async () => {
      const lifecycle = getLifecycle();
      if (lifecycle === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const entries = lifecycle.listTrash();
      if (entries.length === 0) {
        return text("Trash is empty — nothing to restore.");
      }
      const lines = entries.map((e) => `${e.name} — id "${e.id}" (deleted ${e.trashedAt})`);
      return text(lines.join("\n"));
    },
  );

  server.registerTool(
    "restore_diagram",
    {
      title: "Restore diagram",
      description:
        "Restore a deleted diagram from the trash by its id (from list_trash or a delete_diagram receipt), moving its whole footprint back and opening it. Refuses if a diagram with that name now exists.",
      inputSchema: {
        id: z.string().describe('Trash id of the diagram to restore (e.g. "2026-07-02T10-30-00.000Z-news-feed").'),
      },
    },
    async ({ id }) => {
      const lifecycle = getLifecycle();
      if (lifecycle === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const result = lifecycle.restore(id);
      if (!result.ok || result.name === undefined) {
        return errorText(result.error ?? `Could not restore "${id}".`);
      }
      return text(`Restored "${result.name}" from the trash and opened it.`);
    },
  );
}
