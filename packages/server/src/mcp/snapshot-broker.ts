/**
 * Snapshot broker (T24 / DGC-44) — correlates `snapshot-request` broadcasts
 * with the first matching `snapshot-response` frame from a web client.
 *
 * The `get_snapshot` MCP tool cannot rasterize a diagram headlessly, so it
 * asks an open canvas to render on its behalf: the tool calls
 * {@link SnapshotBroker.createRequest} to obtain a correlation id + pending
 * promise, broadcasts the request over WS, and awaits the promise. The hub
 * routes every inbound `snapshot-response` to {@link SnapshotBroker.resolve}
 * (wired via `CreateServerOptions.onSnapshotResponse` in the CLI entry).
 *
 * Leak safety: every pending entry owns a timer; the map entry and its
 * timer are cleared both on resolution and on timeout, so an unanswered
 * request never accumulates — `pendingCount` is exposed so tests can assert
 * this.
 */
import { randomUUID } from "node:crypto";
import type { SnapshotResponseMessage } from "@diagram-copilot/core";

/** Default wait for a client to render + respond before giving up. */
export const SNAPSHOT_TIMEOUT_MS = 5000;

/** A pending snapshot request: correlation id + the promise the tool awaits. */
export interface PendingSnapshot {
  /** Correlation id to stamp on the broadcast `snapshot-request`. */
  id: string;
  /**
   * Resolves with the FIRST `snapshot-response` whose id matches (whether
   * `ok` or not); rejects with an Error after the timeout elapses.
   */
  promise: Promise<SnapshotResponseMessage>;
}

export interface SnapshotBroker {
  /**
   * Register a new pending request. Call BEFORE broadcasting the
   * `snapshot-request` so a fast client can never respond into the void.
   */
  createRequest(timeoutMs?: number): PendingSnapshot;
  /**
   * Route an inbound `snapshot-response`. Returns `true` when it settled a
   * pending request; `false` for unknown/duplicate ids (late responses after
   * a timeout, or a second client answering an already-settled request —
   * both are silently dropped by the caller).
   */
  resolve(message: SnapshotResponseMessage): boolean;
  /** Number of requests still awaiting a response (leak introspection). */
  readonly pendingCount: number;
}

interface PendingEntry {
  settle: (message: SnapshotResponseMessage) => void;
  fail: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** Create a broker. One instance per server process, shared across MCP calls. */
export function createSnapshotBroker(): SnapshotBroker {
  const pending = new Map<string, PendingEntry>();

  return {
    createRequest(timeoutMs: number = SNAPSHOT_TIMEOUT_MS): PendingSnapshot {
      const id = randomUUID();
      const promise = new Promise<SnapshotResponseMessage>((settle, fail) => {
        const timer = setTimeout(() => {
          pending.delete(id); // timeout path: clear the entry — no leak
          fail(new Error(`No snapshot response within ${timeoutMs}ms`));
        }, timeoutMs);
        // Don't let a pending snapshot keep the process alive on shutdown.
        timer.unref?.();
        pending.set(id, { settle, fail, timer });
      });
      return { id, promise };
    },

    resolve(message: SnapshotResponseMessage): boolean {
      const entry = pending.get(message.id);
      if (!entry) return false;
      pending.delete(message.id); // resolution path: clear the entry — no leak
      clearTimeout(entry.timer);
      entry.settle(message);
      return true;
    },

    get pendingCount() {
      return pending.size;
    },
  };
}
