import { useState, type CSSProperties } from "react";
import { Handle, NodeResizer, Position, type NodeProps } from "@xyflow/react";
import { getIcon } from "@diagram-copilot/icons";
import { resolveColor } from "./colors.js";
import { useCollapseActions } from "./CollapseContext.js";
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

/**
 * Collapse/expand toggle (DGC-67): ▾ on a group's title band collapses it into
 * a compact node; ▸ on that representative node expands it back. A BUTTON, not
 * a double-click — double-click is already the rename gesture (DGC-78), and an
 * explicit affordance beats a hidden one for a destructive-looking view change.
 *
 * Kept as a CHILD component (like {@link EditableLabel}) so `ArchNode`/
 * `ArchGroup` stay hook-free, and class-tagged `nodrag` so pressing it on the
 * group title band (the drag handle) never starts a drag. Without a
 * {@link useCollapseActions} provider (render tests, compare pane, no active
 * diagram) it renders nothing.
 */
export function CollapseToggle({ id, collapsed }: { id: string; collapsed: boolean }) {
  const actions = useCollapseActions();
  if (actions === null) return null;
  const hint = collapsed ? `Mở rộng nhóm "${id}"` : `Thu gọn nhóm "${id}"`;
  return (
    <button
      type="button"
      className="arch-collapse-btn nodrag nopan"
      title={hint}
      aria-label={hint}
      aria-expanded={!collapsed}
      onClick={(e) => {
        e.stopPropagation();
        actions.toggle(id);
      }}
      // Keep the press/double-click from bubbling into group selection, the
      // header drag handle, or the rename double-click next to it.
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {collapsed ? "▸" : "▾"}
    </button>
  );
}

/**
 * Icon chip shared by nodes and groups. Baked open-set icons (lucide /
 * simple-icons) are `currentColor` artwork, so they take the accent tint +
 * soft glow. Opt-in PACK glyphs (DGC-99 — official vendor artwork, e.g. AWS
 * Architecture Icons installed via `pnpm icons:aws`) carry their own baked
 * colors and must render verbatim (vendor terms forbid altering them): the
 * `--pack` modifier turns the tint/glow off so the glyph stays untouched
 * inside the same neutral chip frame, at the same chip size.
 */
export function IconChip({ icon, accent, className }: { icon: string; accent: string; className: string }) {
  const meta = getIcon(icon);
  const isPack = meta.source === "pack";
  return (
    <span
      className={isPack ? `${className} ${className}--pack` : className}
      style={isPack ? undefined : { color: accent }}
      // Icon markup comes from the trusted @diagram-copilot/icons registry:
      // artwork baked in at build time (lucide-static / simple-icons) or a
      // pack the user generated locally on purpose (`pnpm icons:aws`) — no
      // user or network input reaches this string, so injecting it via
      // dangerouslySetInnerHTML is safe here.
      dangerouslySetInnerHTML={{ __html: meta.svg }}
    />
  );
}

/** Leaf node — theme B "dark blueprint": optional icon chip + label. */
export function ArchNode({ id, data }: NodeProps) {
  const { label, direction, icon, color, collapsed } = data as ArchNodeData;
  const pos = HANDLE_POSITIONS[direction] ?? HANDLE_POSITIONS.right;
  // `color` is a token *name* (e.g. "orange"); resolveColor turns it into a
  // real CSS value, always falling back to the theme accent so the chip
  // (which always renders once an icon is present) still reads as themed
  // even for nodes without an explicit color. The left accent border below
  // only activates when `color` is actually set, so plain nodes stay
  // uniform.
  const accent = resolveColor(color);
  const style = color !== undefined ? ({ "--node-accent": accent } as CSSProperties) : undefined;
  const className = [
    "arch-node",
    ...(color !== undefined ? ["arch-node--accent"] : []),
    // A collapsed group's compact representative (DGC-67): dashed border +
    // stacked shadow, styled in App.css.
    ...(collapsed === true ? ["arch-node--collapsed"] : []),
  ].join(" ");

  return (
    <div className={className} style={style}>
      <Handle type="target" position={pos.target} className="arch-handle" />
      {collapsed === true && <CollapseToggle id={id} collapsed />}
      {icon !== undefined && <IconChip icon={icon} accent={accent} className="arch-node-chip" />}
      <EditableLabel id={id} label={label} className="arch-node-label" />
      <Handle type="source" position={pos.source} className="arch-handle" />
    </div>
  );
}

/** Deepest nesting level that gets its own tint; deeper groups reuse it. */
const MAX_DEPTH_TINT = 3;

/** Smallest a group may be dragged (DGC-19 resize) — room for the title band. */
export const GROUP_MIN_WIDTH = 120;
export const GROUP_MIN_HEIGHT = 64;

/** Group container — dashed outline with an uppercase corner label, subtly accented when colored. */
export function ArchGroup({ id, data, selected }: NodeProps) {
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
      {/* Manual resize (DGC-19): handles show only while the group is selected.
          The size is dispatched through React Flow's node changes and persisted
          as a layout override in `App` (onNodesChange → PUT /api/layout). The
          wrapper is `pointer-events:none`, so `.arch-group__resize-*` opt the
          controls back in via CSS. */}
      <NodeResizer
        isVisible={selected === true}
        minWidth={GROUP_MIN_WIDTH}
        minHeight={GROUP_MIN_HEIGHT}
        handleClassName="arch-group__resize-handle"
        lineClassName="arch-group__resize-line"
      />
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
        {/* ▾ collapse (DGC-67): folds the group into one compact node. Lives on
            the title band (already pointer-interactive) as an explicit button —
            double-click stays reserved for rename. */}
        <CollapseToggle id={id} collapsed={false} />
        {icon !== undefined && <IconChip icon={icon} accent={accent} className="arch-group-chip" />}
        <EditableLabel id={id} label={label} className="arch-group-label" />
      </div>
      <Handle type="source" position={pos.source} className="arch-handle" />
    </div>
  );
}
