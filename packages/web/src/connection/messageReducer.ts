/**
 * Pure reducer applying a parsed {@link ServerMessage} onto
 * {@link DiagramConnectionState}. No DOM, no WebSocket — testable in
 * isolation. `status` is NOT touched here; it's owned by the connection
 * manager's socket lifecycle (open/close), not by message content.
 */
import type { ServerMessage } from "@diagram-copilot/core";
import type { DiagramConnectionState } from "./types.js";

/** State before the first message has ever arrived. */
export const initialConnectionState: DiagramConnectionState = {
  status: "connecting",
  lastDiagram: null,
  lastError: null,
  workspace: null,
};

/**
 * Fold one server message into connection state. Each message kind
 * replaces its corresponding field wholesale; other fields pass through
 * unchanged.
 */
export function applyServerMessage(
  state: DiagramConnectionState,
  message: ServerMessage,
): DiagramConnectionState {
  switch (message.kind) {
    case "diagram":
      return { ...state, lastDiagram: message };
    case "diagram-error":
      return { ...state, lastError: message };
    case "workspace":
      return { ...state, workspace: message };
    case "snapshot-request":
      // Transient request/response frame (added by T24) — handled by the
      // snapshot responder via the manager's onMessage subscription, not
      // stored in connection state.
      return state;
    default: {
      const exhaustive: never = message;
      return exhaustive;
    }
  }
}
