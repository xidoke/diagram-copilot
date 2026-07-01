import { describe, expect, it } from "vitest";
import { isEditableTarget, isUndoShortcut, resolveApiBase } from "../../src/components/UndoButton";

describe("isUndoShortcut", () => {
  it("matches ⌘Z and Ctrl+Z (either casing)", () => {
    expect(isUndoShortcut({ key: "z", metaKey: true, ctrlKey: false, shiftKey: false })).toBe(true);
    expect(isUndoShortcut({ key: "z", metaKey: false, ctrlKey: true, shiftKey: false })).toBe(true);
    expect(isUndoShortcut({ key: "Z", metaKey: true, ctrlKey: false, shiftKey: false })).toBe(true);
  });

  it("ignores ⇧⌘Z (redo), plain z, and other keys", () => {
    expect(isUndoShortcut({ key: "z", metaKey: true, ctrlKey: false, shiftKey: true })).toBe(false);
    expect(isUndoShortcut({ key: "z", metaKey: false, ctrlKey: false, shiftKey: false })).toBe(false);
    expect(isUndoShortcut({ key: "a", metaKey: true, ctrlKey: false, shiftKey: false })).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("is true for input, textarea, and contentEditable surfaces", () => {
    expect(isEditableTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isEditableTarget({ tagName: "TEXTAREA" } as unknown as EventTarget)).toBe(true);
    expect(
      isEditableTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
  });

  it("is true anywhere inside the Monaco editor container", () => {
    const insideMonaco = { tagName: "SPAN", isContentEditable: false, closest: () => ({}) };
    expect(isEditableTarget(insideMonaco as unknown as EventTarget)).toBe(true);
  });

  it("is false for null and for a plain non-editable element", () => {
    expect(isEditableTarget(null)).toBe(false);
    const plain = { tagName: "DIV", isContentEditable: false, closest: () => null };
    expect(isEditableTarget(plain as unknown as EventTarget)).toBe(false);
  });
});

describe("resolveApiBase", () => {
  it("defaults to same-origin (empty string) with no VITE_API_BASE set", () => {
    expect(resolveApiBase()).toBe("");
  });
});
