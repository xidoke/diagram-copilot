import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./tokens.css";
import "./App.css";
import { StatusPill } from "./components/StatusPill.js";
import { useDiagramConnection } from "./connection/index.js";

export const APP_TITLE = "diagram-copilot";

function DiagramCanvas() {
  const { status, lastDiagram } = useDiagramConnection();

  return (
    <div className="app-shell">
      {lastDiagram && (
        <div className="diagram-info">
          <b>{lastDiagram.name}</b> · v{lastDiagram.version}
        </div>
      )}
      {/* Node rendering from `lastDiagram.doc` is T8's job — canvas is
          intentionally empty here; this shell just mounts React Flow. */}
      <ReactFlow nodes={[]} edges={[]} proOptions={{ hideAttribution: true }} minZoom={0.2} fitView>
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
