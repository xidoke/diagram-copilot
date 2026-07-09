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
  | { op: "add_node"; name: string; icon?: string; color?: string; label?: string; group?: string }
  | { op: "add_edge"; from: string; to: string; label?: string }
  | { op: "remove"; id: string }
  | { op: "remove_edge"; from: string; to: string; label?: string }
  | { op: "rename"; id: string; new_name: string }
  | { op: "set_attr"; id: string; key: "icon" | "color" | "label"; value: string | null }
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

// ── Palette drop → add_node, handle-drag → add_edge (DGC-18 v1.2) ──

/**
 * A name not already taken in `existing`. Tries `base` first, then suffixes
 * `-2`, `-3`, … — matching how a user would number duplicates. The set holds
 * BOTH node and group ids (they share one id namespace in the DSL), so a
 * dropped node never collides with an existing group either. Best-effort only:
 * the server's `add_node` is the real uniqueness guard (a stale client view
 * just gets a 422 that routes into the same toast).
 */
export function uniqueName(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!existing.has(candidate)) return candidate;
  }
}

/**
 * Build the `add_node` op for an icon dragged from the palette onto the canvas.
 * The new node's NAME is derived from the icon id (that's the label shown under
 * each palette cell), de-duplicated against `existingIds`; the same icon id is
 * stored as its `icon` attribute. `group` (the id of the group the drop landed
 * inside, if any) nests the node; an empty/undefined group means document root.
 */
export function buildDropNodeOp(
  iconId: string,
  existingIds: Iterable<string>,
  group?: string,
): Extract<EditOp, { op: "add_node" }> {
  const op: Extract<EditOp, { op: "add_node" }> = {
    op: "add_node",
    name: uniqueName(iconId, new Set(existingIds)),
    icon: iconId,
  };
  if (group !== undefined && group !== "") op.group = group;
  return op;
}

// ── Context menu → set_attr, Cmd+D → duplicate (DGC-20 v1.2) ──

/**
 * Build a `set_attr` op — the context menu's "đổi icon" / "đổi màu" actions.
 * `value` of `null` REMOVES the attribute (server strips it), which is what the
 * "bỏ icon" / "bỏ màu" choices send.
 */
export function buildSetAttrOp(
  id: string,
  key: "icon" | "color" | "label",
  value: string | null,
): Extract<EditOp, { op: "set_attr" }> {
  return { op: "set_attr", id, key, value };
}

/** The subset of a React Flow node the duplicate builder reads. */
export interface DuplicableNode {
  id: string;
  /** React Flow node type — groups (ARCH_GROUP_TYPE) are skipped (see below). */
  type?: string;
  /** Parent group id, if nested — the copy lands in the same group. */
  parentId?: string;
  /** Rendered data: `label`/`icon`/`color` are copied onto the duplicate. */
  data?: { label?: unknown; icon?: unknown; color?: unknown };
}

/**
 * Build the `add_node` op that duplicates one node (Cmd+D). The copy:
 * - takes a fresh unique name off the original's id (`API` → `API-2`, via
 *   {@link uniqueName} against `taken`);
 * - carries the original's `icon` and `color` when set;
 * - carries the original's `label` ONLY when it is EXPLICIT (differs from the
 *   id). A default label (label === id) is dropped so the copy displays its own
 *   new name (`API-2`) instead of confusingly reading as the original (`API`);
 * - lands in the same group (`parentId`) as the original.
 *
 * Pure: the caller passes the `taken` set; {@link buildDuplicateOps} threads it
 * across a multi-select batch so two copies never collide.
 */
export function buildDuplicateOp(
  node: DuplicableNode,
  taken: ReadonlySet<string>,
): Extract<EditOp, { op: "add_node" }> {
  const op: Extract<EditOp, { op: "add_node" }> = {
    op: "add_node",
    name: uniqueName(node.id, taken),
  };
  const icon = node.data?.icon;
  if (typeof icon === "string" && icon !== "") op.icon = icon;
  const color = node.data?.color;
  if (typeof color === "string" && color !== "") op.color = color;
  const label = node.data?.label;
  if (typeof label === "string" && label !== "" && label !== node.id) op.label = label;
  if (typeof node.parentId === "string" && node.parentId !== "") op.group = node.parentId;
  return op;
}

/**
 * Duplicate every LEAF node in `nodes` (Cmd+D on a selection). Groups are
 * skipped — `add_node` makes a leaf, so duplicating a group's box (let alone
 * its members) is a v1 non-goal. Unique names are threaded through one `taken`
 * set seeded from `existingIds`, so duplicating several nodes — or a node and
 * its own existing copy — in a single batch yields distinct names that also
 * clear the server's all-or-nothing uniqueness check.
 */
export function buildDuplicateOps(
  nodes: readonly DuplicableNode[],
  existingIds: Iterable<string>,
): Extract<EditOp, { op: "add_node" }>[] {
  const taken = new Set(existingIds);
  const ops: Extract<EditOp, { op: "add_node" }>[] = [];
  for (const node of nodes) {
    if (node.type === ARCH_GROUP_TYPE) continue;
    const op = buildDuplicateOp(node, taken);
    taken.add(op.name);
    ops.push(op);
  }
  return ops;
}

/** A group's on-screen box (client coords), used to hit-test a drop point. */
export interface GroupBox {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Which group a drop point falls inside — the INNERMOST one when groups nest,
 * chosen by smallest area (a nested group is strictly smaller than its parent).
 * `undefined` when the point misses every group (→ document root).
 *
 * Hit-testing against the groups' own boxes (not `elementsFromPoint`) is
 * deliberate: React Flow renders a group node as a pan surface with
 * `pointer-events: none`, so it never appears in an `elementsFromPoint` stack —
 * geometry is the only reliable signal. Pure: the canvas passes in the boxes it
 * reads from the DOM. Bounds are inclusive so a drop on a border still nests.
 */
export function groupAtPoint(x: number, y: number, groups: readonly GroupBox[]): string | undefined {
  let bestId: string | undefined;
  let bestArea = Infinity;
  for (const g of groups) {
    if (x < g.left || x > g.right || y < g.top || y > g.bottom) continue;
    const area = Math.max(0, g.right - g.left) * Math.max(0, g.bottom - g.top);
    if (area < bestArea) {
      bestArea = area;
      bestId = g.id;
    }
  }
  return bestId;
}

/**
 * Build the `add_edge` op for a handle-drag connection from node `from` to node
 * `to`. `label` (from the Alt-modifier prompt) is trimmed and attached only
 * when non-empty. Returns `null` for a degenerate connection (missing endpoint)
 * so the caller sends nothing.
 */
export function buildAddEdgeOp(
  from: string,
  to: string,
  label?: string | null,
): Extract<EditOp, { op: "add_edge" }> | null {
  if (!from || !to) return null;
  const op: Extract<EditOp, { op: "add_edge" }> = { op: "add_edge", from, to };
  const trimmed = label?.trim();
  if (trimmed) op.label = trimmed;
  return op;
}

/**
 * Build the op that rewrites an existing edge's label (DGC-85, double-click an
 * edge). Edges support the dedicated `set_attr {key:"label"}` op — addressed by
 * the edge's positional `eN` id, which is fresh at double-click time because the
 * canvas re-renders off every broadcast — so a single op suffices (it preserves
 * the edge's position in the DSL text, unlike a remove_edge + add_edge pair):
 * - a new label DIFFERENT from the current one → a `set_attr` op (empty/blank
 *   value clears the label: it sends `null`, which the server's `setAttr` maps
 *   to "delete the label");
 * - a new label EQUAL to the current one (trim-compared) → `null` (no-op): the
 *   caller sends nothing, so an accidental double-click + Enter is free.
 */
export function buildSetEdgeLabelOp(
  edgeId: string,
  currentLabel: string,
  raw: string,
): Extract<EditOp, { op: "set_attr" }> | null {
  const next = raw.trim();
  if (next === currentLabel.trim()) return null;
  return { op: "set_attr", id: edgeId, key: "label", value: next === "" ? null : next };
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
