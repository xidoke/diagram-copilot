/**
 * Unit tests for the snapshot responder (T24 / DGC-44) — pure logic only:
 * request matching, provider lookup, response shaping, detach. The DOM
 * capture pipeline is injected as a fake (this package's tests run in plain
 * node, no jsdom — same convention as export.test.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Rect } from "@xyflow/react";
import {
  serializeMessage,
  type ClientMessage,
  type ServerMessage,
  type SnapshotResponseMessage,
} from "@diagram-copilot/core";
import {
  attachSnapshotResponder,
  setSnapshotProvider,
  SNAPSHOT_SCALE,
  type SnapshotConnection,
} from "../../src/render/snapshotResponder";

const BOUNDS: Rect = { x: 10, y: 20, width: 300, height: 200 };
const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

/** Fake connection: records sends, lets tests deliver inbound frames. */
function makeConnection(rendering: string | null) {
  const listeners = new Set<(message: ServerMessage) => void>();
  const sent: ClientMessage[] = [];
  const connection: SnapshotConnection = {
    getState: () => ({ lastDiagram: rendering === null ? null : { name: rendering } }),
    send: (message) => sent.push(message),
    onMessage: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    connection,
    sent,
    deliver: (message: ServerMessage) => {
      for (const listener of listeners) listener(message);
    },
    listenerCount: () => listeners.size,
  };
}

const request = (name = "demo"): ServerMessage => ({ kind: "snapshot-request", id: "req-1", name });

/** The responder's send happens after awaited capture — flush the microtask queue. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setSnapshotProvider(null); // module-level provider must not leak across tests
});

describe("attachSnapshotResponder", () => {
  it("answers a matching request with ok + the captured PNG data URL", async () => {
    const { connection, sent, deliver } = makeConnection("demo");
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, { getBounds: () => BOUNDS, capture });

    deliver(request("demo"));
    await flush();

    expect(capture).toHaveBeenCalledWith(BOUNDS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      kind: "snapshot-response",
      id: "req-1",
      name: "demo",
      ok: true,
      dataUrl: DATA_URL,
    });
    // Cross-check: the response is schema-valid on the client channel.
    expect(() => serializeMessage(sent[0])).not.toThrow();
  });

  it("stays SILENT when the canvas is rendering a different diagram", async () => {
    const { connection, sent, deliver } = makeConnection("other");
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, { getBounds: () => BOUNDS, capture });

    deliver(request("demo"));
    await flush();

    expect(capture).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("stays SILENT when nothing has been rendered yet (no lastDiagram)", async () => {
    const { connection, sent, deliver } = makeConnection(null);
    attachSnapshotResponder(connection, { getBounds: () => BOUNDS, capture: vi.fn() });

    deliver(request("demo"));
    await flush();

    expect(sent).toHaveLength(0);
  });

  it("uses the module-level provider registered by App via setSnapshotProvider", async () => {
    const { connection, sent, deliver } = makeConnection("demo");
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    setSnapshotProvider(() => BOUNDS);
    attachSnapshotResponder(connection, { capture }); // no getBounds override

    deliver(request("demo"));
    await flush();

    expect(capture).toHaveBeenCalledWith(BOUNDS);
    expect(sent[0]).toMatchObject({ ok: true, dataUrl: DATA_URL });
  });

  it("answers ok:false when no bounds provider is registered", async () => {
    const { connection, sent, deliver } = makeConnection("demo");
    const capture = vi.fn();
    attachSnapshotResponder(connection, { capture }); // provider cleared in afterEach

    deliver(request("demo"));
    await flush();

    expect(capture).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
    const response = sent[0] as SnapshotResponseMessage;
    expect(response).toMatchObject({ kind: "snapshot-response", id: "req-1", ok: false });
    expect(response.error).toMatch(/provider/i);
    expect(response.dataUrl).toBeUndefined();
  });

  it("answers ok:false with the failure message when capture throws", async () => {
    const { connection, sent, deliver } = makeConnection("demo");
    const capture = vi.fn().mockRejectedValue(new Error("canvas viewport not found"));
    attachSnapshotResponder(connection, { getBounds: () => BOUNDS, capture });

    deliver(request("demo"));
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ok: false, error: "canvas viewport not found" });
    expect(() => serializeMessage(sent[0])).not.toThrow();
  });

  it("answers ok:false when the bounds getter itself throws", async () => {
    const { connection, sent, deliver } = makeConnection("demo");
    attachSnapshotResponder(connection, {
      getBounds: () => {
        throw new Error("react flow not mounted");
      },
      capture: vi.fn(),
    });

    deliver(request("demo"));
    await flush();

    expect(sent[0]).toMatchObject({ ok: false, error: "react flow not mounted" });
  });

  it("ignores non-snapshot server messages", async () => {
    const { connection, sent, deliver } = makeConnection("demo");
    const capture = vi.fn();
    attachSnapshotResponder(connection, { getBounds: () => BOUNDS, capture });

    deliver({ kind: "workspace", diagrams: ["demo"], active: "demo" });
    await flush();

    expect(capture).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("detach unsubscribes — later requests go unanswered", async () => {
    const conn = makeConnection("demo");
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    const detach = attachSnapshotResponder(conn.connection, { getBounds: () => BOUNDS, capture });
    expect(conn.listenerCount()).toBe(1);

    detach();
    expect(conn.listenerCount()).toBe(0);
    conn.deliver(request("demo"));
    await flush();

    expect(conn.sent).toHaveLength(0);
  });
});

describe("SNAPSHOT_SCALE", () => {
  it("captures at 1.5x per the T24 spec (lighter than the 2x interactive export)", () => {
    expect(SNAPSHOT_SCALE).toBe(1.5);
  });
});
