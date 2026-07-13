import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeMouseHandler,
  type Node,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./tokens.css";
import "./App.css";
import { layoutDiagram } from "@diagram-copilot/layout";
import { EmptyState, shouldShowEmptyState } from "./components/EmptyState.js";
import { ExportMenu } from "./components/ExportMenu.js";
import { Picker } from "./components/Picker.js";
import { SearchBox } from "./components/SearchBox.js";
import { StatusPill } from "./components/StatusPill.js";
import { StepsNav } from "./components/StepsNav.js";
import { Toolbar } from "./components/Toolbar.js";
import { UndoButton } from "./components/UndoButton.js";
import { Drawer } from "./components/Drawer.js";
import { NotesPanel } from "./components/NotesPanel.js";
import { PresentMode } from "./components/PresentMode.js";
import { isEditableTarget } from "./components/UndoButton.js";
import { useDiagramConnection } from "./connection/index.js";
import { applyPrefs, loadLayoutPrefs, saveLayoutPrefs, type LayoutPrefs } from "./render/layoutOptions.js";
import { reportSnapshotRendered, setSnapshotProvider, type RenderedStamp } from "./render/snapshotResponder.js";
import { ArchGroup, ArchNode } from "./render/ArchNode.js";
import { EditContext, type EditActions } from "./render/EditContext.js";
import {
  buildAddEdgeOp,
  buildDropNodeOp,
  buildDuplicateOps,
  buildRemoveOps,
  buildSetAttrOp,
  buildSetEdgeLabelOp,
  describeRemoval,
  describeReparent,
  groupAtPoint,
  postEdit,
  type GroupBox,
} from "./render/editRequests.js";
import { dropOverridePosition } from "./render/dropPlacement.js";
import { ContextMenu, type ContextMenuTarget } from "./components/ContextMenu.js";
import { InlineEdgeInput } from "./components/InlineEdgeInput.js";
import { ICON_DND_MIME } from "./components/IconPalette.js";
import { ELK_EDGE_TYPE, ElkEdge, ElkEdgeMarkerDefs } from "./render/ElkEdge.js";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE, toFlow } from "./render/toFlow.js";
import {
  applyOverrides,
  deleteOverrides,
  fetchOverrides,
  markDirtyEdges,
  putOverrides,
  type SizedOverrides,
} from "./render/overrides.js";
import {
  absoluteBoxes,
  decideReparent,
  type AbsBox,
  type NodeGeom,
} from "./render/reparent.js";
import { applyDiffToEdges, applyDiffToNodes, type DiffOverlay } from "./render/diffOverlay.js";
import {
  applyHoverToEdges,
  edgeLabelIdFromEventTarget,
  type HoverTarget,
} from "./render/hoverHighlight.js";
import {
  collapseDoc,
  collapsedNodeIds,
  loadCollapsed,
  markCollapsedNodes,
  pruneCollapsedSizes,
  saveCollapsed,
} from "./render/collapse.js";
import { CollapseContext, type CollapseActions } from "./render/CollapseContext.js";
import {
  breadcrumbItems,
  drillDoc,
  drillPathTo,
  externalNodeIds,
  loadDrill,
  markExternalNodes,
  saveDrill,
  validateDrillPath,
  type DrillExternalMode,
} from "./render/drill.js";
import { DrillBreadcrumb } from "./components/DrillBreadcrumb.js";
import type { CompareData } from "./render/compareMode.js";
import { ComparePane } from "./components/ComparePane.js";

export const APP_TITLE = "diagram-copilot";

/** Debounce window before a dragged position is persisted via PUT (T30). */
const LAYOUT_SAVE_DEBOUNCE_MS = 300;

/** Debounce window before a fitView fires, so a burst of diagram messages
 *  (e.g. fast-typed edits) collapses into one fit instead of racing. */
const FIT_VIEW_DEBOUNCE_MS = 100;

/** How long an ELK layout pass must run before the "⋯ layout" chip appears —
 *  fast layouts (the common case) never flash it. */
const LAYOUT_INDICATOR_DELAY_MS = 200;

/** MiniMap (DGC-64/F4) only earns its screen space once a diagram is big
 *  enough that the canvas can't be taken in at a glance. */
const MINIMAP_MIN_NODES = 8;

/** How long the visual-editing toast (delete/rename receipts, DGC-78) stays up. */
const EDIT_TOAST_TIMEOUT_MS = 3000;

/** How long a recorded palette drop (DGC-86) waits for its node to arrive on a
 *  broadcast before it is discarded — avoids a leak when the add is rejected. */
const DROP_PENDING_TTL_MS = 5000;

/** Open inline edge-label editor (DGC-85): editing an existing edge's label, or
 *  naming a not-yet-created edge from an Alt-drag connection. `x`/`y` are the
 *  viewport point the input centers on. */
type LabelEditorState =
  | { kind: "edit"; edgeId: string; current: string; x: number; y: number }
  | { kind: "new"; from: string; to: string; x: number; y: number };

const nodeTypes = { [ARCH_NODE_TYPE]: ArchNode, [ARCH_GROUP_TYPE]: ArchGroup };
const edgeTypes = { [ELK_EDGE_TYPE]: ElkEdge };

/** Stable "no groups collapsed" set — keeps effect deps quiet when inactive. */
const NO_COLLAPSED: ReadonlySet<string> = new Set();

/** Stable "not drilled" path — keeps effect deps quiet when at root (DGC-89). */
const NO_DRILL: readonly string[] = [];

/**
 * How the drill view renders the world outside the focus (DGC-89): both modes
 * exist in `drillDoc` (pure, tested); "collapse" won the eyeball test — the
 * C4-style context reps keep answering "who talks to this interior", where
 * "hide" throws every cross-boundary edge away and strands the view.
 */
const DRILL_EXTERNAL_MODE: DrillExternalMode = "collapse";

/**
 * Overlays that own Esc themselves (each closes on Esc via its own listener).
 * While any is open in the DOM, the drill Esc handler stays quiet — Esc must
 * close the overlay, not also climb a drill level (DGC-89). App-owned
 * overlays (present/compare/label editor/context menu) are guarded by state
 * instead; these dropdown panels keep their open flag private, so presence in
 * the DOM is the one signal App can read without new plumbing.
 */
const OPEN_OVERLAY_SELECTOR =
  ".picker__panel, .export-menu__panel, .icon-palette__panel, .ctx-menu, .search-box";

/** A node's rendered size — `width`/`height` (set by resize/override) win over the
 *  `style` size `toFlow` gives it. Used to hit-test a drop against group boxes. */
function nodeSize(n: Node): { width: number; height: number } {
  const width = typeof n.width === "number" ? n.width : Number(n.style?.width) || 0;
  const height = typeof n.height === "number" ? n.height : Number(n.style?.height) || 0;
  return { width, height };
}

function DiagramCanvas() {
  const { status, lastDiagram, lastError, workspace, send } = useDiagramConnection();
  // `base` is the pure ELK auto-layout; `flow` is what React Flow renders =
  // base with saved manual overrides folded in (and any in-progress drag). The
  // split keeps re-layout (ELK) off the drag/override hot path (T30).
  // `stamp` carries which (name, version) the nodes were laid out FROM, so the
  // snapshot responder's render gate can tell when the DOM really shows the
  // content a snapshot-request asks for (DGC-101).
  const [base, setBase] = useState<{ nodes: Node[]; edges: Edge[]; stamp?: RenderedStamp }>({ nodes: [], edges: [] });
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[]; stamp?: RenderedStamp }>({ nodes: [], edges: [] });
  // Manual position overrides for the active diagram. Mirrored into a ref so the
  // drag handler can build the next record without re-subscribing every render.
  const [overrides, setOverridesState] = useState<SizedOverrides>({});
  const overridesRef = useRef<SizedOverrides>({});
  const setOverrides = useCallback((next: SizedOverrides) => {
    overridesRef.current = next;
    setOverridesState(next);
  }, []);
  const saveTimerRef = useRef<number | null>(null);
  // Palette drops (DGC-86) awaiting their node on a broadcast, keyed by the new
  // node's name → the absolute-flow drop point + when it was recorded. When the
  // node first appears we write its position override here, then drop the entry.
  const pendingDropsRef = useRef<Map<string, { dropAbs: { x: number; y: number }; ts: number }>>(new Map());
  const [prefs, setPrefs] = useState<LayoutPrefs>(() => loadLayoutPrefs());
  const diagramName = lastDiagram?.name ?? null;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleDrawer = useCallback(() => setDrawerOpen((o) => !o), []);
  const [notesOpen, setNotesOpen] = useState(false);
  const toggleNotes = useCallback(() => setNotesOpen((o) => !o), []);
  // Present mode (DGC-73) — full-screen step walkthrough. All the entry/exit
  // hotkeys + UI live in PresentMode; App just owns the on/off flag so it can
  // add the `presenting` class that hides chrome.
  const [presentOn, setPresentOn] = useState(false);
  // Bottom-right "⋯ layout" chip — on only while a layout pass is running
  // past LAYOUT_INDICATOR_DELAY_MS (see the layout effect below).
  const [layingOut, setLayingOut] = useState(false);
  // Δ diff overlay (DGC-79) — the class maps StepsNav computes when its Δ toggle
  // is on; `null` when off. Folded onto the derived flow below.
  const [diffOverlay, setDiffOverlay] = useState<DiffOverlay | null>(null);
  // ⧉ compare mode (DGC-88) — the step pair StepsNav computes when its ⧉ toggle
  // is on; `null` when off. Splits the canvas: previous step rendered static on
  // the left (ComparePane), `right` classes folded onto the live flow below.
  const [compare, setCompare] = useState<CompareData | null>(null);
  // Scopes DOM queries (group-box hit tests) to the LIVE canvas — with the
  // compare pane mounted, a document-wide `.react-flow__node` query could match
  // the left pane's copy of the same node id first.
  const canvasHostRef = useRef<HTMLDivElement | null>(null);
  // Right-click context menu (DGC-20) — `null` when closed. Carries the target
  // node/group plus the viewport point the menu anchors at.
  const [contextMenu, setContextMenu] = useState<{ target: ContextMenuTarget; x: number; y: number } | null>(null);
  // Inline edge-label input (DGC-85) — `null` when closed. Carries whether it is
  // editing an existing edge or naming a new (Alt-drag) one, plus the anchor.
  const [labelEditor, setLabelEditor] = useState<LabelEditorState | null>(null);
  const { fitView, getNodes, getNodesBounds, screenToFlowPosition } = useReactFlow();

  // Group collapse/expand (DGC-67) — VIEW state, per diagram, persisted to
  // localStorage (`dgc.collapsed.<name>`), never to the doc or the layout
  // sidecar. The state carries the diagram name it belongs to so a stale set
  // from diagram A is never applied to diagram B; a fresh diagram reads its
  // saved set synchronously (useMemo) — no flash of the expanded layout.
  const [collapsedState, setCollapsedState] = useState<{ name: string; ids: ReadonlySet<string> } | null>(null);
  const collapsed = useMemo<ReadonlySet<string>>(() => {
    if (!diagramName) return NO_COLLAPSED;
    if (collapsedState?.name === diagramName) return collapsedState.ids;
    return loadCollapsed(diagramName);
  }, [diagramName, collapsedState]);
  const toggleCollapse = useCallback(
    (id: string) => {
      if (!diagramName) return;
      setCollapsedState((prev) => {
        const ids = new Set(prev?.name === diagramName ? prev.ids : loadCollapsed(diagramName));
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        saveCollapsed(diagramName, ids);
        return { name: diagramName, ids };
      });
    },
    [diagramName],
  );
  // Handed to ArchGroup/ArchNode's CollapseToggle via context (same pattern as
  // EditContext). `null` without an active diagram → the ▾/▸ buttons hide.
  const collapseActions = useMemo<CollapseActions | null>(
    () => (diagramName ? { toggle: toggleCollapse } : null),
    [diagramName, toggleCollapse],
  );

  // C4 drill-down (DGC-89) — VIEW state exactly like collapse above: a path
  // of group ids from the root, per diagram, persisted to localStorage
  // (`dgc.drill.<name>`), never to the doc or the layout sidecar. Same
  // name-tagged state so diagram A's drill never applies to diagram B, and a
  // freshly activated diagram restores its own saved path synchronously.
  const [drillState, setDrillState] = useState<{ name: string; path: readonly string[] } | null>(null);
  const drillPath = useMemo<readonly string[]>(() => {
    if (!diagramName) return NO_DRILL;
    if (drillState?.name === diagramName) return drillState.path;
    return loadDrill(diagramName);
  }, [diagramName, drillState]);
  const setDrill = useCallback(
    (path: readonly string[]) => {
      if (!diagramName) return;
      saveDrill(diagramName, path);
      setDrillState({ name: diagramName, path });
    },
    [diagramName],
  );
  // What actually renders: the stored path degraded to its longest prefix
  // still valid in THIS doc (deleted deepest group → its parent; broken chain
  // → root). The stale stored value is kept, so an undo that restores the
  // group also restores the drill — mirror of collapse's stale-id behavior.
  const activeDrill = useMemo<readonly string[]>(
    () => (lastDiagram ? validateDrillPath(lastDiagram.doc, drillPath) : NO_DRILL),
    [lastDiagram, drillPath],
  );
  const drillItems = useMemo(
    () => (lastDiagram && activeDrill.length > 0 ? breadcrumbItems(lastDiagram.doc, activeDrill) : []),
    [lastDiagram, activeDrill],
  );

  useEffect(() => {
    saveLayoutPrefs(prefs);
  }, [prefs]);

  // Give the snapshot responder (T24) access to the live node bbox — only
  // this component sits inside the ReactFlowProvider, so it owns the getter.
  useEffect(() => {
    setSnapshotProvider(() => getNodesBounds(getNodes()));
    return () => setSnapshotProvider(null);
  }, [getNodes, getNodesBounds]);

  useEffect(() => {
    if (!lastDiagram) {
      setLayingOut(false);
      return;
    }
    let stale = false;
    const { doc, options } = applyPrefs(lastDiagram.doc, prefs);
    // Drill (DGC-89) then collapse (DGC-67) — both pure doc transforms applied
    // BEFORE ELK, so the layout engine re-lays out the whole (smaller) doc
    // with no coordinate patching. Drill focuses the view on `activeDrill`'s
    // last group (outside world → dimmed context reps); the user's collapse
    // set then still folds groups INSIDE the drilled view — `applied` marks
    // those representatives for the ▸ affordance.
    const { doc: drilledDoc, externalIds } = drillDoc(doc, activeDrill, DRILL_EXTERNAL_MODE);
    const { doc: viewDoc, applied } = collapseDoc(drilledDoc, collapsed);
    const indicatorId = window.setTimeout(() => {
      if (!stale) setLayingOut(true);
    }, LAYOUT_INDICATOR_DELAY_MS);
    layoutDiagram(viewDoc, options)
      .then((graph) => {
        if (stale) return;
        const f = toFlow(viewDoc, graph);
        setBase({
          nodes: markExternalNodes(markCollapsedNodes(f.nodes, applied), externalIds),
          edges: f.edges,
          // Which broadcast these nodes came from — flows into `flow` below and
          // is reported to the snapshot render gate after the DOM commit.
          stamp: { name: lastDiagram.name, version: lastDiagram.version },
        });
      })
      .catch((err) => console.error("layout failed", err))
      .finally(() => {
        if (stale) return;
        window.clearTimeout(indicatorId);
        setLayingOut(false);
      });
    return () => {
      stale = true;
      window.clearTimeout(indicatorId);
    };
  }, [lastDiagram, prefs, collapsed, activeDrill]);

  // Fold saved overrides onto the freshly auto-laid-out base. Runs on a
  // re-layout (`base`) and whenever `overrides` change (fetch / drag / reset) —
  // never re-running ELK, which the layout effect above owns. Edges whose
  // endpoint is overridden are flagged dirty so ElkEdge stops trusting the
  // stale ELK route and follows the live handles instead (DGC-69).
  useEffect(() => {
    // Δ overlay classes (DGC-79) are layered on top of the override pass here,
    // off the drag hot path (onNodesChange). In compare mode (DGC-88) the live
    // canvas is the RIGHT pane, so the compare payload's `right` classes apply
    // instead (StepsNav keeps the two modes mutually exclusive). `null` → no-op.
    const overlay = compare ? compare.right : diffOverlay;
    // A collapsed group's saved SIZE override must not inflate its compact
    // representative node — strip width/height (keep x/y) for those ids
    // (DGC-67). Drill context reps (DGC-89) are the same shape of stand-in
    // (a group rendered as one leaf), so they get the same strip. Position +
    // dirty-edge behavior is unchanged otherwise.
    const repIds = new Set([...collapsedNodeIds(base.nodes), ...externalNodeIds(base.nodes)]);
    const effOverrides = pruneCollapsedSizes(overrides, repIds);
    setFlow({
      nodes: applyDiffToNodes(applyOverrides(base.nodes, effOverrides), overlay),
      // Pass nodes so a dragged group also dirties edges touching its
      // descendants / crossing its boundary (DGC-71 ancestor case).
      edges: applyDiffToEdges(markDirtyEdges(base.edges, effOverrides, base.nodes), overlay),
      stamp: base.stamp,
    });
  }, [base, overrides, diffOverlay, compare]);

  // Snapshot render gate (DGC-101): this effect runs AFTER the `flow` commit —
  // React Flow's nodes for exactly `flow.stamp`'s (name, version) are in the
  // DOM by now — so a snapshot-request racing an open_diagram/set_diagram is
  // held by the responder until the canvas truly shows the requested content
  // instead of capturing the previous diagram's pixels.
  useEffect(() => {
    reportSnapshotRendered(flow.stamp ?? null);
  }, [flow]);
  useEffect(() => () => reportSnapshotRendered(null), []);

  // Load the manual overrides for whichever diagram just became active. Cleared
  // first so diagram A's pins never briefly apply to diagram B.
  useEffect(() => {
    if (!diagramName) return;
    setOverrides({});
    // Drops recorded against the previous diagram must not land on this one.
    pendingDropsRef.current.clear();
    const controller = new AbortController();
    let cancelled = false;
    fetchOverrides(diagramName, controller.signal)
      .then((loaded) => {
        if (!cancelled) setOverrides(loaded);
      })
      .catch((err) => {
        if (!cancelled && (err as Error).name !== "AbortError") {
          console.error("load layout overrides failed", err);
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [diagramName, setOverrides]);

  // Live flow snapshot for the drag/resize/delete handlers — a ref so window
  // listeners and change callbacks don't re-subscribe on every frame.
  const flowRef = useRef(flow);
  flowRef.current = flow;

  // On-screen group boxes (viewport coords) for point hit-tests. Groups are
  // pan surfaces (`pointer-events: none`), so they never show up in an
  // `elementsFromPoint` stack — read their DOM boxes and let `groupAtPoint`
  // pick the innermost one geometrically. Scoped to the LIVE canvas host:
  // the compare pane renders the same node ids (DGC-88). Shared by the
  // palette drop (DGC-18) and the drill double-click (DGC-89).
  const collectGroupBoxes = useCallback((): GroupBox[] => {
    const boxes: GroupBox[] = [];
    const host: ParentNode = canvasHostRef.current ?? document;
    for (const n of flowRef.current.nodes) {
      if (n.type !== ARCH_GROUP_TYPE) continue;
      const el = host.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      boxes.push({ id: n.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    }
    return boxes;
  }, []);

  // ── Hover association (DGC-100) ────────────────────────────────────────
  // One hover target feeds a DERIVED edge array: hovering a node lights up
  // every edge touching it; hovering an edge's line or its floating label
  // lights up that edge (+ label). `flow` itself is never touched, so the
  // diff overlay / compare classes and the drag hot path stay untouched.
  const [hover, setHover] = useState<HoverTarget | null>(null);
  const displayEdges = useMemo(() => applyHoverToEdges(flow.edges, hover), [flow.edges, hover]);
  const onNodeMouseEnter = useCallback<NodeMouseHandler>(
    (_, node) => setHover({ kind: "node", id: node.id }),
    [],
  );
  const onNodeMouseLeave = useCallback<NodeMouseHandler>(
    // Clear only our own entry — enter of the NEXT hovered element may have
    // already landed (React Flow doesn't order leave/enter across elements).
    (_, node) => setHover((h) => (h?.kind === "node" && h.id === node.id ? null : h)),
    [],
  );
  const onEdgeMouseEnter = useCallback<EdgeMouseHandler>(
    (_, edge) => setHover({ kind: "edge", id: edge.id }),
    [],
  );
  const onEdgeMouseLeave = useCallback<EdgeMouseHandler>(
    (_, edge) => setHover((h) => (h?.kind === "edge" && h.id === edge.id ? null : h)),
    [],
  );
  // Edge-label divs render in EdgeLabelRenderer's HTML layer, OUTSIDE the
  // edge's SVG group — React Flow's edge hover events never fire for them.
  // Delegate mouseover/mouseout on the canvas host instead (they bubble).
  const onCanvasMouseOver = useCallback((e: ReactMouseEvent) => {
    const id = edgeLabelIdFromEventTarget(e.target);
    if (id !== null) setHover({ kind: "edge", id });
  }, []);
  const onCanvasMouseOut = useCallback((e: ReactMouseEvent) => {
    const id = edgeLabelIdFromEventTarget(e.target);
    // Moving between children of the same label must not flicker the highlight.
    if (id === null || edgeLabelIdFromEventTarget(e.relatedTarget) === id) return;
    setHover((h) => (h?.kind === "edge" && h.id === id ? null : h));
  }, []);

  // Debounced PUT of the whole override record (T30 sidecar).
  const scheduleSave = useCallback((name: string, next: SizedOverrides) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      putOverrides(name, next).catch((err) => console.error("save layout overrides failed", err));
    }, LAYOUT_SAVE_DEBOUNCE_MS);
  }, []);

  // Drop-point placement (DGC-86): once a broadcast brings back a node we just
  // dropped from the palette, pin it at the recorded drop point via the normal
  // override path — so it lands under the cursor instead of wherever ELK chose.
  // Runs on every `base` change (a new node only arrives through a re-layout);
  // stale entries (an add that was rejected, so the node never comes) are pruned
  // by TTL so the map can't leak. Other nodes' positions are never touched.
  useEffect(() => {
    if (pendingDropsRef.current.size === 0 || !diagramName) return;
    const now = Date.now();
    const byId = new Map(base.nodes.map((n) => [n.id, n] as const));
    // Absolute origins (for converting a drop inside a group into the parent-
    // relative frame overrides are stored in). Reuses the DGC-19 resolver.
    const absBoxes = absoluteBoxes(
      base.nodes.map((n) => {
        const { width, height } = nodeSize(n);
        return { id: n.id, parentId: n.parentId, position: n.position, width, height };
      }),
    );
    let next = overridesRef.current;
    let changed = false;
    for (const [name, pending] of [...pendingDropsRef.current]) {
      if (now - pending.ts > DROP_PENDING_TTL_MS) {
        pendingDropsRef.current.delete(name);
        continue;
      }
      const node = byId.get(name);
      if (!node) continue; // hasn't arrived on the canvas yet — keep waiting
      const parentAbs = node.parentId ? absBoxes.get(node.parentId) ?? null : null;
      const pos = dropOverridePosition(pending.dropAbs, nodeSize(node), parentAbs);
      next = { ...next, [name]: { ...next[name], x: pos.x, y: pos.y } };
      changed = true;
      pendingDropsRef.current.delete(name);
    }
    if (changed) {
      setOverrides(next);
      scheduleSave(diagramName, next);
    }
  }, [base, diagramName, setOverrides, scheduleSave]);

  // Group resize (DGC-19): NodeResizer dispatches the new size through
  // `onNodesChange`; on the terminal frame (`resizing:false`) we persist it as
  // a layout override — x/y kept so the group stays put — so it survives a
  // re-layout, and "reset layout" clears it. NOTE: the core sidecar schema
  // strips width/height today, so the size holds for the session but not across
  // a reload until that schema gains the two optional fields (see report).
  const persistGroupSize = useCallback(
    (id: string, dims: { width: number; height: number } | undefined) => {
      if (!diagramName || !dims) return;
      const node = flowRef.current.nodes.find((n) => n.id === id);
      if (!node || node.type !== ARCH_GROUP_TYPE) return;
      const next: SizedOverrides = {
        ...overridesRef.current,
        [id]: { x: node.position.x, y: node.position.y, width: dims.width, height: dims.height },
      };
      setOverrides(next);
      scheduleSave(diagramName, next);
    },
    [diagramName, setOverrides, scheduleSave],
  );

  // React Flow drag/selection/resize changes → keep the rendered nodes in sync
  // (a leaf follows the cursor while dragging; a group follows its resize
  // handles). Drag persistence happens on drag stop; a resize is persisted here
  // on its terminal frame.
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setFlow((f) => ({ ...f, nodes: applyNodeChanges(changes, f.nodes) }));
      for (const c of changes) {
        if (c.type === "dimensions" && c.resizing === false) persistGroupSize(c.id, c.dimensions);
      }
    },
    [persistGroupSize],
  );

  // Edge selection changes (DGC-78): the flow is controlled, so click-to-select
  // on an edge only sticks if we fold the change back in. Content edits never
  // come through here — deletes go over `/api/edit` and re-render off the WS
  // broadcast (React Flow's built-in delete is disabled below).
  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setFlow((f) => ({ ...f, edges: applyEdgeChanges(changes, f.edges) }));
  }, []);

  // ── Visual editing p1 (DGC-78): canvas gestures → POST /api/edit ──
  // Small self-clearing toast for edit receipts ("Đã xóa X — Undo để hoàn tác")
  // and server-side rejections (duplicate rename, unknown id, …).
  const [editToast, setEditToast] = useState<{ text: string; error: boolean } | null>(null);
  const showEditToast = useCallback((text: string, error = false) => setEditToast({ text, error }), []);
  useEffect(() => {
    if (!editToast) return;
    const id = window.setTimeout(() => setEditToast(null), EDIT_TOAST_TIMEOUT_MS);
    return () => window.clearTimeout(id);
  }, [editToast]);

  // Canvas keyboard edits — all write the DSL via /api/edit (all-or-nothing) and
  // refresh off the resulting broadcast; no local content state is touched. All
  // ignored while typing in an input/textarea/Monaco (same guard as ⌘Z):
  //   • Delete/Backspace → remove the current selection (leaves + edges; a
  //     selected group is skipped by buildRemoveOps, DGC-19);
  //   • ⌘D / Ctrl+D → duplicate the selected leaf nodes (DGC-20), copying
  //     icon/color/label and keeping each copy in the original's group. The
  //     default (browser bookmark) is suppressed.
  useEffect(() => {
    if (!diagramName) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;

      if ((e.metaKey || e.ctrlKey) && (e.key === "d" || e.key === "D")) {
        // Block the browser's Cmd+D bookmark whenever it fires over the canvas,
        // whether or not there's a node to duplicate.
        e.preventDefault();
        const selected = flowRef.current.nodes.filter((n) => n.selected === true);
        const ops = buildDuplicateOps(selected, flowRef.current.nodes.map((n) => n.id));
        if (ops.length === 0) return;
        const what = ops.length === 1 ? `"${ops[0].name}"` : `${ops.length} node`;
        void postEdit(diagramName, ops).then((result) => {
          if (result.ok) showEditToast(`Đã nhân bản ${what} — Undo để hoàn tác`);
          else showEditToast(`Không nhân bản được ${what}: ${result.error ?? "lỗi không rõ"}`, true);
        });
        return;
      }

      if (e.key === "Delete" || e.key === "Backspace") {
        const ops = buildRemoveOps(flowRef.current.nodes, flowRef.current.edges);
        if (ops.length === 0) return;
        e.preventDefault();
        const what = describeRemoval(ops);
        void postEdit(diagramName, ops).then((result) => {
          if (result.ok) showEditToast(`Đã xóa ${what} — Undo để hoàn tác`);
          else showEditToast(`Không xóa được ${what}: ${result.error ?? "lỗi không rõ"}`, true);
        });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diagramName, showEditToast]);

  // ── Right-click context menu (DGC-20): open on a node/group, act via ops ──
  // React Flow hands us the DOM event + the node; we anchor the menu at the
  // pointer and stash the target's id/type/attrs for the pickers. `onPane
  // ContextMenu` (and any left-click, handled inside ContextMenu) closes it.
  const onNodeContextMenu = useCallback<NodeMouseHandler>((event, node) => {
    event.preventDefault();
    setContextMenu({
      target: { id: node.id, type: node.type, data: node.data as ContextMenuTarget["data"] },
      x: event.clientX,
      y: event.clientY,
    });
  }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  // Context-menu "đổi icon" / "đổi màu" → a set_attr op (null value removes it).
  const handleSetAttr = useCallback(
    (id: string, key: "icon" | "color", value: string | null) => {
      if (!diagramName) return;
      const verb = key === "icon" ? "icon" : "màu";
      void postEdit(diagramName, [buildSetAttrOp(id, key, value)]).then((result) => {
        if (result.ok) {
          showEditToast(value === null ? `Đã bỏ ${verb} của "${id}"` : `Đã đổi ${verb} "${id}" → ${value}`);
        } else {
          showEditToast(`Không đổi ${verb} được: ${result.error ?? "lỗi không rõ"}`, true);
        }
      });
    },
    [diagramName, showEditToast],
  );

  // Context-menu delete. A node removes straight; a group is already confirmed
  // inside the menu. `remove` cascades edges (and group members) server-side.
  const handleContextDelete = useCallback(
    (target: ContextMenuTarget) => {
      if (!diagramName) return;
      void postEdit(diagramName, [{ op: "remove", id: target.id }]).then((result) => {
        if (result.ok) showEditToast(`Đã xóa "${target.id}" — Undo để hoàn tác`);
        else showEditToast(`Không xóa được "${target.id}": ${result.error ?? "lỗi không rõ"}`, true);
      });
    },
    [diagramName, showEditToast],
  );

  // Double-click rename (ArchNode/ArchGroup labels) reaches the server through
  // this context — same write path as delete: rename op, WS broadcast back.
  const editActions = useMemo<EditActions | null>(() => {
    if (!diagramName) return null;
    return {
      rename: (id, newName) => {
        void postEdit(diagramName, [{ op: "rename", id, new_name: newName }]).then((result) => {
          if (result.ok) showEditToast(`Đã đổi tên "${id}" → "${newName}"`);
          else showEditToast(`Không đổi tên được: ${result.error ?? "lỗi không rõ"}`, true);
        });
      },
    };
  }, [diagramName, showEditToast]);

  // ── Add gestures (DGC-18): palette drop → add_node, handle-drag → add_edge ──
  // Alt (Option on macOS) held while releasing a handle-drag connection opens a
  // label prompt for the new edge. Tracked in a ref because React Flow's
  // `onConnect` hands us the connection, not the originating event's modifiers.
  const altPressedRef = useRef(false);
  // Last pointer position (viewport coords) — `onConnect` gets the connection but
  // not an event, so the inline label input (DGC-85) anchors at where the drag
  // was released, which is the last pointermove.
  const pointerRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const track = (e: KeyboardEvent) => {
      altPressedRef.current = e.altKey;
    };
    const clear = () => {
      altPressedRef.current = false;
    };
    const trackPointer = (e: PointerEvent) => {
      pointerRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", clear);
    window.addEventListener("pointermove", trackPointer);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", clear);
      window.removeEventListener("pointermove", trackPointer);
    };
  }, []);

  // Allow the icon drag (and only that) to drop on the canvas — preventDefault
  // on dragover is what makes an element a valid HTML5 drop target.
  const onDragOver = useCallback((event: DragEvent) => {
    if (!event.dataTransfer.types.includes(ICON_DND_MIME)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  // Drop an icon from the palette → add a node (named after the icon, that icon
  // set on it), nested into whatever group the drop landed inside. No optimistic
  // node: the write goes over /api/edit and the canvas refreshes off the
  // broadcast; ELK decides the new node's position (position-at-drop is a
  // deliberate v1 non-goal — see DGC-18).
  const onDrop = useCallback(
    (event: DragEvent) => {
      const iconId = event.dataTransfer.getData(ICON_DND_MIME);
      if (!iconId) return;
      event.preventDefault();
      if (!diagramName) return;
      const nodes = flowRef.current.nodes;
      // Hit-test the drop point against each group's on-screen box (see
      // collectGroupBoxes). Innermost group wins; undefined → the DSL root —
      // except while drilled (DGC-89): open canvas then means "the room
      // you're in", so the drop targets the focus group instead of a root
      // the drill view doesn't even show.
      const group =
        groupAtPoint(event.clientX, event.clientY, collectGroupBoxes()) ??
        (activeDrill.length > 0 ? activeDrill[activeDrill.length - 1] : undefined);
      const op = buildDropNodeOp(iconId, nodes.map((n) => n.id), group);
      // Absolute flow coords of the drop point (DGC-86) — recorded so the new
      // node lands here once the broadcast returns it, instead of at ELK's spot.
      const dropAbs = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      void postEdit(diagramName, [op]).then((result) => {
        if (result.ok) {
          pendingDropsRef.current.set(op.name, { dropAbs, ts: Date.now() });
          showEditToast(`Đã thêm node "${op.name}"${group ? ` vào nhóm "${group}"` : ""}`);
        } else {
          showEditToast(`Không thêm được node: ${result.error ?? "lỗi không rõ"}`, true);
        }
      });
    },
    [diagramName, showEditToast, screenToFlowPosition, collectGroupBoxes, activeDrill],
  );

  // POST an `add_edge` (optionally labelled) and toast the receipt — the shared
  // write path for a plain connect, an Alt-drag that got a label, and one that
  // was dismissed (added without a label).
  const postAddEdge = useCallback(
    (from: string, to: string, label?: string) => {
      if (!diagramName) return;
      const op = buildAddEdgeOp(from, to, label);
      if (!op) return;
      void postEdit(diagramName, [op]).then((result) => {
        if (result.ok) {
          showEditToast(`Đã thêm cạnh ${op.from} > ${op.to}${op.label ? `: ${op.label}` : ""}`);
        } else {
          showEditToast(`Không thêm được cạnh: ${result.error ?? "lỗi không rõ"}`, true);
        }
      });
    },
    [diagramName, showEditToast],
  );

  // Handle-drag from node A to node B → add the edge `A > B`. Plain drop adds it
  // straight away; holding Alt (Option) on drop opens the inline label input
  // (DGC-85, replacing window.prompt) — the edge is only written when that input
  // resolves (Enter → with label; Esc/blur → without, see handleLabelCancel).
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!diagramName) return;
      const { source, target } = connection;
      if (!source || !target) return;
      if (altPressedRef.current) {
        setLabelEditor({ kind: "new", from: source, to: target, x: pointerRef.current.x, y: pointerRef.current.y });
        return;
      }
      postAddEdge(source, target);
    },
    [diagramName, postAddEdge],
  );

  // Double-click an edge → edit its label (DGC-85). Opens the same inline input,
  // prefilled with the current label, anchored at the click. `zoomOnDoubleClick`
  // is already off so nothing zooms underneath.
  const onEdgeDoubleClick = useCallback<EdgeMouseHandler>((event, edge) => {
    event.preventDefault();
    event.stopPropagation();
    const current = typeof edge.label === "string" ? edge.label : "";
    setLabelEditor({ kind: "edit", edgeId: edge.id, current, x: event.clientX, y: event.clientY });
  }, []);

  // Inline label input resolved with a value (Enter):
  //   • editing an edge → a `set_attr {label}` op (blank clears it; unchanged is
  //     a no-op, buildSetEdgeLabelOp returns null);
  //   • a new (Alt-drag) edge → add it with the typed label.
  const handleLabelSubmit = useCallback(
    (editor: LabelEditorState, value: string) => {
      setLabelEditor(null);
      if (!diagramName) return;
      if (editor.kind === "new") {
        postAddEdge(editor.from, editor.to, value);
        return;
      }
      const op = buildSetEdgeLabelOp(editor.edgeId, editor.current, value);
      if (!op) return; // unchanged → nothing to write
      void postEdit(diagramName, [op]).then((result) => {
        if (result.ok) {
          showEditToast(op.value === null ? "Đã bỏ nhãn cạnh" : `Đã đổi nhãn cạnh → "${op.value}"`);
        } else {
          showEditToast(`Không đổi nhãn được: ${result.error ?? "lỗi không rõ"}`, true);
        }
      });
    },
    [diagramName, postAddEdge, showEditToast],
  );

  // Inline label input dismissed (Esc or blur):
  //   • editing an edge → leave the label untouched (do nothing);
  //   • a new (Alt-drag) edge → still add it, WITHOUT a label. The drag gesture
  //     already completed, so discarding the whole edge would be jarring (DGC-85).
  const handleLabelCancel = useCallback(
    (editor: LabelEditorState) => {
      setLabelEditor(null);
      if (editor.kind === "new") postAddEdge(editor.from, editor.to);
    },
    [postAddEdge],
  );

  // ── C4 drill-down zoom (DGC-89): dbl-click a group's body → focus view ──
  // Kept mutually exclusive with the change-visualisation modes (v1 rule):
  // Δ/⧉ diff a WHOLE step pair and present walks whole steps — a focus view
  // underneath either reads as missing content. Entering any of them exits
  // the drill; while one is on, the drill gesture is ignored.
  const changeModeActive = diffOverlay !== null || compare !== null || presentOn;
  const activeDrillRef = useRef(activeDrill);
  activeDrillRef.current = activeDrill;
  useEffect(() => {
    if (!changeModeActive) return;
    if (activeDrillRef.current.length === 0) return;
    setDrill([]);
  }, [changeModeActive, setDrill]);

  // Double-click on a group's BODY dives into it. The body is a pan surface
  // (`pointer-events: none`), so the double-click's target is the react-flow
  // PANE itself — which is exactly what separates this gesture from every
  // element one: the title band (rename + drag handle + ▾ collapse), leaf
  // nodes (rename), and edges (label editor, which also stops propagation)
  // all receive their own events and never surface here as the pane. The
  // group under the point is then found geometrically, innermost first.
  const onCanvasDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.classList.contains("react-flow__pane")) return;
      if (!lastDiagram || changeModeActive) return;
      const hit = groupAtPoint(event.clientX, event.clientY, collectGroupBoxes());
      if (hit === undefined) return;
      // The drill path is the group's full ancestor chain in the SOURCE doc,
      // so diving into a nested group from the root view lands with complete
      // breadcrumbs. Re-clicking the current focus's body is a no-op.
      const path = drillPathTo(lastDiagram.doc, hit);
      if (path === null) return;
      if (path.length === activeDrill.length && path.every((id, i) => id === activeDrill[i])) return;
      setDrill(path);
    },
    [lastDiagram, changeModeActive, activeDrill, collectGroupBoxes, setDrill],
  );

  // Esc climbs ONE drill level. Esc is a crowded key, so this only fires when
  // the drill is actually the topmost context: text inputs keep their native
  // Esc (editable guard); App-owned overlays win by state (present + compare
  // are already exclusive with drill, label editor / context menu close on
  // their own Esc); the self-closing dropdown panels own Esc inside their
  // components, so an open panel — visible in the DOM — silences this too.
  // CAPTURE phase: the panels close via bubble-phase document listeners, and
  // React flushes their unmount at the microtask checkpoint BETWEEN listener
  // invocations — a bubble listener here would see the panel already gone
  // and wrongly pop a level on the same keypress (found in e2e).
  useEffect(() => {
    if (activeDrill.length === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || isEditableTarget(e.target)) return;
      if (presentOn || compare !== null || labelEditor !== null || contextMenu !== null) return;
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) return;
      setDrill(activeDrill.slice(0, -1));
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [activeDrill, presentOn, compare, labelEditor, contextMenu, setDrill]);

  // Drop of a dragged node OR group. DGC-19 splits the outcome by where it
  // landed, hit-testing the dragged box's CENTER against the (absolute) group
  // boxes with `decideReparent` (self + descendants excluded so a node can't be
  // nested into its own subtree):
  //   • dropped in the SAME parent → a plain reposition: record its position as
  //     a layout override (T30/DGC-71), preserving any size override it carries;
  //   • dropped in a DIFFERENT group / out to open canvas → rewrite the DSL
  //     nesting via a `move_to_group` op and drop this node's stale position
  //     override so ELK re-places it in its new home. No optimistic UI — the
  //     canvas refreshes off the resulting WS broadcast (edit-toast on failure).
  const handleNodeDragStop = useCallback(
    (node: Node) => {
      if (!diagramName) return;
      const all = flowRef.current.nodes;
      const geoms: NodeGeom[] = all.map((n) => {
        const { width, height } = nodeSize(n);
        // The dragged node's authoritative final position is the drag-stop node.
        return { id: n.id, parentId: n.parentId, position: n.id === node.id ? node.position : n.position, width, height };
      });
      const boxes = absoluteBoxes(geoms);
      const dragged = boxes.get(node.id);
      const groupBoxes: AbsBox[] = [];
      for (const n of all) {
        if (n.type !== ARCH_GROUP_TYPE) continue;
        const b = boxes.get(n.id);
        if (b) groupBoxes.push(b);
      }
      const decision = dragged
        ? decideReparent({
            nodeId: node.id,
            currentParent: node.parentId ?? null,
            dropPoint: { x: dragged.x + dragged.width / 2, y: dragged.y + dragged.height / 2 },
            groups: groupBoxes,
            nodes: all.map((n) => ({ id: n.id, parentId: n.parentId })),
          })
        : ({ changed: false } as const);

      if (decision.changed) {
        // Re-nest: drop the stale override (its old parent-relative position is
        // meaningless in the new parent) then rewrite the DSL nesting.
        if (node.id in overridesRef.current) {
          const pruned = { ...overridesRef.current };
          delete pruned[node.id];
          setOverrides(pruned);
          scheduleSave(diagramName, pruned);
        }
        void postEdit(diagramName, [{ op: "move_to_group", id: node.id, group: decision.group }]).then((result) => {
          if (result.ok) showEditToast(describeReparent(node.id, decision.group));
          else showEditToast(`Không đổi nhóm được: ${result.error ?? "lỗi không rõ"}`, true);
        });
        return;
      }

      // Same parent → reposition override. Spread the previous record for this
      // node first so a group's size override (DGC-19) survives a later drag.
      const next: SizedOverrides = {
        ...overridesRef.current,
        [node.id]: { ...overridesRef.current[node.id], x: node.position.x, y: node.position.y },
      };
      setOverrides(next);
      scheduleSave(diagramName, next);
    },
    [diagramName, setOverrides, scheduleSave, showEditToast],
  );

  // "Reset layout": clear pins locally and delete the sidecar; the derive
  // effect then restores the pure auto-layout positions.
  const handleResetLayout = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setOverrides({});
    // Drop-in-flight placements would otherwise re-pin a node just after reset.
    pendingDropsRef.current.clear();
    if (diagramName) {
      deleteOverrides(diagramName).catch((err) => console.error("reset layout failed", err));
    }
  }, [diagramName, setOverrides]);

  // Robust fitView: a diagram message can arrive in bursts (fast edits), and
  // React Flow needs the new nodes actually painted before it can measure
  // their bbox. So: debounce 100ms to collapse a burst into one fit, then
  // wait two animation frames (one commit + one paint) before calling
  // fitView. A brand-new diagram (name changed) gets the full 250ms fit
  // duration; an in-place update to the same diagram gets a lighter 150ms
  // fit — we always re-fit on every update rather than trying to detect
  // "small enough" bbox deltas to preserve zoom, since that heuristic added
  // real complexity for a marginal UX gain (see DGC-36 notes).
  const prevDiagramNameRef = useRef<string | null>(null);
  useEffect(() => {
    if (!base.nodes.length) return;
    const isNewDiagram = lastDiagram?.name !== prevDiagramNameRef.current;
    prevDiagramNameRef.current = lastDiagram?.name ?? null;

    let raf1 = 0;
    let raf2 = 0;
    const debounceId = window.setTimeout(() => {
      raf1 = requestAnimationFrame(() => {
        raf2 = requestAnimationFrame(() => {
          fitView({ padding: 0.12, duration: isNewDiagram ? 250 : 150 });
        });
      });
    }, FIT_VIEW_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(debounceId);
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [base, lastDiagram, fitView]);

  // Entering/leaving compare mode resizes the live canvas host (100% ↔ 50%);
  // React Flow observes the resize but keeps the old viewport, so re-fit after
  // the flex split has painted — two rAFs (commit + paint), same recipe as the
  // fitView effect above; one rAF still measures the pre-split width.
  const comparing = compare !== null;
  useEffect(() => {
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        fitView({ padding: 0.12, duration: 200 });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [comparing, fitView]);

  // Keep rendering the last good state; show the banner only while the error
  // is current — a diagram-error carries the version of the last ACCEPTED dsl,
  // so a subsequent fix arrives with a strictly greater version (spec §8).
  const showError = useMemo(() => {
    if (!lastError) return false;
    if (!lastDiagram || lastError.name !== lastDiagram.name) return true;
    return lastDiagram.version <= lastError.version;
  }, [lastError, lastDiagram]);

  // Flattened id/label pairs for SearchBox (DGC-64/F4) — it needs nothing
  // else from a React Flow node.
  const searchNodes = useMemo(
    () => flow.nodes.map((n) => ({ id: n.id, label: String((n.data as { label?: unknown }).label ?? n.id) })),
    [flow.nodes],
  );

  return (
    <EditContext.Provider value={editActions}>
    <CollapseContext.Provider value={collapseActions}>
    <div className={`app-shell${presentOn ? " presenting" : ""}${comparing ? " comparing" : ""}`}>
      {lastDiagram && <Picker workspace={workspace} name={lastDiagram.name} version={lastDiagram.version} />}
      {/* Drill-down breadcrumb (DGC-89) — second pill under the diagram-name
          pill; renders only while drilled. Segment click jumps to that level
          (root segment exits), Esc climbs one level (effect above). */}
      {lastDiagram && (
        <DrillBreadcrumb
          diagramName={lastDiagram.name}
          items={drillItems}
          onJump={(index) => setDrill(activeDrill.slice(0, index + 1))}
        />
      )}
      <Toolbar
        prefs={prefs}
        onChange={setPrefs}
        onResetLayout={diagramName ? handleResetLayout : undefined}
        onPresent={() => setPresentOn(true)}
      >
        {/* Export lives in the toolbar's View cluster (DGC-94) — passed as a
            slot so it keeps its own props/dropdown state. */}
        <ExportMenu name={lastDiagram?.name ?? "diagram"} version={lastDiagram?.version ?? 0} />
      </Toolbar>
      {showError && lastError && (
        <div className="error-banner">
          <b>{lastError.name}</b>:{" "}
          {[...lastError.parseErrors.map((e) => `dòng ${e.line}: ${e.message}`), ...lastError.modelErrors.map((e) => e.message)]
            .slice(0, 3)
            .join(" · ")}
        </div>
      )}
      {/* Arrowhead marker defs — referenced by every elk edge via url(#…),
          from BOTH panes: url() ids resolve document-wide, so the compare
          pane's edges reuse these instead of duplicating the id. */}
      <ElkEdgeMarkerDefs />
      {/* ⧉ compare mode (DGC-88): static previous step on the left; the live
          canvas below becomes the right half via the `comparing` flex split.
          Keyed by step name so sliding the pair (←/→) remounts + re-fits. */}
      {compare && (
        <ComparePane
          key={compare.prevName}
          name={compare.prevName}
          doc={compare.prevDoc}
          overlay={compare.left}
          prefs={prefs}
        />
      )}
      {/* mouseover/out delegation: hover on the floating edge-label divs
          (DGC-100) — see onCanvasMouseOver above. Double-click delegation:
          a dbl-click that surfaces as the PANE is a group-body dive (DGC-89)
          — see onCanvasDoubleClick. */}
      <div
        className="canvas-host"
        ref={canvasHostRef}
        onMouseOver={onCanvasMouseOver}
        onMouseOut={onCanvasMouseOut}
        onDoubleClick={onCanvasDoubleClick}
      >
      <ReactFlow
        nodes={flow.nodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={(_, node) => handleNodeDragStop(node)}
        // Hover association (DGC-100): node hover lights its edges; edge-line
        // hover lights that edge + its label.
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onEdgeMouseEnter={onEdgeMouseEnter}
        onEdgeMouseLeave={onEdgeMouseLeave}
        // Right-click a node/group → context menu (DGC-20). Right-click on the
        // empty pane just dismisses an open one (browser menu left untouched).
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={closeContextMenu}
        // Double-click an edge → inline label editing (DGC-85).
        onEdgeDoubleClick={onEdgeDoubleClick}
        // Handle-drag edge (DGC-18): a connection dropped on any node adds the
        // edge via /api/edit. Loose mode treats a node's two hidden handles as
        // interchangeable so a drag can start/end on either side — the user
        // just drags node→node without aiming at the exact source/target dot.
        onConnect={onConnect}
        connectionMode={ConnectionMode.Loose}
        // Palette icon drop (DGC-18): drop zone for the icon drag.
        onDrop={onDrop}
        onDragOver={onDragOver}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        // Visual editing owns deletion (DGC-78): React Flow's built-in delete
        // would silently drop elements from local state; ours writes the DSL
        // via /api/edit and lets the broadcast re-render the truth.
        deleteKeyCode={null}
        // Multi-select (DGC-20). Left-drag stays PAN (unchanged): React Flow
        // force-disables `selectionOnDrag` while `panOnDrag` is true, so a
        // marquee is drawn by holding Shift and dragging the pane
        // (`selectionKeyCode`, RF's default). `multiSelectionKeyCode` adds
        // Shift so Shift-CLICK also accumulates a selection (Cmd-click keeps
        // working on mac too). Delete/⌘D then act on the whole selection.
        selectionKeyCode="Shift"
        multiSelectionKeyCode={["Meta", "Shift"]}
        // Double-click now means "rename" (node/group labels) — a canvas-level
        // dbl-click zoom firing next to it reads as a glitch.
        zoomOnDoubleClick={false}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--grid-dot)" />
        <Controls />
        {flow.nodes.length > MINIMAP_MIN_NODES && (
          <MiniMap
            className="app-minimap"
            pannable
            zoomable
            // Theme-aware (DGC-94): tokens flip with data-theme, so the map no
            // longer renders as a dark framed box on the light canvas.
            nodeColor="var(--minimap-node)"
            maskColor="var(--minimap-mask)"
            bgColor="var(--minimap-bg)"
          />
        )}
      </ReactFlow>
      </div>
      {workspace && shouldShowEmptyState(workspace, lastDiagram) && (
        <EmptyState workspace={workspace} send={send} />
      )}
      {layingOut && (
        <div className="layout-chip" role="status">
          ⋯ layout
        </div>
      )}
      {editToast && (
        <div className={`edit-toast${editToast.error ? " edit-toast--error" : ""}`} role="status">
          {editToast.text}
        </div>
      )}
      {contextMenu && (
        <ContextMenu
          target={contextMenu.target}
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={closeContextMenu}
          onSetAttr={handleSetAttr}
          onDelete={handleContextDelete}
        />
      )}
      {labelEditor && (
        <InlineEdgeInput
          key={`${labelEditor.kind}:${labelEditor.x}:${labelEditor.y}`}
          x={labelEditor.x}
          y={labelEditor.y}
          initialValue={labelEditor.kind === "edit" ? labelEditor.current : ""}
          placeholder={labelEditor.kind === "edit" ? "Nhãn cạnh…" : "Nhãn (Enter) · Esc = không nhãn"}
          onSubmit={(value) => handleLabelSubmit(labelEditor, value)}
          onCancel={() => handleLabelCancel(labelEditor)}
        />
      )}
      <StatusPill status={status} />
      <StepsNav workspace={workspace} onDiffChange={setDiffOverlay} onCompareChange={setCompare} />
      <UndoButton name={lastDiagram?.name ?? null} />
      <SearchBox nodes={searchNodes} />
      <Drawer open={drawerOpen} onToggle={toggleDrawer} diagram={lastDiagram} send={send} lastError={lastError} />
      <NotesPanel open={notesOpen} onToggle={toggleNotes} name={diagramName} />
      <PresentMode
        present={presentOn}
        onEnter={() => setPresentOn(true)}
        onExit={() => setPresentOn(false)}
        workspace={workspace}
      />
    </div>
    </CollapseContext.Provider>
    </EditContext.Provider>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <DiagramCanvas />
    </ReactFlowProvider>
  );
}
