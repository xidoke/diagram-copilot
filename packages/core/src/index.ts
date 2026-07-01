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
