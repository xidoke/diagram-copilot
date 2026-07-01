/**
 * Unit tests for the snapshot broker (T24 / DGC-44): resolution, timeout,
 * duplicate/unknown-id handling, and — critically — that BOTH settlement
 * paths clear the pending map (no leaks).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SnapshotResponseMessage } from "@diagram-copilot/core";
import { createSnapshotBroker, SNAPSHOT_TIMEOUT_MS } from "../src/mcp/snapshot-broker.js";

function response(id: string, overrides: Partial<SnapshotResponseMessage> = {}): SnapshotResponseMessage {
  return {
    kind: "snapshot-response",
    id,
    name: "demo",
    ok: true,
    dataUrl: "data:image/png;base64,AAAA",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSnapshotBroker", () => {
  it("resolves the pending promise with the first matching response and clears the map", async () => {
    const broker = createSnapshotBroker();
    const { id, promise } = broker.createRequest();
    expect(broker.pendingCount).toBe(1);

    const matched = broker.resolve(response(id));

    expect(matched).toBe(true);
    expect(broker.pendingCount).toBe(0);
    await expect(promise).resolves.toMatchObject({ id, ok: true });
  });

  it("delivers a NOT-ok response too (the tool decides how to surface it)", async () => {
    const broker = createSnapshotBroker();
    const { id, promise } = broker.createRequest();

    broker.resolve(response(id, { ok: false, dataUrl: undefined, error: "canvas not ready" }));

    await expect(promise).resolves.toMatchObject({ ok: false, error: "canvas not ready" });
  });

  it("generates a fresh id per request and routes responses by id", async () => {
    const broker = createSnapshotBroker();
    const a = broker.createRequest();
    const b = broker.createRequest();
    expect(a.id).not.toBe(b.id);
    expect(broker.pendingCount).toBe(2);

    broker.resolve(response(b.id, { name: "other" }));

    await expect(b.promise).resolves.toMatchObject({ id: b.id, name: "other" });
    expect(broker.pendingCount).toBe(1); // `a` still pending

    broker.resolve(response(a.id));
    await expect(a.promise).resolves.toMatchObject({ id: a.id });
    expect(broker.pendingCount).toBe(0);
  });

  it("returns false for an unknown id and keeps other requests pending", () => {
    const broker = createSnapshotBroker();
    broker.createRequest();

    expect(broker.resolve(response("no-such-id"))).toBe(false);
    expect(broker.pendingCount).toBe(1);
  });

  it("first response wins: a duplicate for the same id is reported unmatched", async () => {
    const broker = createSnapshotBroker();
    const { id, promise } = broker.createRequest();

    expect(broker.resolve(response(id))).toBe(true);
    expect(broker.resolve(response(id, { ok: false, error: "late duplicate" }))).toBe(false);

    await expect(promise).resolves.toMatchObject({ ok: true });
  });

  it("rejects after the timeout and clears the map (no leak)", async () => {
    const broker = createSnapshotBroker();
    const { promise } = broker.createRequest(250);
    const outcome = expect(promise).rejects.toThrow(/no snapshot response within 250ms/i);

    vi.advanceTimersByTime(249);
    expect(broker.pendingCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(broker.pendingCount).toBe(0);
    await outcome;
  });

  it("a response arriving AFTER the timeout is reported unmatched", async () => {
    const broker = createSnapshotBroker();
    const { id, promise } = broker.createRequest(100);
    const outcome = expect(promise).rejects.toThrow();

    vi.advanceTimersByTime(100);
    await outcome;

    expect(broker.resolve(response(id))).toBe(false);
    expect(broker.pendingCount).toBe(0);
  });

  it("defaults the timeout to SNAPSHOT_TIMEOUT_MS (5s)", async () => {
    const broker = createSnapshotBroker();
    const { promise } = broker.createRequest();
    const outcome = expect(promise).rejects.toThrow(new RegExp(`${SNAPSHOT_TIMEOUT_MS}ms`));

    vi.advanceTimersByTime(SNAPSHOT_TIMEOUT_MS - 1);
    expect(broker.pendingCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(broker.pendingCount).toBe(0);
    await outcome;
  });
});
