/**
 * Drop-point placement (DGC-86 / T-VE5): map a palette drop into a manual
 * layout override so the new node lands where the user dropped it, instead of
 * wherever ELK's auto-layout would have put it.
 *
 * The canvas records the drop point in ABSOLUTE flow coordinates
 * (`screenToFlowPosition`) at drop time, then — once the broadcast brings the
 * new node back — turns it into an override entry with {@link dropOverridePosition}.
 *
 * COORDINATE FRAME (must match `overrides.ts`): an override stores the node's
 * top-left in the SAME frame React Flow uses for `node.position` — parent-
 * relative for a nested node, absolute for a root node. So when the drop lands
 * inside a group, the group's absolute origin is subtracted here. The node is
 * CENTERED on the drop point (half its measured size subtracted) so it appears
 * under the cursor, not with its corner there.
 */

/** A point / offset in flow coordinates. */
export interface XY {
  x: number;
  y: number;
}

/**
 * Parent-relative override position that centers a node of `size` on the
 * absolute drop point `dropAbs`. `parentAbsOrigin` is the absolute flow origin
 * of the group the node was dropped into, or `null` for a drop at document root
 * (no offset). Pure — the caller resolves the group's absolute origin (e.g. via
 * `absoluteBoxes` from `reparent.ts`) and the node's measured size.
 */
export function dropOverridePosition(
  dropAbs: XY,
  size: { width: number; height: number },
  parentAbsOrigin: XY | null,
): XY {
  const ox = parentAbsOrigin?.x ?? 0;
  const oy = parentAbsOrigin?.y ?? 0;
  return {
    x: dropAbs.x - ox - size.width / 2,
    y: dropAbs.y - oy - size.height / 2,
  };
}
