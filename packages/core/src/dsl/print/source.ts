/**
 * Source tree — the concrete-syntax map behind `applyDocEdit` (DGC-17).
 *
 * Strategy (chosen over raw CST offsets): the grammar is strictly
 * line-oriented — one statement per line, a group's `{` header and `}` footer
 * each own their line, and hidden comments/blank lines produce no AST node.
 * So the AST's statements, walked depth-first, correspond 1:1 and *in order*
 * to the file's non-raw lines. We walk both in lockstep with a cursor,
 * yielding an entry tree where:
 *
 * - every statement entry records its physical line number(s), and
 * - every blank/comment-only line becomes a `raw` entry attached to the
 *   container (document or group body) it physically sits in.
 *
 * This avoids depending on how Langium attaches hidden tokens to composite
 * CST node ranges, and gives byte-exact "keep this line" semantics for free.
 * Structural invariants are asserted; a mismatch means a grammar change broke
 * the line-oriented assumption and this module must be revisited.
 *
 * Edge ids are re-derived here with exactly `parseDsl`'s numbering rule
 * (`e1..eN`, one per fan-out target, depth-first source order) so each edge
 * statement knows which `DiagramEdge` ids it produced.
 */

import { isDirectionLine, type Document, type Line, type Name } from "../generated/ast.js";
import { createArchDslServices } from "../services.js";
import { isRawLine, splitTrailingComment } from "./text.js";

// Compile the Chevrotain parser once at module load, same as parse.ts does.
// (parse.ts keeps its parser module-private; building a second instance costs
// a few ms once and keeps the frozen parse.ts contract untouched.)
const services = createArchDslServices();
const parser = services.ArchDsl.parser.LangiumParser;

/** A blank or comment-only line, kept verbatim. */
export interface RawEntry {
  kind: "raw";
  line: number;
}

/** A `direction <value>` statement. */
export interface DirectionEntry {
  kind: "direction";
  line: number;
  value: string;
}

/** A node declaration statement (`Name` or `Name [attrs]`). */
export interface NodeEntry {
  kind: "node";
  line: number;
  /** Node id (multi-word name joined with single spaces). */
  id: string;
  /** Whether the statement carries a `[ … ]` attribute block. */
  hasAttrs: boolean;
}

/** An edge statement (`A > B` / `A > B, C: label`) covering one or more doc edges. */
export interface EdgesEntry {
  kind: "edges";
  line: number;
  from: string;
  targets: string[];
  /** The `DiagramEdge` ids this statement produced, in target order. */
  edgeIds: string[];
}

/** A group block: header line, nested children, close line. */
export interface GroupEntry {
  kind: "group";
  headerLine: number;
  closeLine: number;
  id: string;
  children: Entry[];
}

export type Entry = RawEntry | DirectionEntry | NodeEntry | EdgesEntry | GroupEntry;

/** The full concrete-syntax map of one DSL text. */
export interface SourceTree {
  /** Top-level entries in source order (including leading/trailing raw lines). */
  entries: Entry[];
  /** Every declaration statement per node id, in source order (re-declaration merges). */
  declsByNodeId: Map<string, NodeEntry[]>;
  /** Group block per group id (ids are unique in a valid doc). */
  groupsById: Map<string, GroupEntry>;
  /** Every `direction` statement in source order (the last one wins). */
  directionEntries: DirectionEntry[];
  /** Total number of doc edges produced (sanity-checked against the parsed doc). */
  edgeCount: number;
}

function joinName(name: Name): string {
  return name.parts.join(" ");
}

/**
 * Build the {@link SourceTree} for a DSL text that is already known to parse
 * cleanly (callers go through `parseDsl` first). `lines` must be the result
 * of splitting the same text (see `text.ts`).
 */
export function buildSourceTree(text: string, lines: string[]): SourceTree {
  const parsed = parser.parse<Document>(text.endsWith("\n") ? text : `${text}\n`);
  if (parsed.lexerErrors.length > 0 || parsed.parserErrors.length > 0) {
    throw new Error("buildSourceTree: text does not parse (callers must validate with parseDsl first)");
  }

  const tree: SourceTree = {
    entries: [],
    declsByNodeId: new Map(),
    groupsById: new Map(),
    directionEntries: [],
    edgeCount: 0,
  };

  let cursor = 0;

  const consumeRaws = (into: Entry[]): void => {
    while (cursor < lines.length && isRawLine(lines[cursor]!)) {
      into.push({ kind: "raw", line: cursor });
      cursor += 1;
    }
  };

  const takeContentLine = (): number => {
    if (cursor >= lines.length) {
      throw new Error("buildSourceTree: ran out of lines while statements remain (grammar/line-model drift)");
    }
    return cursor++;
  };

  const walk = (astLines: Line[], into: Entry[]): void => {
    for (const line of astLines) {
      consumeRaws(into);
      if (isDirectionLine(line)) {
        const entry: DirectionEntry = { kind: "direction", line: takeContentLine(), value: line.value };
        into.push(entry);
        tree.directionEntries.push(entry);
        continue;
      }
      if (line.isGroup) {
        const entry: GroupEntry = {
          kind: "group",
          headerLine: takeContentLine(),
          closeLine: -1,
          id: joinName(line.source),
          children: [],
        };
        walk(line.body, entry.children);
        consumeRaws(entry.children); // blanks/comments between last child and `}`
        entry.closeLine = takeContentLine();
        if (splitTrailingComment(lines[entry.closeLine]!).code.trim() !== "}") {
          throw new Error("buildSourceTree: expected a lone `}` close line (grammar/line-model drift)");
        }
        tree.groupsById.set(entry.id, entry);
        into.push(entry);
        continue;
      }
      if (line.targets.length > 0) {
        const entry: EdgesEntry = {
          kind: "edges",
          line: takeContentLine(),
          from: joinName(line.source),
          targets: line.targets.map(joinName),
          edgeIds: line.targets.map(() => `e${++tree.edgeCount}`),
        };
        into.push(entry);
        continue;
      }
      const entry: NodeEntry = {
        kind: "node",
        line: takeContentLine(),
        id: joinName(line.source),
        hasAttrs: line.attrs !== undefined,
      };
      into.push(entry);
      const decls = tree.declsByNodeId.get(entry.id);
      if (decls === undefined) tree.declsByNodeId.set(entry.id, [entry]);
      else decls.push(entry);
    }
  };

  walk(parsed.value.lines, tree.entries);
  consumeRaws(tree.entries); // trailing blanks/comments after the last statement
  if (cursor !== lines.length) {
    throw new Error("buildSourceTree: leftover lines after the last statement (grammar/line-model drift)");
  }
  return tree;
}
