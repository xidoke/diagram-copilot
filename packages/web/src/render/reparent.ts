/**
 * Drag-to-re-nest geometry (DGC-19): decide, when a node/group is dropped,
 * whether its DSL nesting must change — i.e. whether to emit a `move_to_group`
 * op — and to which group (or the document root).
 *
 * All functions here are PURE and coordinate-frame agnostic: the caller
 * (`App`) resolves React Flow's parent-relative node positions into absolute
 * canvas boxes with {@link absoluteBoxes} and passes the dragged node's drop
 * point + the candidate group boxes in. Keeping the decision pure is what lets
 * the reparent rules (same-parent → reposition, other-group → move, open
 * canvas → root, never into self/descendants) be unit-tested without a DOM.
 *
 * DGC-18 lesson carried over: a React Flow group node is a pan surface with
 * `pointer-events:none`, so hit-testing must NOT use `elementsFromPoint` — it
 * is done here on plain geometry instead.
 */

/** An element's absolute box on the canvas (top-left origin + size, px). */
export interface AbsBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The minimal per-node geometry {@link absoluteBoxes} needs. */
export interface NodeGeom {
  id: string;
  /** Parent group id; absent for a root-level node. */
  parentId?: string;
  /** Position in the node's OWN frame (parent-relative for a child). */
  position: { x: number; y: number };
  width: number;
  height: number;
}

/** The minimal node shape {@link descendantIds}/{@link decideReparent} need. */
interface NodeParent {
  id: string;
  parentId?: string;
}

/**
 * Resolve every node's parent-relative {@link NodeGeom} into an absolute
 * {@link AbsBox}. React Flow keeps a child's `position` relative to its parent
 * group, so a child's absolute origin is its own position plus its parent's
 * absolute origin, walked up the whole chain. Memoized and order-independent
 * (a child listed before its parent still resolves); the model guarantees the
 * `parentId` chain is acyclic, and a visited guard makes it safe regardless.
 */
export function absoluteBoxes(nodes: readonly NodeGeom[]): Map<string, AbsBox> {
  const byId = new Map<string, NodeGeom>();
  for (const n of nodes) byId.set(n.id, n);

  const originCache = new Map<string, { x: number; y: number }>();
  const absoluteOrigin = (id: string): { x: number; y: number } => {
    const cached = originCache.get(id);
    if (cached) return cached;
    const node = byId.get(id);
    if (!node) return { x: 0, y: 0 };
    // Guard against a malformed cycle: seed the cache before recursing.
    originCache.set(id, node.position);
    const parent = node.parentId !== undefined ? byId.get(node.parentId) : undefined;
    const origin = parent
      ? { x: absoluteOrigin(parent.id).x + node.position.x, y: absoluteOrigin(parent.id).y + node.position.y }
      : { x: node.position.x, y: node.position.y };
    originCache.set(id, origin);
    return origin;
  };

  const boxes = new Map<string, AbsBox>();
  for (const n of nodes) {
    const origin = absoluteOrigin(n.id);
    boxes.set(n.id, { id: n.id, x: origin.x, y: origin.y, width: n.width, height: n.height });
  }
  return boxes;
}

/**
 * The INNERMOST group whose box contains `point`, or `null` if none does.
 * "Innermost" = smallest area, so a nested group wins over the parent that
 * encloses it. The box is inclusive of its top-left edge and exclusive at the
 * far edge (a point exactly on the right/bottom border is outside).
 */
export function groupAtPoint(point: { x: number; y: number }, groups: readonly AbsBox[]): string | null {
  let best: AbsBox | null = null;
  for (const g of groups) {
    const inside =
      point.x >= g.x && point.x < g.x + g.width && point.y >= g.y && point.y < g.y + g.height;
    if (!inside) continue;
    if (best === null || g.width * g.height < best.width * best.height) best = g;
  }
  return best?.id ?? null;
}

/**
 * The set of `id`'s transitive descendants (children, grandchildren, …) by
 * `parentId`, NOT including `id` itself. Used to exclude a dragged node and its
 * subtree from the reparent candidates — dropping a group onto its own child
 * would be a cycle (the server rejects it too, but the client must not send it).
 */
export function descendantIds(id: string, nodes: readonly NodeParent[]): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parentId === undefined) continue;
    const list = childrenOf.get(n.parentId);
    if (list) list.push(n.id);
    else childrenOf.set(n.parentId, [n.id]);
  }
  const out = new Set<string>();
  const stack = [...(childrenOf.get(id) ?? [])];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (out.has(cur)) continue;
    out.add(cur);
    for (const child of childrenOf.get(cur) ?? []) stack.push(child);
  }
  return out;
}

/** Outcome of {@link decideReparent}: keep the drag as a reposition, or re-nest. */
export type ReparentDecision =
  | { changed: false }
  | { changed: true; group: string | null };

/**
 * Decide what a drop means for nesting:
 * - dropped in the SAME parent it already has → `{ changed: false }` (the
 *   caller keeps the existing reposition-via-override behavior, no DSL edit);
 * - dropped inside a DIFFERENT group → `{ changed: true, group: <id> }`;
 * - dropped outside every (valid) group while it currently has a parent →
 *   `{ changed: true, group: null }` (move to the document root).
 *
 * The dragged node itself and its descendants are excluded from the candidate
 * groups so a node can never be re-nested into itself or its own subtree.
 */
export function decideReparent(params: {
  nodeId: string;
  currentParent: string | null;
  dropPoint: { x: number; y: number };
  groups: readonly AbsBox[];
  nodes: readonly NodeParent[];
}): ReparentDecision {
  const { nodeId, currentParent, dropPoint, groups, nodes } = params;
  const excluded = descendantIds(nodeId, nodes);
  excluded.add(nodeId);
  const candidates = groups.filter((g) => !excluded.has(g.id));
  const target = groupAtPoint(dropPoint, candidates);
  const current = currentParent ?? null;
  if (target === current) return { changed: false };
  return { changed: true, group: target };
}
