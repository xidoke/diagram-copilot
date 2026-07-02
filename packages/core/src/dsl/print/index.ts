/**
 * Canvas → DSL printer (DGC-17): canonical printing, minimal-diff rewriting,
 * and the edit primitives v1.2 visual editing builds on.
 */
export { printDsl } from "./print.js";
export { applyDocEdit, type ApplyDocEditOptions } from "./apply.js";
export {
  addEdge,
  addNode,
  moveToGroup,
  removeElement,
  renameElement,
  setAttr,
  type ElementAttrKey,
  type NewEdgeSpec,
  type NewNodeSpec,
} from "./edits.js";
