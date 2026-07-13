/**
 * What-if "kill node" simulation (DGC-91) — answer "what happens if Redis
 * dies?" directly on the canvas: toggle nodes dead and watch the traffic
 * paths change color.
 *
 * DESIGN: purely a VIEW overlay, like the diff overlay (DGC-79) — nothing is
 * written to the DSL, the doc, undo history, or localStorage (a what-if is a
 * momentary question, not state worth keeping). {@link applyKill} is the pure
 * heart: it runs on the doc-view App is actually rendering (AFTER the drill
 * and collapse transforms, so a collapsed-group representative dies as one
 * unit), and returns id sets the class helpers below paint onto the React
 * Flow arrays.
 *
 * SEMANTICS (chốt cho v1):
 *   - dead      — the toggled ids themselves (unknown/stale ids are ignored)
 *                 plus every edge touching a dead id. Red, dashed, dimmed.
 *   - isolated  — alive elements that WERE reachable from a traffic source
 *                 before the kill but no longer are. "Source" = a vertex with
 *                 zero inbound edges in the rendered doc (Client, actors, …);
 *                 reachability follows edge direction (from → to) across
 *                 alive edges only, BFS. Amber, dimmed.
 *   - fallback  — a doc with NO sources (every vertex has inbound, e.g. one
 *                 big cycle) has no origin to reason from: nothing is marked
 *                 isolated, only dead. Same rule protects elements that were
 *                 already unreachable before the kill (a detached cycle):
 *                 they are not blamed on the kill.
 *   - groups    — edge endpoints may be group ids; they participate in the
 *                 graph as plain vertices. Containment is NOT an edge: a
 *                 group's members do not inherit its isolation (an edge onto
 *                 a group is an abstraction-level statement, not plumbing to
 *                 each member). Container groups without edges are never
 *                 isolated.
 *   - "gánh thêm traffic" (highlighting alive edges that absorb a dead
 *     parallel path) is deliberately NOT in v1 — inferring "parallel between
 *     the same pair of regions" is ambiguous on real docs, and dead-red +
 *     isolated-amber already tells the failure story. Revisit with metric
 *     annotations (DGC-103).
 */
import type { Edge, Node } from "@xyflow/react";
import type { DiagramDoc } from "@diagram-copilot/core";

/** Class stamped on dead nodes AND dead edges (styled in App.css). */
export const WHATIF_DEAD_CLASS = "whatif-dead";
/** Class stamped on isolated (cut-off but alive) nodes. */
export const WHATIF_ISOLATED_CLASS = "whatif-isolated";

/** Output of {@link applyKill} — id sets over the rendered doc-view. */
export interface KillResult {
  /** Toggled ids that exist in this doc (nodes or groups). */
  deadNodes: ReadonlySet<string>;
  /** Ids of edges touching a dead vertex. */
  deadEdges: ReadonlySet<string>;
  /** Alive vertices that lost all reachability from the traffic sources. */
  isolatedNodes: ReadonlySet<string>;
}

/** BFS over `out` edges from `starts`, excluding `blocked` vertices. */
function reachable(
  starts: Iterable<string>,
  out: ReadonlyMap<string, readonly string[]>,
  blocked: ReadonlySet<string>,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const s of starts) {
    if (blocked.has(s) || seen.has(s)) continue;
    seen.add(s);
    queue.push(s);
  }
  for (let i = 0; i < queue.length; i++) {
    for (const next of out.get(queue[i]) ?? []) {
      if (blocked.has(next) || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** Stable empty set for the alive baseline pass. */
const NO_BLOCKED: ReadonlySet<string> = new Set();

/**
 * Pure: simulate killing `deadIds` on `doc` (the doc-view being rendered).
 * See the module doc for the exact semantics of each returned set.
 */
export function applyKill(doc: DiagramDoc, deadIds: ReadonlySet<string>): KillResult {
  // Vertices = leaf nodes + groups (edges may target either).
  const vertices = new Set<string>();
  for (const n of doc.nodes) vertices.add(n.id);
  for (const g of doc.groups) vertices.add(g.id);

  const deadNodes = new Set<string>();
  for (const id of deadIds) if (vertices.has(id)) deadNodes.add(id);

  const deadEdges = new Set<string>();
  if (deadNodes.size === 0) {
    return { deadNodes, deadEdges, isolatedNodes: new Set() };
  }

  const out = new Map<string, string[]>();
  const hasInbound = new Set<string>();
  for (const e of doc.edges) {
    if (deadNodes.has(e.from) || deadNodes.has(e.to)) deadEdges.add(e.id);
    const targets = out.get(e.from);
    if (targets) targets.push(e.to);
    else out.set(e.from, [e.to]);
    hasInbound.add(e.to);
  }

  // Traffic sources: zero inbound edges in the ORIGINAL doc. No sources →
  // no origin to reason from → nothing isolated (documented fallback).
  const sources: string[] = [];
  for (const v of vertices) if (!hasInbound.has(v)) sources.push(v);

  // Isolated = was reachable before ∖ still reachable ∖ dead. The baseline
  // pass keeps pre-existing unreachable elements (detached cycles) out.
  const baseline = reachable(sources, out, NO_BLOCKED);
  const after = reachable(sources, out, deadNodes);
  const isolatedNodes = new Set<string>();
  for (const v of baseline) {
    if (!after.has(v) && !deadNodes.has(v)) isolatedNodes.add(v);
  }

  return { deadNodes, deadEdges, isolatedNodes };
}

/** Append a class to an existing className (same helper shape as diffOverlay). */
function withClass(existing: string | undefined, cls: string): string {
  return existing ? `${existing} ${cls}` : cls;
}

/**
 * Stamp the kill classes onto React Flow nodes (pure). Untouched nodes keep
 * their references; `null` returns the input array itself — so the overlay is
 * free when the mode is off (mirror of `applyDiffToNodes`).
 */
export function applyKillToNodes(nodes: Node[], kill: KillResult | null): Node[] {
  if (!kill || (kill.deadNodes.size === 0 && kill.isolatedNodes.size === 0)) return nodes;
  return nodes.map((n) => {
    if (kill.deadNodes.has(n.id)) return { ...n, className: withClass(n.className, WHATIF_DEAD_CLASS) };
    if (kill.isolatedNodes.has(n.id)) {
      return { ...n, className: withClass(n.className, WHATIF_ISOLATED_CLASS) };
    }
    return n;
  });
}

/**
 * Stamp the dead class onto React Flow edges by edge id (pure; edge ids
 * survive layout — `toFlow` copies them from the doc-view `applyKill` ran on).
 */
export function applyKillToEdges(edges: Edge[], kill: KillResult | null): Edge[] {
  if (!kill || kill.deadEdges.size === 0) return edges;
  return edges.map((e) =>
    kill.deadEdges.has(e.id) ? { ...e, className: withClass(e.className, WHATIF_DEAD_CLASS) } : e,
  );
}
