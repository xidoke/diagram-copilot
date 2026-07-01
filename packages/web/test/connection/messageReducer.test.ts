import { describe, expect, it } from "vitest";
import type { DiagramErrorMessage, DiagramMessage, WorkspaceMessage } from "@diagram-copilot/core";
import {
  applyServerMessage,
  initialConnectionState,
} from "../../src/connection/messageReducer";

const diagramMessage: DiagramMessage = {
  kind: "diagram",
  name: "checkout-flow",
  version: 3,
  origin: "mcp",
  dsl: "diagram checkout-flow {}",
  doc: { type: "architecture", direction: "right", nodes: [], edges: [], groups: [] },
};

const diagramErrorMessage: DiagramErrorMessage = {
  kind: "diagram-error",
  name: "checkout-flow",
  version: 3,
  origin: "drawer",
  dsl: "diagram checkout-flow { bad }",
  parseErrors: [],
  modelErrors: [],
};

const workspaceMessage: WorkspaceMessage = {
  kind: "workspace",
  diagrams: ["checkout-flow", "checkout-flow.step2"],
  active: "checkout-flow",
};

describe("initialConnectionState", () => {
  it("starts connecting with no diagram data yet", () => {
    expect(initialConnectionState).toEqual({
      status: "connecting",
      lastDiagram: null,
      lastError: null,
      workspace: null,
    });
  });
});

describe("applyServerMessage", () => {
  it("stores a diagram message as lastDiagram", () => {
    const next = applyServerMessage(initialConnectionState, diagramMessage);
    expect(next.lastDiagram).toBe(diagramMessage);
    expect(next.lastError).toBeNull();
    expect(next.workspace).toBeNull();
  });

  it("stores a diagram-error message as lastError without touching lastDiagram", () => {
    const withDiagram = applyServerMessage(initialConnectionState, diagramMessage);
    const next = applyServerMessage(withDiagram, diagramErrorMessage);
    expect(next.lastError).toBe(diagramErrorMessage);
    expect(next.lastDiagram).toBe(diagramMessage);
  });

  it("stores a workspace message", () => {
    const next = applyServerMessage(initialConnectionState, workspaceMessage);
    expect(next.workspace).toBe(workspaceMessage);
  });

  it("does not mutate the state it was given", () => {
    const before = { ...initialConnectionState };
    applyServerMessage(initialConnectionState, diagramMessage);
    expect(initialConnectionState).toEqual(before);
  });
});
