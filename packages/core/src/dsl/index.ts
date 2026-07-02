/**
 * arch-dsl — minimal eraser-style DSL parser (DGC-26).
 *
 * Grammar lives in `arch-dsl.langium`; `generated/` is produced by
 * `pnpm --filter @diagram-copilot/core generate` (langium-cli) and is
 * committed so downstream packages build without running codegen.
 */
export { parseDsl, type ParseDslResult } from "./parse.js";

// DSL printer + minimal-diff doc edits (DGC-17) — DiagramDoc → DSL text.
export {
  addEdge,
  addNode,
  applyDocEdit,
  moveToGroup,
  printDsl,
  removeElement,
  renameElement,
  setAttr,
  type ApplyDocEditOptions,
  type ElementAttrKey,
  type NewEdgeSpec,
  type NewNodeSpec,
} from "./print/index.js";

// Structural diff between two documents (DGC-74) — powers `diff_diagram` and
// (later) a design-evolution overlay. Additive; ids match by name, edges by
// from/to/label. See `diff.ts` for the matching rules.
export {
  diffDocs,
  isDiffEmpty,
  type AttrField,
  type DocDiff,
  type EdgeLabelChange,
  type EdgeRef,
  type FieldChange,
  type GroupChange,
  type MembershipChange,
  type NodeChange,
} from "./diff.js";
