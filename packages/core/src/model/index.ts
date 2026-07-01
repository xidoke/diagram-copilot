/**
 * Diagram model contracts: TypeScript types, Zod schemas, and
 * {@link validateDoc}. See `types.ts` for the shapes and `schema.ts`
 * for validation rules.
 */
export type {
  ArchitectureDoc,
  DiagramDoc,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  Direction,
} from "./types.js";
export {
  ArchitectureDocSchema,
  DiagramDocSchema,
  DiagramEdgeSchema,
  DiagramGroupSchema,
  DiagramNodeSchema,
  DirectionSchema,
  validateDoc,
  type ValidateDocResult,
} from "./schema.js";
