/**
 * ELK layout configuration — spacing presets, direction mapping, and the
 * option objects handed to elkjs. Ported from the verified spike
 * (`spikes/reactflow-elk-layout/src/App.tsx`): `layered` + `INCLUDE_CHILDREN`
 * + `ORTHOGONAL` edge routing is the combination that lays out nested groups
 * with clean right-angle edges.
 */
import type { LayoutOptions as ElkLayoutOptions } from "elkjs/lib/elk.bundled.js";
import type { Direction } from "@diagram-copilot/core";
import type { LayoutOptions } from "./types.js";

/** Four-sided padding in px, used for `elk.padding`. */
interface Padding {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** A resolved set of spacing values for one {@link LayoutOptions.spacing} preset. */
export interface SpacingPreset {
  /** `elk.spacing.nodeNode` — gap between sibling nodes within a layer. */
  nodeNode: number;
  /** `elk.layered.spacing.nodeNodeBetweenLayers` — gap between successive layers. */
  nodeNodeBetweenLayers: number;
  /** `elk.layered.spacing.edgeNodeBetweenLayers` — gap between edges and nodes across layers. */
  edgeNodeBetweenLayers: number;
  /** Padding inside the root graph. */
  rootPadding: Padding;
  /**
   * Padding inside a group. `top` is larger than the other sides to leave
   * room for the group's title label, matching the spike.
   */
  groupPadding: Padding;
}

/**
 * Spacing presets. `normal` mirrors the spike exactly and is the only one
 * exercised in v0.1; `compact` and `airy` are pre-set constants for later.
 */
export const SPACING_PRESETS: Record<
  NonNullable<LayoutOptions["spacing"]>,
  SpacingPreset
> = {
  compact: {
    nodeNode: 24,
    nodeNodeBetweenLayers: 45,
    edgeNodeBetweenLayers: 20,
    rootPadding: { top: 16, left: 16, bottom: 16, right: 16 },
    groupPadding: { top: 28, left: 12, bottom: 12, right: 12 },
  },
  normal: {
    nodeNode: 40,
    nodeNodeBetweenLayers: 70,
    edgeNodeBetweenLayers: 30,
    rootPadding: { top: 24, left: 24, bottom: 24, right: 24 },
    groupPadding: { top: 34, left: 18, bottom: 18, right: 18 },
  },
  airy: {
    nodeNode: 60,
    nodeNodeBetweenLayers: 110,
    edgeNodeBetweenLayers: 45,
    rootPadding: { top: 36, left: 36, bottom: 36, right: 36 },
    groupPadding: { top: 44, left: 28, bottom: 28, right: 28 },
  },
};

/** Default preset when {@link LayoutOptions.spacing} is omitted. */
export const DEFAULT_SPACING: NonNullable<LayoutOptions["spacing"]> = "normal";

/** Map a document {@link Direction} to ELK's `elk.direction` value. */
export const DIRECTION_TO_ELK: Record<Direction, "RIGHT" | "LEFT" | "UP" | "DOWN"> = {
  right: "RIGHT",
  left: "LEFT",
  up: "UP",
  down: "DOWN",
};

/** Serialize {@link Padding} into ELK's `[top=..,left=..,bottom=..,right=..]` form. */
function elkPadding(p: Padding): string {
  return `[top=${p.top},left=${p.left},bottom=${p.bottom},right=${p.right}]`;
}

/** Layout options for the root graph (algorithm, direction, spacing, padding). */
export function rootLayoutOptions(
  direction: Direction,
  preset: SpacingPreset,
): ElkLayoutOptions {
  return {
    "elk.algorithm": "layered",
    "elk.direction": DIRECTION_TO_ELK[direction],
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.spacing.nodeNodeBetweenLayers": String(preset.nodeNodeBetweenLayers),
    "elk.spacing.nodeNode": String(preset.nodeNode),
    "elk.layered.spacing.edgeNodeBetweenLayers": String(preset.edgeNodeBetweenLayers),
    // Edge labels are ELK-native (DGC-69): labels enter the layered router as
    // real boxes (see measureEdgeLabel), so ELK widens layer gaps to fit them.
    // SMART_DOWN (the documented default, pinned here on the *registered* id —
    // the `elk.edgeLabels.…` spelling is silently ignored) picks the side of
    // the edge with fewer conflicts, defaulting to below.
    "elk.layered.edgeLabels.sideSelection": "SMART_DOWN",
    "elk.padding": elkPadding(preset.rootPadding),
  };
}

/** Layout options for a group node (extra top padding for its title label). */
export function groupLayoutOptions(preset: SpacingPreset): ElkLayoutOptions {
  return {
    "elk.padding": elkPadding(preset.groupPadding),
  };
}
