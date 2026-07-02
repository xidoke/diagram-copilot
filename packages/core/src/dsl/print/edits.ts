/**
 * Edit primitives for v1.2 visual editing (DGC-17).
 *
 * Thin, DSL-text-in/DSL-text-out wrappers: each one parses the DSL, applies a
 * single semantic change to the resulting {@link DiagramDoc}, and delegates
 * the concrete-syntax-preserving rewrite to {@link applyDocEdit}. All of them
 * throw a descriptive `Error` on unknown ids, name conflicts, or DSL that
 * does not parse — they never return silently-wrong text.
 */

import type { DiagramDoc, DiagramEdge, DiagramGroup, DiagramNode } from "../../model/index.js";
import { parseDsl } from "../parse.js";
import { applyDocEdit } from "./apply.js";
import { assertPrintableName } from "./format.js";

function parseOrThrow(dsl: string, op: string): DiagramDoc {
  const result = parseDsl(dsl);
  if (!result.ok) {
    const details = [...result.parseErrors, ...result.modelErrors]
      .map((e) => ("line" in e ? `${e.line}:${e.column} ${e.message}` : `${e.path}: ${e.message}`))
      .join("; ");
    throw new Error(`${op}: DSL does not parse: ${details}`);
  }
  return result.doc;
}

function hasId(doc: DiagramDoc, id: string): boolean {
  return doc.nodes.some((n) => n.id === id) || doc.groups.some((g) => g.id === id);
}

/** New-node input for {@link addNode}: `label` defaults to the id. */
export interface NewNodeSpec {
  id: string;
  label?: string;
  icon?: string;
  color?: string;
  groupId?: string;
}

/**
 * Add a node. `groupId` (parameter or spec field, parameter wins) places it
 * inside an existing group — the declaration is inserted just before that
 * group's `}`; root nodes go after the last root-level declaration.
 */
export function addNode(dsl: string, node: NewNodeSpec, groupId?: string): string {
  const doc = parseOrThrow(dsl, "addNode");
  if (hasId(doc, node.id)) throw new Error(`addNode: id "${node.id}" already exists`);
  const created: DiagramNode = { id: node.id, label: node.label ?? node.id };
  if (node.icon !== undefined) created.icon = node.icon;
  if (node.color !== undefined) created.color = node.color;
  const target = groupId ?? node.groupId;
  if (target !== undefined) created.groupId = target;
  return applyDocEdit(dsl, { ...doc, nodes: [...doc.nodes, created] });
}

/** New-edge input for {@link addEdge}: `id` defaults to the next free `eN`. */
export interface NewEdgeSpec {
  id?: string;
  from: string;
  to: string;
  label?: string;
}

/** Add an edge (appended at the end of the file). Endpoints must already exist. */
export function addEdge(dsl: string, edge: NewEdgeSpec): string {
  const doc = parseOrThrow(dsl, "addEdge");
  const used = new Set(doc.edges.map((e) => e.id));
  let id = edge.id;
  if (id === undefined) {
    let n = doc.edges.length + 1;
    while (used.has(`e${n}`)) n += 1;
    id = `e${n}`;
  } else if (used.has(id)) {
    throw new Error(`addEdge: edge id "${id}" already exists`);
  }
  const created: DiagramEdge = { id, from: edge.from, to: edge.to };
  if (edge.label !== undefined && edge.label !== "") created.label = edge.label;
  return applyDocEdit(dsl, { ...doc, edges: [...doc.edges, created] });
}

/**
 * Rename a node or group. The name IS the id, so every reference follows:
 * edge statements mentioning the element are rewritten with the new name, a
 * default display label (label === old id) follows the rename, and an
 * explicit `label:` attribute is kept as-is. Renaming to the current name is
 * a no-op (returns the input verbatim).
 */
export function renameElement(dsl: string, id: string, newName: string): string {
  const doc = parseOrThrow(dsl, "renameElement");
  assertPrintableName(newName, "renameElement: new name");
  if (!hasId(doc, id)) throw new Error(`renameElement: no node or group with id "${id}"`);
  if (newName === id) return dsl;
  if (hasId(doc, newName)) throw new Error(`renameElement: id "${newName}" already exists`);

  const edited: DiagramDoc = {
    ...doc,
    nodes: doc.nodes.map((n) => {
      const copy: DiagramNode = { ...n };
      if (copy.id === id) {
        copy.id = newName;
        if (copy.label === id) copy.label = newName; // default label follows the name
      }
      if (copy.groupId === id) copy.groupId = newName;
      return copy;
    }),
    groups: doc.groups.map((g) => {
      const copy: DiagramGroup = { ...g };
      if (copy.id === id) {
        copy.id = newName;
        if (copy.label === id) copy.label = newName;
      }
      if (copy.parentId === id) copy.parentId = newName;
      return copy;
    }),
    edges: doc.edges.map((e) => ({
      ...e,
      from: e.from === id ? newName : e.from,
      to: e.to === id ? newName : e.to,
    })),
  };
  return applyDocEdit(dsl, edited, { renames: { [id]: newName } });
}

/** Attribute keys accepted by {@link setAttr}. */
export type ElementAttrKey = "icon" | "color" | "label";

/**
 * Set or clear (`value: null`) an attribute on a node, group, or — for
 * `label` only — an edge (addressed by its `eN` id). Clearing `label` on a
 * node/group resets the display label to the id.
 */
export function setAttr(dsl: string, id: string, key: ElementAttrKey, value: string | null): string {
  const doc = parseOrThrow(dsl, "setAttr");

  const applyToElement = <T extends DiagramNode | DiagramGroup>(element: T): T => {
    const copy = { ...element };
    if (key === "label") {
      copy.label = value === null ? copy.id : value;
    } else if (value === null) {
      delete copy[key];
    } else {
      copy[key] = value;
    }
    return copy;
  };

  if (doc.nodes.some((n) => n.id === id)) {
    return applyDocEdit(dsl, { ...doc, nodes: doc.nodes.map((n) => (n.id === id ? applyToElement(n) : n)) });
  }
  if (doc.groups.some((g) => g.id === id)) {
    return applyDocEdit(dsl, { ...doc, groups: doc.groups.map((g) => (g.id === id ? applyToElement(g) : g)) });
  }
  if (doc.edges.some((e) => e.id === id)) {
    if (key !== "label") throw new Error(`setAttr: edges only support the "label" attribute (got "${key}")`);
    return applyDocEdit(dsl, {
      ...doc,
      edges: doc.edges.map((e) => {
        if (e.id !== id) return e;
        const copy: DiagramEdge = { ...e };
        if (value === null || value === "") delete copy.label;
        else copy.label = value;
        return copy;
      }),
    });
  }
  throw new Error(`setAttr: no node, group, or edge with id "${id}"`);
}

/**
 * Move a node (sets `groupId`) or group (sets `parentId`) into `groupId`,
 * or to the document root with `null`. The target group must exist; moving a
 * group into its own subtree is rejected (nesting must stay acyclic).
 */
export function moveToGroup(dsl: string, id: string, groupId: string | null): string {
  const doc = parseOrThrow(dsl, "moveToGroup");
  if (groupId !== null && !doc.groups.some((g) => g.id === groupId)) {
    throw new Error(`moveToGroup: no group with id "${groupId}"`);
  }
  if (doc.nodes.some((n) => n.id === id)) {
    return applyDocEdit(dsl, {
      ...doc,
      nodes: doc.nodes.map((n) => {
        if (n.id !== id) return n;
        const copy: DiagramNode = { ...n };
        if (groupId === null) delete copy.groupId;
        else copy.groupId = groupId;
        return copy;
      }),
    });
  }
  if (doc.groups.some((g) => g.id === id)) {
    if (groupId === id) throw new Error(`moveToGroup: cannot move group "${id}" into itself`);
    return applyDocEdit(dsl, {
      ...doc,
      groups: doc.groups.map((g) => {
        if (g.id !== id) return g;
        const copy: DiagramGroup = { ...g };
        if (groupId === null) delete copy.parentId;
        else copy.parentId = groupId;
        return copy;
      }),
    });
  }
  throw new Error(`moveToGroup: no node or group with id "${id}"`);
}

/**
 * Remove one edge addressed by its endpoints (and optional label) instead of
 * its positional `eN` id. Edge ids are assigned by parse order, so a client
 * holding a stale view could delete the wrong edge by id — endpoints are
 * stable. `label` narrows parallel edges; when several `from > to` edges
 * exist with DIFFERENT labels and no `label` is given, the call is rejected
 * as ambiguous. Indistinguishable duplicates remove the first occurrence.
 */
export function removeEdge(dsl: string, from: string, to: string, label?: string): string {
  const doc = parseOrThrow(dsl, "removeEdge");
  const candidates = doc.edges.filter(
    (e) => e.from === from && e.to === to && (label === undefined || (e.label ?? "") === label),
  );
  if (candidates.length === 0) {
    throw new Error(`removeEdge: no edge ${from} > ${to}${label !== undefined ? `: ${label}` : ""}`);
  }
  const labels = [...new Set(candidates.map((e) => e.label ?? ""))];
  if (candidates.length > 1 && label === undefined && labels.length > 1) {
    const listed = labels.map((l) => (l === "" ? "(no label)" : `"${l}"`)).join(", ");
    throw new Error(
      `removeEdge: ${candidates.length} edges match ${from} > ${to} — pass a label to disambiguate (${listed})`,
    );
  }
  const removeId = candidates[0].id;
  return applyDocEdit(dsl, { ...doc, edges: doc.edges.filter((e) => e.id !== removeId) });
}

/**
 * Remove a node, group, or edge by id.
 * - Node: also removes every edge that references it.
 * - Group: cascades — descendant groups and member nodes are removed too,
 *   along with every edge touching any removed element.
 * - Edge (`eN` id, when it doesn't collide with an element id): just that edge.
 */
export function removeElement(dsl: string, id: string): string {
  const doc = parseOrThrow(dsl, "removeElement");

  if (doc.nodes.some((n) => n.id === id) || doc.groups.some((g) => g.id === id)) {
    const removed = new Set<string>([id]);
    // Transitive closure over group containment (groups list is small; loop until stable).
    let grew = true;
    while (grew) {
      grew = false;
      for (const g of doc.groups) {
        if (!removed.has(g.id) && g.parentId !== undefined && removed.has(g.parentId)) {
          removed.add(g.id);
          grew = true;
        }
      }
    }
    for (const n of doc.nodes) {
      if (n.groupId !== undefined && removed.has(n.groupId)) removed.add(n.id);
    }
    return applyDocEdit(dsl, {
      ...doc,
      nodes: doc.nodes.filter((n) => !removed.has(n.id)),
      groups: doc.groups.filter((g) => !removed.has(g.id)),
      edges: doc.edges.filter((e) => !removed.has(e.from) && !removed.has(e.to)),
    });
  }
  if (doc.edges.some((e) => e.id === id)) {
    return applyDocEdit(dsl, { ...doc, edges: doc.edges.filter((e) => e.id !== id) });
  }
  throw new Error(`removeElement: no node, group, or edge with id "${id}"`);
}
