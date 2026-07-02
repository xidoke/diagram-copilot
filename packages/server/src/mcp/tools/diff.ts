/**
 * `diff_diagram` MCP tool (DGC-74) — a structural diff between two saved
 * diagrams, e.g. `news-feed.step1` → `news-feed.step2`, so Claude (and the
 * human) can see how a design evolved between snapshots.
 *
 * Both diagrams are read fresh from the workspace and parsed; `to` defaults to
 * the active diagram. The diff itself lives in `@diagram-copilot/core`
 * ({@link diffDocs}, which matches nodes/groups by id and edges by
 * from/to/label since edge ids are positional). This tool only reads — it never
 * writes or activates anything — and renders the {@link DocDiff} as a compact
 * markdown receipt. Identical documents report "No differences."; an unreadable
 * or unparseable side names which diagram failed so the caller can fix it.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  diffDocs,
  isDiffEmpty,
  parseDsl,
  type DiagramGroup,
  type DiagramNode,
  type DocDiff,
  type EdgeLabelChange,
  type EdgeRef,
  type GroupChange,
  type ModelError,
  type NodeChange,
  type ParseError,
} from "@diagram-copilot/core";
import type { WorkspaceOps } from "../../workspace/watcher.js";

/** Wrap a plain string into the MCP text-content result shape. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Wrap an error string into an `isError` MCP result. */
function errorText(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/** Name of the active diagram, or `null` when the workspace is empty. */
function activeName(diagrams: ReturnType<WorkspaceOps["list"]>): string | null {
  return diagrams.find((d) => d.active)?.name ?? null;
}

/** Render parse/model errors from a failed {@link parseDsl}, one per line. */
function formatParseErrors(errors: { parseErrors: ParseError[]; modelErrors: ModelError[] }): string {
  const lines: string[] = [];
  for (const e of errors.parseErrors) lines.push(`  line ${e.line}, col ${e.column}: ${e.message}`);
  for (const e of errors.modelErrors) lines.push(`  ${e.path === "" ? "" : `${e.path}: `}${e.message}`);
  return lines.join("\n");
}

/** Attribute value for a receipt, with a visible placeholder for "absent". */
function val(v: string | undefined): string {
  return v ?? "none";
}

/** `Redis Cache [redis]` — a node's label, with its icon in brackets when set. */
function fmtNode(node: DiagramNode): string {
  return node.icon === undefined ? node.label : `${node.label} [${node.icon}]`;
}

/** `API Server (color: gray→blue)` — an element's id and its attribute deltas. */
function fmtChange(c: NodeChange | GroupChange): string {
  const parts = c.changes.map((ch) => `${ch.field}: ${val(ch.from)}→${val(ch.to)}`);
  return `${c.id} (${parts.join(", ")})`;
}

/** `A→B: label` — an edge by endpoints, with its label when present. */
function fmtEdge(r: EdgeRef): string {
  return r.label === undefined ? `${r.from}→${r.to}` : `${r.from}→${r.to}: ${r.label}`;
}

/** `A→B: old→new` — an edge whose label changed. */
function fmtEdgeLabel(c: EdgeLabelChange): string {
  return `${c.from}→${c.to}: ${val(c.fromLabel)}→${val(c.toLabel)}`;
}

/** Join up to `max` samples, appending an ellipsis when the list is longer. */
function sample(items: string[], max = 4): string {
  return items.length <= max ? items.join(", ") : `${items.slice(0, max).join(", ")}, …`;
}

/** Build the one-line edge summary (`+N (...) −M (...) ~K (...)`), or "no change". */
function fmtEdges(edges: DocDiff["edges"]): string {
  const segs: string[] = [];
  if (edges.added.length > 0) segs.push(`+${edges.added.length} (${sample(edges.added.map(fmtEdge))})`);
  if (edges.removed.length > 0) segs.push(`−${edges.removed.length} (${sample(edges.removed.map(fmtEdge))})`);
  if (edges.labelChanged.length > 0) {
    segs.push(`~${edges.labelChanged.length} (${sample(edges.labelChanged.map(fmtEdgeLabel))})`);
  }
  return segs.length > 0 ? segs.join(" ") : "no change";
}

/** Render a {@link DocDiff} as the markdown receipt (see module docblock). */
function formatReceipt(from: string, to: string, diff: DocDiff): string {
  if (isDiffEmpty(diff)) return `${from} → ${to}\n\nNo differences.`;

  const group = (g: DiagramGroup) => `${g.label} (group)`;
  const added = [...diff.nodes.added.map(fmtNode), ...diff.groups.added.map(group)];
  const removed = [...diff.nodes.removed.map(fmtNode), ...diff.groups.removed.map(group)];
  const changed = [
    ...diff.nodes.changed.map(fmtChange),
    ...diff.groups.changed.map((c) => `${fmtChange(c)} (group)`),
  ];
  const moved = diff.groups.membershipChanged.map(
    (m) => `${m.id} (${m.from ?? "root"} → ${m.to ?? "root"})`,
  );

  return [
    `${from} → ${to}`,
    `+ Added: ${added.length > 0 ? added.join(", ") : "—"}`,
    `- Removed: ${removed.length > 0 ? removed.join(", ") : "—"}`,
    `~ Changed: ${changed.length > 0 ? changed.join(", ") : "—"}`,
    `↪ Moved: ${moved.length > 0 ? moved.join(", ") : "—"}`,
    `Edges: ${fmtEdges(diff.edges)}`,
  ].join("\n");
}

/**
 * Register `diff_diagram` on `server`. Registered only alongside a workspace
 * (`getWorkspace`); it reads two diagrams and never mutates state, so it needs
 * no other wiring. `getWorkspace` may return `null` before the watcher starts.
 */
export function registerDiffDiagramTool(
  server: McpServer,
  getWorkspace: () => WorkspaceOps | null,
): void {
  server.registerTool(
    "diff_diagram",
    {
      title: "Diff diagrams",
      description:
        "Compare two saved diagrams and report how the design evolved: added/removed/changed nodes and groups, nodes moved between groups, and edge additions/removals/label changes. `to` defaults to the active diagram. Read-only — nothing is written or activated. Great for comparing snapshot steps like `news-feed.step1` and `news-feed.step2`.",
      inputSchema: {
        from: z
          .string()
          .describe('The "before" diagram name (without the .arch extension), e.g. "news-feed.step1".'),
        to: z
          .string()
          .optional()
          .describe('The "after" diagram name. Defaults to the active diagram.'),
      },
    },
    async ({ from, to }) => {
      const workspace = getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }

      const target = to ?? activeName(workspace.list());
      if (target === null) {
        return errorText(
          'No "to" diagram was given and no diagram is active. Pass a `to` name, or open one with open_diagram first.',
        );
      }

      const fromRead = workspace.read(from);
      if (!fromRead.ok || fromRead.dsl === undefined) {
        return errorText(`Could not read "from" diagram "${from}": ${fromRead.error ?? "not found"}.`);
      }
      const toRead = workspace.read(target);
      if (!toRead.ok || toRead.dsl === undefined) {
        return errorText(`Could not read "to" diagram "${target}": ${toRead.error ?? "not found"}.`);
      }

      const fromParsed = parseDsl(fromRead.dsl);
      if (!fromParsed.ok) {
        return errorText(`"from" diagram "${from}" does not parse:\n${formatParseErrors(fromParsed)}`);
      }
      const toParsed = parseDsl(toRead.dsl);
      if (!toParsed.ok) {
        return errorText(`"to" diagram "${target}" does not parse:\n${formatParseErrors(toParsed)}`);
      }

      return text(formatReceipt(from, target, diffDocs(fromParsed.doc, toParsed.doc)));
    },
  );
}
