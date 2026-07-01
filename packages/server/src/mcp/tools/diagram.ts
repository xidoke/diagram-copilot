/**
 * Diagram MCP tools — `get_diagram` and `set_diagram` (DGC-40).
 *
 * The read/write heart of the copilot: Claude reads a diagram's current DSL
 * with `get_diagram`, edits it, and writes the whole document back with
 * `set_diagram`. Both act through the narrow {@link WorkspaceOps} view of the
 * workspace watcher (fetched fresh on every call so answers reflect live state),
 * defaulting to the active diagram when no `name` is given.
 *
 * `set_diagram` validates with `parseDsl` BEFORE touching disk: on any
 * parse/model error it writes nothing, leaves the version untouched, and returns
 * every error as `line X, col Y: message` (plus model-error paths) so Claude can
 * fix the DSL and call again — a self-correcting loop. On success the watcher's
 * `update` writes the file, bumps the version, and broadcasts a `diagram` frame
 * with origin `mcp` to every web client.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { parseDsl, type ModelError, type ParseError } from "@diagram-copilot/core";
import type { WorkspaceOps } from "../../workspace/watcher.js";

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

/** Name of the active diagram, or `null` when the workspace is empty. */
function activeName(diagrams: ReturnType<WorkspaceOps["list"]>): string | null {
  return diagrams.find((d) => d.active)?.name ?? null;
}

/**
 * Render a failed {@link parseDsl} result as a self-correction message: one
 * line per syntax error (`line X, col Y: message`) or model error
 * (`path: message`), closed with an instruction to fix and retry. `parseDsl`
 * never returns both lists non-empty, but both are handled defensively.
 */
function formatDslErrors(errors: { parseErrors: ParseError[]; modelErrors: ModelError[] }): string {
  const lines: string[] = [];
  if (errors.parseErrors.length > 0) {
    lines.push(`DSL has ${count(errors.parseErrors.length, "syntax error")} — nothing was written:`);
    for (const e of errors.parseErrors) {
      lines.push(`  line ${e.line}, col ${e.column}: ${e.message}`);
    }
  }
  if (errors.modelErrors.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`DSL has ${count(errors.modelErrors.length, "validation error")} — nothing was written:`);
    for (const e of errors.modelErrors) {
      lines.push(`  ${e.path === "" ? "" : `${e.path}: `}${e.message}`);
    }
  }
  lines.push("");
  lines.push("Fix the DSL and call set_diagram again.");
  return lines.join("\n");
}

/**
 * Register `get_diagram` and `set_diagram` on `server`. Called from the MCP
 * handler only when the server was wired with a workspace. `getWorkspace` may
 * return `null` before the watcher has started, in which case the tools report
 * that gracefully.
 */
export function registerDiagramTools(
  server: McpServer,
  getWorkspace: () => WorkspaceOps | null,
): void {
  server.registerTool(
    "get_diagram",
    {
      title: "Get diagram",
      description:
        "Read a diagram's current arch-dsl source. Defaults to the active diagram; pass `name` to read a specific one. Returns the name, version and raw DSL in a code block — the starting point before editing and writing back with set_diagram.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Diagram name (without the .arch extension). Defaults to the active diagram."),
      },
    },
    async ({ name }) => {
      const workspace = getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }
      const target = name ?? activeName(workspace.list());
      if (target === null) {
        return errorText(
          'No diagram is open. Use open_diagram with a name (e.g. { "name": "demo" }) to create or open one, then call get_diagram.',
        );
      }
      const result = workspace.read(target);
      if (!result.ok || result.dsl === undefined) {
        return errorText(result.error ?? `Could not read diagram "${target}".`);
      }
      return text(`Diagram "${target}" (v${result.version}):\n\n\`\`\`\n${result.dsl}\n\`\`\``);
    },
  );

  server.registerTool(
    "set_diagram",
    {
      title: "Set diagram",
      description:
        "Replace a diagram's ENTIRE arch-dsl source (a full document, not a patch). Defaults to the active diagram; pass `name` to target or create a specific one. The DSL is validated first — on any parse/model error nothing is written and the errors are returned so you can fix and retry. Call get_dsl_guide for syntax and list_icons for icon ids.",
      inputSchema: {
        dsl: z.string().describe("The full arch-dsl document to write (replaces existing content)."),
        name: z
          .string()
          .optional()
          .describe(
            "Diagram name (without the .arch extension). Defaults to the active diagram; a name that does not exist yet is created.",
          ),
      },
    },
    async ({ dsl, name }) => {
      const workspace = getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }

      // Validate FIRST: never write DSL that fails to parse/validate. On error
      // return each problem so Claude can self-correct without a disk write.
      const parsed = parseDsl(dsl);
      if (!parsed.ok) {
        return errorText(formatDslErrors(parsed));
      }

      const diagrams = workspace.list();
      const target = name ?? activeName(diagrams);
      if (target === null) {
        return errorText(
          'No diagram is open and no name was given. Pass a name (e.g. { "name": "demo", "dsl": "…" }) to create one.',
        );
      }

      // A brand-new named diagram is created (empty template + activated) before
      // the real content is written by update below.
      if (!diagrams.some((d) => d.name === target)) {
        const created = workspace.open(target);
        if (!created.ok) {
          return errorText(created.error ?? `Could not create diagram "${target}".`);
        }
      }

      const result = workspace.update(target, dsl);
      if (!result.ok || result.doc === undefined) {
        return errorText(result.error ?? `Could not update diagram "${target}".`);
      }
      const { doc } = result;
      return text(
        `Applied — ${result.name} is now v${result.version} (${count(doc.nodes.length, "node")}, ${count(doc.groups.length, "group")}, ${count(doc.edges.length, "edge")}).`,
      );
    },
  );
}
