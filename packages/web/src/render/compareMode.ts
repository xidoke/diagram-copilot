/**
 * Compare mode (DGC-88) — "show me step N-1 and step N side by side."
 *
 * Where the Δ overlay (DGC-79, diffOverlay.ts) paints one-directional change
 * marks onto the live canvas, compare mode splits the canvas in two:
 *
 *   - LEFT pane: a static, read-only render of the PREVIOUS step
 *     (`ComparePane`), where elements that are gone in the current step glow
 *     red (`diff-removed`) and attribute/label changes glow amber;
 *   - RIGHT pane: the live canvas showing the CURRENT step, with the familiar
 *     Δ classes (added green, changed amber).
 *
 * Both panes are driven by ONE structural diff ({@link diffDocs} previous →
 * current); {@link buildCompareOverlays} is the pure heart that splits that
 * diff into the two per-pane class maps, keyed the way each pane renders:
 * removed elements exist only in the previous doc (left ids / before-labels),
 * added elements only in the current one (right ids / after-labels), changed
 * elements in both. {@link computeCompare} is the thin async shell that
 * fetches + parses the two steps' DSL — same endpoints and failure semantics
 * as `computeDiffOverlay` (`null` → the caller simply shows no compare pane).
 */
import { diffDocs, parseDsl, type DiagramDoc, type DocDiff } from "@diagram-copilot/core";
import {
  buildDiffClassNames,
  edgeDiffKey,
  fetchDsl,
  prevStepName,
  type DiffClass,
  type DiffOverlay,
} from "./diffOverlay.js";

/** The two per-pane overlays one diff fans out into. */
export interface CompareOverlays {
  /** For the previous-step pane: removed red, changed amber (before-keys). */
  left: DiffOverlay;
  /** For the live current-step canvas: added green, changed amber — identical
   *  to the Δ overlay, so the right pane never drifts from DGC-79. */
  right: DiffOverlay;
}

/**
 * Pure: split a structural {@link DocDiff} (previous → current) into the two
 * pane overlays. The right pane reuses {@link buildDiffClassNames} wholesale;
 * the left pane mirrors its shape but keys everything by what the PREVIOUS
 * step renders: removed node/group ids, removed edges' content, and — for a
 * label rewrite — the BEFORE label (the left pane draws the old label). Both
 * panes share one summary object (the counts describe the same diff).
 */
export function buildCompareOverlays(diff: DocDiff): CompareOverlays {
  const right = buildDiffClassNames(diff);

  const nodeClasses: Record<string, DiffClass> = {};
  const edgeClasses: Record<string, DiffClass> = {};

  // Changed first so a (theoretically impossible) id that is also removed ends
  // up with the louder "removed" flag — same precedence idea as the right pane.
  for (const n of diff.nodes.changed) nodeClasses[n.id] = "diff-changed";
  for (const g of diff.groups.changed) nodeClasses[g.id] = "diff-changed";
  for (const m of diff.groups.membershipChanged) {
    if (nodeClasses[m.id] === undefined) nodeClasses[m.id] = "diff-changed";
  }
  for (const n of diff.nodes.removed) nodeClasses[n.id] = "diff-removed";
  for (const g of diff.groups.removed) nodeClasses[g.id] = "diff-removed";

  // Edge-label rewrites key off the BEFORE label — that is what the left
  // pane's React Flow edge renders (mirror of the right pane's after-key).
  for (const e of diff.edges.labelChanged) {
    edgeClasses[edgeDiffKey(e.from, e.to, e.fromLabel)] = "diff-changed";
  }
  for (const e of diff.edges.removed) {
    edgeClasses[edgeDiffKey(e.from, e.to, e.label)] = "diff-removed";
  }

  return { left: { nodeClasses, edgeClasses, summary: right.summary }, right };
}

/** Everything App needs to run compare mode for one step pair. */
export interface CompareData {
  /** The previous step's diagram name (left pane title + fetch key). */
  prevName: string;
  /** The current step's diagram name (the live canvas already shows it). */
  currentName: string;
  /** Parsed previous-step doc — the left pane lays it out with ELK itself. */
  prevDoc: DiagramDoc;
  /** Left-pane class map (removed/changed on the previous step's elements). */
  left: DiffOverlay;
  /** Right-pane class map (added/changed), applied to the live canvas. */
  right: DiffOverlay;
}

/**
 * Fetch the previous + current step's DSL, parse both, diff, and build the two
 * pane overlays. Returns `null` when there is no previous step, either fetch
 * fails, or either source fails to parse — the caller then simply leaves
 * compare mode dark (same contract as `computeDiffOverlay`).
 */
export async function computeCompare(
  diagrams: string[],
  active: string | null | undefined,
  signal?: AbortSignal,
): Promise<CompareData | null> {
  const prev = prevStepName(diagrams, active);
  if (!prev || !active) return null;

  const [prevDsl, curDsl] = await Promise.all([fetchDsl(prev, signal), fetchDsl(active, signal)]);
  if (prevDsl === null || curDsl === null) return null;

  const before = parseDsl(prevDsl);
  const after = parseDsl(curDsl);
  if (!before.ok || !after.ok) return null;

  const { left, right } = buildCompareOverlays(diffDocs(before.doc, after.doc));
  return { prevName: prev, currentName: active, prevDoc: before.doc, left, right };
}
