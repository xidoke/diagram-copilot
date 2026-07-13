/**
 * C4 drill-down zoom (DGC-89) — double-click a group's body to "dive into"
 * it: the canvas re-renders showing only that group's interior, with the
 * outside world reduced to compact context, and a breadcrumb path to climb
 * back out.
 *
 * DESIGN: drill is — like collapse (DGC-67) — a pure TRANSFORM on the
 * {@link DiagramDoc} applied BEFORE layout, so ELK lays the focused view out
 * like any other doc and `toFlow`/overrides/edit gestures keep working on
 * real ids. The transform is built ON TOP of {@link collapseDoc}:
 *
 *   1. every group that sits NEXT to the drill path (a sibling of any path
 *      entry, or a root-level group off the path) is collapsed into its
 *      representative leaf — reusing collapseDoc's edge re-target + dedupe;
 *   2. the path's ancestor groups are removed (their frame would just wrap
 *      the whole view) and elements that lived directly inside them are
 *      re-rooted; the focus group itself becomes the view's root container;
 *   3. edges that touch the ancestors themselves are dropped, and so are
 *      edges purely between externals — then any external element left with
 *      no edge into the scope is dropped too. What remains outside the focus
 *      frame is exactly the C4-style context: "who talks to this interior",
 *      as single nodes (flagged for dim styling via `data.drillExternal`).
 *
 * An alternative `"hide"` mode drops the outside world entirely (cross-
 * boundary edges included). Both are pure and tested; App picks the one that
 * reads better (see DGC-89 notes).
 *
 * Drill state is VIEW state like collapse: a path of group ids from the root
 * (`["vpc","data"]`), persisted per diagram in `localStorage`
 * (`dgc.drill.<name>`), never in the doc or the layout sidecar. A stale path
 * (deleted/re-nested group) degrades to its longest valid prefix at render
 * time — the stored value is kept, so an undo that brings the group back
 * restores the drill (mirrors collapse's stale-id behavior).
 */
import type { Node } from "@xyflow/react";
import type { DiagramDoc, DiagramEdge, DiagramGroup, DiagramNode } from "@diagram-copilot/core";
import type { PrefsStorage } from "./layoutOptions.js";
import { collapseDoc } from "./collapse.js";

/** Stable empty set/path — keeps memo/effect deps quiet when not drilled. */
const NO_EXTERNALS: ReadonlySet<string> = new Set();

/** How the world outside the focus scope is rendered. */
export type DrillExternalMode = "collapse" | "hide";

/** Output of {@link drillDoc}. */
export interface DrillResult {
  /** The focused view doc (the INPUT doc, by reference, when path is empty). */
  doc: DiagramDoc;
  /**
   * Ids of the context elements kept OUTSIDE the focus scope (collapse mode
   * only) — used to stamp `data.drillExternal` for the dimmed styling.
   */
  externalIds: ReadonlySet<string>;
}

/**
 * The root→group ancestor chain for `groupId` (`["vpc","data"]`), or `null`
 * when `groupId` is not a group in this doc. This is what a double-click on
 * a group's body turns into the new drill path.
 */
export function drillPathTo(doc: DiagramDoc, groupId: string): string[] | null {
  const byId = new Map(doc.groups.map((g) => [g.id, g] as const));
  if (!byId.has(groupId)) return null;
  const path: string[] = [];
  const seen = new Set<string>();
  for (let cur: string | undefined = groupId; cur !== undefined; ) {
    if (seen.has(cur)) return null; // cycle — model forbids it, stay safe
    seen.add(cur);
    const g = byId.get(cur);
    if (!g) return null; // broken parent reference
    path.unshift(g.id);
    cur = g.parentId;
  }
  return path;
}

/**
 * Validate a (possibly stale) stored path against THIS doc: every entry must
 * be a group whose parent is exactly the previous entry (the first must be
 * root-level). Returns the longest valid prefix — so deleting the deepest
 * group lands you on its parent, and a broken chain resets to root. The
 * input reference is returned unchanged when fully valid (memo-friendly).
 */
export function validateDrillPath(doc: DiagramDoc, path: readonly string[]): readonly string[] {
  const byId = new Map(doc.groups.map((g) => [g.id, g] as const));
  let valid = 0;
  for (let i = 0; i < path.length; i++) {
    const g = byId.get(path[i]);
    const expectedParent = i === 0 ? undefined : path[i - 1];
    if (!g || g.parentId !== expectedParent) break;
    valid++;
  }
  return valid === path.length ? path : path.slice(0, valid);
}

/** One breadcrumb segment: the group id + its display label. */
export interface BreadcrumbItem {
  id: string;
  label: string;
}

/** Map a drill path to breadcrumb segments (label falls back to the id). */
export function breadcrumbItems(doc: DiagramDoc, path: readonly string[]): BreadcrumbItem[] {
  const labelById = new Map(doc.groups.map((g) => [g.id, g.label] as const));
  return path.map((id) => ({ id, label: labelById.get(id) ?? id }));
}

/** `id → containing group` chain map for a doc (nodes AND groups). */
function containerMap(doc: DiagramDoc): Map<string, string | undefined> {
  const containerOf = new Map<string, string | undefined>();
  for (const g of doc.groups) containerOf.set(g.id, g.parentId);
  for (const n of doc.nodes) containerOf.set(n.id, n.groupId);
  return containerOf;
}

/** Whether `id` is the focus or sits anywhere inside it. */
function inScope(id: string, focus: string, containerOf: Map<string, string | undefined>): boolean {
  const seen = new Set<string>();
  for (let cur: string | undefined = id; cur !== undefined && !seen.has(cur); cur = containerOf.get(cur)) {
    if (cur === focus) return true;
    seen.add(cur);
  }
  return false;
}

/** Copy of `g` without its `parentId` (re-rooted in the drill view). */
function rootGroup(g: DiagramGroup): DiagramGroup {
  const { parentId: _parentId, ...rest } = g;
  return rest;
}

/** Copy of `n` without its `groupId` (re-rooted in the drill view). */
function rootNode(n: DiagramNode): DiagramNode {
  const { groupId: _groupId, ...rest } = n;
  return rest;
}

/**
 * Pure transform: focus the view on the last group of `path` (assumed
 * validated — run {@link validateDrillPath} first). Empty path → the input
 * doc by reference. See the module doc for the algorithm.
 */
export function drillDoc(
  doc: DiagramDoc,
  path: readonly string[],
  mode: DrillExternalMode = "collapse",
): DrillResult {
  if (path.length === 0) return { doc, externalIds: NO_EXTERNALS };
  const focus = path[path.length - 1];
  const ancestors = new Set(path.slice(0, -1));

  if (mode === "hide") {
    const containerOf = containerMap(doc);
    const groups = doc.groups
      .filter((g) => inScope(g.id, focus, containerOf))
      .map((g) => (g.id === focus ? rootGroup(g) : g));
    const nodes = doc.nodes.filter((n) => inScope(n.id, focus, containerOf));
    const keep = new Set<string>([...groups.map((g) => g.id), ...nodes.map((n) => n.id)]);
    const edges = doc.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
    return { doc: { ...doc, nodes, groups, edges }, externalIds: NO_EXTERNALS };
  }

  // 1. Collapse every top-level external group — a group sitting directly at
  // the root or inside a path ancestor that is not itself on the path. Deeper
  // external groups are absorbed into these reps by collapseDoc; children of
  // the focus are untouched (their parent is the focus, not an ancestor).
  const collapseIds = new Set<string>();
  for (const g of doc.groups) {
    if (g.id === focus || ancestors.has(g.id)) continue;
    if (g.parentId === undefined || ancestors.has(g.parentId)) collapseIds.add(g.id);
  }
  const { doc: base } = collapseDoc(doc, collapseIds);

  // 2. Remove ancestor frames; re-root the focus and anything that lived
  // directly inside an ancestor (external leaves + the sibling reps).
  const groups: DiagramGroup[] = [];
  for (const g of base.groups) {
    if (ancestors.has(g.id)) continue;
    const parentIsAncestor = g.parentId !== undefined && ancestors.has(g.parentId);
    groups.push(g.id === focus || parentIsAncestor ? rootGroup(g) : g);
  }
  const containerOf = containerMap(base);
  const scopeNodes: DiagramNode[] = [];
  const externals: DiagramNode[] = [];
  for (const n of base.nodes) {
    if (inScope(n.id, focus, containerOf)) {
      scopeNodes.push(n);
    } else {
      externals.push(n.groupId !== undefined && ancestors.has(n.groupId) ? rootNode(n) : n);
    }
  }

  // 3. Edges: an endpoint on a removed ancestor frame has nowhere to land →
  // dropped; edges purely between externals are outside the story → dropped;
  // what remains touches the scope. Externals that end up unconnected are
  // context noise and dropped with their (zero) edges.
  const scopeIds = new Set<string>([...groups.map((g) => g.id), ...scopeNodes.map((n) => n.id)]);
  const connectedExternals = new Set<string>();
  const edges: DiagramEdge[] = [];
  for (const e of base.edges) {
    if (ancestors.has(e.from) || ancestors.has(e.to)) continue;
    const fromScope = scopeIds.has(e.from);
    const toScope = scopeIds.has(e.to);
    if (!fromScope && !toScope) continue;
    edges.push(e);
    if (!fromScope) connectedExternals.add(e.from);
    if (!toScope) connectedExternals.add(e.to);
  }
  const keptExternals = externals.filter((n) => connectedExternals.has(n.id));

  return {
    doc: { ...doc, nodes: [...scopeNodes, ...keptExternals], groups, edges },
    externalIds: new Set(keptExternals.map((n) => n.id)),
  };
}

/**
 * Flag the external context nodes with `data.drillExternal` so `ArchNode`
 * dims them (styled in App.css). Pure; untouched nodes keep their references
 * and an empty set returns the input array itself — mirror of
 * `markCollapsedNodes`.
 */
export function markExternalNodes(nodes: Node[], externalIds: ReadonlySet<string>): Node[] {
  if (externalIds.size === 0) return nodes;
  return nodes.map((n) =>
    externalIds.has(n.id) ? { ...n, data: { ...n.data, drillExternal: true } } : n,
  );
}

/** Ids of the nodes {@link markExternalNodes} flagged (derived, no extra state). */
export function externalNodeIds(nodes: Node[]): Set<string> {
  const ids = new Set<string>();
  for (const n of nodes) if (n.data?.drillExternal === true) ids.add(n.id);
  return ids;
}

/** `localStorage` key prefix — one entry per diagram: `dgc.drill.<name>`. */
export const DRILL_STORAGE_PREFIX = "dgc.drill.";

/**
 * Load the saved drill path for a diagram. Defensive parse: anything that is
 * not a JSON array of strings yields the root path — unlike collapse's set,
 * a drill path is positional, so a partially valid payload is a different
 * place and gets reset wholesale. Stale-but-well-formed paths are kept
 * (validateDrillPath degrades them at render time; an undo can revive them).
 */
export function loadDrill(name: string, storage: PrefsStorage = window.localStorage): string[] {
  const raw = storage.getItem(`${DRILL_STORAGE_PREFIX}${name}`);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((v): v is string => typeof v === "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}

/** Persist the drill path for a diagram (whole-path write, like collapse). */
export function saveDrill(
  name: string,
  path: readonly string[],
  storage: PrefsStorage = window.localStorage,
): void {
  storage.setItem(`${DRILL_STORAGE_PREFIX}${name}`, JSON.stringify([...path]));
}
