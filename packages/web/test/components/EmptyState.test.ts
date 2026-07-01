import { describe, expect, it } from "vitest";
import { parseDsl, type DiagramMessage, type WorkspaceMessage } from "@diagram-copilot/core";
import { DEMO_DSL, shouldShowEmptyState } from "../../src/components/EmptyState";

const workspace = (diagrams: string[], active = diagrams[0] ?? "untitled"): WorkspaceMessage => ({
  kind: "workspace",
  diagrams,
  active,
});

const diagram = (overrides: Partial<DiagramMessage> = {}): DiagramMessage => ({
  kind: "diagram",
  name: "demo",
  version: 0,
  origin: "mcp",
  dsl: "A > B\n",
  doc: { direction: "right", nodes: [], groups: [], edges: [] },
  ...overrides,
});

describe("shouldShowEmptyState", () => {
  it("stays hidden while still connecting (no workspace message yet)", () => {
    expect(shouldShowEmptyState(null, null)).toBe(false);
  });

  it("stays hidden while connecting even if a stray diagram somehow arrived", () => {
    expect(shouldShowEmptyState(null, diagram())).toBe(false);
  });

  it("shows once the workspace is confirmed genuinely empty", () => {
    expect(shouldShowEmptyState(workspace([], "untitled"), null)).toBe(true);
  });

  it("stays hidden when the workspace already lists diagrams", () => {
    expect(shouldShowEmptyState(workspace(["news-feed"], "news-feed"), null)).toBe(false);
  });

  it("stays hidden when a diagram is already rendered, even if workspace.diagrams is (stale-)empty", () => {
    expect(shouldShowEmptyState(workspace([], "untitled"), diagram())).toBe(false);
  });

  it("stays hidden when both a workspace listing and a diagram are present", () => {
    expect(shouldShowEmptyState(workspace(["news-feed"], "news-feed"), diagram({ name: "news-feed" }))).toBe(
      false,
    );
  });
});

describe("DEMO_DSL", () => {
  it("parses cleanly with the core DSL parser", () => {
    const result = parseDsl(DEMO_DSL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.doc.nodes).toHaveLength(4);
    expect(result.doc.groups).toHaveLength(1);
  });

  it("gives every node an icon and a color", () => {
    const result = parseDsl(DEMO_DSL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const node of result.doc.nodes) {
      expect(node.icon).toBeTruthy();
      expect(node.color).toBeTruthy();
    }
  });

  it("places two of the four nodes inside the group", () => {
    const result = parseDsl(DEMO_DSL);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const grouped = result.doc.nodes.filter((n) => n.groupId === result.doc.groups[0]?.id);
    expect(grouped).toHaveLength(2);
  });
});
