import { GrammarUtils, type AstNode } from "langium";
import type { ModelError, ParseError } from "../errors.js";
import { DirectionSchema, validateDoc } from "../model/index.js";
import type {
  DiagramDoc,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  Direction,
} from "../model/index.js";
import { isDirectionLine, isStatement, type Document, type Line, type Name, type Statement } from "./generated/ast.js";
import { createArchDslServices } from "./services.js";

/**
 * Result of {@link parseDsl}.
 *
 * - Syntax problems (lexer/parser diagnostics, invalid `direction` value,
 *   malformed/unknown attributes) surface as `parseErrors` with 1-based
 *   line/column.
 * - Semantic problems found by {@link validateDoc} on the mapped document
 *   surface as `modelErrors`.
 * - The two error lists never mix: when syntax fails we do not attempt
 *   semantic validation (`modelErrors` is `[]`), and vice versa.
 */
export type ParseDslResult =
  | { ok: true; doc: DiagramDoc }
  | { ok: false; parseErrors: ParseError[]; modelErrors: ModelError[] };

// Building the Langium services compiles the Chevrotain parser; do it once
// at module load and reuse the (stateless w.r.t. input) parser for all calls.
const services = createArchDslServices();
const parser = services.ArchDsl.parser.LangiumParser;

/** Attribute keys accepted inside `[ … ]` (v0.2). */
const ATTR_KEYS = ["icon", "color", "label"] as const;
type AttrKey = (typeof ATTR_KEYS)[number];
type Attrs = Partial<Record<AttrKey, string>>;

/**
 * Parse eraser-style architecture DSL into a {@link DiagramDoc} (v0.2 scope:
 * `direction`, node declarations, `[icon:… color:… label:…]` attributes,
 * nested `{ … }` group blocks, and `A > B` / `A > B: label` edges).
 *
 * Synchronous: uses Langium's `LangiumParser.parse()` directly — the grammar
 * has no cross-references, so no async document building/linking is needed.
 *
 * Mapping semantics (eraser-like):
 * - A node/group id and default label are the name as written, with runs of
 *   whitespace inside the name collapsed to a single space and outer
 *   whitespace trimmed. A `label:` attribute overrides the display label but
 *   never the id.
 * - A `{ … }` block declares a group; nodes/groups inside it get
 *   `groupId` / `parentId` set to the nearest enclosing group.
 * - Edges may reference nodes *or* groups; an endpoint that is a known group
 *   is left as-is, otherwise an implicit (group-less) node is auto-created.
 * - Explicit declaration wins: a node first seen implicitly (via an edge)
 *   and later declared explicitly inside a group takes on that group and any
 *   attributes. Implicit edge references never mutate an existing node.
 *   Declaring a node inside a group assigns its membership; the last such
 *   declaration wins.
 * - Re-declaring an existing name merges attributes onto the same node.
 * - Nodes appear in order of first appearance in the source (depth-first);
 *   edge ids are positional (`e1`, `e2`, …) in source order.
 * - Edge labels run from `:` to end of line and are trimmed; a label that is
 *   empty after trimming is omitted.
 * - `direction` defaults to `right`; if stated multiple times the last wins.
 */
export function parseDsl(dsl: string): ParseDslResult {
  // The grammar consumes statements as `(Line? NL)*`, so ensure the final
  // line is NL-terminated. Appending at EOF never shifts error positions.
  const text = dsl.endsWith("\n") ? dsl : `${dsl}\n`;
  const result = parser.parse<Document>(text);

  const parseErrors: ParseError[] = [];

  for (const error of result.lexerErrors) {
    parseErrors.push({
      line: positiveOr(error.line, 1),
      column: positiveOr(error.column, 1),
      message: error.message,
    });
  }

  for (const error of result.parserErrors) {
    const fallback = endPosition(text);
    parseErrors.push({
      line: positiveOr(error.token.startLine, fallback.line),
      column: positiveOr(error.token.startColumn, fallback.column),
      message: error.message,
    });
  }

  if (parseErrors.length > 0) {
    return { ok: false, parseErrors, modelErrors: [] };
  }

  // AST → DiagramDoc.
  let direction: Direction = "right";
  const nodesById = new Map<string, DiagramNode>();
  const groups: DiagramGroup[] = [];
  const edges: DiagramEdge[] = [];

  // Pass 1: collect every group id so edge endpoints referencing a group
  // (possibly declared later) are not auto-created as spurious nodes.
  const groupIds = new Set<string>();
  collectGroupIds(result.value.lines, groupIds);

  // An edge endpoint references either a known group (left as-is) or a node
  // (auto-created, group-less, on first appearance).
  const ensureEndpoint = (id: string): void => {
    if (groupIds.has(id)) return;
    if (!nodesById.has(id)) {
      nodesById.set(id, { id, label: id });
    }
  };

  // An explicit node declaration create-or-upgrades the node: assigns its
  // enclosing group (if any) and applies its attributes.
  const declareNode = (id: string, groupId: string | undefined, attrs: Attrs): void => {
    let node = nodesById.get(id);
    if (node === undefined) {
      node = { id, label: id };
      nodesById.set(id, node);
    }
    if (groupId !== undefined) node.groupId = groupId;
    if (attrs.label !== undefined) node.label = attrs.label;
    if (attrs.icon !== undefined) node.icon = attrs.icon;
    if (attrs.color !== undefined) node.color = attrs.color;
  };

  // Pass 2: build nodes/groups/edges in source order (depth-first).
  const walk = (lines: Line[], currentGroupId: string | undefined): void => {
    for (const line of lines) {
      if (isDirectionLine(line)) {
        const parsed = DirectionSchema.safeParse(line.value);
        if (!parsed.success) {
          parseErrors.push({
            ...propertyPosition(line, "value"),
            message: `Invalid direction "${line.value}" — expected right, left, up, or down`,
          });
          continue;
        }
        direction = parsed.data; // last statement wins
        continue;
      }

      if (line.isGroup) {
        const id = joinName(line.source);
        const attrs = parseAttrs(line, parseErrors);
        const group: DiagramGroup = { id, label: attrs.label ?? id };
        if (currentGroupId !== undefined) group.parentId = currentGroupId;
        if (attrs.icon !== undefined) group.icon = attrs.icon;
        if (attrs.color !== undefined) group.color = attrs.color;
        groups.push(group);
        walk(line.body, id);
        continue;
      }

      const from = joinName(line.source);
      if (line.target === undefined) {
        declareNode(from, currentGroupId, parseAttrs(line, parseErrors));
      } else {
        const to = joinName(line.target);
        ensureEndpoint(from);
        ensureEndpoint(to);
        const edge: DiagramEdge = { id: `e${edges.length + 1}`, from, to };
        // EDGE_LABEL includes the leading ':'; strip it and trim.
        const label = line.label?.slice(1).trim();
        if (label !== undefined && label !== "") {
          edge.label = label;
        }
        edges.push(edge);
      }
    }
  };

  walk(result.value.lines, undefined);

  if (parseErrors.length > 0) {
    return { ok: false, parseErrors, modelErrors: [] };
  }

  const doc: DiagramDoc = {
    type: "architecture",
    direction,
    nodes: [...nodesById.values()],
    groups,
    edges,
  };

  const validated = validateDoc(doc);
  if (!validated.ok) {
    return { ok: false, parseErrors: [], modelErrors: validated.errors };
  }
  return { ok: true, doc: validated.doc };
}

/** Recursively collect the ids of every group (`{ … }` block). */
function collectGroupIds(lines: Line[], into: Set<string>): void {
  for (const line of lines) {
    if (isStatement(line) && line.isGroup) {
      into.add(joinName(line.source));
      collectGroupIds(line.body, into);
    }
  }
}

/**
 * Parse a statement's opaque `ATTRS` token (`[key: value, …]`) into a typed
 * {@link Attrs} record. Unknown keys, missing colons, and empty values are
 * reported as {@link ParseError}s pointed at the attribute list. The whole
 * bracket block is one lexer token (the DSL's `:` always lexes as an edge
 * label), so keys/values are split here rather than in the grammar.
 */
function parseAttrs(statement: Statement, parseErrors: ParseError[]): Attrs {
  const raw = statement.attrs;
  if (raw === undefined) return {};
  const attrs: Attrs = {};
  const inner = raw.slice(1, -1); // strip surrounding [ ]
  for (const rawPair of inner.split(",")) {
    const pair = rawPair.trim();
    if (pair === "") continue; // tolerate `[]`, trailing/leading commas
    const colon = pair.indexOf(":");
    if (colon === -1) {
      parseErrors.push({
        ...propertyPosition(statement, "attrs"),
        message: `Malformed attribute "${pair}" — expected "key: value"`,
      });
      continue;
    }
    const key = pair.slice(0, colon).trim();
    const value = pair.slice(colon + 1).trim();
    if (!isAttrKey(key)) {
      parseErrors.push({
        ...propertyPosition(statement, "attrs"),
        message: `Unknown attribute "${key}" — expected ${ATTR_KEYS.join(", ")}`,
      });
      continue;
    }
    if (value === "") {
      parseErrors.push({
        ...propertyPosition(statement, "attrs"),
        message: `Attribute "${key}" requires a value`,
      });
      continue;
    }
    attrs[key] = value;
  }
  return attrs;
}

function isAttrKey(key: string): key is AttrKey {
  return (ATTR_KEYS as readonly string[]).includes(key);
}

/** Join a parsed multi-word name back into a single-space-separated string. */
function joinName(name: Name): string {
  return name.parts.join(" ");
}

/** Chevrotain positions can be NaN/undefined (e.g. at EOF); guard them. */
function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? value : fallback;
}

/** 1-based position just past the end of the text (fallback for EOF errors). */
function endPosition(text: string): { line: number; column: number } {
  const lines = text.split(/\r\n|\r|\n/);
  return { line: lines.length, column: lines[lines.length - 1]!.length + 1 };
}

/** 1-based position of an AST property's CST node (fallbacks to the node, then 1:1). */
function propertyPosition(node: AstNode, property: string): { line: number; column: number } {
  const cst = GrammarUtils.findNodeForProperty(node.$cstNode, property) ?? node.$cstNode;
  if (cst === undefined) {
    return { line: 1, column: 1 };
  }
  // CST ranges are 0-based (LSP convention); ParseError is 1-based.
  return { line: cst.range.start.line + 1, column: cst.range.start.character + 1 };
}
