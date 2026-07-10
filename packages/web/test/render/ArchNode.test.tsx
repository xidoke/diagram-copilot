import { afterEach, describe, expect, it } from "vitest";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { registerIconPack, unregisterIconPack } from "@diagram-copilot/icons";
import { ArchGroup, ArchNode, CollapseToggle, IconChip } from "../../src/render/ArchNode.js";
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

const renderGroup = (data: Partial<ArchNodeData>, extra: Partial<NodeProps> = {}) =>
  ArchGroup({ data: { label: "VPC", direction: "right", ...data }, ...extra } as unknown as NodeProps);
const resizers = (el: unknown) => collect(el).filter((n) => n.type === NodeResizer);
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

  it("renders a NodeResizer whose handles show only when the group is selected (DGC-19)", () => {
    const rs = resizers(renderGroup({}, { selected: true }));
    expect(rs).toHaveLength(1);
    expect(rs[0].props.isVisible).toBe(true);
    // Unselected → the resizer is present but its handles stay hidden.
    expect(resizers(renderGroup({}, { selected: false }))[0].props.isVisible).toBe(false);
    // No `selected` prop at all (plain render) reads as not-visible.
    expect(resizers(renderGroup({}))[0].props.isVisible).toBe(false);
  });

  it("renders a small icon chip beside the label when the group has an icon", () => {
    const chipEl = collect(renderGroup({ icon: "server" })).find((n) => n.type === IconChip);
    expect(chipEl).toBeDefined();
    expect(chipEl.props.className).toBe("arch-group-chip");
    // IconChip is hook-free — call it as a plain function to inspect the span.
    const span = IconChip(chipEl.props) as any;
    expect(typeof span.props.dangerouslySetInnerHTML.__html).toBe("string");
    expect(span.props.dangerouslySetInnerHTML.__html.length).toBeGreaterThan(0);
    // No chip when there's no icon.
    expect(collect(renderGroup({})).find((n) => n.type === IconChip)).toBeUndefined();
  });
});

/** Opt-in pack glyph rendering (DGC-99): verbatim artwork, no tint/glow. */
describe("IconChip", () => {
  afterEach(() => {
    unregisterIconPack("testaws");
  });

  it("tints baked open-set icons with the node accent", () => {
    const span = IconChip({ icon: "server", accent: "#123456", className: "arch-node-chip" }) as any;
    expect(span.props.className).toBe("arch-node-chip");
    expect(span.props.style).toEqual({ color: "#123456" });
    expect(span.props.dangerouslySetInnerHTML.__html).toContain("currentColor");
  });

  it("renders pack glyphs verbatim: --pack modifier, no tint, baked colors kept", () => {
    registerIconPack({
      namespace: "testaws",
      title: "Test AWS",
      license: "test",
      icons: { s3: { title: "Amazon S3", svg: '<svg viewBox="0 0 64 64"><rect fill="#7AA116"/></svg>' } },
    });
    const span = IconChip({ icon: "testaws:s3", accent: "#123456", className: "arch-node-chip" }) as any;
    expect(span.props.className).toBe("arch-node-chip arch-node-chip--pack");
    expect(span.props.style).toBeUndefined();
    expect(span.props.dangerouslySetInnerHTML.__html).toContain('fill="#7AA116"');
  });
});

describe("ArchNode", () => {
  it("still renders target + source handles (regression)", () => {
    const kinds = handles(renderNode({})).map((h) => h.props.type).sort();
    expect(kinds).toEqual(["source", "target"]);
  });
});

/** Collapse/expand affordances (DGC-67). */
const toggles = (el: unknown) => collect(el).filter((n) => n.type === CollapseToggle);

describe("collapse/expand toggle (DGC-67)", () => {
  it("puts a ▾ collapse toggle on the group title band", () => {
    const group = ArchGroup({
      id: "vpc",
      data: { label: "VPC", direction: "right" },
    } as unknown as NodeProps);
    const ts = toggles(group);
    expect(ts).toHaveLength(1);
    expect(ts[0].props).toEqual({ id: "vpc", collapsed: false });
    // It must sit INSIDE the title band (the group's drag handle), so the
    // click target is on the interactive strip, not the pass-through body.
    const band = collect(group).find((n) => n.props?.className === "arch-group__title");
    expect(collect(band).some((n) => n.type === CollapseToggle)).toBe(true);
  });

  it("renders a plain leaf with no toggle and no collapsed styling", () => {
    const node = ArchNode({ id: "api", data: { label: "API", direction: "right" } } as unknown as NodeProps);
    expect(toggles(node)).toHaveLength(0);
    expect((node as any).props.className).not.toContain("arch-node--collapsed");
  });

  it("renders a collapsed representative with a ▸ expand toggle + collapsed class", () => {
    const node = ArchNode({
      id: "vpc",
      data: { label: "VPC (3)", direction: "right", collapsed: true },
    } as unknown as NodeProps);
    const ts = toggles(node);
    expect(ts).toHaveLength(1);
    expect(ts[0].props).toEqual({ id: "vpc", collapsed: true });
    expect((node as any).props.className).toContain("arch-node--collapsed");
  });
});
