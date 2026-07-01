import { z } from "zod";
import { formatErrorPath, type ModelError } from "../errors.js";
import type {
  ArchitectureDoc,
  DiagramDoc,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  Direction,
} from "./types.js";

/** Zod schema for {@link Direction}. */
export const DirectionSchema = z.enum(["right", "left", "up", "down"]);

/** Non-empty id: structural references must never be blank. */
const IdSchema = z.string().min(1, "id must not be empty");

/** Zod schema for {@link DiagramNode}. */
export const DiagramNodeSchema = z.object({
  id: IdSchema,
  label: z.string(),
  icon: z.string().optional(),
  color: z.string().optional(),
  groupId: IdSchema.optional(),
});

/** Zod schema for {@link DiagramGroup}. */
export const DiagramGroupSchema = z.object({
  id: IdSchema,
  label: z.string(),
  parentId: IdSchema.optional(),
  icon: z.string().optional(),
  color: z.string().optional(),
});

/** Zod schema for {@link DiagramEdge}. */
export const DiagramEdgeSchema = z.object({
  id: IdSchema,
  from: IdSchema,
  to: IdSchema,
  label: z.string().optional(),
});

/**
 * Shape-only schema for {@link ArchitectureDoc} — no referential checks.
 *
 * Exported as the `architecture` member for the v1.1 discriminated union
 * (`z.discriminatedUnion` requires plain object schemas). For actual
 * validation always use {@link DiagramDocSchema} / {@link validateDoc},
 * which add the referential refinements.
 */
export const ArchitectureDocSchema = z.object({
  type: z.literal("architecture"),
  direction: DirectionSchema,
  nodes: z.array(DiagramNodeSchema),
  groups: z.array(DiagramGroupSchema),
  edges: z.array(DiagramEdgeSchema),
});

/**
 * Referential integrity checks that go beyond shape:
 * - node/group ids unique across one shared namespace (edges may target either)
 * - edge ids unique among edges
 * - `node.groupId` and `group.parentId` reference existing groups
 * - group nesting is acyclic
 * - `edge.from` / `edge.to` reference an existing node or group
 *
 * Runs only when the shape parse succeeded; collects every violation in
 * one pass so Claude / the drawer can fix all errors at once.
 */
function refineArchitectureDoc(doc: ArchitectureDoc, ctx: z.RefinementCtx): void {
  // Unique ids — nodes and groups share one namespace.
  const seenIds = new Set<string>();
  doc.nodes.forEach((node, index) => {
    if (seenIds.has(node.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "id"],
        message: `Duplicate id "${node.id}" — node and group ids must be unique`,
      });
    }
    seenIds.add(node.id);
  });
  doc.groups.forEach((group, index) => {
    if (seenIds.has(group.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups", index, "id"],
        message: `Duplicate id "${group.id}" — node and group ids must be unique`,
      });
    }
    seenIds.add(group.id);
  });

  // Unique edge ids (their own namespace).
  const seenEdgeIds = new Set<string>();
  doc.edges.forEach((edge, index) => {
    if (seenEdgeIds.has(edge.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edges", index, "id"],
        message: `Duplicate edge id "${edge.id}"`,
      });
    }
    seenEdgeIds.add(edge.id);
  });

  // groupId / parentId must reference an existing group.
  const groupIds = new Set(doc.groups.map((group) => group.id));
  doc.nodes.forEach((node, index) => {
    if (node.groupId !== undefined && !groupIds.has(node.groupId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nodes", index, "groupId"],
        message: `Unknown group "${node.groupId}"`,
      });
    }
  });
  doc.groups.forEach((group, index) => {
    if (group.parentId !== undefined && !groupIds.has(group.parentId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups", index, "parentId"],
        message: `Unknown parent group "${group.parentId}"`,
      });
    }
  });

  // Group nesting must be acyclic. Walk each parent chain once; a chain that
  // re-enters itself is a cycle (reported once, at the first group in it).
  const groupIndexById = new Map(doc.groups.map((group, index) => [group.id, index] as const));
  const parentById = new Map<string, string>();
  for (const group of doc.groups) {
    if (group.parentId !== undefined && groupIds.has(group.parentId)) {
      parentById.set(group.id, group.parentId);
    }
  }
  const visitState = new Map<string, "visiting" | "done">();
  for (const group of doc.groups) {
    if (visitState.get(group.id) === "done") continue;
    const chain: string[] = [];
    let current: string | undefined = group.id;
    while (current !== undefined && visitState.get(current) !== "done") {
      if (visitState.get(current) === "visiting") {
        const cycle = chain.slice(chain.indexOf(current));
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["groups", groupIndexById.get(cycle[0]!)!, "parentId"],
          message: `Group nesting cycle: ${[...cycle, current].join(" → ")}`,
        });
        break;
      }
      visitState.set(current, "visiting");
      chain.push(current);
      current = parentById.get(current);
    }
    for (const id of chain) visitState.set(id, "done");
  }

  // Edge endpoints must reference an existing node or group.
  const endpointIds = new Set<string>([...doc.nodes.map((node) => node.id), ...groupIds]);
  doc.edges.forEach((edge, index) => {
    if (!endpointIds.has(edge.from)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edges", index, "from"],
        message: `Unknown endpoint "${edge.from}" — edges must reference an existing node or group`,
      });
    }
    if (!endpointIds.has(edge.to)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["edges", index, "to"],
        message: `Unknown endpoint "${edge.to}" — edges must reference an existing node or group`,
      });
    }
  });
}

/**
 * Full Zod schema for {@link DiagramDoc}: shape + referential refinements.
 *
 * v1.1 extension point: replace with
 * `z.discriminatedUnion('type', [ArchitectureDocSchema, …]).superRefine(…)`
 * — the exported name and output type stay stable.
 */
export const DiagramDocSchema = ArchitectureDocSchema.superRefine(refineArchitectureDoc);

/** Result of {@link validateDoc}: the parsed doc, or all semantic errors. */
export type ValidateDocResult =
  | { ok: true; doc: DiagramDoc }
  | { ok: false; errors: ModelError[] };

/**
 * Validate an unknown value as a {@link DiagramDoc}.
 *
 * Runs {@link DiagramDocSchema} (shape + refinements) and maps every Zod
 * issue to a {@link ModelError} with a `nodes[2].id`-style path. This is the
 * single entry point the server uses after Langium parsing, and what MCP
 * `set_diagram` reports back to Claude on semantic errors.
 */
export function validateDoc(input: unknown): ValidateDocResult {
  const parsed = DiagramDocSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, doc: parsed.data };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      path: formatErrorPath(issue.path),
      message: issue.message,
    })),
  };
}

// --- Compile-time drift guards: schema output must equal the hand-written
// --- types in ./types.ts. A failure here is a broken contract.
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;
type _DirectionInSync = Assert<MutuallyAssignable<z.infer<typeof DirectionSchema>, Direction>>;
type _NodeInSync = Assert<MutuallyAssignable<z.infer<typeof DiagramNodeSchema>, DiagramNode>>;
type _GroupInSync = Assert<MutuallyAssignable<z.infer<typeof DiagramGroupSchema>, DiagramGroup>>;
type _EdgeInSync = Assert<MutuallyAssignable<z.infer<typeof DiagramEdgeSchema>, DiagramEdge>>;
type _DocInSync = Assert<MutuallyAssignable<z.infer<typeof DiagramDocSchema>, DiagramDoc>>;
