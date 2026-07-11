/**
 * Unit tests for the snapshot responder (T24 / DGC-44) — pure logic only:
 * request matching, provider lookup, response shaping, detach. The DOM
 * capture pipeline is injected as a fake (this package's tests run in plain
 * node, no jsdom — same convention as export.test.ts).
 *
 * DGC-101 adds the RENDER GATE cases: `lastDiagram` is connection state and
 * updates the instant a `diagram` frame arrives — long before React/ELK
 * repaint the canvas — so a responder that trusts it alone returns the
 * PREVIOUS diagram's pixels when a snapshot-request races an
 * open_diagram/set_diagram. The responder must wait until App reports the
 * exact (name, version) as committed to the DOM before capturing, and stay
 * silent if that never happens.
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
  reportSnapshotRendered,
  setSnapshotProvider,
  SNAPSHOT_SCALE,
  type RenderedStamp,
  type SnapshotConnection,
} from "../../src/render/snapshotResponder";

const BOUNDS: Rect = { x: 10, y: 20, width: 300, height: 200 };
const DATA_URL = "data:image/png;base64,iVBORw0KGgo=";

/** Shorthand for a (name, version) pair. */
const d = (name: string, version = 1): RenderedStamp => ({ name, version });

/** Fake connection: records sends, lets tests deliver inbound frames and move the canvas on. */
function makeConnection(initial: RenderedStamp | null) {
  let lastDiagram: RenderedStamp | null = initial;
  const listeners = new Set<(message: ServerMessage) => void>();
  const sent: ClientMessage[] = [];
  const connection: SnapshotConnection = {
    getState: () => ({ lastDiagram }),
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
    setLastDiagram: (next: RenderedStamp | null) => {
      lastDiagram = next;
    },
  };
}

const request = (name = "demo"): ServerMessage => ({ kind: "snapshot-request", id: "req-1", name });

/** The responder's send happens after awaited capture — flush the microtask queue. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Real-timer sleep for the poll-loop tests (poll intervals are overridden to 1-2ms). */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Fast poll/wait overrides so the gate tests finish in milliseconds. */
const FAST = { renderPollMs: 1, renderWaitMs: 250 } as const;

/** A stamp getter that always matches `stamp` — for tests not about the gate. */
const renderedAs = (stamp: RenderedStamp) => ({ getRenderedStamp: () => stamp });

afterEach(() => {
  setSnapshotProvider(null); // module-level provider must not leak across tests
  reportSnapshotRendered(null); // module-level rendered stamp must not leak either
});

describe("attachSnapshotResponder", () => {
  it("answers a matching request with ok + the captured PNG data URL", async () => {
    const { connection, sent, deliver } = makeConnection(d("demo"));
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, { getBounds: () => BOUNDS, capture, ...renderedAs(d("demo")) });

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
    const { connection, sent, deliver } = makeConnection(d("other"));
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, { getBounds: () => BOUNDS, capture, ...renderedAs(d("other")) });

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
    const { connection, sent, deliver } = makeConnection(d("demo"));
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    setSnapshotProvider(() => BOUNDS);
    reportSnapshotRendered(d("demo"));
    attachSnapshotResponder(connection, { capture }); // no getBounds/getRenderedStamp override

    deliver(request("demo"));
    await flush();

    expect(capture).toHaveBeenCalledWith(BOUNDS);
    expect(sent[0]).toMatchObject({ ok: true, dataUrl: DATA_URL });
  });

  it("answers ok:false when no bounds provider is registered", async () => {
    const { connection, sent, deliver } = makeConnection(d("demo"));
    const capture = vi.fn();
    // Rendered stamp matches; only the BOUNDS provider is missing.
    attachSnapshotResponder(connection, { capture, ...renderedAs(d("demo")) });

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
    const { connection, sent, deliver } = makeConnection(d("demo"));
    const capture = vi.fn().mockRejectedValue(new Error("canvas viewport not found"));
    attachSnapshotResponder(connection, { getBounds: () => BOUNDS, capture, ...renderedAs(d("demo")) });

    deliver(request("demo"));
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ ok: false, error: "canvas viewport not found" });
    expect(() => serializeMessage(sent[0])).not.toThrow();
  });

  it("answers ok:false when the bounds getter itself throws", async () => {
    const { connection, sent, deliver } = makeConnection(d("demo"));
    attachSnapshotResponder(connection, {
      getBounds: () => {
        throw new Error("react flow not mounted");
      },
      capture: vi.fn(),
      ...renderedAs(d("demo")),
    });

    deliver(request("demo"));
    await flush();

    expect(sent[0]).toMatchObject({ ok: false, error: "react flow not mounted" });
  });

  it("ignores non-snapshot server messages", async () => {
    const { connection, sent, deliver } = makeConnection(d("demo"));
    const capture = vi.fn();
    attachSnapshotResponder(connection, { getBounds: () => BOUNDS, capture, ...renderedAs(d("demo")) });

    deliver({ kind: "workspace", diagrams: ["demo"], active: "demo" });
    await flush();

    expect(capture).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("detach unsubscribes — later requests go unanswered", async () => {
    const conn = makeConnection(d("demo"));
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    const detach = attachSnapshotResponder(conn.connection, {
      getBounds: () => BOUNDS,
      capture,
      ...renderedAs(d("demo")),
    });
    expect(conn.listenerCount()).toBe(1);

    detach();
    expect(conn.listenerCount()).toBe(0);
    conn.deliver(request("demo"));
    await flush();

    expect(conn.sent).toHaveLength(0);
  });
});

describe("render gate (DGC-101) — answer only once the canvas SHOWS the target", () => {
  it("open_diagram race: holds the response while the DOM still shows the previous diagram, answers after the target renders", async () => {
    // Canvas state: server already broadcast diagram "b" (lastDiagram = b@1),
    // but the DOM still shows the previously rendered "a" — the exact window
    // in which the old responder captured a's pixels and named them b.
    const { connection, sent, deliver } = makeConnection(d("b", 1));
    let rendered: RenderedStamp | null = d("a", 4);
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, {
      getBounds: () => BOUNDS,
      capture,
      getRenderedStamp: () => rendered,
      ...FAST,
    });

    deliver(request("b"));
    await sleep(20);
    expect(capture).not.toHaveBeenCalled(); // MUST NOT capture a's pixels
    expect(sent).toHaveLength(0);

    rendered = d("b", 1); // React/ELK finished — the DOM now shows b@1
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(sent[0]).toMatchObject({ kind: "snapshot-response", id: "req-1", name: "b", ok: true });
  });

  it("set_diagram version race: same name but an older rendered version must not be captured", async () => {
    // Direction change: name unchanged, version bumped 2 → 3. The old
    // name-only gate passed instantly and returned the old direction's pixels.
    const { connection, sent, deliver } = makeConnection(d("a", 3));
    let rendered: RenderedStamp | null = d("a", 2);
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, {
      getBounds: () => BOUNDS,
      capture,
      getRenderedStamp: () => rendered,
      ...FAST,
    });

    deliver(request("a"));
    await sleep(20);
    expect(capture).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);

    rendered = d("a", 3);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ name: "a", ok: true });
  });

  it("requires the EXACT version — a stale higher version (pre-restart render) never passes", async () => {
    // A tab that rendered a@57 before a server restart reconnects to a server
    // now serving a@1: `renderedVersion >= expected` would bless the stale
    // pixels, so the gate must demand equality and stay silent here.
    const { connection, sent, deliver } = makeConnection(d("a", 1));
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, {
      getBounds: () => BOUNDS,
      capture,
      getRenderedStamp: () => d("a", 57),
      renderPollMs: 1,
      renderWaitMs: 30,
    });

    deliver(request("a"));
    await sleep(60); // well past the wait budget
    expect(capture).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("gives up SILENTLY when the target content never renders within the wait budget", async () => {
    // Silence (not ok:false) keeps the server's timeout + headless-retry
    // machinery intact — same contract as "showing a different diagram".
    const { connection, sent, deliver } = makeConnection(d("b", 1));
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, {
      getBounds: () => BOUNDS,
      capture,
      getRenderedStamp: () => d("a", 1), // layout failed / never converges
      renderPollMs: 1,
      renderWaitMs: 30,
    });

    deliver(request("b"));
    await sleep(60);
    expect(capture).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("aborts the wait when the canvas moves on to ANOTHER diagram mid-wait", async () => {
    const { connection, sent, deliver, setLastDiagram } = makeConnection(d("b", 1));
    let rendered: RenderedStamp | null = d("a", 1);
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, {
      getBounds: () => BOUNDS,
      capture,
      getRenderedStamp: () => rendered,
      ...FAST,
    });

    deliver(request("b"));
    await sleep(5);
    setLastDiagram(d("c", 1)); // open_diagram "c" landed while we waited for b
    await sleep(10);
    rendered = d("b", 1); // even a late b render must not resurrect the request
    await sleep(20);
    expect(capture).not.toHaveBeenCalled();
    expect(sent).toHaveLength(0);
  });

  it("answers immediately (no added latency) when the canvas already shows the exact target", async () => {
    const { connection, sent, deliver } = makeConnection(d("demo", 7));
    const capture = vi.fn().mockResolvedValue(DATA_URL);
    attachSnapshotResponder(connection, {
      getBounds: () => BOUNDS,
      capture,
      ...renderedAs(d("demo", 7)),
      // Deliberately HUGE poll interval: a matching stamp must short-circuit
      // before the first sleep, or this test times out.
      renderPollMs: 60_000,
      renderWaitMs: 120_000,
    });

    deliver(request("demo"));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ ok: true, dataUrl: DATA_URL });
  });
});

describe("SNAPSHOT_SCALE", () => {
  it("captures at 1.5x per the T24 spec (lighter than the 2x interactive export)", () => {
    expect(SNAPSHOT_SCALE).toBe(1.5);
  });
});
