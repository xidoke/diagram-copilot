/**
 * Inline floating text input for edge labels (DGC-85 / T-VE4).
 *
 * One small `fixed`-positioned input, portaled to <body> (like ContextMenu /
 * IconPalette) so it escapes the canvas stacking context. Two call sites share
 * it, replacing the old `window.prompt`:
 *   • double-click an edge → edit its label (prefilled with the current one);
 *   • Alt-drag a new connection → name the edge before it is created.
 *
 * SEMANTICS (decided at the call site via `onSubmit` / `onCancel`):
 *   • Enter → onSubmit(value)  — apply the typed text;
 *   • Escape → onCancel()      — abandon the typed text;
 *   • blur (click away) → onCancel() — same as Escape (never apply implicitly:
 *     for a label edit that means "leave the label as-is"; for a NEW edge the
 *     caller wires onCancel to still add the edge WITHOUT a label, since the
 *     drag gesture is already complete).
 * Escape and blur both route to onCancel, so the caller only distinguishes
 * "committed a value" from "did not" — the component never double-fires (a
 * `resolved` guard makes Enter's programmatic close swallow the trailing blur).
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "./inlineEdgeInput.css";

export interface InlineEdgeInputProps {
  /** Viewport coords the input centers on (the double-click / drop point). */
  x: number;
  y: number;
  /** Prefilled text (the edge's current label; "" for a new edge). */
  initialValue: string;
  placeholder?: string;
  /** Enter — commit the typed value. */
  onSubmit: (value: string) => void;
  /** Escape or blur — abandon the typed value. */
  onCancel: () => void;
}

export function InlineEdgeInput({ x, y, initialValue, placeholder, onSubmit, onCancel }: InlineEdgeInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards against a double resolve: Enter calls onSubmit then unmounts the
  // input, whose blur would otherwise fire onCancel a beat later.
  const resolved = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const submit = () => {
    if (resolved.current) return;
    resolved.current = true;
    onSubmit(value);
  };
  const cancel = () => {
    if (resolved.current) return;
    resolved.current = true;
    onCancel();
  };

  return createPortal(
    <input
      ref={inputRef}
      className="inline-edge-input"
      type="text"
      value={value}
      placeholder={placeholder}
      style={{ left: x, top: y }}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        // Keep canvas hotkeys (Delete/⌘D) and pane handlers out of the field.
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={cancel}
    />,
    document.body,
  );
}
