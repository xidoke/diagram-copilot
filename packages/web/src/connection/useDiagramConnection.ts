/**
 * React entry point for the diagram-copilot WS connection.
 *
 * Thin glue only: wires {@link createConnectionManager} into React state via
 * `useEffect`/`useState`. All actual behavior (backoff, parsing, dispatch,
 * outbound send) lives in `connectionManager.ts` / `backoff.ts` /
 * `messageReducer.ts`, which are unit-tested without any DOM.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage } from "@diagram-copilot/core";
import { attachSnapshotResponder } from "../render/snapshotResponder.js";
import { createConnectionManager, type ConnectionManager } from "./connectionManager.js";
import { initialConnectionState } from "./messageReducer.js";
import type { DiagramConnectionState } from "./types.js";

/** Default WS endpoint when `VITE_WS_URL` isn't set (see `.env` / vite config). */
export const DEFAULT_WS_URL = "ws://localhost:4747/ws";

/**
 * Connection state plus an outbound `send`. The hook return is a superset of
 * {@link DiagramConnectionState}, so existing consumers that destructure
 * `status` / `lastDiagram` / `lastError` / `workspace` keep working.
 */
export interface DiagramConnection extends DiagramConnectionState {
  /** Send a client→server message (dropped with a warn if not connected). */
  send: (message: ClientMessage) => void;
}

function resolveWsUrl(): string {
  const fromEnv = import.meta.env.VITE_WS_URL as string | undefined;
  return fromEnv ?? DEFAULT_WS_URL;
}

/**
 * Connects to the diagram-copilot server over WebSocket and keeps
 * connection status + the latest diagram/error/workspace messages in
 * React state. Reconnects automatically with exponential backoff; see
 * `connectionManager.ts` for the underlying lifecycle. Also returns a stable
 * `send` that forwards to the current manager (the drawer uses this to push
 * DSL edits back to the server).
 */
export function useDiagramConnection(url: string = resolveWsUrl()): DiagramConnection {
  const [state, setState] = useState<DiagramConnectionState>(initialConnectionState);
  const managerRef = useRef<ConnectionManager | null>(null);

  useEffect(() => {
    const manager = createConnectionManager({ url, onStateChange: setState });
    // Answer server `snapshot-request` frames with canvas-rendered PNGs
    // (T24) — bounds come from the provider App registers via
    // setSnapshotProvider; the responder stays silent until it exists.
    const detachSnapshotResponder = attachSnapshotResponder(manager);
    managerRef.current = manager;
    return () => {
      detachSnapshotResponder();
      manager.close();
      managerRef.current = null;
    };
  }, [url]);

  // Stable identity so effects/senders downstream don't re-subscribe each
  // render; it forwards to whatever manager is currently mounted.
  const send = useCallback((message: ClientMessage) => {
    managerRef.current?.send(message);
  }, []);

  return { ...state, send };
}
