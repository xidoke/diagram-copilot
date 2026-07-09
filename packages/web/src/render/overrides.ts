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
 * verbatim, with no conversion. Both leaf nodes and groups are draggable
 * (DGC-71: groups by their title band), so an override may key a leaf, a
 * root node, or a group — all handled identically since the frame is the same.
 */
import type { Edge, Node } from "@xyflow/react";
import type { LayoutOverrides } from "@diagram-copilot/core";

/**
 * Web-side override value. The core sidecar schema ({@link LayoutOverrides})
 * stores only `{ x, y }`; DGC-19 group resize adds an OPTIONAL `{ width,
 * height }`. `SizedOverrides` is a strict superset (every `LayoutOverrides`
 * is a valid `SizedOverrides`), so it slots into the same fetch/apply/PUT
 * plumbing. NOTE: the server's Zod schema strips the extra keys on PUT, so a
 * size override survives a re-layout WITHIN a session (it lives in the client
 * override map) but not across a reload until the core schema gains the two
 * optional fields — see the DGC-19 report / server `LayoutPositionSchema`.
 */
export interface SizedPosition {
  x: number;
  y: number;
  width?: number;
  height?: number;
}
export type SizedOverrides = Record<string, SizedPosition>;

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
export async function putOverrides(name: string, overrides: SizedOverrides): Promise<void> {
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
 * marker; all other nodes are returned unchanged. Applies to leaves, root
 * nodes, and groups alike (DGC-71 — a dragged group's descendants ride along
 * for free because their positions are parent-relative). Override ids with no
 * matching node are ignored. Does not mutate the input.
 */
export function applyOverrides(nodes: Node[], overrides: SizedOverrides): Node[] {
  return nodes.map((node) => {
    const override = overrides[node.id];
    if (!override) return node;
    const className = node.className
      ? `${node.className} ${PINNED_CLASS}`
      : PINNED_CLASS;
    const next: Node = { ...node, position: { x: override.x, y: override.y }, className };
    // A group SIZE override (DGC-19) is applied to both `width`/`height` (which
    // React Flow's node wrapper prefers over `style.width`) and `style` (how
    // `toFlow` sizes a group in the first place), so the resized size holds
    // whichever path measures it. Position-only overrides leave size untouched.
    if (override.width !== undefined && override.height !== undefined) {
      next.width = override.width;
      next.height = override.height;
      next.style = { ...node.style, width: override.width, height: override.height };
    }
    return next;
  });
}

/**
 * Edge-side companion of {@link applyOverrides} (DGC-69): flag every edge
 * whose source OR target has a saved override as `data.dirtyEndpoints` — the
 * ELK-routed sections were computed for the auto-layout position, so once an
 * endpoint is pinned elsewhere the static route is meaningless and `ElkEdge`
 * must draw a live smoothstep instead. Pure: edges whose flag already matches
 * are returned unchanged (base edges carry no flag, which reads as `false`).
 *
 * ANCESTOR CASE (DGC-71): dragging a group moves all its descendants (their
 * positions are parent-relative), so an ELK route touching a descendant — or
 * one crossing the group's boundary — is stale even though the descendant's
 * own id has no override. Pass `nodes` and an endpoint is considered
 * overridden when the endpoint itself OR any ancestor group in its `parentId`
 * chain has an override. Called without `nodes`, it degrades to the original
 * endpoint-only check (kept for existing 2-arg callers/tests).
 */
export function markDirtyEdges(
  edges: Edge[],
  overrides: LayoutOverrides,
  nodes?: Node[],
): Edge[] {
  // Map each node id → its parent id (undefined for root) so we can walk the
  // ancestry chain. Built once per call from the current node array.
  const parentOf = new Map<string, string | undefined>();
  if (nodes) for (const n of nodes) parentOf.set(n.id, n.parentId);

  // Is `id` — or any group above it — pinned? Walks the parentId chain (the
  // model guarantees it is acyclic; a visited guard makes it safe regardless).
  const overriddenWithAncestors = (id: string): boolean => {
    let cur: string | undefined = id;
    const seen = new Set<string>();
    while (cur !== undefined && !seen.has(cur)) {
      if (overrides[cur] !== undefined) return true;
      seen.add(cur);
      cur = parentOf.get(cur);
    }
    return false;
  };

  return edges.map((edge) => {
    const dirty =
      overriddenWithAncestors(edge.source) || overriddenWithAncestors(edge.target);
    if (Boolean(edge.data?.dirtyEndpoints) === dirty) return edge;
    return { ...edge, data: { ...edge.data, dirtyEndpoints: dirty } };
  });
}
