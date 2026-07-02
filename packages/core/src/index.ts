/**
 * @diagram-copilot/core — shared contracts for diagram-copilot.
 *
 * Frozen by DGC-22: the diagram model (+ Zod validation), shared error
 * shapes, the WS protocol, and workspace file conventions. Every other
 * package (server, web, layout, icons) builds against these exports.
 */

// Diagram model + validation
export type {
  ArchitectureDoc,
  DiagramDoc,
  DiagramEdge,
  DiagramGroup,
  DiagramNode,
  Direction,
} from "./model/index.js";
export {
  ArchitectureDocSchema,
  DiagramDocSchema,
  DiagramEdgeSchema,
  DiagramGroupSchema,
  DiagramNodeSchema,
  DirectionSchema,
  validateDoc,
  type ValidateDocResult,
} from "./model/index.js";

// DSL parser (DGC-26) — eraser-style DSL → DiagramDoc
export { parseDsl, type ParseDslResult } from "./dsl/index.js";

// Structural diff (DGC-74) — `diffDocs(a, b)` compares two DiagramDocs (ids by
// name, edges by from/to/label); `isDiffEmpty` reports "no change". Feeds the
// `diff_diagram` MCP tool and a later design-evolution overlay.
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
} from "./dsl/index.js";

// DSL printer + minimal-diff doc edits (DGC-17) — DiagramDoc → DSL text.
// Foundation for v1.2 visual editing: `printDsl` renders a canonical document,
// `applyDocEdit` rewrites existing text preserving comments/order/bytes of
// everything unchanged, and the primitives wrap single canvas gestures.
export {
  addEdge,
  addNode,
  applyDocEdit,
  moveToGroup,
  printDsl,
  removeEdge,
  removeElement,
  renameElement,
  setAttr,
  type ApplyDocEditOptions,
  type ElementAttrKey,
  type NewEdgeSpec,
  type NewNodeSpec,
} from "./dsl/index.js";

// Shared error shapes
export {
  ModelErrorSchema,
  ParseErrorSchema,
  formatErrorPath,
  type ModelError,
  type ParseError,
} from "./errors.js";

// WS protocol
export {
  ClientMessageSchema,
  ClientOriginSchema,
  DiagramErrorMessageSchema,
  DiagramMessageSchema,
  OriginSchema,
  ServerMessageSchema,
  SnapshotRequestMessageSchema,
  SnapshotResponseMessageSchema,
  UpdateMessageSchema,
  WorkspaceMessageSchema,
  parseClientMessage,
  parseServerMessage,
  serializeMessage,
  type ClientMessage,
  type ClientOrigin,
  type DiagramErrorMessage,
  type DiagramMessage,
  type Origin,
  type ParseMessageResult,
  type ProtocolMessage,
  type ServerMessage,
  type SnapshotRequestMessage,
  type SnapshotResponseMessage,
  type UpdateMessage,
  type WorkspaceMessage,
} from "./protocol/index.js";

// Workspace file conventions
export {
  ARCH_EXT,
  LAYOUT_SIDECAR_EXT,
  LayoutOverridesSchema,
  LayoutPositionSchema,
  diagramNameFromFile,
  isArchFile,
  layoutSidecarPath,
  type LayoutOverrides,
  type LayoutPosition,
} from "./workspace.js";
