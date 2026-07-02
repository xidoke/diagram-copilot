/**
 * Manual layout overrides — the web-side client for the `/api/layout/:name`
 * sidecar API plus the pure merge that folds saved positions into React Flow
 * nodes.
 *
 * COORDINATE SYSTEM (load-bearing): an override is stored in the *same* frame
 * React Flow uses for `node.position` — i.e. the node's top-left relative to
 * its `parentId` group, or absolute canvas coordinates for a root-level node.
 * React Flow keeps a child's `position` parent-relative and reports it that way
 * from `onNodeDragStop`, so a dragged position is stored and re-applied
 * verbatim, with no conversion. Only leaf nodes are draggable (groups keep
 * `draggable: false`), so in practice only leaf positions are ever overridden.
 */
import type { Edge, Node } from "@xyflow/react";
import type { LayoutOverrides } from "@diagram-copilot/core";
import { ARCH_GROUP_TYPE } from "./toFlow.js";

/** CSS class marking a node pinned to a manual position (see `App.css`). */
export const PINNED_CLASS = "arch-node--pinned";

/**
 * HTTP origin of the diagram-copilot server. In production the web bundle is
 * served from the same origin, but in `vite` dev the app runs on a different
 * port while the WS still points at the server (`VITE_WS_URL` /
 * {@link DEFAULT_WS_URL}). Derive the API base from that same URL so both dev
 * and prod hit the one server, converting the `ws(s)` scheme to `http(s)` and
 * dropping the `/ws` path.
 */
function apiBase(): string {
  const wsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  // No explicit override → relative URLs: same-origin in production, and the
  // vite dev proxy forwards `/api/*` to :4747 (a cross-origin absolute URL is
  // CORS-blocked by the browser — found in T25 e2e).
  if (!wsUrl) return "";
  try {
    const url = new URL(wsUrl);
    const protocol = url.protocol === "wss:" ? "https:" : "http:";
    return `${protocol}//${url.host}`;
  } catch {
    return "";
  }
}

function layoutUrl(name: string): string {
  return `${apiBase()}/api/layout/${encodeURIComponent(name)}`;
}

/** Fetch the saved overrides for `name` (`{}` when none / on a missing file). */
export async function fetchOverrides(name: string, signal?: AbortSignal): Promise<LayoutOverrides> {
  const res = await fetch(layoutUrl(name), { signal });
  if (!res.ok) throw new Error(`GET layout overrides for "${name}" failed: ${res.status}`);
  return (await res.json()) as LayoutOverrides;
}

/** Persist the full overrides record for `name`. */
export async function putOverrides(name: string, overrides: LayoutOverrides): Promise<void> {
  const res = await fetch(layoutUrl(name), {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(overrides),
  });
  if (!res.ok) throw new Error(`PUT layout overrides for "${name}" failed: ${res.status}`);
}

/** Remove the sidecar for `name` (reset to pure auto-layout). */
export async function deleteOverrides(name: string): Promise<void> {
  const res = await fetch(layoutUrl(name), { method: "DELETE" });
  if (!res.ok) throw new Error(`DELETE layout overrides for "${name}" failed: ${res.status}`);
}

/**
 * Pure merge: return a new node array where every node whose id has a saved
 * override takes that override's position and gains the {@link PINNED_CLASS}
 * marker; all other nodes are returned unchanged. Group nodes are never
 * overridden (only leaf/root nodes are draggable), and override ids with no
 * matching node are ignored. Does not mutate the input.
 */
export function applyOverrides(nodes: Node[], overrides: LayoutOverrides): Node[] {
  return nodes.map((node) => {
    if (node.type === ARCH_GROUP_TYPE) return node;
    const position = overrides[node.id];
    if (!position) return node;
    const className = node.className
      ? `${node.className} ${PINNED_CLASS}`
      : PINNED_CLASS;
    return { ...node, position: { x: position.x, y: position.y }, className };
  });
}

/**
 * Edge-side companion of {@link applyOverrides} (DGC-69): flag every edge
 * whose source OR target has a saved override as `data.dirtyEndpoints` — the
 * ELK-routed sections were computed for the auto-layout position, so once an
 * endpoint is pinned elsewhere the static route is meaningless and `ElkEdge`
 * must draw a live smoothstep instead. Pure: edges whose flag already matches
 * are returned unchanged (base edges carry no flag, which reads as `false`).
 */
export function markDirtyEdges(edges: Edge[], overrides: LayoutOverrides): Edge[] {
  return edges.map((edge) => {
    const dirty = overrides[edge.source] !== undefined || overrides[edge.target] !== undefined;
    if (Boolean(edge.data?.dirtyEndpoints) === dirty) return edge;
    return { ...edge, data: { ...edge.data, dirtyEndpoints: dirty } };
  });
}
