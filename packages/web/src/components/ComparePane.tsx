/**
 * Compare pane (DGC-88) — the LEFT half of compare mode: a static, read-only
 * render of the PREVIOUS step, side by side with the live canvas (which shows
 * the current step on the right).
 *
 * Architecture: a second React Flow instance in its own {@link ReactFlowProvider}
 * (nested providers isolate their stores, so it never leaks selection/viewport
 * into the live canvas), fed by the same pure pipeline the live canvas uses —
 * `layoutDiagram` (ELK) → `toFlow` → diff classes. That buys pixel parity with
 * the live canvas for free (ArchNode/ArchGroup/ElkEdge + all their CSS are
 * reused wholesale) at the cost of one extra RF store, which is cheap at this
 * project's diagram sizes. The `elk-edge-arrow` marker is deliberately NOT
 * re-rendered here: `url(#…)` resolves document-wide against the single defs
 * App mounts, and duplicating the id would be invalid HTML.
 *
 * Read-only is enforced twice: instance-wide (`nodesDraggable` & co. off) and
 * per node (`toFlow` sets `draggable`/`selectable: true` per node, and RF lets
 * a per-node flag override the instance default — so both are stripped here).
 *
 * Each pane runs its own ELK pass on its own doc and fits its own viewport —
 * positions are NOT mapped across panes and viewports are NOT synced (explicit
 * v1 non-goals; ELK may legitimately lay the two steps out differently).
 * Layout overrides (T30 pins) are also not applied — the pane is a reference
 * rendering of the step's structure, not a mirror of manual tweaks.
 */
import { useEffect, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
} from "@xyflow/react";
import type { DiagramDoc } from "@diagram-copilot/core";
import { layoutDiagram } from "@diagram-copilot/layout";
import { applyPrefs, type LayoutPrefs } from "../render/layoutOptions.js";
import { ArchGroup, ArchNode } from "../render/ArchNode.js";
import { ELK_EDGE_TYPE, ElkEdge } from "../render/ElkEdge.js";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE, toFlow } from "../render/toFlow.js";
import { applyDiffToEdges, applyDiffToNodes, type DiffOverlay } from "../render/diffOverlay.js";

const nodeTypes = { [ARCH_NODE_TYPE]: ArchNode, [ARCH_GROUP_TYPE]: ArchGroup };
const edgeTypes = { [ELK_EDGE_TYPE]: ElkEdge };

/**
 * Fit the pane's own viewport once its nodes are in (and again when the step
 * pair slides under ←/→). The `fitView` prop only fits on init, but this
 * pane's nodes arrive async (ELK), so an explicit fit is needed — two rAFs
 * (commit + paint) before measuring, same recipe as App's fitView effect.
 */
function PaneFitter({ nodeCount, name }: { nodeCount: number; name: string }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (nodeCount === 0) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        void fitView({ padding: 0.12, duration: 150 });
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [nodeCount, name, fitView]);
  return null;
}

export interface ComparePaneProps {
  /** The previous step's diagram name (badge + fit key). */
  name: string;
  /** Parsed previous-step doc, already fetched by `computeCompare`. */
  doc: DiagramDoc;
  /** Left-pane diff classes: removed red, changed amber. */
  overlay: DiffOverlay;
  /** The user's layout prefs — applied here too so both panes share direction/spacing. */
  prefs: LayoutPrefs;
}

export function ComparePane({ name, doc, overlay, prefs }: ComparePaneProps) {
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });

  useEffect(() => {
    let stale = false;
    const { doc: prefDoc, options } = applyPrefs(doc, prefs);
    layoutDiagram(prefDoc, options)
      .then((graph) => {
        if (stale) return;
        const f = toFlow(prefDoc, graph);
        setFlow({
          // Strip the per-node interactivity toFlow grants (per-node flags win
          // over the instance-wide `nodesDraggable={false}` below).
          nodes: applyDiffToNodes(f.nodes, overlay).map((n) => ({
            ...n,
            draggable: false,
            selectable: false,
          })),
          edges: applyDiffToEdges(f.edges, overlay),
        });
      })
      .catch((err) => console.error("[compare] layout failed", err));
    return () => {
      stale = true;
    };
  }, [doc, overlay, prefs]);

  return (
    <div className="compare-pane" role="region" aria-label={`Bước trước: ${name}`}>
      <div className="compare-pane__badge" title={name}>
        <b>{name}</b> · bước trước
      </div>
      <ReactFlowProvider>
        <ReactFlow
          id="compare-pane"
          nodes={flow.nodes}
          edges={flow.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          zoomOnDoubleClick={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          minZoom={0.2}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--grid-dot)" />
          <PaneFitter nodeCount={flow.nodes.length} name={name} />
        </ReactFlow>
      </ReactFlowProvider>
    </div>
  );
}
