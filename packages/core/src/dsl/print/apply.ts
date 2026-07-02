/**
 * applyDocEdit — minimal-diff DiagramDoc → DSL rewrite (DGC-17, the heart of
 * v1.2 visual editing).
 *
 * Given the original DSL text and an edited copy of the document it parses
 * to, produce new DSL text that realizes the edit while preserving concrete
 * syntax everywhere the document did not change:
 *
 * - unchanged statements keep their original line **byte-for-byte** (spacing,
 *   trailing comments, everything);
 * - blank lines and comment-only lines are kept in place;
 * - statement order is preserved;
 * - a changed statement is rewritten canonically **on its own line only**,
 *   re-attaching its original trailing comment (and the original gap before
 *   it);
 * - a moved element's declaration is removed from its old spot and inserted
 *   at the new container (nodes: just before the group's `}`, or after the
 *   last root-level declaration), carrying its trailing comment along;
 * - a deleted statement's line disappears together with its trailing comment
 *   (full-line comments around it stay);
 * - new nodes/groups are inserted into their container (groups render as
 *   fresh blocks); new edges are appended at the end of the file.
 *
 * No-op guarantee: `applyDocEdit(dsl, parseDsl(dsl).doc) === dsl` (byte
 * identity) — there is no special fast path; the algorithm simply keeps every
 * line verbatim when nothing changed, so the guarantee is structural, not
 * shortcut-based.
 *
 * ## Matching strategy (how orig ↔ edited elements pair up)
 *
 * - Nodes and groups match **by id** (the name IS the identity). A rename
 *   therefore looks like remove+add unless the caller supplies
 *   `options.renames` (old id → new id), which `renameElement` does; renamed
 *   elements then rewrite in place and every referencing edge statement is
 *   rewritten with the new name.
 * - Edges match by id first (ids are `parseDsl`'s positional `e1..eN`, so an
 *   edited doc derived from parsing this same text carries matching ids),
 *   then by content (`from`/`to`/`label`) for docs whose edge ids were
 *   renumbered. Unmatched original edges are removed; unmatched edited edges
 *   are new.
 * - A fan-out statement (`A > B, C: label`) covers several doc edges. It is
 *   kept verbatim only when *all* of its edges survive unchanged; otherwise
 *   it is re-emitted from the surviving edges, re-grouping consecutive
 *   same-source+label runs back into fan-out form, with the original
 *   trailing comment on the first emitted line.
 *
 * ## Known limits (documented, tested where relevant)
 *
 * - Edge ids are positional on re-parse: structural edits (removals,
 *   insertions) renumber `e1..eN` when the result is parsed again. Semantics
 *   and order are preserved; ids are canonicalized.
 * - If a node is declared on several lines (re-declaration merges), an edit
 *   to that node rewrites its *last* declaration with the full attribute set
 *   and strips attributes from earlier ones; moving such a node collapses it
 *   to a single declaration at the target.
 * - Deleting a group also drops the blank/comment lines inside its block;
 *   surviving children (re-parented in the edited doc) are re-inserted at
 *   their new container.
 * - Mixed EOL files are normalized to the dominant EOL flavour.
 */

import { validateDoc } from "../../model/index.js";
import type { DiagramDoc, DiagramEdge, DiagramGroup, DiagramNode } from "../../model/index.js";
import { parseDsl } from "../parse.js";
import { formatEdgeStatement, formatGroupHeader, formatNodeDecl } from "./format.js";
import { buildSourceTree, type Entry, type GroupEntry, type NodeEntry, type EdgesEntry } from "./source.js";
import { commentSuffixOf, indentOf, joinLines, reindent, splitLines } from "./text.js";

/** Options for {@link applyDocEdit}. */
export interface ApplyDocEditOptions {
  /**
   * Rename map (old id → new id) for nodes/groups whose *identity* changed.
   * Without it a rename is indistinguishable from remove+add (the id is the
   * name); with it the element rewrites in place, keeping its line position
   * and trailing comment, and every edge statement mentioning the old name is
   * rewritten. `renameElement` supplies this automatically.
   */
  renames?: Readonly<Record<string, string>>;
}

interface NodePlan {
  status: "same" | "rewrite" | "move" | "remove";
  edited?: DiagramNode;
}

interface GroupPlan {
  status: "same" | "rewrite" | "move" | "remove";
  /** True when the header line text must change (rename or attr/label change). */
  headerDirty: boolean;
  edited?: DiagramGroup;
}

interface EdgePlan {
  status: "same" | "rewrite" | "remove";
  edited?: DiagramEdge;
}

/**
 * Rewrite `originalDsl` so it parses to `editedDoc`, changing as little of
 * the original text as possible. Throws when the original text does not
 * parse or the edited document is invalid / cannot round-trip.
 */
export function applyDocEdit(originalDsl: string, editedDoc: DiagramDoc, options?: ApplyDocEditOptions): string {
  const parsed = parseDsl(originalDsl);
  if (!parsed.ok) {
    const details = [...parsed.parseErrors, ...parsed.modelErrors]
      .map((e) => ("line" in e ? `${e.line}:${e.column} ${e.message}` : `${e.path}: ${e.message}`))
      .join("; ");
    throw new Error(`applyDocEdit: original DSL does not parse: ${details}`);
  }
  const validated = validateDoc(editedDoc);
  if (!validated.ok) {
    throw new Error(
      `applyDocEdit: edited document is invalid: ${validated.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
    );
  }
  const orig = parsed.doc;
  const edited = validated.doc;

  const renames = new Map<string, string>(Object.entries(options?.renames ?? {}));
  const ren = (id: string | undefined): string | undefined => (id === undefined ? undefined : (renames.get(id) ?? id));

  const src = splitLines(originalDsl);
  const tree = buildSourceTree(originalDsl, src.lines);
  if (tree.edgeCount !== orig.edges.length) {
    throw new Error("applyDocEdit: edge numbering drifted from parseDsl (internal invariant)");
  }
  const line = (index: number): string => src.lines[index]!;

  // ---------------------------------------------------------------------
  // Phase 1 — diff: pair every original element with its edited counterpart.
  // ---------------------------------------------------------------------
  const editedNodesById = new Map(edited.nodes.map((n) => [n.id, n]));
  const editedGroupsById = new Map(edited.groups.map((g) => [g.id, g]));

  const nodePlans = new Map<string, NodePlan>(); // keyed by ORIGINAL id
  const origIdByEditedNodeId = new Map<string, string>();
  for (const o of orig.nodes) {
    const newId = ren(o.id)!;
    const e = editedNodesById.get(newId);
    if (e === undefined) {
      nodePlans.set(o.id, { status: "remove" });
      continue;
    }
    origIdByEditedNodeId.set(e.id, o.id);
    const moved = ren(o.groupId) !== e.groupId;
    // "same" means the declaration LINE text is already correct: identical
    // name and attrs. (A renamed *group* does not touch its members' lines.)
    const textStable = newId === o.id && o.label === e.label && o.icon === e.icon && o.color === e.color;
    nodePlans.set(o.id, { status: moved ? "move" : textStable ? "same" : "rewrite", edited: e });
  }

  const groupPlans = new Map<string, GroupPlan>(); // keyed by ORIGINAL id
  const origIdByEditedGroupId = new Map<string, string>();
  for (const o of orig.groups) {
    const newId = ren(o.id)!;
    const e = editedGroupsById.get(newId);
    if (e === undefined) {
      groupPlans.set(o.id, { status: "remove", headerDirty: false });
      continue;
    }
    origIdByEditedGroupId.set(e.id, o.id);
    const moved = ren(o.parentId) !== e.parentId;
    const headerStable = newId === o.id && o.label === e.label && o.icon === e.icon && o.color === e.color;
    groupPlans.set(o.id, {
      status: moved ? "move" : headerStable ? "same" : "rewrite",
      headerDirty: !headerStable,
      edited: e,
    });
  }

  // Edges: id match first, then content match (for renumbered edited docs).
  const edgePlans = new Map<string, EdgePlan>(); // keyed by ORIGINAL edge id
  const editedEdgesById = new Map(edited.edges.map((e) => [e.id, e]));
  const claimedEditedEdgeIds = new Set<string>();
  const edgeTextStable = (o: DiagramEdge, e: DiagramEdge): boolean =>
    o.from === e.from && o.to === e.to && o.label === e.label;
  const unmatchedOrigEdges: DiagramEdge[] = [];
  for (const o of orig.edges) {
    const e = editedEdgesById.get(o.id);
    if (e !== undefined && !claimedEditedEdgeIds.has(e.id)) {
      claimedEditedEdgeIds.add(e.id);
      edgePlans.set(o.id, { status: edgeTextStable(o, e) ? "same" : "rewrite", edited: e });
    } else {
      unmatchedOrigEdges.push(o);
    }
  }
  const unclaimedEditedEdges = edited.edges.filter((e) => !claimedEditedEdgeIds.has(e.id));
  for (const o of unmatchedOrigEdges) {
    const index = unclaimedEditedEdges.findIndex(
      (e) => ren(o.from) === e.from && ren(o.to) === e.to && o.label === e.label,
    );
    if (index === -1) {
      edgePlans.set(o.id, { status: "remove" });
      continue;
    }
    const [e] = unclaimedEditedEdges.splice(index, 1);
    claimedEditedEdgeIds.add(e!.id);
    edgePlans.set(o.id, { status: edgeTextStable(o, e!) ? "same" : "rewrite", edited: e });
  }
  const newEdges = edited.edges.filter((e) => !claimedEditedEdgeIds.has(e.id));

  const directionDirty = edited.direction !== orig.direction;
  const lastDirectionEntry = tree.directionEntries[tree.directionEntries.length - 1];

  // ---------------------------------------------------------------------
  // Phase 2 — insertion buckets: everything that needs a NEW line, grouped by
  // target container (edited-id space; `undefined` = document root).
  // ---------------------------------------------------------------------
  const nodeInsertions = new Map<string | undefined, Array<{ node: DiagramNode; commentSuffix: string }>>();
  const groupInsertions = new Map<string | undefined, Array<{ group: DiagramGroup; movedFrom?: GroupEntry }>>();
  const pushNodeInsertion = (node: DiagramNode, commentSuffix: string): void => {
    const list = nodeInsertions.get(node.groupId);
    if (list === undefined) nodeInsertions.set(node.groupId, [{ node, commentSuffix }]);
    else list.push({ node, commentSuffix });
  };
  const pushGroupInsertion = (group: DiagramGroup, movedFrom?: GroupEntry): void => {
    const list = groupInsertions.get(group.parentId);
    if (list === undefined) groupInsertions.set(group.parentId, [{ group, movedFrom }]);
    else list.push({ group, movedFrom });
  };

  // An implicit (edge-created) node only needs a declaration when it now
  // carries information a bare edge mention cannot express.
  const needsDecl = (n: DiagramNode): boolean =>
    n.icon !== undefined || n.color !== undefined || n.label !== n.id || n.groupId !== undefined;

  // Ids still mentioned by a surviving or new edge statement (edited-id
  // space). An implicit node whose every mentioning edge disappears would
  // silently vanish from the re-parsed doc, so it gets a declaration instead.
  const mentionedByEdges = new Set<string>();
  for (const plan of edgePlans.values()) {
    if (plan.status !== "remove" && plan.edited !== undefined) {
      mentionedByEdges.add(plan.edited.from);
      mentionedByEdges.add(plan.edited.to);
    }
  }
  for (const e of newEdges) {
    mentionedByEdges.add(e.from);
    mentionedByEdges.add(e.to);
  }

  for (const e of edited.nodes) {
    const origId = origIdByEditedNodeId.get(e.id);
    if (origId === undefined) {
      // Brand-new node: declare it even when bare, so it exists independent of edges.
      pushNodeInsertion(e, "");
      continue;
    }
    const plan = nodePlans.get(origId)!;
    const decls = tree.declsByNodeId.get(origId) ?? [];
    if (plan.status === "move") {
      // Old declaration line(s) drop; the (last declaration's) trailing
      // comment travels with the node to its new container.
      const primary = decls[decls.length - 1];
      pushNodeInsertion(e, primary === undefined ? "" : commentSuffixOf(line(primary.line)));
    } else if (plan.status !== "remove" && decls.length === 0 && (needsDecl(e) || !mentionedByEdges.has(e.id))) {
      // Implicit node that gained attrs/label, or whose last mentioning edge
      // was removed: it needs an explicit declaration to keep existing.
      pushNodeInsertion(e, "");
    }
  }
  for (const e of edited.groups) {
    const origId = origIdByEditedGroupId.get(e.id);
    if (origId === undefined) {
      pushGroupInsertion(e);
      continue;
    }
    if (groupPlans.get(origId)!.status === "move") {
      pushGroupInsertion(e, tree.groupsById.get(origId)!);
    }
  }

  // ---------------------------------------------------------------------
  // Phase 3 — emit: walk the source tree, keeping/rewriting/dropping each
  // line, then splice in the insertions.
  // ---------------------------------------------------------------------
  const out: string[] = [];
  // Root insertion anchor: right after the last root-level declaration
  // statement (node decl or group block); falls back to right after the last
  // `direction` line, then after the file's leading blank/comment block.
  let rootDeclAnchor = -1;
  let rootDirectionAnchor = -1;

  const renderNodeEntry = (entry: NodeEntry, delta: number, into: string[]): void => {
    const plan = nodePlans.get(entry.id)!;
    if (plan.status === "remove" || plan.status === "move") return; // line drops with its comment
    const text = line(entry.line);
    if (plan.status === "same") {
      into.push(reindent(text, delta));
      return;
    }
    // rewrite: the LAST declaration carries the full canonical state; earlier
    // ones are stripped to a bare (possibly renamed) name so no stale
    // attribute survives the re-declaration merge.
    const decls = tree.declsByNodeId.get(entry.id)!;
    const primary = decls[decls.length - 1];
    const edited_ = plan.edited!;
    if (entry === primary) {
      into.push(reindent(indentOf(text) + formatNodeDecl(edited_) + commentSuffixOf(text), delta));
    } else if (entry.hasAttrs || edited_.id !== entry.id) {
      into.push(reindent(indentOf(text) + formatNodeDecl({ id: edited_.id, label: edited_.id }) + commentSuffixOf(text), delta));
    } else {
      into.push(reindent(text, delta));
    }
  };

  const renderEdgesEntry = (entry: EdgesEntry, delta: number, into: string[]): void => {
    const plans = entry.edgeIds.map((id) => edgePlans.get(id)!);
    if (plans.every((p) => p.status === "same")) {
      into.push(reindent(line(entry.line), delta));
      return;
    }
    const survivors = plans.filter((p) => p.status !== "remove").map((p) => p.edited!);
    if (survivors.length === 0) return; // whole statement (and its comment) drops
    const text = line(entry.line);
    const indent = indentOf(text);
    const suffix = commentSuffixOf(text);
    // Re-group consecutive same-source+label runs back into fan-out lines so
    // e.g. renaming one target of `A > B, C: x` keeps a single statement.
    const runs: DiagramEdge[][] = [];
    for (const edge of survivors) {
      const run = runs[runs.length - 1];
      if (run !== undefined && run[0]!.from === edge.from && run[0]!.label === edge.label) run.push(edge);
      else runs.push([edge]);
    }
    runs.forEach((run, i) => {
      const statement = formatEdgeStatement(run[0]!.from, run.map((e) => e.to), run[0]!.label);
      into.push(reindent(indent + statement + (i === 0 ? suffix : ""), delta));
    });
  };

  const renderGroupBlock = (entry: GroupEntry, plan: GroupPlan, delta: number, into: string[]): void => {
    const headerText = line(entry.headerLine);
    if (plan.headerDirty) {
      into.push(reindent(indentOf(headerText) + formatGroupHeader(plan.edited!) + commentSuffixOf(headerText), delta));
    } else {
      into.push(reindent(headerText, delta));
    }
    renderChildren(entry.children, delta, into, { dropRaws: false, atRoot: false });
    renderInsertionsFor(plan.edited!.id, indentOf(headerText).length + delta + 2, into);
    into.push(reindent(line(entry.closeLine), delta));
  };

  const renderChildren = (
    entries: Entry[],
    delta: number,
    into: string[],
    ctx: { dropRaws: boolean; atRoot: boolean },
  ): void => {
    for (const entry of entries) {
      switch (entry.kind) {
        case "raw": {
          if (!ctx.dropRaws) into.push(reindent(line(entry.line), delta));
          break;
        }
        case "direction": {
          if (directionDirty && entry === lastDirectionEntry) {
            const text = line(entry.line);
            into.push(reindent(`${indentOf(text)}direction ${edited.direction}${commentSuffixOf(text)}`, delta));
          } else {
            into.push(reindent(line(entry.line), delta));
          }
          if (ctx.atRoot) rootDirectionAnchor = into.length;
          break;
        }
        case "node": {
          renderNodeEntry(entry, delta, into);
          if (ctx.atRoot) rootDeclAnchor = into.length;
          break;
        }
        case "edges": {
          renderEdgesEntry(entry, delta, into);
          break;
        }
        case "group": {
          const plan = groupPlans.get(entry.id)!;
          if (plan.status === "remove") {
            // Dissolve the block: header/close/comments drop; children were
            // either deleted or re-parented (rendered elsewhere), except
            // edge/direction statements which stay, dedented one level.
            renderChildren(entry.children, delta - 2, into, { dropRaws: true, atRoot: false });
          } else if (plan.status !== "move") {
            renderGroupBlock(entry, plan, delta, into);
          }
          if (ctx.atRoot) rootDeclAnchor = into.length;
          break;
        }
      }
    }
  };

  const renderInsertionsFor = (containerId: string | undefined, indentLen: number, into: string[]): void => {
    const indent = " ".repeat(indentLen);
    for (const { node, commentSuffix } of nodeInsertions.get(containerId) ?? []) {
      into.push(indent + formatNodeDecl(node) + commentSuffix);
    }
    for (const insertion of groupInsertions.get(containerId) ?? []) {
      if (insertion.movedFrom !== undefined) {
        const entry = insertion.movedFrom;
        const plan = groupPlans.get(entry.id)!;
        renderGroupBlock(entry, plan, indentLen - indentOf(line(entry.headerLine)).length, into);
      } else {
        into.push(indent + formatGroupHeader(insertion.group));
        renderInsertionsFor(insertion.group.id, indentLen + 2, into);
        into.push(`${indent}}`);
      }
    }
  };

  renderChildren(tree.entries, 0, out, { dropRaws: false, atRoot: true });

  // Leading raw block (file header comments / blanks) maps 1:1 to the first
  // output lines — the final fallback anchor for insertions.
  let leadingRaws = 0;
  while (leadingRaws < tree.entries.length && tree.entries[leadingRaws]!.kind === "raw") leadingRaws += 1;

  let insertAt = rootDeclAnchor !== -1 ? rootDeclAnchor : rootDirectionAnchor !== -1 ? rootDirectionAnchor : leadingRaws;
  if (directionDirty && lastDirectionEntry === undefined) {
    // No direction statement existed; state the new one explicitly up top.
    out.splice(leadingRaws, 0, `direction ${edited.direction}`);
    if (insertAt >= leadingRaws) insertAt += 1;
  }

  const rootInsertLines: string[] = [];
  renderInsertionsFor(undefined, 0, rootInsertLines);
  if (rootInsertLines.length > 0) out.splice(insertAt, 0, ...rootInsertLines);

  for (const edge of newEdges) {
    out.push(formatEdgeStatement(edge.from, [edge.to], edge.label));
  }

  return joinLines(out, src);
}
