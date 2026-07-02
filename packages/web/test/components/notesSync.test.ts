import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeNotesSaver, NOTES_SAVE_DEBOUNCE_MS } from "../../src/components/notesSync";

describe("makeNotesSaver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("debounces a burst of pushes into a single save with the last value", () => {
    const saved: Array<{ name: string; markdown: string }> = [];
    const saver = makeNotesSaver({ save: (name, markdown) => saved.push({ name, markdown }) });

    saver.push("demo", "a");
    saver.push("demo", "ab");
    saver.push("demo", "abc");

    // Nothing fires until the debounce elapses.
    vi.advanceTimersByTime(NOTES_SAVE_DEBOUNCE_MS - 1);
    expect(saved).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(saved).toEqual([{ name: "demo", markdown: "abc" }]);
  });

  it("uses a custom debounce window when provided", () => {
    const saved: string[] = [];
    const saver = makeNotesSaver({ save: (_n, md) => saved.push(md), debounceMs: 1000 });

    saver.push("d", "x");
    vi.advanceTimersByTime(999);
    expect(saved).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(saved).toEqual(["x"]);
  });

  it("captures the diagram name at push time so a mid-debounce switch is safe", () => {
    const saved: Array<{ name: string; markdown: string }> = [];
    const saver = makeNotesSaver({ save: (name, markdown) => saved.push({ name, markdown }) });

    // Typed against diagram A, then a later push targets diagram B before A's
    // debounce fires — each save must land on the name it was typed for.
    saver.push("alpha", "notes for A");
    vi.advanceTimersByTime(NOTES_SAVE_DEBOUNCE_MS);
    saver.push("beta", "notes for B");
    vi.advanceTimersByTime(NOTES_SAVE_DEBOUNCE_MS);

    expect(saved).toEqual([
      { name: "alpha", markdown: "notes for A" },
      { name: "beta", markdown: "notes for B" },
    ]);
  });

  it("flush() saves immediately, bypassing the debounce", () => {
    const saved: string[] = [];
    const saver = makeNotesSaver({ save: (_n, md) => saved.push(md) });

    saver.push("d", "now");
    saver.flush();
    expect(saved).toEqual(["now"]);

    // The armed timer was cleared by flush — no duplicate later.
    vi.advanceTimersByTime(NOTES_SAVE_DEBOUNCE_MS);
    expect(saved).toHaveLength(1);
  });

  it("cancel() discards a pending edit and disarms the timer", () => {
    const saved: string[] = [];
    const saver = makeNotesSaver({ save: (_n, md) => saved.push(md) });

    saver.push("d", "throwaway");
    saver.cancel();
    vi.advanceTimersByTime(NOTES_SAVE_DEBOUNCE_MS);
    expect(saved).toHaveLength(0);
  });

  it("flush() with nothing pending is a no-op", () => {
    const saved: string[] = [];
    const saver = makeNotesSaver({ save: (_n, md) => saved.push(md) });
    saver.flush();
    expect(saved).toHaveLength(0);
  });
});
