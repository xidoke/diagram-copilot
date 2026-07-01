/**
 * arch-dsl — minimal eraser-style architecture DSL
 * (DGC-26 v0.1, DGC-29 v0.2, DGC-30 v0.3).
 *
 * Supported statements (one per line, newline-significant):
 *   direction right|left|up|down
 *   Node Name With Spaces
 *   Node Name [icon: server, color: orange]
 *   Some Node > Other Node
 *   Some Node > Other Node: edge label to end of line
 *   Some Node > A, B, C            // one-to-many fan-out (one edge per target)
 *   Some Node > A, B: shared label // the label applies to every fan-out edge
 *   // a full-line comment
 *   Some Node // an end-of-line comment
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
 *   (e.g. Vietnamese) work for free; the mapper never applies Unicode
 *   normalization, so ids compare by raw code units.
 * - After a name, one token of lookahead disambiguates the three
 *   suffixes (all first-sets disjoint, LL(1)):
 *     `>`      → edge (then optional `, target` repeats and an optional label)
 *     `[`      → attributes (then an optional `{ … }` group block)
 *     `{`      → group block (no attributes)
 *   No suffix at all → a plain node declaration.
 * - `A > B, C, D` is one-to-many: each comma-separated target becomes its
 *   own edge (`e1..eN` in source order). `,` is excluded from WORD, so it
 *   is a clean separator; a trailing `: label` applies to every edge.
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
 * - Comments: `//` to end of line is a hidden SL_COMMENT terminal, so a
 *   comment may appear on its own line or trail any statement, and — being
 *   hidden — it never shifts the line/column of a later error. SL_COMMENT
 *   is declared before WORD so a boundary `//…` (line start or after
 *   whitespace/`>`) lexes as a comment rather than a word; `/` stays legal
 *   inside a name (e.g. `TCP/IP`) because SL_COMMENT needs a double slash.
 *   The one place a comment is NOT hidden is *inside* a greedy EDGE_LABEL
 *   (the `:` grabs the rest of the line first); there `//…` is stripped
 *   during AST→doc mapping — comment wins over label content. See parse.ts.
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
        '>' targets+=Name (',' targets+=Name)* (label=EDGE_LABEL)?
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
hidden terminal SL_COMMENT: /\/\/[^\n\r]*/;
terminal WORD: /[^\s>:{}\[\],]+/;
hidden terminal WS: /[ \t]+/;
