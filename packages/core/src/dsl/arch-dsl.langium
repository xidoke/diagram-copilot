/**
 * arch-dsl — minimal eraser-style architecture DSL (DGC-26, v0.1 scope).
 *
 * Supported statements (one per line):
 *   direction right|left|up|down
 *   Node Name With Spaces
 *   Some Node > Other Node
 *   Some Node > Other Node: edge label to end of line
 *
 * Design notes:
 * - Newlines are significant (statement separators), so NL is a real
 *   terminal and only spaces/tabs are hidden.
 * - Multi-word names are parsed as `WORD+` and re-joined with single
 *   spaces during AST→doc mapping (whitespace inside names is
 *   normalized). WORD is a negated class, so basic Unicode names
 *   (e.g. Vietnamese) work for free.
 * - Node vs edge lines are left-factored into one `StatementLine` rule
 *   (`Name ('>' Name (label)?)?`) to stay LL(1): both start with an
 *   unbounded `WORD+` and could not be distinguished with fixed
 *   lookahead otherwise.
 * - The direction value is a plain WORD (validated in TypeScript), so
 *   `right`/`left`/`up`/`down` are NOT reserved words and stay usable
 *   in node names. Only `direction` itself is a keyword.
 * - EDGE_LABEL eats `:` plus the rest of the line, so labels may
 *   contain further colons.
 *
 * v0.1 explicitly excludes groups `{}`, `[icon: …]` attributes,
 * comments, and one-to-many edges (T9/T10).
 */
grammar ArchDsl

entry Document:
    (lines+=Line? NL)*;

Line:
    DirectionLine | StatementLine;

DirectionLine:
    'direction' value=WORD;

StatementLine:
    source=Name ('>' target=Name (label=EDGE_LABEL)?)?;

Name:
    parts+=WORD+;

terminal NL: /\r?\n/;
terminal EDGE_LABEL: /:[^\n\r]*/;
terminal WORD: /[^\s>:]+/;
hidden terminal WS: /[ \t]+/;
