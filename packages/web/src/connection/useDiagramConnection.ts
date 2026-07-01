/**
 * React entry point for the diagram-copilot WS connection.
 *
 * Thin glue only: wires {@link createConnectionManager} into React state via
 * `useEffect`/`useState`. All actual behavior (backoff, parsing, dispatch)
 * lives in `connectionManager.ts` / `backoff.ts` / `messageReducer.ts`,
 * which are unit-tested without any DOM.
 */
import { useEffect, useState } from "react";
import { createConnectionManager } from "./connectionManager.js";
import { initialConnectionState } from "./messageReducer.js";
import type { DiagramConnectionState } from "./types.js";

/** Default WS endpoint when `VITE_WS_URL` isn't set (see `.env` / vite config). */
export const DEFAULT_WS_URL = "ws://localhost:4747/ws";

function resolveWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  return fromEnv ?? DEFAULT_WS_URL;
}

/**
 * Connects to the diagram-copilot server over WebSocket and keeps
 * connection status + the latest diagram/error/workspace messages in
 * React state. Reconnects automatically with exponential backoff; see
 * `connectionManager.ts` for the underlying lifecycle.
 */
export function useDiagramConnection(url: string = resolveWsUrl()): DiagramConnectionState {
  const [state, setState] = useState<DiagramConnectionState>(initialConnectionState);

  useEffect(() => {
    const manager = createConnectionManager({ url, onStateChange: setState });
    return () => manager.close();
  }, [url]);

  return state;
}
