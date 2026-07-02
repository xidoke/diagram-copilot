import { useState, type CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getIcon } from "@diagram-copilot/icons";
import { resolveColor } from "./colors.js";
import { useEditActions } from "./EditContext.js";
import { validateRename } from "./editRequests.js";
import type { ArchNodeData } from "./toFlow.js";

const HANDLE_POSITIONS: Record<string, { target: Position; source: Position }> = {
  right: { target: Position.Left, source: Position.Right },
  left: { target: Position.Right, source: Position.Left },
  down: { target: Position.Top, source: Position.Bottom },
  up: { target: Position.Bottom, source: Position.Top },
};

/**
 * Node/group label with double-click-to-rename (DGC-78 visual editing p1).
 *
 * Double-click swaps the label span for an inline input holding the element's
 * NAME (= id — that is what a rename edits; an explicit `label:` attr is a
 * separate attribute and stays put). Enter posts a `rename` op through the
 * {@link useEditActions} context (the canvas then refreshes off the WS
 * broadcast); Escape or blur cancels. Without a provider (render tests, no
 * active diagram) the label is inert.
 *
 * Kept as a CHILD component so `ArchNode`/`ArchGroup` stay hook-free and
 * callable as plain functions (see `ArchNode.test.tsx`), and so the input is
 * class-tagged `nodrag` — React Flow must not start a node/group drag from a
 * pointerdown inside it (critical for the group title band, which doubles as
 * the drag handle).
 */
export function EditableLabel({ id, label, className }: { id: string; label: string; className: string }) {
  const edit = useEditActions();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(id);

  if (!editing || edit === null) {
    return (
      <span
        className={className}
        onDoubleClick={
          edit === null
            ? undefined
            : (e) => {
                e.stopPropagation();
                setDraft(id);
                setEditing(true);
              }
        }
        title={edit === null ? undefined : "Double-click để đổi tên"}
      >
        {label}
      </span>
    );
  }

  const finish = (submit: boolean) => {
    setEditing(false);
    if (!submit) return;
    const next = validateRename(id, draft);
    if (next !== null) edit.rename(id, next);
  };

  return (
    <input
      className="arch-rename-input nodrag nopan"
      value={draft}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        // Keep Enter/Escape/Backspace away from the canvas-level shortcuts
        // (Delete-to-remove, ⌘Z undo) and React Flow's own key handling.
        e.stopPropagation();
        if (e.key === "Enter") finish(true);
        else if (e.key === "Escape") finish(false);
      }}
      onBlur={() => finish(false)}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      aria-label={`Đổi tên "${id}"`}
    />
  );
}

/** Leaf node — theme B "dark blueprint": optional icon chip + label. */
export function ArchNode({ id, data }: NodeProps) {
  const { label, direction, icon, color } = data as ArchNodeData;
  const pos = HANDLE_POSITIONS[direction] ?? HANDLE_POSITIONS.right;
  // `color` is a token *name* (e.g. "orange"); resolveColor turns it into a
  // real CSS value, always falling back to the theme accent so the chip
  // (which always renders once an icon is present) still reads as themed
  // even for nodes without an explicit color. The left accent border below
  // only activates when `color` is actually set, so plain nodes stay
  // uniform.
  const accent = resolveColor(color);
  const style = color !== undefined ? ({ "--node-accent": accent } as CSSProperties) : undefined;
  const className = color !== undefined ? "arch-node arch-node--accent" : "arch-node";

  return (
    <div className={className} style={style}>
      <Handle type="target" position={pos.target} className="arch-handle" />
      {icon !== undefined && (
        <span
          className="arch-node-chip"
          style={{ color: accent }}
          // Icon markup is baked into the trusted @diagram-copilot/icons
          // workspace package at build time (lucide-static / simple-icons
          // artwork, no user or network input reaches this string), so
          // injecting it via dangerouslySetInnerHTML is safe here.
          dangerouslySetInnerHTML={{ __html: getIcon(icon).svg }}
        />
      )}
      <EditableLabel id={id} label={label} className="arch-node-label" />
      <Handle type="source" position={pos.source} className="arch-handle" />
    </div>
  );
}

/** Deepest nesting level that gets its own tint; deeper groups reuse it. */
const MAX_DEPTH_TINT = 3;

/** Group container — dashed outline with an uppercase corner label, subtly accented when colored. */
export function ArchGroup({ id, data }: NodeProps) {
  const { label, direction, icon, color, depth } = data as ArchNodeData;
  const pos = HANDLE_POSITIONS[direction] ?? HANDLE_POSITIONS.right;
  const accent = resolveColor(color);
  const style = color !== undefined ? ({ "--node-accent": accent } as CSSProperties) : undefined;
  // Base + depth tint (clamped) + optional accent. Depth 0 tint is a no-op, so
  // root groups keep the plain `--group-bg`.
  const depthClass = `arch-group--depth-${Math.min(depth ?? 0, MAX_DEPTH_TINT)}`;
  const className = [
    "arch-group",
    depthClass,
    ...(color !== undefined ? ["arch-group--accent"] : []),
  ].join(" ");

  return (
    <div className={className} style={style}>
      {/* Hidden handles so edges may terminate on the group itself
          (`API > VPC`). Positioned by flow direction, like ArchNode. */}
      <Handle type="target" position={pos.target} className="arch-handle" />
      {/* Title band = the group's drag handle (DGC-71). React Flow only starts
          a group drag when the pointerdown lands here (see ARCH_GROUP_DRAG_HANDLE
          / dragHandle in toFlow); the body stays free for pan/select/child-drag.
          `title` gives a hover tooltip hinting the affordance. Double-click on
          the label renames the group (DGC-78) — the rename input is `nodrag`,
          so typing in it never starts a drag. */}
      <div className="arch-group__title" title="Kéo tiêu đề để di chuyển nhóm">
        {icon !== undefined && (
          <span
            className="arch-group-chip"
            style={{ color: accent }}
            // Icon markup comes from the trusted @diagram-copilot/icons package
            // (see ArchNode), so injecting it here is safe.
            dangerouslySetInnerHTML={{ __html: getIcon(icon).svg }}
          />
        )}
        <EditableLabel id={id} label={label} className="arch-group-label" />
      </div>
      <Handle type="source" position={pos.source} className="arch-handle" />
    </div>
  );
}
