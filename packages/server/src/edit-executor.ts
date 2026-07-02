/**
 * Shared surgical-edit executor (DGC-78 visual editing p1).
 *
 * The ops schema and the sequential all-or-nothing apply loop used to live
 * inside the `edit_diagram` MCP tool (`mcp/tools/edit.ts`, DGC-72). Visual
 * editing gives the web canvas the same power over plain HTTP
 * (`POST /api/edit`), so the executor moved here — BOTH callers import this
 * module rather than owning a copy:
 *
 * - each op maps 1:1 onto a DGC-17 core edit primitive ({@link addNode},
 *   {@link renameElement}, {@link removeEdge}, …), which rewrites the DSL
 *   text minimally — every line an op does not touch survives byte-for-byte
 *   (user comments, spacing, statement order);
 * - ops apply SEQUENTIALLY, each parsing the text the previous op produced;
 * - the whole batch is all-or-nothing: the first failing op aborts with its
 *   index and reason, and the caller writes nothing.
 *
 * This module also owns the `POST /api/edit` HTTP handler (same
 * one-feature-one-module shape as `notes.ts`/`history/http.ts`): validate the
 * body, run the executor, write through {@link WorkspaceOps.update} (version
 * bump + origin-`mcp` broadcast — the canvas refreshes off that frame, no
 * client-side state mutation).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  addEdge,
  addNode,
  moveToGroup,
  removeEdge,
  removeElement,
  renameElement,
  setAttr,
} from "@diagram-copilot/core";
import type { WorkspaceOps } from "./workspace/watcher.js";

/**
 * One edit op per core primitive. Discriminated on `op` so both Zod errors
 * and the generated JSON schema stay precise per variant.
 */
export const EditOpSchema = z.discriminatedUnion("op", [
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
  // Endpoint-addressed edge removal (DGC-78): edge `eN` ids are positional
  // (parse order), so a canvas holding a slightly stale view could delete the
  // wrong edge by id — `from`/`to` (+ optional label for parallel edges) are
  // stable across unrelated edits.
  z.object({
    op: z.literal("remove_edge"),
    from: z.string().describe("Source node/group id of the edge to remove."),
    to: z.string().describe("Target node/group id of the edge to remove."),
    label: z.string().optional().describe("Edge label — needed only to disambiguate parallel edges."),
  }),
]);

export type EditOp = z.infer<typeof EditOpSchema>;

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
    case "remove_edge":
      return removeEdge(dsl, op.from, op.to, op.label);
  }
}

/** One-line human summary of an op for receipts (MCP text + HTTP `applied`). */
export function describeOp(op: EditOp): string {
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
    case "remove_edge":
      return `remove_edge ${op.from} > ${op.to}${op.label !== undefined ? `: ${op.label}` : ""}`;
  }
}

/** Does this primitive error mean "the id you referenced doesn't exist"? */
export function isUnknownIdError(message: string): boolean {
  return /no (node|group|edge)|Unknown endpoint/i.test(message);
}

/** Outcome of {@link applyEditOps}: the rewritten DSL, or the first failure. */
export type EditApplyResult =
  | { ok: true; dsl: string }
  | { ok: false; error: string; opIndex: number };

/**
 * Apply `ops` to `dsl` sequentially, all-or-nothing. On the first failing op
 * the loop aborts and reports its ZERO-BASED index plus the primitive's error
 * message — the caller must not write anything in that case.
 */
export function applyEditOps(dsl: string, ops: readonly EditOp[]): EditApplyResult {
  let current = dsl;
  for (const [index, op] of ops.entries()) {
    try {
      current = applyOp(current, op);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: message, opIndex: index };
    }
  }
  return { ok: true, dsl: current };
}

// ---------------------------------------------------------------------------
// `POST /api/edit` — the web canvas's write path (DGC-78).
// ---------------------------------------------------------------------------

/** Route this handler answers. */
export const EDIT_PATH = "/api/edit";

/** Cap on the request body we will buffer — an ops batch is small JSON. */
const MAX_BODY_BYTES = 256 * 1024;

/** `POST /api/edit` body: unlike the MCP tool, `name` is required — the canvas always knows it. */
const EditRequestSchema = z.object({
  name: z.string().min(1),
  ops: z.array(EditOpSchema).min(1),
});

/** JSON receipt sent back by {@link createEditApiHandler}. */
export interface EditResponseBody {
  ok: boolean;
  name?: string;
  /** Version after the write (unchanged when the ops were a pure no-op). */
  version?: number;
  /** One human-readable line per applied op (see {@link describeOp}). */
  applied?: string[];
  error?: string;
  /** Zero-based index of the failing op when the batch aborted. */
  opIndex?: number;
}

function sendJson(res: ServerResponse, status: number, body: EditResponseBody): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

/** Buffer a (small) request body to a string, rejecting anything oversized. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > MAX_BODY_BYTES) reject(new Error("request body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

/**
 * Build the `POST /api/edit` handler. `getWorkspace` follows the same
 * mutable-watcher-ref pattern as every other API handler (null before the
 * watcher starts → 503). Statuses: 405 non-POST, 400 invalid body, 404
 * unknown diagram, 422 when an op fails (with `opIndex`), 200 on success —
 * including the pure no-op case, which skips the write so the version does
 * not bump and no phantom broadcast goes out (same rule as the MCP tool).
 */
export function createEditApiHandler(
  getWorkspace: () => WorkspaceOps | null,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "Method Not Allowed — POST only." });
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { ok: false, error: "Invalid JSON body." });
      return;
    }
    const parsed = EditRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue !== undefined && issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
      sendJson(res, 400, {
        ok: false,
        error: `Invalid request${where}: ${issue?.message ?? "expected { name, ops }"}.`,
      });
      return;
    }
    const { name, ops } = parsed.data;

    const workspace = getWorkspace();
    if (workspace === null) {
      sendJson(res, 503, { ok: false, error: "Workspace is not ready yet — try again in a moment." });
      return;
    }

    const current = workspace.read(name);
    if (!current.ok || current.dsl === undefined) {
      sendJson(res, 404, { ok: false, name, error: current.error ?? `Unknown diagram "${name}".` });
      return;
    }

    const result = applyEditOps(current.dsl, ops);
    if (!result.ok) {
      sendJson(res, 422, { ok: false, name, error: result.error, opIndex: result.opIndex });
      return;
    }

    // Pure no-op (e.g. rename to the same name): don't write, don't bump.
    if (result.dsl === current.dsl) {
      sendJson(res, 200, { ok: true, name, version: current.version, applied: ops.map(describeOp) });
      return;
    }

    const written = workspace.update(name, result.dsl);
    if (!written.ok) {
      sendJson(res, 500, { ok: false, name, error: written.error ?? `Could not update diagram "${name}".` });
      return;
    }
    sendJson(res, 200, { ok: true, name: written.name, version: written.version, applied: ops.map(describeOp) });
  };
}
