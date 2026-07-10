/**
 * `list_icons` MCP tool — lets Claude browse the `@diagram-copilot/icons`
 * registry (id, title, source) before writing an `[icon: ...]` attribute,
 * instead of guessing ids that silently fall back to a generic box (see
 * `getIcon` in `@diagram-copilot/icons`).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { listIcons, type IconMeta } from "@diagram-copilot/icons";
import { z } from "zod";

/** A handful of common aliases worth surfacing even when they don't match `query`. */
const HIGHLIGHTED_ALIASES = ["postgres", "kafka", "k8s", "db", "lb", "cdn", "queue", "cache"] as const;

function formatIcon(icon: IconMeta): string {
  // Pack icons (opt-in vendor sets, DGC-99) credit their pack namespace —
  // e.g. `aws:dynamodb — Amazon DynamoDB (aws pack)`.
  const source = icon.source === "pack" && icon.pack !== undefined ? `${icon.pack} pack` : icon.source;
  return `${icon.id} — ${icon.title} (${source})`;
}

/** Builds the `list_icons` response text for a given (already-filtered) result set. */
function formatResult(icons: IconMeta[], query: string | undefined): string {
  const aliasHint = `Common aliases → canonical id: ${HIGHLIGHTED_ALIASES.join(", ")}.`;

  if (icons.length === 0) {
    const forQuery = query === undefined ? "" : ` for "${query}"`;
    return [
      `No icons match${forQuery}. Call list_icons again without a query (or with a different keyword) to see the full set.`,
      aliasHint,
    ].join("\n");
  }

  const header =
    query === undefined
      ? `${icons.length} icon(s) available.`
      : `${icons.length} icon(s) match "${query}".`;
  return [header, aliasHint, "", ...icons.map(formatIcon)].join("\n");
}

/** Registers the `list_icons` tool on `server`. Input: optional `query` substring filter. */
export function registerListIconsTool(server: McpServer): void {
  server.registerTool(
    "list_icons",
    {
      title: "List available diagram icons",
      description:
        'Lists icon ids usable in an arch-dsl [icon: ...] attribute, with title and source. Pass `query` to filter by id/title substring (case-insensitive), e.g. "postgres" or "queue". Call without a query to see everything.',
      inputSchema: { query: z.string().optional() },
    },
    async ({ query }) => {
      const icons = listIcons(query);
      return {
        content: [{ type: "text" as const, text: formatResult(icons, query) }],
      };
    },
  );
}
