/**
 * `edit_diagram` MCP tool (DGC-72) — surgical, comment-preserving edits.
 *
 * Instead of rewriting the whole document (`set_diagram`), Claude sends a
 * list of small semantic ops (add a node, rename, change a color, …). The ops
 * schema and the sequential all-or-nothing apply loop are SHARED with the web
 * canvas's `POST /api/edit` route — both live in `edit-executor.ts` (DGC-78),
 * so this file only owns the MCP-shaped wrapping: resolving the target
 * diagram, the text receipts, and the write through the same
 * {@link WorkspaceOps.update} path `set_diagram` uses (version bump +
 * origin-`mcp` broadcast).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseDsl } from "@diagram-copilot/core";
import { EditOpSchema, applyEditOps, describeOp, isUnknownIdError } from "../../edit-executor.js";
import type { WorkspaceOps } from "../../workspace/watcher.js";

/** Wrap a plain string into the MCP text-content result shape. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Wrap an error string into an `isError` MCP result (so Claude sees it as a failure). */
function errorText(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/** `"1 node"` / `"3 nodes"` — small pluralization helper for the receipt. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** Name of the active diagram, or `null` when the workspace is empty. */
function activeName(diagrams: ReturnType<WorkspaceOps["list"]>): string | null {
  return diagrams.find((d) => d.active)?.name ?? null;
}

/**
 * Register `edit_diagram` on `server`. Same wiring contract as
 * `registerDiagramTools`: `getWorkspace` is fetched fresh per call and may
 * return `null` before the watcher has started.
 */
export function registerEditDiagramTool(
  server: McpServer,
  getWorkspace: () => WorkspaceOps | null,
): void {
  server.registerTool(
    "edit_diagram",
    {
      title: "Edit diagram (surgical ops)",
      description:
        "Apply a sequence of small, surgical edits to a diagram WITHOUT rewriting the whole document — the user's comments and formatting are preserved on every untouched line. Ops: add_node, add_edge, rename (updates all referencing edges), set_attr (icon/color/label; value null removes it), move_to_group (group null = root), remove (nodes/groups cascade to their edges), remove_edge (by from/to endpoints, label to disambiguate parallel edges). Ops apply in order and the call is all-or-nothing: if one fails, nothing is written. Prefer this over set_diagram for small changes; use set_diagram for large rewrites. Defaults to the active diagram; pass `name` to target another.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Diagram name (without the .arch extension). Defaults to the active diagram. Must already exist."),
        ops: z.array(EditOpSchema).min(1).describe("Edit operations, applied in order (all-or-nothing)."),
      },
    },
    async ({ name, ops }) => {
      const workspace = getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const target = name ?? activeName(workspace.list());
      if (target === null) {
        return errorText(
          'No diagram is open. Use open_diagram with a name (e.g. { "name": "demo" }) to create or open one, then call edit_diagram.',
        );
      }
      const current = workspace.read(target);
      if (!current.ok || current.dsl === undefined) {
        return errorText(
          (current.error ?? `Could not read diagram "${target}".`) +
            " edit_diagram only edits existing diagrams — use list_diagrams to see names, or set_diagram to create one.",
        );
      }

      // Shared executor: sequential, all-or-nothing (nothing touches disk on
      // failure — the first failing op aborts with its index and reason).
      const applied = applyEditOps(current.dsl, ops);
      if (!applied.ok) {
        const failedOp = ops[applied.opIndex];
        const lines = [
          `edit_diagram failed at op ${applied.opIndex + 1} of ${ops.length} (${failedOp?.op ?? "?"}) — nothing was written, "${target}" is unchanged:`,
          `  ${applied.error}`,
          "",
        ];
        lines.push(
          isUnknownIdError(applied.error)
            ? "Call get_diagram to see the current node/group/edge ids, fix the op, and call edit_diagram again."
            : "Fix the op and call edit_diagram again (get_diagram shows the current DSL).",
        );
        return errorText(lines.join("\n"));
      }
      const dsl = applied.dsl;

      // Rename-to-same-name (and similar) can be a pure no-op: skip the write
      // so the version does not bump and no phantom broadcast goes out.
      if (dsl === current.dsl) {
        const doc = parseDsl(dsl);
        const counts = doc.ok
          ? ` (${count(doc.doc.nodes.length, "node")}, ${count(doc.doc.groups.length, "group")}, ${count(doc.doc.edges.length, "edge")})`
          : "";
        return text(
          `No changes — the ${count(ops.length, "op")} left "${target}" identical; still v${current.version}${counts}.`,
        );
      }

      // Every op succeeded — write once through the same path set_diagram uses
      // (update validates again, bumps the version, broadcasts origin `mcp`).
      const result = workspace.update(target, dsl);
      if (!result.ok || result.doc === undefined) {
        return errorText(result.error ?? `Could not update diagram "${target}".`);
      }
      const { doc } = result;
      const receipt = [
        `Applied ${count(ops.length, "edit")} to "${result.name}" — now v${result.version} (${count(doc.nodes.length, "node")}, ${count(doc.groups.length, "group")}, ${count(doc.edges.length, "edge")}):`,
        ...ops.map((op, i) => `  ${i + 1}. ${describeOp(op)}`),
      ];
      return text(receipt.join("\n"));
    },
  );
}
