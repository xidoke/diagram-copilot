/**
 * `snapshot_diagram` MCP tool (DGC-58/T37) — freezes the current DSL of a
 * diagram into a new, numbered "step" file so an SD (spaced/evolutionary
 * design) learning session can look back at earlier stages (baseline → +cache
 * → +shard, ...) without losing them to further edits.
 *
 * Naming: snapshotting `name` writes `<base>.step<N>.arch`, where `base` is
 * `name` itself, or — if `name` already looks like `<base>.step<K>` — the
 * part before `.step<K>` (so re-snapshotting a step keeps chaining off the
 * same base instead of nesting `foo.step1.step1`). `N` is one past the
 * highest existing `<base>.step*` in the workspace, so steps are always
 * gapless and monotonically increasing regardless of which step you started
 * from.
 *
 * Content: the first line is a marker comment `// snapshot v<V> — <label>`
 * (V = the source diagram's version at snapshot time, label defaults to
 * `step <N>`), followed by the source DSL verbatim.
 *
 * Active diagram is left untouched. Both read/act through the narrow
 * {@link WorkspaceOps} view of the workspace watcher, fetched fresh on every
 * call. `WorkspaceOps.createDiagram` (like `open`) always activates the file
 * it writes — there is no "write without activating" primitive — so this
 * tool captures the active diagram *before* calling `createDiagram` and
 * restores it afterward with `WorkspaceOps.setActive`. Both were added to the
 * narrow `WorkspaceOps` interface (they previously lived only on the fuller
 * `WorkspaceWatcher`) since MCP tools only ever see `WorkspaceOps`.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DiagramListing, WorkspaceOps } from "../../workspace/watcher.js";

/** Wrap a plain string into the MCP text-content result shape. */
function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

/** Wrap an error string into an `isError` MCP result (so Claude sees it as a failure). */
function errorText(body: string) {
  return { content: [{ type: "text" as const, text: body }], isError: true };
}

/** Name of the active diagram, or `null` when the workspace is empty. */
function activeName(diagrams: DiagramListing[]): string | null {
  return diagrams.find((d) => d.active)?.name ?? null;
}

/** Matches the `.step<N>` suffix a snapshot name carries. */
const STEP_SUFFIX = /\.step(\d+)$/;

/**
 * The base a snapshot chains off of: `name` itself, or — when `name` is
 * already a step (`<base>.step<K>`) — the part before `.step<K>`, so
 * re-snapshotting a step does not nest suffixes.
 */
function stepBase(name: string): string {
  const match = STEP_SUFFIX.exec(name);
  return match ? name.slice(0, match.index) : name;
}

/** One past the highest existing `<base>.step<N>` among `diagrams` (1 if none exist). */
function nextStepNumber(base: string, diagrams: DiagramListing[]): number {
  let max = 0;
  for (const d of diagrams) {
    const match = STEP_SUFFIX.exec(d.name);
    if (match !== null && d.name.slice(0, match.index) === base) {
      const n = Number(match[1]);
      if (n > max) max = n;
    }
  }
  return max + 1;
}

/**
 * Register `snapshot_diagram` on `server`. Called from the MCP handler only
 * when the server was wired with a workspace. `getWorkspace` may return
 * `null` before the watcher has started, in which case the tool reports that
 * gracefully.
 */
export function registerSnapshotDiagramTool(
  server: McpServer,
  getWorkspace: () => WorkspaceOps | null,
): void {
  server.registerTool(
    "snapshot_diagram",
    {
      title: "Snapshot diagram",
      description:
        'Freeze a diagram\'s current DSL into a new numbered step file (`<base>.step<N>.arch`) for evolutionary-design learning (e.g. baseline → +cache → +shard). Defaults to the active diagram. Does not change what diagram is active. Snapshotting a step chains off its own base rather than nesting.',
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Diagram name (without the .arch extension) to snapshot. Defaults to the active diagram."),
        label: z
          .string()
          .optional()
          .describe('Short label recorded in the snapshot\'s header comment. Defaults to "step <N>".'),
      },
    },
    async ({ name, label }) => {
      const workspace = getWorkspace();
      if (workspace === null) {
        return errorText("Workspace is not ready yet — try again in a moment.");
      }

      const diagrams = workspace.list();
      const activeBefore = activeName(diagrams);
      const target = name ?? activeBefore;
      if (target === null) {
        return errorText(
          'No diagram is open and no name was given. Pass a name (e.g. { "name": "demo" }) to snapshot.',
        );
      }
      if (!diagrams.some((d) => d.name === target)) {
        return errorText(`Diagram "${target}" does not exist.`);
      }

      const source = workspace.read(target);
      if (!source.ok || source.dsl === undefined) {
        return errorText(source.error ?? `Could not read diagram "${target}".`);
      }

      const base = stepBase(target);
      const stepN = nextStepNumber(base, diagrams);
      const stepName = `${base}.step${stepN}`;
      const stepLabel = label ?? `step ${stepN}`;
      const content = `// snapshot v${source.version} — ${stepLabel}\n${source.dsl}`;

      const created = workspace.createDiagram(stepName, content);
      if (!created.ok) {
        return errorText(created.error ?? `Could not create snapshot "${stepName}".`);
      }

      // createDiagram always activates the file it just wrote; restore
      // whatever was active before the snapshot (a no-op if it already
      // matches, which cannot happen here since stepName is always new).
      if (activeBefore !== null && activeBefore !== stepName) {
        workspace.setActive(activeBefore);
      }

      return text(`Snapshotted ${target} v${source.version} → ${stepName} ("${stepLabel}")`);
    },
  );
}
