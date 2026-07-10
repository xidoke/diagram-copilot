/**
 * Context handing the group collapse/expand toggle (DGC-67) down to the
 * custom React Flow nodes — same pattern as {@link EditContext}: the node
 * components live in a module-level `nodeTypes` map so they can't take props
 * from `App`, but a provider around `<ReactFlow>` reaches them. `null` (no
 * provider / no active diagram / the read-only compare pane) hides the
 * ▸/▾ affordances entirely, which keeps plain render tests provider-free.
 */
import { createContext, useContext } from "react";

export interface CollapseActions {
  /**
   * Toggle a group's collapsed state. Collapse is VIEW state (localStorage,
   * per diagram) — the doc itself is never edited; `App` re-runs the pure
   * collapse transform + ELK layout off the updated set.
   */
  toggle: (id: string) => void;
}

export const CollapseContext = createContext<CollapseActions | null>(null);

/** The collapse actions, or `null` when collapse/expand is unavailable. */
export function useCollapseActions(): CollapseActions | null {
  return useContext(CollapseContext);
}
