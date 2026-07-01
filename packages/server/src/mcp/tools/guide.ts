/**
 * `get_dsl_guide` MCP tool — a zero-input reference so a fresh Claude Code
 * session can write valid arch-dsl on the first try without reading the
 * grammar/parser source.
 *
 * The guide text is a plain exported `const` (not inlined in the tool
 * callback) so it is trivially unit-testable (assert it mentions the key
 * constructs) and so a later tuning task (T25) can edit copy without
 * touching registration wiring.
 *
 * Keep this in sync with the real grammar/mapper:
 * `packages/core/src/dsl/arch-dsl.langium` and `packages/core/src/dsl/parse.ts`.
 * Every construct and example below must actually parse — see
 * `packages/core/test/dsl.test.ts` / `dsl-ext.test.ts` for the ground truth,
 * and the color list must match `packages/web/src/render/colors.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Full arch-dsl reference text returned verbatim by `get_dsl_guide`. */
export const DSL_GUIDE = `arch-dsl — architecture diagram DSL reference

One statement per line. Whitespace inside a name is collapsed to single
spaces; leading/trailing blank lines and indentation are ignored. Node and
group ids are case-sensitive and Unicode-safe (Vietnamese names work fine).

1. direction (optional, one line, defaults to "right")
   direction right   // or: left, up, down

2. Nodes — a bare name declares a node. Multi-word and Unicode names are fine.
   Server
   Load Balancer
   Người dùng

3. Attributes — "[key: value, key: value]" right after a name.
   Keys: icon, color, label (only these three; anything else is a parse error).
   Values must not contain a comma (commas separate key:value pairs).
   API [icon: server, color: orange, label: API Gateway]
   - icon: an icon id/alias (call list_icons to find valid ids; an unknown
     id never errors — it just renders a generic box).
   - color: one of the named tokens below (unknown strings silently fall
     back to the default accent color instead of erroring).
   - label: overrides the display text; the id/name stays what you wrote.

4. Groups — "{ ... }" nests statements inside a named container. Groups may
   carry the same [icon:, color:, label:] attributes as nodes, before "{".
   VPC [color: gray] {
     API [icon: server]
     Database [icon: postgresql]
   }
   Groups nest arbitrarily deep and can be edge endpoints themselves.

5. Edges — "Source > Target" on one line, optional ": label" to end of line
   (labels may contain further colons, e.g. "ratio 2:1").
   API > Database: reads/writes
   Referencing a name that was never declared auto-creates a plain node.

6. One-to-many edges — "Source > A, B, C" fans out into one edge per
   target (in the order written); a trailing ": label" applies to all of them.
   Gateway > Auth, Users, Billing: routes to

7. Comments — "//" to end of line, on its own line or trailing a statement.
   Comment wins over label text: "A > B: cache // hot" produces the label
   "cache" (everything from "//" onward is dropped, even inside a label).
   A single "/" is fine in a name or label (e.g. "read/write", "TCP/IP") —
   only a double slash starts a comment.
   // internal services
   Cache [icon: redis] // in-memory

Valid color tokens (anything else falls back to the default theme accent):
  blue, orange, green, red, purple, pink, yellow, teal, gray

Icons: call the list_icons tool to browse ids/aliases before using [icon: ...].
An id that list_icons doesn't know still renders (generic box fallback), so
prefer a real id/alias for a recognizable diagram.

Full example (direction, groups, icons, colors, one-to-many, comments):

  direction right

  Client [icon: monitor, color: blue]

  VPC [color: gray] {
    API [icon: server, color: orange]
    Database [icon: postgresql, color: teal]

    API > Database: reads/writes
  }

  Client > API: HTTPS
  API > Cache, Queue: publishes // fan-out to two implicit nodes
`;

/** Registers the `get_dsl_guide` tool on `server`. No input, plain text output. */
export function registerGetDslGuideTool(server: McpServer): void {
  server.registerTool(
    "get_dsl_guide",
    {
      title: "Get arch-dsl guide",
      description:
        "Returns the full arch-dsl syntax reference (nodes, attributes, groups, edges, one-to-many fan-out, comments, direction, valid colors) with examples. Call this before writing or editing diagram DSL.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: DSL_GUIDE }],
    }),
  );
}
