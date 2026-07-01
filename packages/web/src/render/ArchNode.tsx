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

/** Deepest nesting level that gets its own tint; deeper groups reuse it. */
const MAX_DEPTH_TINT = 3;

/** Group container — dashed outline with an uppercase corner label, subtly accented when colored. */
export function ArchGroup({ data }: NodeProps) {
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
      <span className="arch-group-label">
        {icon !== undefined && (
          <span
            className="arch-group-chip"
            style={{ color: accent }}
            // Icon markup comes from the trusted @diagram-copilot/icons package
            // (see ArchNode), so injecting it here is safe.
            dangerouslySetInnerHTML={{ __html: getIcon(icon).svg }}
          />
        )}
        {label}
      </span>
      <Handle type="source" position={pos.source} className="arch-handle" />
    </div>
  );
}
