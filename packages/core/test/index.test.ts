import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

/**
 * Contract surface smoke test: every public export of
 * @diagram-copilot/core must exist. Downstream packages (server, web,
 * layout, icons) build against exactly this list — DGC-22 freezes it.
 */
describe("@diagram-copilot/core public surface", () => {
  it("exports the model contracts", () => {
    expect(core.DirectionSchema).toBeDefined();
    expect(core.DiagramNodeSchema).toBeDefined();
    expect(core.DiagramGroupSchema).toBeDefined();
    expect(core.DiagramEdgeSchema).toBeDefined();
    expect(core.ArchitectureDocSchema).toBeDefined();
    expect(core.DiagramDocSchema).toBeDefined();
    expect(core.validateDoc).toBeTypeOf("function");
  });

  it("exports the shared error schemas", () => {
    expect(core.ParseErrorSchema).toBeDefined();
    expect(core.ModelErrorSchema).toBeDefined();
  });

  it("exports the WS protocol contracts", () => {
    expect(core.OriginSchema).toBeDefined();
    expect(core.DiagramMessageSchema).toBeDefined();
    expect(core.DiagramErrorMessageSchema).toBeDefined();
    expect(core.WorkspaceMessageSchema).toBeDefined();
    expect(core.ServerMessageSchema).toBeDefined();
    expect(core.UpdateMessageSchema).toBeDefined();
    expect(core.ClientMessageSchema).toBeDefined();
    expect(core.parseServerMessage).toBeTypeOf("function");
    expect(core.parseClientMessage).toBeTypeOf("function");
    expect(core.serializeMessage).toBeTypeOf("function");
  });

  it("exports the workspace conventions", () => {
    expect(core.ARCH_EXT).toBe(".arch");
    expect(core.LAYOUT_SIDECAR_EXT).toBe(".layout.json");
    expect(core.isArchFile).toBeTypeOf("function");
    expect(core.diagramNameFromFile).toBeTypeOf("function");
    expect(core.layoutSidecarPath).toBeTypeOf("function");
    expect(core.LayoutPositionSchema).toBeDefined();
    expect(core.LayoutOverridesSchema).toBeDefined();
  });
});
