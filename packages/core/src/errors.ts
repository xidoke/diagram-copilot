import { z } from "zod";

/**
 * Syntax error produced while parsing DSL text.
 *
 * Emitted by the Langium parser on the server, forwarded verbatim over the
 * WS protocol (`diagram-error`), through MCP tool results (so Claude can
 * self-correct), and into Monaco markers. Positions are 1-based, matching
 * both Langium diagnostics and Monaco marker conventions.
 */
export interface ParseError {
  /** 1-based line in the DSL source. */
  line: number;
  /** 1-based column in the DSL source. */
  column: number;
  /** Human-readable description of the syntax problem. */
  message: string;
}

/** Zod schema for {@link ParseError}. */
export const ParseErrorSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  message: z.string(),
});

/**
 * Semantic error produced while validating a parsed {@link DiagramDoc}
 * (duplicate ids, dangling references, group cycles, shape violations).
 *
 * `path` addresses the offending location inside the document using
 * bracket-index notation, e.g. `"nodes[2].id"`, `"edges[0].from"`,
 * `"direction"`. Root-level problems use an empty string.
 */
export interface ModelError {
  /** Location inside the document, e.g. `"nodes[2].id"`; `""` for the root. */
  path: string;
  /** Human-readable description of the semantic problem. */
  message: string;
}

/** Zod schema for {@link ModelError}. */
export const ModelErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});

/**
 * Format a path of object keys / array indexes (e.g. a Zod issue path)
 * into the canonical {@link ModelError.path} notation:
 * `["nodes", 2, "id"]` → `"nodes[2].id"`; `[]` → `""`.
 */
export function formatErrorPath(segments: ReadonlyArray<string | number>): string {
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += out === "" ? segment : `.${segment}`;
    }
  }
  return out;
}
