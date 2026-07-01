/**
 * Tests for the connection manager's raw-message subscription (`onMessage`,
 * added by T24) — the hook the snapshot responder rides on. Uses the same
 * MockWebSocket pattern as connectionManagerSend.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeMessage, type ServerMessage } from "@diagram-copilot/core";
import {
  createConnectionManager,
  type WebSocketConstructor,
  type WebSocketLike,
} from "../../src/connection/connectionManager";

class MockWebSocket implements WebSocketLike {
  static instances: MockWebSocket[] = [];
  url: string;
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {}
  triggerOpen(): void {
    this.onopen?.(undefined);
  }
  triggerMessage(message: ServerMessage): void {
    this.onmessage?.({ data: serializeMessage(message) });
  }
}

const WebSocketImpl = MockWebSocket as unknown as WebSocketConstructor;

function latestSocket(): MockWebSocket {
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1];
  if (!socket) throw new Error("no MockWebSocket instance created");
  return socket;
}

const workspaceMessage: ServerMessage = { kind: "workspace", diagrams: ["demo"], active: "demo" };
const snapshotRequest: ServerMessage = { kind: "snapshot-request", id: "req-1", name: "demo" };

beforeEach(() => {
  MockWebSocket.instances = [];
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeManager() {
  return createConnectionManager({ url: "ws://x", WebSocketImpl, onStateChange: () => {} });
}

describe("createConnectionManager().onMessage", () => {
  it("delivers every parsed inbound server message to subscribers", () => {
    const manager = makeManager();
    const seen: ServerMessage[] = [];
    manager.onMessage((message) => seen.push(message));

    latestSocket().triggerOpen();
    latestSocket().triggerMessage(workspaceMessage);
    latestSocket().triggerMessage(snapshotRequest);

    expect(seen).toEqual([workspaceMessage, snapshotRequest]);
  });

  it("fires AFTER the reducer — getState() inside a listener sees the message applied", () => {
    const manager = makeManager();
    let workspaceAtDelivery: unknown = "not yet";
    manager.onMessage(() => {
      workspaceAtDelivery = manager.getState().workspace;
    });

    latestSocket().triggerOpen();
    latestSocket().triggerMessage(workspaceMessage);

    expect(workspaceAtDelivery).toEqual(workspaceMessage);
  });

  it("passes snapshot-request through without touching connection state", () => {
    const manager = makeManager();
    latestSocket().triggerOpen();
    const before = manager.getState();

    latestSocket().triggerMessage(snapshotRequest);

    expect(manager.getState()).toEqual(before);
  });

  it("unsubscribe stops delivery", () => {
    const manager = makeManager();
    const seen: ServerMessage[] = [];
    const unsubscribe = manager.onMessage((message) => seen.push(message));

    latestSocket().triggerOpen();
    latestSocket().triggerMessage(workspaceMessage);
    unsubscribe();
    latestSocket().triggerMessage(snapshotRequest);

    expect(seen).toEqual([workspaceMessage]);
  });

  it("a throwing listener is logged and does not block state or other listeners", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const manager = makeManager();
    const seen: ServerMessage[] = [];
    manager.onMessage(() => {
      throw new Error("listener boom");
    });
    manager.onMessage((message) => seen.push(message));

    latestSocket().triggerOpen();
    latestSocket().triggerMessage(workspaceMessage);

    expect(error).toHaveBeenCalled();
    expect(seen).toEqual([workspaceMessage]);
    expect(manager.getState().workspace).toEqual(workspaceMessage);
  });

  it("malformed frames never reach subscribers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = makeManager();
    const listener = vi.fn();
    manager.onMessage(listener);

    latestSocket().triggerOpen();
    latestSocket().onmessage?.({ data: "{not json" });

    expect(listener).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
