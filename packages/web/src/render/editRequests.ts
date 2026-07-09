/**
 * Visual editing p1 (DGC-78): canvas gestures → `POST /api/edit` ops.
 *
 * The canvas NEVER mutates diagram content locally — a gesture (Delete key,
 * inline rename) is translated here into the server's surgical edit ops,
 * posted over HTTP, and the canvas then refreshes off the normal `diagram`
 * WS broadcast the write triggers. The ops rewrite the DSL text minimally on
 * the server (DGC-17 primitives), so the user's comments survive.
 *
 * Pure helpers (`buildRemoveOps`, `describeRemoval`, `validateRename`) are
 * separated from the fetch wrapper so they can be unit-tested without a DOM.
 */
import { resolveApiBase } from "../components/UndoButton.js";
import { ARCH_GROUP_TYPE } from "./toFlow.js";

/** The subset of a React Flow node the remove builder needs. */
export interface RemovableNode {
  id: string;
  selected?: boolean;
  /** React Flow node type — used to skip groups (see {@link buildRemoveOps}). */
  type?: string;
}

/** The subset of a React Flow edge the remove builder needs. */
export interface RemovableEdge {
  source: string;
  target: string;
  selected?: boolean;
  /** React Flow allows ReactNode labels; only plain strings reach the DSL. */
  label?: unknown;
}

/** Ops this client sends — mirrors the server's `EditOpSchema` variants it uses. */
export type EditOp =
  | { op: "remove"; id: string }
  | { op: "remove_edge"; from: string; to: string; label?: string }
  | { op: "rename"; id: string; new_name: string }
  | { op: "move_to_group"; id: string; group: string | null };

/**
 * Translate the current React Flow selection into remove ops:
 * - every selected node → `remove` (the server cascades its edges);
 * - every selected edge → `remove_edge` by ENDPOINTS (edge `eN` ids are
 *   positional, endpoints are stable), skipping edges that already fall with
 *   a selected endpoint node — a second remove of the same edge would abort
 *   the whole all-or-nothing batch.
 */
export function buildRemoveOps(nodes: readonly RemovableNode[], edges: readonly RemovableEdge[]): EditOp[] {
  // Groups are selectable (DGC-19 resize) but must NOT be deletable from the
  // canvas — a single Delete would cascade the whole group + members server
  // side. Skip them here to keep the pre-DGC-19 "leaves/edges only" behavior.
  const removedNodes = new Set(
    nodes.filter((n) => n.selected === true && n.type !== ARCH_GROUP_TYPE).map((n) => n.id),
  );
  const ops: EditOp[] = [...removedNodes].map((id) => ({ op: "remove", id }));
  for (const edge of edges) {
    if (edge.selected !== true) continue;
    if (removedNodes.has(edge.source) || removedNodes.has(edge.target)) continue;
    const op: EditOp = { op: "remove_edge", from: edge.source, to: edge.target };
    if (typeof edge.label === "string" && edge.label !== "") op.label = edge.label;
    ops.push(op);
  }
  return ops;
}

/** Human summary of a remove batch for the toast: one element by name, several by count. */
export function describeRemoval(ops: readonly EditOp[]): string {
  if (ops.length === 1) {
    const op = ops[0];
    if (op.op === "remove") return `"${op.id}"`;
    if (op.op === "remove_edge") return `cạnh ${op.from} > ${op.to}`;
  }
  return `${ops.length} phần tử`;
}

/** Toast line for a successful drag-to-re-nest (DGC-19): into a group, or out to root. */
export function describeReparent(id: string, group: string | null): string {
  return group === null ? `Đã đưa "${id}" ra ngoài nhóm` : `Đã chuyển "${id}" vào nhóm "${group}"`;
}

/** Outcome of {@link validateRename} — `null` means "nothing to do" (empty or unchanged). */
export function validateRename(currentName: string, raw: string): string | null {
  const next = raw.trim();
  if (next === "" || next === currentName) return null;
  return next;
}

/** JSON receipt shape `POST /api/edit` answers with (see server `edit-executor.ts`). */
export interface EditApiResult {
  ok: boolean;
  name?: string;
  version?: number;
  applied?: string[];
  error?: string;
  opIndex?: number;
}

/**
 * `POST /api/edit` — apply `ops` to diagram `name`, all-or-nothing. Network
 * failures resolve (never throw) as `{ ok: false, error }` so call sites can
 * route every failure into the same toast.
 */
export async function postEdit(name: string, ops: readonly EditOp[]): Promise<EditApiResult> {
  try {
    const res = await fetch(`${resolveApiBase()}/api/edit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, ops }),
    });
    const body = (await res.json().catch(() => null)) as EditApiResult | null;
    if (body !== null && typeof body === "object") return body;
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
