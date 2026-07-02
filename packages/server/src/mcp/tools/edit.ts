/**
 * `edit_diagram` MCP tool (DGC-72) — surgical, comment-preserving edits.
 *
 * Instead of rewriting the whole document (`set_diagram`), Claude sends a
 * list of small semantic ops (add a node, rename, change a color, …). Each op
 * maps 1:1 onto a DGC-17 core edit primitive ({@link addNode},
 * {@link renameElement}, …), which rewrite the DSL text minimally — every
 * line the op does not touch survives byte-for-byte, so the user's comments,
 * spacing and statement order are preserved.
 *
 * Ops apply SEQUENTIALLY, each parsing the text produced by the previous one,
 * and the whole call is all-or-nothing: the first failing op aborts with its
 * index and reason, and nothing is written to disk. Only when every op
 * succeeds is the result written through the same {@link WorkspaceOps.update}
 * path `set_diagram` uses (version bump + origin-`mcp` broadcast).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  addEdge,
  addNode,
  moveToGroup,
  parseDsl,
  removeElement,
  renameElement,
  setAttr,
} from "@diagram-copilot/core";
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
 * One edit op per DGC-17 primitive. Discriminated on `op` so both Zod errors
 * and the generated JSON schema stay precise per variant.
 */
const EditOpSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add_node"),
    name: z.string().describe("Name (= id) of the new node. Must not already exist."),
    icon: z.string().optional().describe("Icon id/alias (see list_icons)."),
    color: z.string().optional().describe("Color token (see get_dsl_guide)."),
    label: z.string().optional().describe("Display label; defaults to the name."),
    group: z.string().optional().describe("Existing group to place the node in; omit for document root."),
  }),
  z.object({
    op: z.literal("add_edge"),
    from: z.string().describe("Source node/group id (must exist)."),
    to: z.string().describe("Target node/group id (must exist)."),
    label: z.string().optional().describe("Optional edge label."),
  }),
  z.object({
    op: z.literal("rename"),
    id: z.string().describe("Current node or group id."),
    new_name: z.string().describe("New name (= id). Every edge referencing the old name is updated."),
  }),
  z.object({
    op: z.literal("set_attr"),
    id: z.string().describe("Node, group, or edge id (edges: label only, id like `e1`)."),
    key: z.enum(["icon", "color", "label"]).describe("Attribute to change."),
    value: z.string().nullable().describe("New value, or null to remove the attribute."),
  }),
  z.object({
    op: z.literal("move_to_group"),
    id: z.string().describe("Node or group id to move."),
    group: z.string().nullable().describe("Target group id, or null to move to the document root."),
  }),
  z.object({
    op: z.literal("remove"),
    id: z.string().describe("Node, group, or edge id to remove. Nodes/groups take their edges (and group members) with them."),
  }),
]);

type EditOp = z.infer<typeof EditOpSchema>;

/** Apply one op to `dsl`, returning the new text. Throws with a descriptive message on failure. */
function applyOp(dsl: string, op: EditOp): string {
  switch (op.op) {
    case "add_node": {
      const spec: Parameters<typeof addNode>[1] = { id: op.name };
      if (op.label !== undefined) spec.label = op.label;
      if (op.icon !== undefined) spec.icon = op.icon;
      if (op.color !== undefined) spec.color = op.color;
      if (op.group !== undefined) spec.groupId = op.group;
      return addNode(dsl, spec);
    }
    case "add_edge": {
      const spec: Parameters<typeof addEdge>[1] = { from: op.from, to: op.to };
      if (op.label !== undefined) spec.label = op.label;
      return addEdge(dsl, spec);
    }
    case "rename":
      return renameElement(dsl, op.id, op.new_name);
    case "set_attr":
      return setAttr(dsl, op.id, op.key, op.value);
    case "move_to_group":
      return moveToGroup(dsl, op.id, op.group);
    case "remove":
      return removeElement(dsl, op.id);
  }
}

/** One-line human summary of an op for the success receipt. */
function describeOp(op: EditOp): string {
  switch (op.op) {
    case "add_node":
      return `add_node "${op.name}"${op.group !== undefined ? ` in group "${op.group}"` : ""}`;
    case "add_edge":
      return `add_edge ${op.from} > ${op.to}${op.label !== undefined ? `: ${op.label}` : ""}`;
    case "rename":
      return `rename "${op.id}" -> "${op.new_name}"`;
    case "set_attr":
      return op.value === null
        ? `set_attr "${op.id}" ${op.key} removed`
        : `set_attr "${op.id}" ${op.key} = "${op.value}"`;
    case "move_to_group":
      return `move_to_group "${op.id}" -> ${op.group === null ? "root" : `"${op.group}"`}`;
    case "remove":
      return `remove "${op.id}"`;
  }
}

/** Does this primitive error mean "the id you referenced doesn't exist"? */
function isUnknownIdError(message: string): boolean {
  return /no (node|group|edge)|Unknown endpoint/i.test(message);
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
        "Apply a sequence of small, surgical edits to a diagram WITHOUT rewriting the whole document — the user's comments and formatting are preserved on every untouched line. Ops: add_node, add_edge, rename (updates all referencing edges), set_attr (icon/color/label; value null removes it), move_to_group (group null = root), remove (nodes/groups cascade to their edges). Ops apply in order and the call is all-or-nothing: if one fails, nothing is written. Prefer this over set_diagram for small changes; use set_diagram for large rewrites. Defaults to the active diagram; pass `name` to target another.",
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

      // Apply sequentially; each op parses the text the previous op produced.
      // First failure aborts the whole call — nothing has touched disk yet.
      let dsl = current.dsl;
      for (const [index, op] of ops.entries()) {
        try {
          dsl = applyOp(dsl, op);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const lines = [
            `edit_diagram failed at op ${index + 1} of ${ops.length} (${op.op}) — nothing was written, "${target}" is unchanged:`,
            `  ${message}`,
            "",
          ];
          lines.push(
            isUnknownIdError(message)
              ? "Call get_diagram to see the current node/group/edge ids, fix the op, and call edit_diagram again."
              : "Fix the op and call edit_diagram again (get_diagram shows the current DSL).",
          );
          return errorText(lines.join("\n"));
        }
      }

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
