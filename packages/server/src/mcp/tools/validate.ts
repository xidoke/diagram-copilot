/**
 * `validate_dsl` MCP tool (F1 / DGC-61) — a dry-run check of arch-dsl WITHOUT
 * touching disk.
 *
 * `set_diagram` already validates-before-writing, but there is no way to ask
 * "is this DSL valid?" without committing a write. `validate_dsl` closes that
 * gap: it runs the exact same `parseDsl` (parse + `validateDoc`) pipeline and
 * reports either an OK receipt with node/group/edge counts, or the full list of
 * `line X, col Y: message` problems — so Claude can draft and iterate on a large
 * rewrite before ever calling `set_diagram`. It never reads or writes the
 * workspace, so it needs no wiring (registered like `get_dsl_guide`/`list_icons`).
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseDsl, type ModelError, type ParseError } from "@diagram-copilot/core";

/** Wrap a plain string into the MCP text-content result shape. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Wrap an error string into an `isError` MCP result (so Claude sees it as a failure). */
function errorText(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/** `"1 node"` / `"3 nodes"` — small pluralization helper for the receipt. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * Render a failed {@link parseDsl} result as a list of problems: one line per
 * syntax error (`line X, col Y: message`) or model error (`path: message`).
 * Mirrors the shape `set_diagram` returns so a caller learns one error format.
 * `parseDsl` never returns both lists non-empty, but both are handled.
 */
function formatDslErrors(errors: { parseErrors: ParseError[]; modelErrors: ModelError[] }): string {
  const lines: string[] = [];
  if (errors.parseErrors.length > 0) {
    lines.push(`Invalid — ${count(errors.parseErrors.length, "syntax error")}:`);
    for (const e of errors.parseErrors) {
      lines.push(`  line ${e.line}, col ${e.column}: ${e.message}`);
    }
  }
  if (errors.modelErrors.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`Invalid — ${count(errors.modelErrors.length, "validation error")}:`);
    for (const e of errors.modelErrors) {
      lines.push(`  ${e.path === "" ? "" : `${e.path}: `}${e.message}`);
    }
  }
  lines.push("");
  lines.push("Fix the DSL and validate again (nothing was written).");
  return lines.join("\n");
}

/**
 * Register the `validate_dsl` tool on `server`. No state needed — a pure
 * function of its `dsl` input — so it is registered unconditionally alongside
 * the other stateless reference tools.
 */
export function registerValidateDslTool(server: McpServer): void {
  server.registerTool(
    "validate_dsl",
    {
      title: "Validate arch-dsl",
      description:
        "Dry-run check of an arch-dsl document WITHOUT writing anything. Runs the same parse + validation as set_diagram and returns either an OK receipt (with node/group/edge counts) or every problem as `line X, col Y: message`. Use it to draft and self-correct a large rewrite before committing it with set_diagram.",
      inputSchema: {
        dsl: z.string().describe("The full arch-dsl document to validate (nothing is written)."),
      },
    },
    async ({ dsl }) => {
      const parsed = parseDsl(dsl);
      if (!parsed.ok) {
        return errorText(formatDslErrors(parsed));
      }
      const { doc } = parsed;
      return text(
        `Valid — ${count(doc.nodes.length, "node")}, ${count(doc.groups.length, "group")}, ${count(doc.edges.length, "edge")}. Nothing was written; call set_diagram to apply it.`,
      );
    },
  );
}
