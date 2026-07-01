import type { CSSProperties } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { getIcon } from "@diagram-copilot/icons";
import { resolveColor } from "./colors.js";
import type { ArchNodeData } from "./toFlow.js";

const HANDLE_POSITIONS: Record<string, { target: Position; source: Position }> = {
  right: { target: Position.Left, source: Position.Right },
  left: { target: Position.Right, source: Position.Left },
  down: { target: Position.Top, source: Position.Bottom },
  up: { target: Position.Bottom, source: Position.Top },
};

/** Leaf node — theme B "dark blueprint": optional icon chip + label. */
export function ArchNode({ data }: NodeProps) {
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
      <span className="arch-node-label">{label}</span>
      <Handle type="source" position={pos.source} className="arch-handle" />
    </div>
  );
}

/** Group container — dashed outline with an uppercase corner label, subtly accented when colored. */
export function ArchGroup({ data }: NodeProps) {
  const { label, color } = data as ArchNodeData;
  const style = color !== undefined ? ({ "--node-accent": resolveColor(color) } as CSSProperties) : undefined;
  const className = color !== undefined ? "arch-group arch-group--accent" : "arch-group";

  return (
    <div className={className} style={style}>
      <span className="arch-group-label">{label}</span>
    </div>
  );
}
