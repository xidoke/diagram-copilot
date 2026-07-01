import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./tokens.css";
import "./App.css";
import { layoutDiagram } from "@diagram-copilot/layout";
import { EmptyState, shouldShowEmptyState } from "./components/EmptyState.js";
import { ExportMenu } from "./components/ExportMenu.js";
import { StatusPill } from "./components/StatusPill.js";
import { Toolbar } from "./components/Toolbar.js";
import { UndoButton } from "./components/UndoButton.js";
import { Drawer } from "./components/Drawer.js";
import { useDiagramConnection } from "./connection/index.js";
import { applyPrefs, loadLayoutPrefs, saveLayoutPrefs, type LayoutPrefs } from "./render/layoutOptions.js";
import { ArchGroup, ArchNode } from "./render/ArchNode.js";
import { ELK_EDGE_TYPE, ElkEdge, ElkEdgeMarkerDefs } from "./render/ElkEdge.js";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE, toFlow } from "./render/toFlow.js";

export const APP_TITLE = "diagram-copilot";

/** Debounce window before a fitView fires, so a burst of diagram messages
 *  (e.g. fast-typed edits) collapses into one fit instead of racing. */
const FIT_VIEW_DEBOUNCE_MS = 100;

/** How long an ELK layout pass must run before the "⋯ layout" chip appears —
 *  fast layouts (the common case) never flash it. */
const LAYOUT_INDICATOR_DELAY_MS = 200;

const nodeTypes = { [ARCH_NODE_TYPE]: ArchNode, [ARCH_GROUP_TYPE]: ArchGroup };
const edgeTypes = { [ELK_EDGE_TYPE]: ElkEdge };

function DiagramCanvas() {
  const { status, lastDiagram, lastError, workspace, send } = useDiagramConnection();
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const [prefs, setPrefs] = useState<LayoutPrefs>(() => loadLayoutPrefs());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const toggleDrawer = useCallback(() => setDrawerOpen((o) => !o), []);
  // Bottom-right "⋯ layout" chip — on only while a layout pass is running
  // past LAYOUT_INDICATOR_DELAY_MS (see the layout effect below).
  const [layingOut, setLayingOut] = useState(false);
  const { fitView } = useReactFlow();

  useEffect(() => {
    saveLayoutPrefs(prefs);
  }, [prefs]);

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
        setFlow(toFlow(doc, graph));
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
    if (!flow.nodes.length) return;
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
  }, [flow, lastDiagram, fitView]);

  // Keep rendering the last good state; show the banner only while the error
  // is current — a diagram-error carries the version of the last ACCEPTED dsl,
  // so a subsequent fix arrives with a strictly greater version (spec §8).
  const showError = useMemo(() => {
    if (!lastError) return false;
    if (!lastDiagram || lastError.name !== lastDiagram.name) return true;
    return lastDiagram.version <= lastError.version;
  }, [lastError, lastDiagram]);

  return (
    <div className="app-shell">
      {lastDiagram && (
        <div className="diagram-info">
          <b>{lastDiagram.name}</b> · v{lastDiagram.version}
        </div>
      )}
      <Toolbar prefs={prefs} onChange={setPrefs} />
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
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
        fitView
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--grid-dot)" />
        <Controls />
      </ReactFlow>
      {workspace && shouldShowEmptyState(workspace, lastDiagram) && (
        <EmptyState workspace={workspace} send={send} />
      )}
      {layingOut && (
        <div className="layout-chip" role="status">
          ⋯ layout
        </div>
      )}
      <StatusPill status={status} />
      <UndoButton name={lastDiagram?.name ?? null} />
      <Drawer open={drawerOpen} onToggle={toggleDrawer} diagram={lastDiagram} send={send} />
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <DiagramCanvas />
    </ReactFlowProvider>
  );
}
