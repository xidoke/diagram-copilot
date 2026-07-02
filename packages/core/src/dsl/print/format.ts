/**
 * Canonical statement formatters + printability guards (DGC-17).
 *
 * Shared by `printDsl` (full re-print) and `applyDocEdit` (per-line rewrite).
 * Every formatter validates its inputs against the grammar's lexical rules so
 * a doc that cannot survive a parse round-trip is rejected loudly instead of
 * silently producing different-meaning DSL.
 */

import type { DiagramGroup, DiagramNode } from "../../model/index.js";

/** Exactly the grammar's WORD terminal: one name part. */
const WORD_RE = /^[^\s>:{}[\],]+$/;

/**
 * Assert that `id` can appear as a node/group name and round-trip through the
 * parser unchanged:
 * - non-empty, no leading/trailing whitespace, single spaces between parts
 *   (the mapper collapses whitespace runs, so anything else cannot survive);
 * - each part matches WORD (no whitespace or structural `> : { } [ ] ,`);
 * - no part is the keyword `direction` (it would lex as a keyword token and
 *   break the name mid-way);
 * - no part starts with `//` (it would lex as a comment). A `//` *inside* a
 *   part (e.g. `TCP//IP`) is fine — WORD wins at a non-boundary position.
 */
export function assertPrintableName(id: string, what: string): void {
  if (id === "" || id !== id.trim()) {
    throw new Error(`${what}: name ${JSON.stringify(id)} must be non-empty without surrounding whitespace`);
  }
  for (const part of id.split(" ")) {
    if (part === "") {
      throw new Error(`${what}: name ${JSON.stringify(id)} must not contain consecutive spaces`);
    }
    if (!WORD_RE.test(part)) {
      throw new Error(
        `${what}: name ${JSON.stringify(id)} contains characters not allowed in a name (whitespace or one of > : { } [ ] ,)`,
      );
    }
    if (part === "direction") {
      throw new Error(`${what}: name ${JSON.stringify(id)} must not contain the reserved word "direction"`);
    }
    if (part.startsWith("//")) {
      throw new Error(`${what}: name ${JSON.stringify(id)} has a part starting with "//" (it would lex as a comment)`);
    }
  }
}

/**
 * Assert that an attribute value (`icon`, `color`, or a `label:` override)
 * round-trips inside a `[ … ]` block: non-empty, already trimmed (the parser
 * trims), and free of `]` (ends the ATTRS token), `,` (splits pairs) and
 * newlines. A `:` or `//` inside the value is fine — the whole bracket block
 * is one opaque token and only the first `:` of a pair is structural.
 */
export function assertPrintableAttrValue(value: string, what: string): void {
  if (value === "" || value !== value.trim()) {
    throw new Error(`${what}: attribute value ${JSON.stringify(value)} must be non-empty without surrounding whitespace`);
  }
  if (/[\],\r\n]/.test(value)) {
    throw new Error(`${what}: attribute value ${JSON.stringify(value)} must not contain "]", "," or newlines`);
  }
}

/**
 * Assert that an edge label round-trips through `: label to end of line`:
 * non-empty, already trimmed, single-line, and free of `//` (comment wins
 * over label content on re-parse, so a label containing `//` cannot survive).
 */
export function assertPrintableEdgeLabel(label: string, what: string): void {
  if (label === "" || label !== label.trim()) {
    throw new Error(`${what}: edge label ${JSON.stringify(label)} must be non-empty without surrounding whitespace`);
  }
  if (/[\r\n]/.test(label)) {
    throw new Error(`${what}: edge label ${JSON.stringify(label)} must not contain newlines`);
  }
  if (label.includes("//")) {
    throw new Error(`${what}: edge label ${JSON.stringify(label)} must not contain "//" (it would re-parse as a comment)`);
  }
}

/**
 * Canonical `[icon: …, color: …, label: …]` attribute block for a node or
 * group, or `""` when the element carries no attributes. The `label:`
 * attribute is emitted only when the display label differs from the id
 * (the id IS the default label). Canonical key order: icon, color, label.
 */
function formatAttrs(element: DiagramNode | DiagramGroup, what: string): string {
  const pairs: string[] = [];
  if (element.icon !== undefined) {
    assertPrintableAttrValue(element.icon, what);
    pairs.push(`icon: ${element.icon}`);
  }
  if (element.color !== undefined) {
    assertPrintableAttrValue(element.color, what);
    pairs.push(`color: ${element.color}`);
  }
  if (element.label !== element.id) {
    assertPrintableAttrValue(element.label, what);
    pairs.push(`label: ${element.label}`);
  }
  return pairs.length === 0 ? "" : `[${pairs.join(", ")}]`;
}

/** Canonical node declaration statement, e.g. `API Gateway [icon: server, color: orange]`. */
export function formatNodeDecl(node: DiagramNode): string {
  const what = `node "${node.id}"`;
  assertPrintableName(node.id, what);
  const attrs = formatAttrs(node, what);
  return attrs === "" ? node.id : `${node.id} ${attrs}`;
}

/** Canonical group header statement, e.g. `Data tier [color: blue] {` (the `{` included). */
export function formatGroupHeader(group: DiagramGroup): string {
  const what = `group "${group.id}"`;
  assertPrintableName(group.id, what);
  const attrs = formatAttrs(group, what);
  return attrs === "" ? `${group.id} {` : `${group.id} ${attrs} {`;
}

/**
 * Canonical edge statement, e.g. `LB > API Server A, API Server B: round robin`.
 * All targets share the source and (optional) label — the DSL's one-to-many
 * fan-out form. An `undefined` label prints no `:` suffix.
 */
export function formatEdgeStatement(from: string, targets: string[], label: string | undefined): string {
  assertPrintableName(from, `edge source "${from}"`);
  for (const target of targets) assertPrintableName(target, `edge target "${target}"`);
  const head = `${from} > ${targets.join(", ")}`;
  if (label === undefined) return head;
  assertPrintableEdgeLabel(label, `edge "${from} > ${targets.join(", ")}"`);
  return `${head}: ${label}`;
}
