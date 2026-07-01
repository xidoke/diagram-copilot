import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiagramMessage } from "@diagram-copilot/core";
import {
  createConnectionManager,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../../src/connection/connectionManager";
import type { DiagramConnectionState } from "../../src/connection/types";

/** Minimal controllable WebSocket stand-in; no real networking. */
class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  triggerOpen(): void {
    this.onopen?.(undefined);
  }

  triggerMessage(data: string): void {
    this.onmessage?.({ data });
  }

  triggerClose(): void {
    this.onclose?.(undefined);
  }
}

const WebSocketImpl = MockWebSocket as unknown as WebSocketConstructor;

const diagramMessage: DiagramMessage = {
  kind: "diagram",
  name: "checkout-flow",
  version: 1,
  origin: "mcp",
  dsl: "diagram checkout-flow {}",
  doc: { type: "architecture", direction: "right", nodes: [], edges: [], groups: [] },
};

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!socket) throw new Error("no MockWebSocket instance created");
  return socket;
}

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createConnectionManager", () => {
  it("opens a socket to the given url and starts in connecting state", () => {
    const states: DiagramConnectionState[] = [];
    createConnectionManager({ url: "ws://localhost:4747/ws", WebSocketImpl, onStateChange: (s) => states.push(s) });

    expect(MockWebSocket.instances).toHaveLength(1);
    expect(latestSocket().url).toBe("ws://localhost:4747/ws");
  });

  it("transitions to connected when the socket opens", () => {
    const states: DiagramConnectionState[] = [];
    createConnectionManager({ url: "ws://x", WebSocketImpl, onStateChange: (s) => states.push(s) });

    latestSocket().triggerOpen();

    expect(states.at(-1)?.status).toBe("connected");
  });

  it("dispatches a valid diagram message into lastDiagram", () => {
    const states: DiagramConnectionState[] = [];
    createConnectionManager({ url: "ws://x", WebSocketImpl, onStateChange: (s) => states.push(s) });

    latestSocket().triggerOpen();
    latestSocket().triggerMessage(JSON.stringify(diagramMessage));

    expect(states.at(-1)?.lastDiagram).toEqual(diagramMessage);
  });

  it("ignores an unparsable frame and warns instead of throwing or updating state", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const states: DiagramConnectionState[] = [];
    createConnectionManager({ url: "ws://x", WebSocketImpl, onStateChange: (s) => states.push(s) });

    latestSocket().triggerOpen();
    const beforeCount = states.length;
    expect(() => latestSocket().triggerMessage("not json")).not.toThrow();

    expect(warn).toHaveBeenCalled();
    expect(states.length).toBe(beforeCount);
    expect(states.at(-1)?.lastDiagram).toBeNull();
  });

  it("moves to disconnected on close and reconnects after the backoff delay", () => {
    const states: DiagramConnectionState[] = [];
    createConnectionManager({ url: "ws://x", WebSocketImpl, onStateChange: (s) => states.push(s) });

    latestSocket().triggerOpen();
    latestSocket().triggerClose();

    expect(states.at(-1)?.status).toBe("disconnected");
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(499);
    expect(MockWebSocket.instances).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it("resets backoff to the initial delay after a successful reconnect", () => {
    const states: DiagramConnectionState[] = [];
    createConnectionManager({ url: "ws://x", WebSocketImpl, onStateChange: (s) => states.push(s) });

    latestSocket().triggerOpen();
    latestSocket().triggerClose();
    vi.advanceTimersByTime(500);
    expect(MockWebSocket.instances).toHaveLength(2);

    latestSocket().triggerOpen();
    latestSocket().triggerClose();
    vi.advanceTimersByTime(499);
    expect(MockWebSocket.instances).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(MockWebSocket.instances).toHaveLength(3);
  });

  it("stops reconnecting once closed by the caller", () => {
    const states: DiagramConnectionState[] = [];
    const manager = createConnectionManager({ url: "ws://x", WebSocketImpl, onStateChange: (s) => states.push(s) });

    latestSocket().triggerOpen();
    manager.close();
    expect(latestSocket().closed).toBe(true);

    latestSocket().triggerClose();
    vi.advanceTimersByTime(20_000);
    expect(MockWebSocket.instances).toHaveLength(1);
  });
});
