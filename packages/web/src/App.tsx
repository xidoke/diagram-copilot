import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./tokens.css";
import "./App.css";
import type { LayoutOverrides } from "@diagram-copilot/core";
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
import { setSnapshotProvider } from "./render/snapshotResponder.js";
import { ArchGroup, ArchNode } from "./render/ArchNode.js";
import { EditContext, type EditActions } from "./render/EditContext.js";
import { buildRemoveOps, describeRemoval, postEdit } from "./render/editRequests.js";
import { ELK_EDGE_TYPE, ElkEdge, ElkEdgeMarkerDefs } from "./render/ElkEdge.js";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE, toFlow } from "./render/toFlow.js";
import { applyOverrides, deleteOverrides, fetchOverrides, markDirtyEdges, putOverrides } from "./render/overrides.js";

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

const nodeTypes = { [ARCH_NODE_TYPE]: ArchNode, [ARCH_GROUP_TYPE]: ArchGroup };
const edgeTypes = { [ELK_EDGE_TYPE]: ElkEdge };

function DiagramCanvas() {
  const { status, lastDiagram, lastError, workspace, send } = useDiagramConnection();
  // `base` is the pure ELK auto-layout; `flow` is what React Flow renders =
  // base with saved manual overrides folded in (and any in-progress drag). The
  // split keeps re-layout (ELK) off the drag/override hot path (T30).
  const [base, setBase] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  // Manual position overrides for the active diagram. Mirrored into a ref so the
  // drag handler can build the next record without re-subscribing every render.
  const [overrides, setOverridesState] = useState<LayoutOverrides>({});
  const overridesRef = useRef<LayoutOverrides>({});
  const setOverrides = useCallback((next: LayoutOverrides) => {
    overridesRef.current = next;
    setOverridesState(next);
  }, []);
  const saveTimerRef = useRef<number | null>(null);
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
  const { fitView, getNodes, getNodesBounds } = useReactFlow();

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
    const indicatorId = window.setTimeout(() => {
      if (!stale) setLayingOut(true);
    }, LAYOUT_INDICATOR_DELAY_MS);
    layoutDiagram(doc, options)
      .then((graph) => {
        if (stale) return;
        setBase(toFlow(doc, graph));
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
  }, [lastDiagram, prefs]);

  // Fold saved overrides onto the freshly auto-laid-out base. Runs on a
  // re-layout (`base`) and whenever `overrides` change (fetch / drag / reset) —
  // never re-running ELK, which the layout effect above owns. Edges whose
  // endpoint is overridden are flagged dirty so ElkEdge stops trusting the
  // stale ELK route and follows the live handles instead (DGC-69).
  useEffect(() => {
    setFlow({
      nodes: applyOverrides(base.nodes, overrides),
      // Pass nodes so a dragged group also dirties edges touching its
      // descendants / crossing its boundary (DGC-71 ancestor case).
      edges: markDirtyEdges(base.edges, overrides, base.nodes),
    });
  }, [base, overrides]);

  // Load the manual overrides for whichever diagram just became active. Cleared
  // first so diagram A's pins never briefly apply to diagram B.
  useEffect(() => {
    if (!diagramName) return;
    setOverrides({});
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

  // React Flow drag/selection changes → keep the rendered nodes in sync so a
  // leaf follows the cursor while dragging (persistence happens on drag stop).
  const onNodesChange = useCallback((changes: NodeChange[]) => {
    setFlow((f) => ({ ...f, nodes: applyNodeChanges(changes, f.nodes) }));
  }, []);

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

  // Live flow snapshot for the Delete handler below — a ref so the window
  // listener does not re-subscribe on every drag frame.
  const flowRef = useRef(flow);
  flowRef.current = flow;

  // Delete/Backspace removes the current selection by WRITING THE DSL — ops go
  // to /api/edit (all-or-nothing) and the canvas refreshes off the resulting
  // broadcast; no local content state is touched. Ignored while typing in an
  // input/textarea/Monaco (same guard as the ⌘Z shortcut).
  useEffect(() => {
    if (!diagramName) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (isEditableTarget(e.target)) return;
      const ops = buildRemoveOps(flowRef.current.nodes, flowRef.current.edges);
      if (ops.length === 0) return;
      e.preventDefault();
      const what = describeRemoval(ops);
      void postEdit(diagramName, ops).then((result) => {
        if (result.ok) showEditToast(`Đã xóa ${what} — Undo để hoàn tác`);
        else showEditToast(`Không xóa được ${what}: ${result.error ?? "lỗi không rõ"}`, true);
      });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [diagramName, showEditToast]);

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

  const scheduleSave = useCallback((name: string, next: LayoutOverrides) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      putOverrides(name, next).catch((err) => console.error("save layout overrides failed", err));
    }, LAYOUT_SAVE_DEBOUNCE_MS);
  }, []);

  // Drop of a dragged node OR group (DGC-71): record its position (React Flow
  // reports it in the node's own frame — parent-relative for children, see
  // overrides.ts) and persist the whole record, debounced. Groups key the same
  // override map as leaves; the derive effect re-applies it and their
  // descendants follow because their positions are parent-relative.
  const handleNodeDragStop = useCallback(
    (node: Node) => {
      if (!diagramName) return;
      const next: LayoutOverrides = {
        ...overridesRef.current,
        [node.id]: { x: node.position.x, y: node.position.y },
      };
      setOverrides(next);
      scheduleSave(diagramName, next);
    },
    [diagramName, setOverrides, scheduleSave],
  );

  // "Reset layout": clear pins locally and delete the sidecar; the derive
  // effect then restores the pure auto-layout positions.
  const handleResetLayout = useCallback(() => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    setOverrides({});
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
    <div className={`app-shell${presentOn ? " presenting" : ""}`}>
      {lastDiagram && <Picker workspace={workspace} name={lastDiagram.name} version={lastDiagram.version} />}
      <Toolbar
        prefs={prefs}
        onChange={setPrefs}
        onResetLayout={diagramName ? handleResetLayout : undefined}
        onPresent={() => setPresentOn(true)}
      />
      <ExportMenu name={lastDiagram?.name ?? "diagram"} version={lastDiagram?.version ?? 0} />
      {showError && lastError && (
        <div className="error-banner">
          <b>{lastError.name}</b>:{" "}
          {[...lastError.parseErrors.map((e) => `dòng ${e.line}: ${e.message}`), ...lastError.modelErrors.map((e) => e.message)]
            .slice(0, 3)
            .join(" · ")}
        </div>
      )}
      {/* Arrowhead marker defs — referenced by every elk edge via url(#…). */}
      <ElkEdgeMarkerDefs />
      <ReactFlow
        nodes={flow.nodes}
        edges={flow.edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={(_, node) => handleNodeDragStop(node)}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        // Visual editing owns deletion (DGC-78): React Flow's built-in delete
        // would silently drop elements from local state; ours writes the DSL
        // via /api/edit and lets the broadcast re-render the truth.
        deleteKeyCode={null}
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
            nodeColor="rgba(74, 163, 255, 0.35)"
            maskColor="rgba(5, 8, 14, 0.75)"
            bgColor="var(--panel-translucent)"
          />
        )}
      </ReactFlow>
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
      <StatusPill status={status} />
      <StepsNav workspace={workspace} />
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
