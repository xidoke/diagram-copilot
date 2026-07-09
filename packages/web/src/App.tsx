import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
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
import { setSnapshotProvider } from "./render/snapshotResponder.js";
import { ArchGroup, ArchNode } from "./render/ArchNode.js";
import { EditContext, type EditActions } from "./render/EditContext.js";
import {
  buildAddEdgeOp,
  buildDropNodeOp,
  buildDuplicateOps,
  buildRemoveOps,
  buildSetAttrOp,
  describeRemoval,
  describeReparent,
  groupAtPoint,
  postEdit,
  type GroupBox,
} from "./render/editRequests.js";
import { ContextMenu, type ContextMenuTarget } from "./components/ContextMenu.js";
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
  const [base, setBase] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  // Manual position overrides for the active diagram. Mirrored into a ref so the
  // drag handler can build the next record without re-subscribing every render.
  const [overrides, setOverridesState] = useState<SizedOverrides>({});
  const overridesRef = useRef<SizedOverrides>({});
  const setOverrides = useCallback((next: SizedOverrides) => {
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
  // Δ diff overlay (DGC-79) — the class maps StepsNav computes when its Δ toggle
  // is on; `null` when off. Folded onto the derived flow below.
  const [diffOverlay, setDiffOverlay] = useState<DiffOverlay | null>(null);
  // Right-click context menu (DGC-20) — `null` when closed. Carries the target
  // node/group plus the viewport point the menu anchors at.
  const [contextMenu, setContextMenu] = useState<{ target: ContextMenuTarget; x: number; y: number } | null>(null);
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
      // Δ overlay classes (DGC-79) are layered on top of the override pass here,
      // off the drag hot path (onNodesChange). `null` overlay → no-op.
      nodes: applyDiffToNodes(applyOverrides(base.nodes, overrides), diffOverlay),
      // Pass nodes so a dragged group also dirties edges touching its
      // descendants / crossing its boundary (DGC-71 ancestor case).
      edges: applyDiffToEdges(markDirtyEdges(base.edges, overrides, base.nodes), diffOverlay),
    });
  }, [base, overrides, diffOverlay]);

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

  // Live flow snapshot for the drag/resize/delete handlers — a ref so window
  // listeners and change callbacks don't re-subscribe on every frame.
  const flowRef = useRef(flow);
  flowRef.current = flow;

  // Debounced PUT of the whole override record (T30 sidecar).
  const scheduleSave = useCallback((name: string, next: SizedOverrides) => {
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      putOverrides(name, next).catch((err) => console.error("save layout overrides failed", err));
    }, LAYOUT_SAVE_DEBOUNCE_MS);
  }, []);

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
  useEffect(() => {
    const track = (e: KeyboardEvent) => {
      altPressedRef.current = e.altKey;
    };
    const clear = () => {
      altPressedRef.current = false;
    };
    window.addEventListener("keydown", track);
    window.addEventListener("keyup", track);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("keydown", track);
      window.removeEventListener("keyup", track);
      window.removeEventListener("blur", clear);
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
      // Hit-test the drop point against each group's on-screen box. Groups are
      // pan surfaces (`pointer-events: none`) so they never show up in an
      // `elementsFromPoint` stack — read their boxes from the DOM and let
      // `groupAtPoint` pick the innermost one geometrically (undefined → root).
      const boxes: GroupBox[] = [];
      for (const n of nodes) {
        if (n.type !== ARCH_GROUP_TYPE) continue;
        const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(n.id)}"]`);
        if (!el) continue;
        const r = el.getBoundingClientRect();
        boxes.push({ id: n.id, left: r.left, top: r.top, right: r.right, bottom: r.bottom });
      }
      const group = groupAtPoint(event.clientX, event.clientY, boxes);
      const op = buildDropNodeOp(iconId, nodes.map((n) => n.id), group);
      void postEdit(diagramName, [op]).then((result) => {
        if (result.ok) showEditToast(`Đã thêm node "${op.name}"${group ? ` vào nhóm "${group}"` : ""}`);
        else showEditToast(`Không thêm được node: ${result.error ?? "lỗi không rõ"}`, true);
      });
    },
    [diagramName, showEditToast],
  );

  // Handle-drag from node A to node B → add the edge `A > B`. Hold Alt on drop
  // to be prompted for a label (cancel = add nothing). Same write path as above.
  const onConnect = useCallback(
    (connection: Connection) => {
      if (!diagramName) return;
      const { source, target } = connection;
      if (!source || !target) return;
      let op: ReturnType<typeof buildAddEdgeOp>;
      if (altPressedRef.current) {
        const input = window.prompt(`Nhãn cho cạnh "${source}" → "${target}" (bỏ trống nếu không cần):`, "");
        if (input === null) return; // cancelled → add nothing
        op = buildAddEdgeOp(source, target, input);
      } else {
        op = buildAddEdgeOp(source, target);
      }
      if (!op) return;
      const edgeOp = op;
      void postEdit(diagramName, [edgeOp]).then((result) => {
        if (result.ok) {
          showEditToast(`Đã thêm cạnh ${edgeOp.from} > ${edgeOp.to}${edgeOp.label ? `: ${edgeOp.label}` : ""}`);
        } else {
          showEditToast(`Không thêm được cạnh: ${result.error ?? "lỗi không rõ"}`, true);
        }
      });
    },
    [diagramName, showEditToast],
  );

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
        // Right-click a node/group → context menu (DGC-20). Right-click on the
        // empty pane just dismisses an open one (browser menu left untouched).
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={closeContextMenu}
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
      <StatusPill status={status} />
      <StepsNav workspace={workspace} onDiffChange={setDiffOverlay} />
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
