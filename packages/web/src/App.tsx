import { useEffect, useMemo, useState } from "react";
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
import { StatusPill } from "./components/StatusPill.js";
import { useDiagramConnection } from "./connection/index.js";
import { ArchGroup, ArchNode } from "./render/ArchNode.js";
import { ELK_EDGE_TYPE, ElkEdge, ElkEdgeMarkerDefs } from "./render/ElkEdge.js";
import { ARCH_GROUP_TYPE, ARCH_NODE_TYPE, toFlow } from "./render/toFlow.js";

export const APP_TITLE = "diagram-copilot";

const nodeTypes = { [ARCH_NODE_TYPE]: ArchNode, [ARCH_GROUP_TYPE]: ArchGroup };
const edgeTypes = { [ELK_EDGE_TYPE]: ElkEdge };

function DiagramCanvas() {
  const { status, lastDiagram, lastError } = useDiagramConnection();
  const [flow, setFlow] = useState<{ nodes: Node[]; edges: Edge[] }>({ nodes: [], edges: [] });
  const { fitView } = useReactFlow();

  useEffect(() => {
    if (!lastDiagram) return;
    let stale = false;
    layoutDiagram(lastDiagram.doc)
      .then((graph) => {
        if (stale) return;
        setFlow(toFlow(lastDiagram.doc, graph));
      })
      .catch((err) => console.error("layout failed", err));
    return () => {
      stale = true;
    };
  }, [lastDiagram]);

  useEffect(() => {
    if (flow.nodes.length) {
      const t = setTimeout(() => fitView({ padding: 0.12, duration: 250 }), 50);
      return () => clearTimeout(t);
    }
  }, [flow, fitView]);

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
      <StatusPill status={status} />
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
