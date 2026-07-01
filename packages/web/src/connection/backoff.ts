/**
 * Reconnect backoff for {@link createConnectionManager}.
 *
 * Pure — no timers, no DOM, no WebSocket. Exponential backoff starting at
 * {@link INITIAL_BACKOFF_MS}, doubling per attempt, capped at
 * {@link MAX_BACKOFF_MS}. The manager resets `attempt` back to 0 whenever
 * the socket reaches `connected`, so a long-lived healthy connection never
 * carries a stale backoff into its next disconnect.
 */

/** Delay (ms) before the first reconnect attempt. */
export const INITIAL_BACKOFF_MS = 500;

/** Upper bound (ms) on the reconnect delay, reached once attempts pile up. */
export const MAX_BACKOFF_MS = 8000;

/**
 * Delay (ms) to wait before reconnect attempt number `attempt` (0-based).
 * Negative attempts are clamped to 0.
 */
export function nextBackoffDelay(attempt: number): number {
  const safeAttempt = Math.max(0, attempt);
  const delay = INITIAL_BACKOFF_MS * 2 ** safeAttempt;
  return Math.min(delay, MAX_BACKOFF_MS);
}
