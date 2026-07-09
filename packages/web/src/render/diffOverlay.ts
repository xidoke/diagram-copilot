/**
 * Diff overlay (DGC-79) — "what changed since the step before this one?"
 *
 * When the active diagram is part of an evolution chain (`news-feed`,
 * `news-feed.step1`, …; see StepsNav's `buildStepChain`), the Δ toggle fetches
 * the *previous* step's `.arch` source alongside the current one, parses both
 * with the shared core parser, and structurally diffs them ({@link diffDocs}).
 * The result becomes a set of CSS classes React Flow paints onto the canvas:
 *
 *   - added node/group/edge → `diff-added`   (green glow)
 *   - changed attribute / moved edge label → `diff-changed` (amber ring)
 *   - removed elements are NOT rendered as ghost nodes — that would perturb the
 *     ELK layout. Instead they are surfaced as a "− N removed" count + name
 *     list on the StepsNav panel (see {@link DiffSummary}).
 *
 * {@link buildDiffClassNames} is the pure heart of the module (a `DocDiff` in,
 * class maps + summary out) so it is unit-testable without any network or DOM.
 * {@link computeDiffOverlay} is the thin async shell that fetches + parses.
 */
import type { Edge, Node } from "@xyflow/react";
import { diffDocs, parseDsl, type DocDiff } from "@diagram-copilot/core";
import { buildStepChain } from "../components/StepsNav.js";

/** The visual states an element can be flagged with. `diff-removed` never
 *  appears on the live canvas (ghost nodes would perturb ELK) — it exists for
 *  compare mode's LEFT pane (DGC-88), which renders the *previous* step where
 *  the removed element still lives. */
export type DiffClass = "diff-added" | "diff-changed" | "diff-removed";

/** Compact counts + removed-element names for the StepsNav Δ panel. */
export interface DiffSummary {
  /** Nodes + groups present in the current step but not the previous one. */
  addedNodes: number;
  /** Edges present in the current step but not the previous one. */
  addedEdges: number;
  /** Attribute deltas + membership moves + edge-label rewrites. */
  changed: number;
  /** Nodes + groups + edges present in the previous step but gone now. */
  removed: number;
  /** Names of removed nodes + groups (edges have no name), for the panel hint. */
  removedNames: string[];
  /** `true` when the two steps are structurally identical (nothing to show). */
  empty: boolean;
}

/**
 * The overlay React Flow consumes: a class per node/group id, a class per edge
 * content key (see {@link edgeDiffKey} — edges have no stable id), plus the
 * {@link DiffSummary} the panel renders.
 */
export interface DiffOverlay {
  /** node/group id → diff class. */
  nodeClasses: Record<string, DiffClass>;
  /** edge content key → diff class. */
  edgeClasses: Record<string, DiffClass>;
  summary: DiffSummary;
}

/**
 * Content key for an edge — its positional `eN` id is meaningless across steps
 * (an earlier line shifts every id after it), so edges are keyed by
 * `from`/`to`/`label` exactly like the core diff matches them. The ``
 * separator can't occur in a diagram name, so keys never collide. Callers on
 * the React Flow side build the same key from `source`/`target`/`label`.
 */
export function edgeDiffKey(from: string, to: string, label?: string): string {
  return `${from}${to}${label ?? ""}`;
}

/**
 * Pure: turn a structural {@link DocDiff} (previous → current) into the class
 * maps + summary the overlay renders. Added elements win over changed if an id
 * somehow appears in both (it can't for the same element, but the guard keeps
 * the mapping unambiguous).
 */
export function buildDiffClassNames(diff: DocDiff): DiffOverlay {
  const nodeClasses: Record<string, DiffClass> = {};
  const edgeClasses: Record<string, DiffClass> = {};

  // Changed first so a later "added" on the same id would override it (added is
  // the louder signal); in practice an element is never both.
  for (const n of diff.nodes.changed) nodeClasses[n.id] = "diff-changed";
  for (const g of diff.groups.changed) nodeClasses[g.id] = "diff-changed";
  // A node that only moved containers is still "changed" — surface it too,
  // unless it already carries a louder flag.
  for (const m of diff.groups.membershipChanged) {
    if (nodeClasses[m.id] === undefined) nodeClasses[m.id] = "diff-changed";
  }

  for (const n of diff.nodes.added) nodeClasses[n.id] = "diff-added";
  for (const g of diff.groups.added) nodeClasses[g.id] = "diff-added";

  // Edge-label rewrites key off the CURRENT (after) label, since that is what
  // the live React Flow edge renders.
  for (const e of diff.edges.labelChanged) {
    edgeClasses[edgeDiffKey(e.from, e.to, e.toLabel)] = "diff-changed";
  }
  for (const e of diff.edges.added) {
    edgeClasses[edgeDiffKey(e.from, e.to, e.label)] = "diff-added";
  }

  const removedNames = [
    ...diff.nodes.removed.map((n) => n.id),
    ...diff.groups.removed.map((g) => g.id),
  ];
  const changed =
    diff.nodes.changed.length +
    diff.groups.changed.length +
    diff.groups.membershipChanged.length +
    diff.edges.labelChanged.length;
  const removed = removedNames.length + diff.edges.removed.length;
  const addedNodes = diff.nodes.added.length + diff.groups.added.length;
  const addedEdges = diff.edges.added.length;

  const summary: DiffSummary = {
    addedNodes,
    addedEdges,
    changed,
    removed,
    removedNames,
    empty: addedNodes === 0 && addedEdges === 0 && changed === 0 && removed === 0,
  };

  return { nodeClasses, edgeClasses, summary };
}

/**
 * The diagram immediately before `active` in its evolution chain, or `null`
 * when there is no previous step: a standalone diagram, a diagram not in the
 * list, or the chain's first element (base / `step 1`). Reuses
 * {@link buildStepChain} so the "prev" notion stays identical to the
 * StepsNav ‹ › walk.
 */
export function prevStepName(diagrams: string[], active: string | null | undefined): string | null {
  const chain = buildStepChain(diagrams, active);
  if (!chain || chain.index <= 0) return null;
  return chain.chain[chain.index - 1];
}

/** Relative endpoint for the raw-DSL read API — same-origin in prod, proxied to
 *  :4747 in dev (see Picker/StepsNav's `/api/open`). */
const API_DSL_URL = "/api/dsl";

/** Fetch a diagram's raw `.arch` source, or `null` if it doesn't exist / fails.
 *  Exported for compare mode (DGC-88), which fetches the same pair of steps. */
export async function fetchDsl(name: string, signal?: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(`${API_DSL_URL}/${encodeURIComponent(name)}`, { signal });
    if (!res.ok) return null;
    const parsed = (await res.json().catch(() => null)) as { dsl?: unknown } | null;
    return parsed && typeof parsed.dsl === "string" ? parsed.dsl : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the previous + current step's DSL, parse both, and build the overlay.
 * Returns `null` when there is no previous step, either fetch fails, or either
 * source fails to parse — the caller then simply shows no overlay.
 */
export async function computeDiffOverlay(
  diagrams: string[],
  active: string | null | undefined,
  signal?: AbortSignal,
): Promise<DiffOverlay | null> {
  const prev = prevStepName(diagrams, active);
  if (!prev || !active) return null;

  const [prevDsl, curDsl] = await Promise.all([fetchDsl(prev, signal), fetchDsl(active, signal)]);
  if (prevDsl === null || curDsl === null) return null;

  const before = parseDsl(prevDsl);
  const after = parseDsl(curDsl);
  if (!before.ok || !after.ok) return null;

  return buildDiffClassNames(diffDocs(before.doc, after.doc));
}

/** Append a class to an existing className, preserving what's already there. */
function withClass(existing: string | undefined, cls: string): string {
  return existing ? `${existing} ${cls}` : cls;
}

/** Apply the overlay's node/group classes to a React Flow node array (pure). */
export function applyDiffToNodes(nodes: Node[], overlay: DiffOverlay | null): Node[] {
  if (!overlay) return nodes;
  return nodes.map((n) => {
    const cls = overlay.nodeClasses[n.id];
    return cls ? { ...n, className: withClass(n.className, cls) } : n;
  });
}

/** Apply the overlay's edge classes to a React Flow edge array (pure). */
export function applyDiffToEdges(edges: Edge[], overlay: DiffOverlay | null): Edge[] {
  if (!overlay) return edges;
  return edges.map((e) => {
    const label = typeof e.label === "string" ? e.label : undefined;
    const cls = overlay.edgeClasses[edgeDiffKey(e.source, e.target, label)];
    return cls ? { ...e, className: withClass(e.className, cls) } : e;
  });
}
