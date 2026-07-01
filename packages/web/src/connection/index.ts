/**
 * Public surface of the WS connection module — the only imports other
 * packages/components (e.g. T8's node rendering) should need.
 */
export { useDiagramConnection, DEFAULT_WS_URL } from "./useDiagramConnection.js";
export type { ConnectionStatus, DiagramConnectionState } from "./types.js";

// Lower-level building blocks — exported for tests and for advanced
// callers that want the connection manager without the React hook.
export { createConnectionManager } from "./connectionManager.js";
export type {
  ConnectionManager,
  ConnectionManagerOptions,
  WebSocketConstructor,
  WebSocketLike,
} from "./connectionManager.js";
export { applyServerMessage, initialConnectionState } from "./messageReducer.js";
export { nextBackoffDelay, INITIAL_BACKOFF_MS, MAX_BACKOFF_MS } from "./backoff.js";
