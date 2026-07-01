/**
 * WebSocket lifecycle manager for the diagram-copilot server connection.
 *
 * Depends on `WebSocketLike` rather than the DOM `WebSocket` type so it can
 * run — and be tested — without a browser: pass a mock constructor via
 * `WebSocketImpl` (used by the vitest suite) or let it fall back to the
 * global `WebSocket` (real usage, from {@link useDiagramConnection}).
 *
 * Reconnects with {@link nextBackoffDelay} on every close, resetting the
 * attempt counter back to 0 once a connection opens successfully. Inbound
 * frames are parsed with `parseServerMessage`; frames that fail to parse
 * are dropped with a `console.warn` rather than throwing or updating state.
 */
import { parseServerMessage, serializeMessage, type ClientMessage } from "@diagram-copilot/core";
import { nextBackoffDelay } from "./backoff.js";
import { applyServerMessage, initialConnectionState } from "./messageReducer.js";
import type { DiagramConnectionState } from "./types.js";

/** Minimal native WebSocket surface the manager relies on. */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

/** Constructor shape matching both the DOM `WebSocket` and test mocks. */
export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface ConnectionManagerOptions {
  /** WS endpoint to connect to. */
  url: string;
  /** Called with the full new state after every transition. */
  onStateChange: (state: DiagramConnectionState) => void;
  /** Defaults to the global `WebSocket`; override in tests. */
  WebSocketImpl?: WebSocketConstructor;
}

export interface ConnectionManager {
  /** Current state (same value last passed to `onStateChange`). */
  getState(): DiagramConnectionState;
  /**
   * Serialize and send a client→server message over the open socket.
   * If the socket isn't open yet (connecting/reconnecting), the message is
   * dropped with a `console.warn` — the server is the source of truth, so a
   * dropped optimistic edit simply means the next successful edit wins; we
   * don't queue, to avoid replaying stale DSL after a reconnect.
   */
  send(message: ClientMessage): void;
  /** Tears down the socket and cancels any pending reconnect — final. */
  close(): void;
}

export function createConnectionManager(options: ConnectionManagerOptions): ConnectionManager {
  const maybeWebSocketImpl =
    options.WebSocketImpl ?? (globalThis.WebSocket as unknown as WebSocketConstructor | undefined);
  if (!maybeWebSocketImpl) {
    throw new Error(
      "createConnectionManager: no WebSocket implementation available; pass WebSocketImpl explicitly.",
    );
  }
  // Rebind to a variable TS can prove is non-undefined inside the `connect`
  // closure below (control-flow narrowing doesn't cross function boundaries).
  const WebSocketImpl: WebSocketConstructor = maybeWebSocketImpl;

  let state = initialConnectionState;
  let attempt = 0;
  let socket: WebSocketLike | null = null;
  let socketOpen = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function setState(next: DiagramConnectionState): void {
    state = next;
    options.onStateChange(state);
  }

  function connect(): void {
    if (stopped) return;
    setState({ ...state, status: "connecting" });

    const ws = new WebSocketImpl(options.url);
    socket = ws;
    socketOpen = false;

    ws.onopen = () => {
      attempt = 0;
      socketOpen = true;
      setState({ ...state, status: "connected" });
    };

    ws.onmessage = (ev) => {
      const result = parseServerMessage(ev.data);
      if (!result.ok) {
        console.warn("[diagram-copilot] dropped malformed server message:", result.error);
        return;
      }
      setState(applyServerMessage(state, result.message));
    };

    ws.onclose = () => {
      socketOpen = false;
      if (stopped) return;
      setState({ ...state, status: "disconnected" });
      scheduleReconnect();
    };

    // Native WebSocket always follows an error with a close event, which
    // drives the actual reconnect — nothing extra to do here.
    ws.onerror = () => {};
  }

  function scheduleReconnect(): void {
    const delay = nextBackoffDelay(attempt);
    attempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  connect();

  return {
    getState() {
      return state;
    },
    send(message: ClientMessage) {
      if (!socket || !socketOpen) {
        console.warn(
          "[diagram-copilot] dropped outbound message; socket not open:",
          message.kind,
        );
        return;
      }
      socket.send(serializeMessage(message));
    },
    close() {
      stopped = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      socket?.close();
    },
  };
}
