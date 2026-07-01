import { describe, expect, it } from "vitest";
import { INITIAL_BACKOFF_MS, MAX_BACKOFF_MS, nextBackoffDelay } from "../../src/connection/backoff";

describe("nextBackoffDelay", () => {
  it("starts at the initial delay for attempt 0", () => {
    expect(nextBackoffDelay(0)).toBe(INITIAL_BACKOFF_MS);
    expect(nextBackoffDelay(0)).toBe(500);
  });

  it("doubles for each subsequent attempt", () => {
    expect(nextBackoffDelay(1)).toBe(1000);
    expect(nextBackoffDelay(2)).toBe(2000);
    expect(nextBackoffDelay(3)).toBe(4000);
  });

  it("caps at the max delay", () => {
    expect(nextBackoffDelay(4)).toBe(MAX_BACKOFF_MS);
    expect(nextBackoffDelay(4)).toBe(8000);
    expect(nextBackoffDelay(5)).toBe(8000);
    expect(nextBackoffDelay(100)).toBe(8000);
  });

  it("never returns a delay below the initial value for attempt 0 or negative", () => {
    expect(nextBackoffDelay(-1)).toBe(INITIAL_BACKOFF_MS);
  });
});
