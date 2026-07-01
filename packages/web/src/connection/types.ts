import type { DiagramErrorMessage, DiagramMessage, WorkspaceMessage } from "@diagram-copilot/core";

/** Lifecycle of the WS connection to the diagram-copilot server. */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";

/**
 * State surfaced by {@link useDiagramConnection}. Each field holds the most
 * recent message of its kind — messages don't patch each other, they
 * replace wholesale per the protocol contract (see `@diagram-copilot/core`).
 */
export interface DiagramConnectionState {
  status: ConnectionStatus;
  lastDiagram: DiagramMessage | null;
  lastError: DiagramErrorMessage | null;
  workspace: WorkspaceMessage | null;
}
