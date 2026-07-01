import { Handle, Position, type NodeProps } from "@xyflow/react";
import type { ArchNodeData } from "./toFlow.js";

const HANDLE_POSITIONS: Record<string, { target: Position; source: Position }> = {
  right: { target: Position.Left, source: Position.Right },
  left: { target: Position.Right, source: Position.Left },
  down: { target: Position.Top, source: Position.Bottom },
  up: { target: Position.Bottom, source: Position.Top },
};

/** Leaf node — theme B "dark blueprint". Icons arrive with T12 (v0.2). */
export function ArchNode({ data }: NodeProps) {
  const { label, direction } = data as ArchNodeData;
  const pos = HANDLE_POSITIONS[direction] ?? HANDLE_POSITIONS.right;
  return (
    <div className="arch-node">
      <Handle type="target" position={pos.target} className="arch-handle" />
      <span className="arch-node-label">{label}</span>
      <Handle type="source" position={pos.source} className="arch-handle" />
    </div>
  );
}

/** Group container — dashed outline with an uppercase corner label. */
export function ArchGroup({ data }: NodeProps) {
  const { label } = data as ArchNodeData;
  return (
    <div className="arch-group">
      <span className="arch-group-label">{label}</span>
    </div>
  );
}
