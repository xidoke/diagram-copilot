/**
 * arch-dsl — minimal eraser-style architecture DSL (DGC-26 v0.1, DGC-29 v0.2).
 *
 * Supported statements (one per line, newline-significant):
 *   direction right|left|up|down
 *   Node Name With Spaces
 *   Node Name [icon: server, color: orange]
 *   Some Node > Other Node
 *   Some Node > Other Node: edge label to end of line
 *   Group Name [icon: …, color: …] {
 *     Nested Node
 *     Nested Group { … }
 *   }
 *
 * Design notes:
 * - Newlines are significant (statement separators), so NL is a real
 *   terminal and only spaces/tabs are hidden.
 * - Multi-word names are parsed as `WORD+` and re-joined with single
 *   spaces during AST→doc mapping (whitespace inside names is
 *   normalized). WORD is a negated class, so basic Unicode names
 *   (e.g. Vietnamese) work for free.
 * - After a name, one token of lookahead disambiguates the three
 *   suffixes (all first-sets disjoint, LL(1)):
 *     `>`      → edge
 *     `[`      → attributes (then an optional `{ … }` group block)
 *     `{`      → group block (no attributes)
 *   No suffix at all → a plain node declaration.
 * - The direction value is a plain WORD (validated in TypeScript), so
 *   `right`/`left`/`up`/`down` are NOT reserved words and stay usable
 *   in node names. Only `direction` itself is a keyword.
 * - EDGE_LABEL eats `:` plus the rest of the line, so labels may
 *   contain further colons (e.g. "ratio 2:1"). Because a bare `:`
 *   always lexes as EDGE_LABEL, attributes cannot use `:` as a
 *   structural token — instead the whole `[ … ]` block is one opaque
 *   ATTRS terminal, split into `key: value` pairs in TypeScript.
 * - WORD excludes the structural characters `{ } [ ] ,` so that group
 *   blocks and attribute lists tokenize; consequently those characters
 *   can no longer appear inside a node/group name (v0.1 already
 *   excluded whitespace, `>` and `:`).
 *
 * v0.2 excludes comments and one-to-many edges (later tasks).
 */
grammar ArchDsl

entry Document:
    (lines+=Line? NL)*;

Line:
    DirectionLine | Statement;

DirectionLine:
    'direction' value=WORD;

Statement:
    source=Name (
        '>' target=Name (label=EDGE_LABEL)?
      | attrs=ATTRS GroupBlock?
      | GroupBlock
    )?;

fragment GroupBlock:
    isGroup?='{' NL (body+=Line? NL)* '}';

Name:
    parts+=WORD+;

terminal NL: /\r?\n/;
terminal EDGE_LABEL: /:[^\n\r]*/;
terminal ATTRS: /\[[^\]\r\n]*\]/;
terminal WORD: /[^\s>:{}\[\],]+/;
hidden terminal WS: /[ \t]+/;
