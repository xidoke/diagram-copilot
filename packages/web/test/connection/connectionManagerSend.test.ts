import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseClientMessage, type UpdateMessage } from "@diagram-copilot/core";
import {
  createConnectionManager,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../../src/connection/connectionManager";

/** Mock WebSocket that also records `send` frames. */
class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  triggerOpen(): void {
    this.onopen?.(undefined);
  }
  triggerClose(): void {
    this.onclose?.(undefined);
  }
}

const WebSocketImpl = MockWebSocket as unknown as WebSocketConstructor;

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!socket) throw new Error("no MockWebSocket instance created");
  return socket;
}

const update: UpdateMessage = {
  kind: "update",
  name: "checkout-flow",
  dsl: "diagram checkout-flow {}",
  origin: "drawer",
  baseVersion: 2,
};

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createConnectionManager().send", () => {
  it("serializes and sends over the socket once open", () => {
    const manager = createConnectionManager({
      url: "ws://x",
      WebSocketImpl,
      onStateChange: () => {},
    });

    latestSocket().triggerOpen();
    manager.send(update);

    expect(latestSocket().sent).toHaveLength(1);
    const parsed = parseClientMessage(latestSocket().sent[0]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.message).toEqual(update);
  });

  it("drops the message and warns when the socket is not open", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = createConnectionManager({
      url: "ws://x",
      WebSocketImpl,
      onStateChange: () => {},
    });

    // Still connecting — no open event yet.
    manager.send(update);

    expect(latestSocket().sent).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });

  it("stops sending after the socket closes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = createConnectionManager({
      url: "ws://x",
      WebSocketImpl,
      onStateChange: () => {},
    });

    latestSocket().triggerOpen();
    const openSocket = latestSocket();
    openSocket.triggerClose();

    manager.send(update);
    expect(openSocket.sent).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
  });
});
