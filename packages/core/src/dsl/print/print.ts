/**
 * printDsl — canonical DiagramDoc → DSL text (DGC-17).
 *
 * Produces a clean, freshly formatted document (no concrete syntax to
 * preserve — that is `applyDocEdit`'s job):
 *
 * ```
 * direction right
 *
 * Client [icon: monitor]
 *
 * Service tier {
 *   LB [icon: network, color: blue]
 *   Inner group {
 *     …
 *   }
 * }
 *
 * Client > LB: HTTPS request
 * ```
 *
 * Format decisions (deliberate, tested):
 * - `direction` is always emitted first, even when it is the default
 *   (`right`) — explicit beats implicit for a generated file.
 * - Every node gets an explicit declaration (even bare, attribute-less ones
 *   that edges would auto-create) so the re-parsed node order matches the
 *   printed order, not edge-appearance order.
 * - Groups nest with 2-space indentation; a blank line precedes each
 *   top-level group block and the edge section.
 * - Edges print one per line in `doc.edges` order — fan-out targets are NOT
 *   re-grouped into `A > B, C` even when source+label match, because
 *   1-edge-1-line keeps the mapping between text lines and `DiagramEdge`s
 *   trivial for v1.2 visual editing. (`applyDocEdit` still preserves existing
 *   fan-out lines; this choice only affects freshly printed text.)
 * - Attribute order is canonical: `icon`, `color`, then `label` (the `label:`
 *   attribute appears only when the display label differs from the id).
 * - Within a container, members (nodes and child groups) are ordered by their
 *   first appearance in `doc.nodes` (a group ranks at its earliest descendant
 *   node; empty groups sort last). For any `parseDsl`-produced doc this
 *   reconstructs the original declaration order, so
 *   `parseDsl(printDsl(doc)).doc` deep-equals `doc`.
 *
 * Known limits (throw with a clear message rather than emit lossy DSL):
 * - names/labels that cannot re-parse (structural characters, the word
 *   `direction`, `//`-leading parts, non-trimmed or empty values) are
 *   rejected — see the guards in `format.ts`;
 * - edge ids are positional on parse (`e1..eN`); printing preserves edge
 *   *order*, so docs whose edge ids are not already `e1..eN` in order will
 *   re-parse with renumbered ids (semantics preserved, ids canonicalized).
 */

import { validateDoc } from "../../model/index.js";
import type { DiagramDoc, DiagramGroup, DiagramNode } from "../../model/index.js";
import { formatEdgeStatement, formatGroupHeader, formatNodeDecl } from "./format.js";

type Member =
  | { kind: "node"; node: DiagramNode; rank: number }
  | { kind: "group"; group: DiagramGroup; rank: number };

/** Render a {@link DiagramDoc} as canonical arch-dsl text. Throws on docs that cannot round-trip. */
export function printDsl(doc: DiagramDoc): string {
  const validated = validateDoc(doc);
  if (!validated.ok) {
    throw new Error(
      `printDsl: invalid document — ${validated.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
  }
  const d = validated.doc;

  // First-appearance rank: nodes rank by index in doc.nodes; a group ranks at
  // its earliest member (recursively), so sibling order reconstructs the
  // declaration order of any parseDsl-produced doc. Empty groups rank last.
  const nodeRank = new Map<string, number>(d.nodes.map((n, i) => [n.id, i]));
  const nodesByGroup = new Map<string | undefined, DiagramNode[]>();
  for (const node of d.nodes) {
    const list = nodesByGroup.get(node.groupId);
    if (list === undefined) nodesByGroup.set(node.groupId, [node]);
    else list.push(node);
  }
  const groupsByParent = new Map<string | undefined, DiagramGroup[]>();
  for (const group of d.groups) {
    const list = groupsByParent.get(group.parentId);
    if (list === undefined) groupsByParent.set(group.parentId, [group]);
    else list.push(group);
  }
  const groupRankMemo = new Map<string, number>();
  const groupRank = (group: DiagramGroup): number => {
    const memo = groupRankMemo.get(group.id);
    if (memo !== undefined) return memo;
    let rank = Number.POSITIVE_INFINITY;
    for (const node of nodesByGroup.get(group.id) ?? []) {
      rank = Math.min(rank, nodeRank.get(node.id)!);
    }
    for (const child of groupsByParent.get(group.id) ?? []) {
      rank = Math.min(rank, groupRank(child));
    }
    groupRankMemo.set(group.id, rank);
    return rank;
  };

  const membersOf = (containerId: string | undefined): Member[] => {
    const members: Member[] = [
      ...(nodesByGroup.get(containerId) ?? []).map((node): Member => ({ kind: "node", node, rank: nodeRank.get(node.id)! })),
      ...(groupsByParent.get(containerId) ?? []).map((group): Member => ({ kind: "group", group, rank: groupRank(group) })),
    ];
    // Stable sort: ties (only possible at Infinity, i.e. empty groups) keep
    // nodes-then-groups insertion order.
    return members.sort((a, b) => a.rank - b.rank);
  };

  const out: string[] = [`direction ${d.direction}`];

  const emitMember = (member: Member, depth: number): void => {
    const indent = "  ".repeat(depth);
    if (member.kind === "node") {
      out.push(indent + formatNodeDecl(member.node));
      return;
    }
    // A blank line before each top-level group block keeps sections readable.
    if (depth === 0 && out[out.length - 1] !== "") out.push("");
    out.push(indent + formatGroupHeader(member.group));
    for (const child of membersOf(member.group.id)) emitMember(child, depth + 1);
    out.push(`${indent}}`);
  };

  const rootMembers = membersOf(undefined);
  if (rootMembers.length > 0) out.push("");
  for (const member of rootMembers) emitMember(member, 0);

  if (d.edges.length > 0) {
    if (out[out.length - 1] !== "") out.push("");
    for (const edge of d.edges) {
      out.push(formatEdgeStatement(edge.from, [edge.to], edge.label));
    }
  }

  return `${out.join("\n")}\n`;
}
