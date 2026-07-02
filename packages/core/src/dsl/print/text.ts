/**
 * Line-level text utilities for the concrete-syntax-preserving DSL printer
 * (DGC-17).
 *
 * `applyDocEdit` deliberately does NOT navigate Langium CST offsets. The
 * grammar is strictly line-oriented — every statement is NL-terminated, a
 * group's `{` header and `}` footer each own their line — so a lossless line
 * model (split once, keep every untouched line verbatim, re-join with the
 * original EOL flavour) is both simpler and byte-exact. The AST is walked *in
 * parallel* with the physical lines (see `source.ts`); the only lexical
 * knowledge duplicated here is the trailing-comment boundary rule, kept in
 * one place ({@link splitTrailingComment}) and mirrored from the terminal
 * definitions in `arch-dsl.langium`.
 */

/** A DSL text split into terminator-less lines plus enough info to re-join losslessly. */
export interface SourceText {
  /** Line contents without terminators. */
  lines: string[];
  /** EOL flavour used when re-joining (`"\r\n"` iff the input used it). */
  eol: "\n" | "\r\n";
  /** Whether the original text ended with a newline. */
  finalNewline: boolean;
}

/**
 * Split DSL text into lines, remembering the EOL flavour and whether the text
 * ended with a newline, so {@link joinLines} can reproduce the input byte-for-
 * byte when nothing changed. Files with *mixed* EOLs are normalized to the
 * dominant flavour (a documented limitation; the identity guarantee assumes a
 * consistent EOL, which is what the workspace writes).
 */
export function splitLines(text: string): SourceText {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const finalNewline = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (finalNewline) lines.pop(); // drop the empty segment after the last EOL
  return { lines, eol, finalNewline };
}

/** Inverse of {@link splitLines}: re-join edited lines with the original EOL conventions. */
export function joinLines(lines: string[], source: SourceText): string {
  if (lines.length === 0) return "";
  return lines.join(source.eol) + (source.finalNewline ? source.eol : "");
}

/** True for a line the parser ignores entirely: blank/whitespace-only or comment-only. */
export function isRawLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed === "" || trimmed.startsWith("//");
}

/** The leading whitespace of a line. */
export function indentOf(line: string): string {
  return /^[ \t]*/.exec(line)![0];
}

/** Result of {@link splitTrailingComment}. */
export interface SplitLine {
  /** Statement text, right-trimmed, without the trailing comment. */
  code: string;
  /** Whitespace between code and comment (`""` when there is no comment). */
  gap: string;
  /** The trailing `// …` comment including the slashes, or `""` when none. */
  comment: string;
}

/**
 * Split a physical line into statement code and trailing `//` comment,
 * replicating the lexer's token-boundary rules:
 *
 * - after a bare `:` the rest of the line is one greedy `EDGE_LABEL` token,
 *   and the AST→doc mapper cuts the label at the FIRST `//` (comment wins
 *   over label content) — so on such a line the comment starts at the first
 *   `//` after the colon;
 * - a `[ … ]` attribute list is one opaque `ATTRS` token — `//` and `:`
 *   inside the brackets are plain text;
 * - elsewhere `//` starts a comment only at a token boundary (line start,
 *   after whitespace, or after one of the structural tokens `> { } , ]`);
 *   inside a WORD (e.g. `TCP//IP`) it is part of the name.
 */
export function splitTrailingComment(line: string): SplitLine {
  let commentStart = -1;
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === ":") {
      // Greedy EDGE_LABEL: everything to EOL; comment-wins cuts at first `//`.
      commentStart = line.indexOf("//", i + 1);
      break;
    }
    if (ch === "[") {
      const close = line.indexOf("]", i);
      if (close === -1) break; // unterminated ATTRS never parses; treat as code
      i = close + 1;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      const prev = i === 0 ? " " : line[i - 1]!;
      if (/[\s>{},\]]/.test(prev)) {
        commentStart = i;
        break;
      }
    }
    i += 1;
  }
  if (commentStart === -1) {
    return { code: line.replace(/[ \t]+$/, ""), gap: "", comment: "" };
  }
  const before = line.slice(0, commentStart);
  const code = before.replace(/[ \t]+$/, "");
  return { code, gap: before.slice(code.length), comment: line.slice(commentStart) };
}

/**
 * The `gap + comment` suffix to re-attach when a line is rewritten or moved,
 * or `""` when the line carries no trailing comment.
 */
export function commentSuffixOf(line: string): string {
  const { gap, comment } = splitTrailingComment(line);
  return comment === "" ? "" : gap + comment;
}

/**
 * Shift a kept-verbatim line's indentation by `delta` spaces (used when a
 * whole group block moves to a different nesting depth). Blank lines stay
 * blank; dedenting never removes more leading spaces than the line has.
 */
export function reindent(line: string, delta: number): string {
  if (delta === 0 || line === "") return line;
  if (delta > 0) return " ".repeat(delta) + line;
  let strip = 0;
  while (strip < -delta && line[strip] === " ") strip += 1;
  return line.slice(strip);
}
