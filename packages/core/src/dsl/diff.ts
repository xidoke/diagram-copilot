/**
 * Structural diff between two {@link DiagramDoc}s (DGC-74) — the model layer
 * behind the `diff_diagram` MCP tool and (later) a canvas overlay that shows
 * how a design evolved between two snapshots (e.g. `news-feed.step1` vs
 * `news-feed.step2`).
 *
 * The diff is computed on the language-neutral document, never on DSL text, so
 * it is insensitive to formatting, comments, and declaration order. Two
 * invariants shape the algorithm:
 *
 * - **id = name.** A node/group's id is its declared name (see `print/edits.ts`),
 *   stable across edits unless explicitly renamed. So nodes and groups are
 *   matched by id: same id ⇒ same element, and an attribute delta is reported
 *   as a change rather than an add+remove pair. A rename therefore reads as a
 *   remove + add — intentional, since the model gives us nothing to tie the two
 *   ids together.
 * - **edge ids are positional.** `parseDsl` numbers edges `e1..eN` in source
 *   order (DGC-17), so an edge's id shifts whenever earlier lines change. Edges
 *   are matched on their `from`/`to`/`label` content instead — see
 *   {@link diffEdges} for the exact heuristic.
 *
 * Every list in the returned {@link DocDiff} is sorted deterministically (by id,
 * then by edge endpoints/label) so the same pair of docs always yields the same
 * diff — important for stable receipts and snapshot tests.
 */

import type { DiagramDoc, DiagramEdge, DiagramGroup, DiagramNode } from "../model/index.js";

/** The attribute fields compared on nodes and groups, in report order. */
const ATTR_FIELDS = ["icon", "color", "label"] as const;
/** A single comparable attribute of a node or group. */
export type AttrField = (typeof ATTR_FIELDS)[number];

/** One attribute delta on an element whose id is unchanged: `field` went `from → to`. */
export interface FieldChange {
  /** Which attribute changed. */
  field: AttrField;
  /** Value in the "before" doc (`undefined` when the attribute was absent). */
  from?: string;
  /** Value in the "after" doc (`undefined` when the attribute was cleared). */
  to?: string;
}

/** A node kept across both docs (same id) with one or more attribute deltas. */
export interface NodeChange {
  /** The node id (= its name), unchanged between the docs. */
  id: string;
  /** Non-empty list of attribute deltas, ordered by {@link ATTR_FIELDS}. */
  changes: FieldChange[];
}

/** A group kept across both docs (same id) with one or more attribute deltas. */
export interface GroupChange {
  /** The group id (= its name), unchanged between the docs. */
  id: string;
  /** Non-empty list of attribute deltas, ordered by {@link ATTR_FIELDS}. */
  changes: FieldChange[];
}

/**
 * A node that stayed in both docs but moved between containers. `from`/`to` are
 * the containing group id, or `null` for the document root, so a move to/from
 * root is captured too.
 */
export interface MembershipChange {
  /** The node id (= its name). */
  id: string;
  /** Containing group id in the "before" doc, or `null` for root. */
  from: string | null;
  /** Containing group id in the "after" doc, or `null` for root. */
  to: string | null;
}

/** An edge referenced by content (its positional `eN` id is deliberately dropped). */
export interface EdgeRef {
  /** Source node/group id. */
  from: string;
  /** Target node/group id. */
  to: string;
  /** Edge label, or `undefined` when unlabeled. */
  label?: string;
}

/** An edge kept across both docs (same `from`/`to`) whose label changed. */
export interface EdgeLabelChange {
  /** Source node/group id. */
  from: string;
  /** Target node/group id. */
  to: string;
  /** Label in the "before" doc (`undefined` when it was unlabeled). */
  fromLabel?: string;
  /** Label in the "after" doc (`undefined` when the label was removed). */
  toLabel?: string;
}

/**
 * The full structural delta from doc `a` (before) to doc `b` (after). Empty
 * arrays everywhere means the two docs are structurally identical — see
 * {@link isDiffEmpty}.
 */
export interface DocDiff {
  nodes: {
    /** Nodes present in `b` but not `a`, sorted by id. */
    added: DiagramNode[];
    /** Nodes present in `a` but not `b`, sorted by id. */
    removed: DiagramNode[];
    /** Nodes in both with icon/color/label deltas, sorted by id. */
    changed: NodeChange[];
  };
  groups: {
    /** Groups present in `b` but not `a`, sorted by id. */
    added: DiagramGroup[];
    /** Groups present in `a` but not `b`, sorted by id. */
    removed: DiagramGroup[];
    /** Groups in both with icon/color/label deltas, sorted by id. */
    changed: GroupChange[];
    /** Nodes (in both docs) whose containing group changed, sorted by id. */
    membershipChanged: MembershipChange[];
  };
  edges: {
    /** Edges in `b` with no content match in `a`, sorted by from/to/label. */
    added: EdgeRef[];
    /** Edges in `a` with no content match in `b`, sorted by from/to/label. */
    removed: EdgeRef[];
    /** Edges kept by from/to whose label changed, sorted by from/to. */
    labelChanged: EdgeLabelChange[];
  };
}

/** Case-sensitive, locale-independent string order for deterministic sorting. */
function cmpStr(x: string, y: string): number {
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Sort an {@link EdgeRef}-like list by from, then to, then label (blank last-equal). */
function cmpEdge(x: EdgeRef, y: EdgeRef): number {
  return cmpStr(x.from, y.from) || cmpStr(x.to, y.to) || cmpStr(x.label ?? "", y.label ?? "");
}

/** Attribute deltas between two nodes/groups, in {@link ATTR_FIELDS} order. */
function attrChanges(a: DiagramNode | DiagramGroup, b: DiagramNode | DiagramGroup): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of ATTR_FIELDS) {
    const from = a[field];
    const to = b[field];
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

/**
 * Diff nodes by id: an id only in `b` is added, only in `a` is removed, in both
 * with differing icon/color/label is a change, and (separately) a node in both
 * whose `groupId` differs is a membership change (root modeled as `null`).
 */
function diffNodes(a: DiagramDoc, b: DiagramDoc): {
  added: DiagramNode[];
  removed: DiagramNode[];
  changed: NodeChange[];
  membershipChanged: MembershipChange[];
} {
  const byIdA = new Map(a.nodes.map((n) => [n.id, n]));
  const byIdB = new Map(b.nodes.map((n) => [n.id, n]));

  const added = b.nodes.filter((n) => !byIdA.has(n.id));
  const removed = a.nodes.filter((n) => !byIdB.has(n.id));

  const changed: NodeChange[] = [];
  const membershipChanged: MembershipChange[] = [];
  for (const before of a.nodes) {
    const after = byIdB.get(before.id);
    if (after === undefined) continue;
    const changes = attrChanges(before, after);
    if (changes.length > 0) changed.push({ id: before.id, changes });
    const from = before.groupId ?? null;
    const to = after.groupId ?? null;
    if (from !== to) membershipChanged.push({ id: before.id, from, to });
  }

  added.sort((x, y) => cmpStr(x.id, y.id));
  removed.sort((x, y) => cmpStr(x.id, y.id));
  changed.sort((x, y) => cmpStr(x.id, y.id));
  membershipChanged.sort((x, y) => cmpStr(x.id, y.id));
  return { added, removed, changed, membershipChanged };
}

/** Diff groups by id (added/removed/changed on label/color/icon). */
function diffGroups(a: DiagramDoc, b: DiagramDoc): {
  added: DiagramGroup[];
  removed: DiagramGroup[];
  changed: GroupChange[];
} {
  const byIdA = new Map(a.groups.map((g) => [g.id, g]));
  const byIdB = new Map(b.groups.map((g) => [g.id, g]));

  const added = b.groups.filter((g) => !byIdA.has(g.id));
  const removed = a.groups.filter((g) => !byIdB.has(g.id));

  const changed: GroupChange[] = [];
  for (const before of a.groups) {
    const after = byIdB.get(before.id);
    if (after === undefined) continue;
    const changes = attrChanges(before, after);
    if (changes.length > 0) changed.push({ id: before.id, changes });
  }

  added.sort((x, y) => cmpStr(x.id, y.id));
  removed.sort((x, y) => cmpStr(x.id, y.id));
  changed.sort((x, y) => cmpStr(x.id, y.id));
  return { added, removed, changed };
}

/** Content key that treats an unlabeled edge and a `""`-labeled edge alike. */
function edgeKey(e: DiagramEdge): string {
  return `${e.from} ${e.to} ${e.label ?? ""}`;
}
/** Endpoint-only key (ignores the label) for the label-change heuristic. */
function pairKey(e: EdgeRef): string {
  return `${e.from} ${e.to}`;
}
function toRef(e: DiagramEdge): EdgeRef {
  return e.label === undefined ? { from: e.from, to: e.to } : { from: e.from, to: e.to, label: e.label };
}

/**
 * Diff edges on content, never on the positional `eN` id (DGC-17). Two passes:
 *
 * 1. **Exact-match pass (multiset).** Edges with identical `from`/`to`/`label`
 *    in both docs are unchanged and dropped. A multiset (not a set) so a
 *    genuinely duplicated fan-out edge is only cancelled once per occurrence.
 *    Fan-out (`A > B, C`) is expanded by the parser into distinct edges that
 *    share `from`+`label` but differ in `to`, so adding/removing one target
 *    surfaces cleanly here as a single add/remove.
 *
 * 2. **Label-change pass (heuristic).** Among the leftovers, edges that share
 *    `from`+`to` but (necessarily, since exact matches are gone) differ in
 *    label are paired up as {@link EdgeLabelChange}. When several leftovers
 *    share one endpoint pair, they are paired in sorted-label order so the
 *    result is deterministic. Whatever is still unpaired is a pure add (only in
 *    `b`) or remove (only in `a`). This is intentionally endpoint-anchored: a
 *    label rewrite on a stable connection reads as one "label changed" rather
 *    than an add + remove.
 */
function diffEdges(a: DiagramDoc, b: DiagramDoc): {
  added: EdgeRef[];
  removed: EdgeRef[];
  labelChanged: EdgeLabelChange[];
} {
  // Pass 1 — cancel exact (from,to,label) matches as a multiset.
  const bByKey = new Map<string, DiagramEdge[]>();
  for (const e of b.edges) {
    const bucket = bByKey.get(edgeKey(e));
    if (bucket) bucket.push(e);
    else bByKey.set(edgeKey(e), [e]);
  }
  const leftoverA: DiagramEdge[] = [];
  for (const e of a.edges) {
    const bucket = bByKey.get(edgeKey(e));
    if (bucket && bucket.length > 0) bucket.shift();
    else leftoverA.push(e);
  }
  const leftoverB: DiagramEdge[] = [];
  for (const bucket of bByKey.values()) leftoverB.push(...bucket);

  // Pass 2 — pair leftovers that share endpoints (label changed).
  const bByPair = new Map<string, DiagramEdge[]>();
  for (const e of leftoverB) {
    const bucket = bByPair.get(pairKey(e));
    if (bucket) bucket.push(e);
    else bByPair.set(pairKey(e), [e]);
  }
  for (const bucket of bByPair.values()) bucket.sort((x, y) => cmpStr(x.label ?? "", y.label ?? ""));

  const labelChanged: EdgeLabelChange[] = [];
  const removed: EdgeRef[] = [];
  for (const e of [...leftoverA].sort(cmpEdge)) {
    const bucket = bByPair.get(pairKey(e));
    const match = bucket && bucket.length > 0 ? bucket.shift() : undefined;
    if (match) {
      const change: EdgeLabelChange = { from: e.from, to: e.to };
      if (e.label !== undefined) change.fromLabel = e.label;
      if (match.label !== undefined) change.toLabel = match.label;
      labelChanged.push(change);
    } else {
      removed.push(toRef(e));
    }
  }
  const added: EdgeRef[] = [];
  for (const bucket of bByPair.values()) for (const e of bucket) added.push(toRef(e));

  added.sort(cmpEdge);
  removed.sort(cmpEdge);
  labelChanged.sort((x, y) => cmpStr(x.from, y.from) || cmpStr(x.to, y.to));
  return { added, removed, labelChanged };
}

/**
 * Compute the structural delta from `a` (before) to `b` (after). Pure and
 * deterministic: the result depends only on the two docs' content, and every
 * list is stably sorted. See the module docblock for the matching rules.
 */
export function diffDocs(a: DiagramDoc, b: DiagramDoc): DocDiff {
  const nodes = diffNodes(a, b);
  const groups = diffGroups(a, b);
  const edges = diffEdges(a, b);
  return {
    nodes: { added: nodes.added, removed: nodes.removed, changed: nodes.changed },
    groups: {
      added: groups.added,
      removed: groups.removed,
      changed: groups.changed,
      membershipChanged: nodes.membershipChanged,
    },
    edges,
  };
}

/** `true` when `diff` records no change at all (the two docs are structurally identical). */
export function isDiffEmpty(diff: DocDiff): boolean {
  return (
    diff.nodes.added.length === 0 &&
    diff.nodes.removed.length === 0 &&
    diff.nodes.changed.length === 0 &&
    diff.groups.added.length === 0 &&
    diff.groups.removed.length === 0 &&
    diff.groups.changed.length === 0 &&
    diff.groups.membershipChanged.length === 0 &&
    diff.edges.added.length === 0 &&
    diff.edges.removed.length === 0 &&
    diff.edges.labelChanged.length === 0
  );
}
