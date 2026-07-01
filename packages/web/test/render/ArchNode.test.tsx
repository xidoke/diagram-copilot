import { describe, expect, it } from "vitest";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { ArchGroup, ArchNode } from "../../src/render/ArchNode.js";
import type { ArchNodeData } from "../../src/render/toFlow.js";

/**
 * These tests call the node components as plain functions (no hooks) and walk
 * the returned React element tree — no DOM/jsdom needed. That's enough to prove
 * structural facts like "the group renders handles", which is exactly why an
 * edge terminating on a group (`API > VPC`) now renders: the model + toFlow
 * already carry the edge, but React Flow needs a handle on the target to draw
 * it, and `ArchGroup` previously had none.
 */

/** Recursively gather every React element in a rendered tree. */
function collect(node: unknown, out: any[] = []): any[] {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const c of node) collect(c, out);
    return out;
  }
  out.push(node);
  collect((node as any).props?.children, out);
  return out;
}

const handles = (el: unknown) => collect(el).filter((n) => n.type === Handle);

const renderGroup = (data: Partial<ArchNodeData>) =>
  ArchGroup({ data: { label: "VPC", direction: "right", ...data } } as unknown as NodeProps);
const renderNode = (data: Partial<ArchNodeData>) =>
  ArchNode({ data: { label: "API", direction: "right", ...data } } as unknown as NodeProps);

describe("ArchGroup", () => {
  it("renders hidden target + source handles so edges can terminate on it", () => {
    const hs = handles(renderGroup({}));
    expect(hs).toHaveLength(2);
    const kinds = hs.map((h) => h.props.type).sort();
    expect(kinds).toEqual(["source", "target"]);
    expect(hs.every((h) => h.props.className === "arch-handle")).toBe(true);
  });

  it("positions handles per direction (right → target Left / source Right)", () => {
    const byKind = Object.fromEntries(handles(renderGroup({ direction: "right" })).map((h) => [h.props.type, h.props.position]));
    expect(byKind.target).toBe(Position.Left);
    expect(byKind.source).toBe(Position.Right);
  });

  it("positions handles per direction (down → target Top / source Bottom)", () => {
    const byKind = Object.fromEntries(handles(renderGroup({ direction: "down" })).map((h) => [h.props.type, h.props.position]));
    expect(byKind.target).toBe(Position.Top);
    expect(byKind.source).toBe(Position.Bottom);
  });

  it("applies a depth class, clamped at 3", () => {
    expect((renderGroup({ depth: 0 }) as any).props.className).toContain("arch-group--depth-0");
    expect((renderGroup({ depth: 2 }) as any).props.className).toContain("arch-group--depth-2");
    expect((renderGroup({ depth: 7 }) as any).props.className).toContain("arch-group--depth-3");
  });

  it("adds the accent class only when a color is set", () => {
    expect((renderGroup({}) as any).props.className).not.toContain("arch-group--accent");
    expect((renderGroup({ color: "blue" }) as any).props.className).toContain("arch-group--accent");
  });

  it("renders a small icon chip beside the label when the group has an icon", () => {
    const withIcon = collect(renderGroup({ icon: "server" })).find((n) => n.props?.className === "arch-group-chip");
    expect(withIcon).toBeDefined();
    expect(typeof withIcon.props.dangerouslySetInnerHTML.__html).toBe("string");
    expect(withIcon.props.dangerouslySetInnerHTML.__html.length).toBeGreaterThan(0);
    // No chip when there's no icon.
    expect(collect(renderGroup({})).find((n) => n.props?.className === "arch-group-chip")).toBeUndefined();
  });
});

describe("ArchNode", () => {
  it("still renders target + source handles (regression)", () => {
    const kinds = handles(renderNode({})).map((h) => h.props.type).sort();
    expect(kinds).toEqual(["source", "target"]);
  });
});
