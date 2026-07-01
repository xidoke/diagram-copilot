import { GrammarUtils, type AstNode } from "langium";
import type { ModelError, ParseError } from "../errors.js";
import { DirectionSchema, validateDoc } from "../model/index.js";
import type { DiagramDoc, DiagramEdge, DiagramNode, Direction } from "../model/index.js";
import { isDirectionLine, type Document, type Name } from "./generated/ast.js";
import { createArchDslServices } from "./services.js";

/**
 * Result of {@link parseDsl}.
 *
 * - Syntax problems (lexer/parser diagnostics, invalid `direction` value)
 *   surface as `parseErrors` with 1-based line/column.
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

/**
 * Parse eraser-style architecture DSL into a {@link DiagramDoc} (v0.1 scope:
 * `direction`, node declarations, `A > B` / `A > B: label` edges).
 *
 * Synchronous: uses Langium's `LangiumParser.parse()` directly — the grammar
 * has no cross-references, so no async document building/linking is needed.
 *
 * Mapping semantics (eraser-like):
 * - A node's id and label are the name as written, with runs of whitespace
 *   inside the name collapsed to a single space and outer whitespace trimmed
 *   (names are tokenized as words; hidden spacing is not preserved).
 * - Re-declaring an existing name is a no-op (no duplicate-id error).
 * - Edges referencing undeclared names auto-create those nodes; nodes appear
 *   in order of first appearance in the source.
 * - Edge ids are positional: `e1`, `e2`, … in source order.
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
  const edges: DiagramEdge[] = [];
  const ensureNode = (name: string): void => {
    if (!nodesById.has(name)) {
      nodesById.set(name, { id: name, label: name });
    }
  };

  for (const line of result.value.lines) {
    if (isDirectionLine(line)) {
      const parsed = DirectionSchema.safeParse(line.value);
      if (!parsed.success) {
        const position = propertyPosition(line, "value");
        parseErrors.push({
          ...position,
          message: `Invalid direction "${line.value}" — expected right, left, up, or down`,
        });
        continue;
      }
      direction = parsed.data; // last statement wins
    } else {
      const from = joinName(line.source);
      if (line.target === undefined) {
        ensureNode(from);
      } else {
        const to = joinName(line.target);
        ensureNode(from);
        ensureNode(to);
        const edge: DiagramEdge = { id: `e${edges.length + 1}`, from, to };
        // EDGE_LABEL includes the leading ':'; strip it and trim.
        const label = line.label?.slice(1).trim();
        if (label !== undefined && label !== "") {
          edge.label = label;
        }
        edges.push(edge);
      }
    }
  }

  if (parseErrors.length > 0) {
    return { ok: false, parseErrors, modelErrors: [] };
  }

  const doc: DiagramDoc = {
    type: "architecture",
    direction,
    nodes: [...nodesById.values()],
    groups: [],
    edges,
  };

  const validated = validateDoc(doc);
  if (!validated.ok) {
    return { ok: false, parseErrors: [], modelErrors: validated.errors };
  }
  return { ok: true, doc: validated.doc };
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
