/**
 * Context handing visual-editing actions (DGC-78) down to the custom React
 * Flow nodes. `ArchNode`/`ArchGroup` are registered in a module-level
 * `nodeTypes` map, so they cannot receive props from `App` — but they DO
 * render inside its tree, so a context provider around `<ReactFlow>` reaches
 * them. `null` (no provider / no active diagram) disables the affordances,
 * which keeps plain render tests provider-free.
 */
import { createContext, useContext } from "react";

export interface EditActions {
  /**
   * Rename a node or group: posts a `rename` op to `/api/edit`. The canvas
   * updates via the resulting WS broadcast; failures surface as a toast.
   */
  rename: (id: string, newName: string) => void;
}

export const EditContext = createContext<EditActions | null>(null);

/** The edit actions, or `null` when visual editing is unavailable. */
export function useEditActions(): EditActions | null {
  return useContext(EditContext);
}
