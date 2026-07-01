/**
 * Round-trip + rejection tests for the snapshot protocol messages added by
 * T24 / DGC-44: `snapshot-request` (server → client) and `snapshot-response`
 * (client → server). Kept in their own file (rather than appended to
 * protocol.test.ts) so parallel workstreams touching the original suite
 * don't conflict.
 */
import { describe, expect, it } from "vitest";
import {
  parseClientMessage,
  parseServerMessage,
  serializeMessage,
  type ClientMessage,
  type ServerMessage,
  type SnapshotRequestMessage,
  type SnapshotResponseMessage,
} from "../src/index.js";

const TINY_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

describe("snapshot-request (server → client) — round-trip", () => {
  it("round-trips through serializeMessage + parseServerMessage", () => {
    const message: SnapshotRequestMessage = {
      kind: "snapshot-request",
      id: "req-42",
      name: "news-feed",
    };
    const result = parseServerMessage(serializeMessage(message));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual(message);
    }
  });

  it("is rejected on the CLIENT channel (direction matters)", () => {
    const message: ServerMessage = { kind: "snapshot-request", id: "req-1", name: "demo" };
    expect(parseClientMessage(JSON.stringify(message)).ok).toBe(false);
  });

  it("rejects an empty id or empty name", () => {
    for (const raw of [
      { kind: "snapshot-request", id: "", name: "demo" },
      { kind: "snapshot-request", id: "req-1", name: "" },
      { kind: "snapshot-request", name: "demo" }, // missing id entirely
    ]) {
      expect(parseServerMessage(JSON.stringify(raw)).ok).toBe(false);
    }
  });
});

describe("snapshot-response (client → server) — round-trip", () => {
  it("round-trips a successful response carrying a PNG data URL", () => {
    const message: SnapshotResponseMessage = {
      kind: "snapshot-response",
      id: "req-42",
      name: "news-feed",
      ok: true,
      dataUrl: TINY_PNG_DATA_URL,
    };
    const result = parseClientMessage(serializeMessage(message));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual(message);
    }
  });

  it("round-trips a failed response carrying an error string", () => {
    const message: SnapshotResponseMessage = {
      kind: "snapshot-response",
      id: "req-42",
      name: "news-feed",
      ok: false,
      error: "canvas viewport not found",
    };
    const result = parseClientMessage(serializeMessage(message));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual(message);
    }
  });

  it("is rejected on the SERVER channel (direction matters)", () => {
    const message: ClientMessage = {
      kind: "snapshot-response",
      id: "req-1",
      name: "demo",
      ok: true,
      dataUrl: TINY_PNG_DATA_URL,
    };
    expect(parseServerMessage(JSON.stringify(message)).ok).toBe(false);
  });

  it("rejects a response missing id, name or ok", () => {
    for (const raw of [
      { kind: "snapshot-response", name: "demo", ok: true },
      { kind: "snapshot-response", id: "req-1", ok: true },
      { kind: "snapshot-response", id: "req-1", name: "demo" },
      { kind: "snapshot-response", id: "", name: "demo", ok: true },
    ]) {
      expect(parseClientMessage(JSON.stringify(raw)).ok).toBe(false);
    }
  });
});

describe("existing message kinds are untouched by the T24 additions", () => {
  it("still round-trips an 'update' client message", () => {
    const message: ClientMessage = {
      kind: "update",
      name: "demo",
      dsl: "A > B",
      origin: "drawer",
      baseVersion: 1,
    };
    const result = parseClientMessage(serializeMessage(message));
    expect(result.ok).toBe(true);
  });

  it("still round-trips a 'workspace' server message", () => {
    const message: ServerMessage = { kind: "workspace", diagrams: ["demo"], active: "demo" };
    const result = parseServerMessage(serializeMessage(message));
    expect(result.ok).toBe(true);
  });
});
