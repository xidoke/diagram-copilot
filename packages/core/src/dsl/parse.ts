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
 * Parse eraser-style architecture DSL into a {@link DiagramDoc} (v0.3 scope:
 * `direction`, node declarations, `[icon:… color:… label:…]` attributes,
 * nested `{ … }` group blocks, `A > B` / `A > B: label` edges, one-to-many
 * `A > B, C, D` fan-out edges, and `//` line comments).
 *
 * Synchronous: uses Langium's `LangiumParser.parse()` directly — the grammar
 * has no cross-references, so no async document building/linking is needed.
 *
 * Mapping semantics (eraser-like):
 * - A node/group id and default label are the name as written, with runs of
 *   whitespace inside the name collapsed to a single space and outer
 *   whitespace trimmed (but no Unicode normalization — Vietnamese and other
 *   non-ASCII names round-trip verbatim and compare by raw code units). A
 *   `label:` attribute overrides the display label but never the id.
 * - `A > B, C, D` is one-to-many: each comma-separated target yields its own
 *   edge (`e1..eN` in source order); a trailing `: label` applies to all of
 *   them, and every endpoint is auto-created on first appearance.
 * - `//` starts a comment to end of line (hidden), so comments never shift a
 *   later error's line/column; a `//` swallowed by a greedy edge label is
 *   stripped here (comment wins over label content).
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
      message: friendlyParserMessage(error),
    });
  }

  if (parseErrors.length > 0) {
    return { ok: false, parseErrors, modelErrors: [] };
  }

  // DGC-104: a mermaid-style arrow (`A --> B`, `A -> B`, `A => B`, `A <- B`) is
  // NOT a lexer/parser error here — WORD accepts `-`, `=` and `<`, so the
  // arrow's `>` peels off as the edge operator and its dash/equals residue
  // glues onto the source name (`A --` + edge to B), or a reverse arrow is
  // swallowed whole into a single node id (`A <- B`). The parse "succeeds" into
  // a garbage diagram. Detect those arrow-shaped tokens on the AST and report a
  // fix-it diagnostic instead of silently building the wrong doc.
  collectArrowDiagnostics(result.value.lines, parseErrors);
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
      if (line.targets.length === 0) {
        declareNode(from, currentGroupId, parseAttrs(line, parseErrors));
      } else {
        ensureEndpoint(from);
        // EDGE_LABEL includes the leading ':' and, being greedy, may have
        // swallowed a trailing `//…` comment (the `:` out-lexes SL_COMMENT).
        // Strip the leading ':', drop any comment, and trim; the resulting
        // label — when non-empty — is shared by every fan-out edge.
        const label = line.label === undefined ? undefined : stripLineComment(line.label.slice(1)).trim();
        // One-to-many: `A > B, C, D` yields one edge per target, numbered
        // e1..eN in source order; implicit endpoints are auto-created once.
        for (const targetName of line.targets) {
          const to = joinName(targetName);
          ensureEndpoint(to);
          const edge: DiagramEdge = { id: `e${edges.length + 1}`, from, to };
          if (label !== undefined && label !== "") {
            edge.label = label;
          }
          edges.push(edge);
        }
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

// Mermaid-style arrows (DGC-104). arch-dsl uses a bare `>` for edges (`A > B`);
// reaching for mermaid syntax (`A --> B`, `A -> B`, `A => B`, `A <- B`) is a
// common mistake. Because WORD accepts `-`, `=` and `<`, such an arrow never
// fails to lex — the `>` splits off as the edge and the dash/equals residue
// clings to the name (`A --`), or a reverse arrow is glued whole into one node
// id (`A <- B`). We match the arrow tokens on the mapped AST — never a blind
// regex over raw text — so a legitimate dash *inside* a single WORD
// (`micro-service`, `us-east-1`) is untouched: only a STANDALONE dash/equals/
// `<-` token, sitting exactly where an edge operator was meant, trips the check.
const EDGE_ARROW_RESIDUE = /^(?:<?-+|=+)$/; // trailing name part before an edge `>`: - -- = <- <--
const REVERSE_ARROW = /^<-+$/; // `<-` / `<--` glued between two names (no `>` on the line)

/**
 * Recursively flag mermaid-style arrow tokens as fix-it {@link ParseError}s,
 * recursing into group bodies. Additive: appends to `parseErrors` and never
 * touches the grammar or a well-formed parse. See {@link EDGE_ARROW_RESIDUE}.
 */
function collectArrowDiagnostics(lines: Line[], parseErrors: ParseError[]): void {
  for (const line of lines) {
    if (!isStatement(line)) continue;
    const parts = line.source.parts;
    if (line.targets.length > 0) {
      // `X <arrow> Y`: the arrow's `>` became the edge, so its dash/equals
      // residue is the last WORD of the source name, immediately before `>`.
      const residue = parts[parts.length - 1]!;
      if (EDGE_ARROW_RESIDUE.test(residue)) {
        const realSource = parts.slice(0, -1).join(" ");
        parseErrors.push({
          ...partPosition(line.source, parts.length - 1),
          message: arrowMessage(`${residue}>`, realSource, joinName(line.targets[0]!)),
        });
      }
    } else {
      // No edge on this line: a reverse arrow `<-`/`<--` was glued between two
      // names into one node/group id. Flag the first one that precedes a name.
      for (let i = 0; i < parts.length - 1; i++) {
        if (REVERSE_ARROW.test(parts[i]!)) {
          // A reverse arrow points right-to-left, so the fix flips the endpoints.
          parseErrors.push({
            ...partPosition(line.source, i),
            message: arrowMessage(parts[i]!, parts.slice(i + 1).join(" "), parts.slice(0, i).join(" ")),
          });
          break;
        }
      }
    }
    if (line.isGroup) collectArrowDiagnostics(line.body, parseErrors);
  }
}

/**
 * The shared "arrow is not valid — use `>`" message, with a fix-it hint naming
 * both endpoints when we can recover them (`from`/`to` non-empty).
 */
function arrowMessage(arrow: string, from: string, to: string): string {
  const hint = from !== "" && to !== "" ? ` — did you mean "${from} > ${to}"?` : "";
  return `Mermaid-style arrow "${arrow}" is not valid here; arch-dsl uses ">" for edges${hint}`;
}

/** 1-based position of the WORD part at `index` inside a multi-word {@link Name}. */
function partPosition(name: Name, index: number): { line: number; column: number } {
  const cst = GrammarUtils.findNodeForProperty(name.$cstNode, "parts", index) ?? name.$cstNode;
  if (cst === undefined) {
    return { line: 1, column: 1 };
  }
  // CST ranges are 0-based (LSP convention); ParseError is 1-based.
  return { line: cst.range.start.line + 1, column: cst.range.start.character + 1 };
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

/**
 * Drop an inline `//…` comment from an edge label.
 *
 * Comments are a hidden `SL_COMMENT` terminal everywhere *except* inside an
 * `EDGE_LABEL`, whose greedy `:` swallows the rest of the line (including any
 * trailing `//…`). Per the DSL's "comment wins" rule, we cut the label at the
 * first `//`. A lone `/` is preserved (e.g. `read/write`), so only a double
 * slash starts a comment.
 */
function stripLineComment(label: string): string {
  const at = label.indexOf("//");
  return at === -1 ? label : label.slice(0, at);
}

/**
 * Minimal structural view of a Chevrotain `IRecognitionException`. Chevrotain
 * is a transitive dependency (not directly importable under pnpm), so we type
 * only the fields we read rather than importing the class.
 */
interface RecognitionErrorLike {
  name: string;
  message: string;
  token: { image: string; tokenType?: { name?: string } };
}

/**
 * Turn a verbose Chevrotain parser diagnostic into a short, actionable
 * one-line message shared by Claude self-correction and Monaco markers.
 *
 * The raw messages are multi-line and cryptic (e.g. "expecting at least one
 * iteration which starts with…"). We reduce them to `Unexpected <found>;
 * expected <what>.` using the error kind and the offending token, and never
 * emit a multi-line message. Line/column are handled by the caller and are
 * unaffected.
 */
function friendlyParserMessage(error: RecognitionErrorLike): string {
  const found = describeFoundToken(error.token);
  const expected = describeExpected(error);
  if (expected !== undefined) {
    return `Unexpected ${found}; expected ${expected}.`;
  }
  return `Unexpected ${found}.`;
}

/** Human phrase for the token the parser actually saw. */
function describeFoundToken(token: RecognitionErrorLike["token"]): string {
  const name = token.tokenType?.name;
  if (name === "EOF" || token.image === "") return "end of input";
  if (name === "NL" || token.image === "\n" || token.image === "\r\n") return "end of line";
  return `'${token.image}'`;
}

/**
 * Human phrase for what the parser wanted, or `undefined` to omit the
 * "expected …" clause. `EarlyExitException` only fires in this grammar where a
 * `Name` (`WORD+`) must begin — after `>`, after `,`, or at a statement start —
 * so it always means "a name". Other kinds carry the expected token type inside
 * the message (`type 'X'`), which we map to a friendly phrase; an expected
 * `EOF` (stray leading token) reads better as a bare "Unexpected …".
 */
function describeExpected(error: RecognitionErrorLike): string | undefined {
  if (error.name === "EarlyExitException") return "a name";
  const match = /type '([^']+)'|<\[(\w+)\]>/.exec(error.message);
  const expectedToken = match?.[1] ?? match?.[2];
  return expectedToken === undefined ? undefined : friendlyExpectedToken(expectedToken);
}

/** Friendly phrase for an expected token type; `undefined` drops the clause. */
function friendlyExpectedToken(name: string): string | undefined {
  switch (name) {
    case "WORD":
      return "a name";
    case "EDGE_LABEL":
      return "a label";
    case "ATTRS":
      return "attributes";
    case "NL":
      return "a new line";
    case "EOF":
      return undefined; // stray token: "Unexpected 'X'." reads cleaner
    default:
      return `'${name}'`; // structural keyword, e.g. }
  }
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
