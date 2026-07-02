/**
 * Notes MCP tools — `get_notes` and `set_notes` (DGC-63).
 *
 * The design-reasoning companion to `get_diagram` / `set_diagram`: where those
 * read/write the picture (the DSL), these read/write the `<name>.notes.md`
 * file beside it — the running record of *why* the diagram looks the way it
 * does. After Claude and the human weigh a trade-off ("queue vs. direct call",
 * "why a 5-minute cache TTL"), Claude drops the conclusion into the notes with
 * `set_notes` so it survives past the conversation.
 *
 * Both act through a {@link NotesStore} (shared with the `/api/notes/:name`
 * HTTP handler, so one sanitize + 1 MB cap covers both) and default to the
 * active diagram — resolved fresh on every call from the live {@link
 * WorkspaceOps} view so answers reflect current workspace state.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceOps } from "../../workspace/watcher.js";
import type { NotesStore } from "../../notes.js";

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
 * Register `get_notes` and `set_notes` on `server`. Called from the MCP
 * handler only when the server was wired with both a workspace and a notes
 * store. `getWorkspace` may return `null` before the watcher has started, in
 * which case the tools report that gracefully.
 */
export function registerNotesTools(
  server: McpServer,
  getWorkspace: () => WorkspaceOps | null,
  notes: NotesStore,
): void {
  server.registerTool(
    "get_notes",
    {
      title: "Get notes",
      description:
        "Read a diagram's markdown design notes — the free-form record of WHY it looks the way it does (trade-offs, rationale, decisions). Defaults to the active diagram; pass `name` for a specific one. Returns empty when no notes have been written yet.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Diagram name (without the .arch extension). Defaults to the active diagram."),
      },
    },
    async ({ name }) => {
      const workspace = getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const target = name ?? activeName(workspace.list());
      if (target === null) {
        return errorText(
          'No diagram is open. Use open_diagram with a name (e.g. { "name": "demo" }) first, then call get_notes.',
        );
      }
      const result = notes.read(target);
      if (!result.ok) {
        return errorText(result.error);
      }
      if (result.markdown.trim() === "") {
        return text(
          `No notes yet for "${result.name}". Use set_notes to record the design reasoning behind this diagram.`,
        );
      }
      return text(`Notes for "${result.name}":\n\n${result.markdown}`);
    },
  );

  server.registerTool(
    "set_notes",
    {
      title: "Set notes",
      description:
        "Replace a diagram's markdown design notes (the whole document, not a patch). Use this to capture the WHY behind the diagram — trade-offs weighed, decisions made, rationale — so it outlives the conversation. Defaults to the active diagram; pass `name` to target a specific one. Notes are NOT part of the diagram DSL and never change the picture.",
      inputSchema: {
        markdown: z
          .string()
          .describe("The full markdown notes document to write (replaces existing notes)."),
        name: z
          .string()
          .optional()
          .describe("Diagram name (without the .arch extension). Defaults to the active diagram."),
      },
    },
    async ({ markdown, name }) => {
      const workspace = getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const target = name ?? activeName(workspace.list());
      if (target === null) {
        return errorText(
          'No diagram is open and no name was given. Pass a name (e.g. { "name": "demo", "markdown": "…" }).',
        );
      }
      const result = notes.write(target, markdown);
      if (!result.ok) {
        return errorText(result.error);
      }
      const bytes = Buffer.byteLength(markdown, "utf8");
      return text(`Saved notes for "${result.name}" (${bytes} byte${bytes === 1 ? "" : "s"}).`);
    },
  );
}
