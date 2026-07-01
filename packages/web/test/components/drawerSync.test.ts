import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClientMessageSchema, type ClientMessage } from "@diagram-copilot/core";
import {
  makeUpdateSender,
  shouldApplyRemote,
  UPDATE_DEBOUNCE_MS,
  type UpdateMeta,
} from "../../src/components/drawerSync";

describe("shouldApplyRemote", () => {
  it("applies when the editor is idle and the remote text differs", () => {
    expect(
      shouldApplyRemote({ value: "old", isEditing: false }, { dsl: "new" }),
    ).toBe("apply");
  });

  it("ignores when the remote text is identical (idle)", () => {
    expect(
      shouldApplyRemote({ value: "same", isEditing: false }, { dsl: "same" }),
    ).toBe("ignore");
  });

  it("ignores when identical even if the user is actively editing", () => {
    // Nothing changed, so there's nothing to clobber or flag.
    expect(
      shouldApplyRemote({ value: "same", isEditing: true }, { dsl: "same" }),
    ).toBe("ignore");
  });

  it("defers (badge) when focused/typing and the remote text differs", () => {
    expect(
      shouldApplyRemote({ value: "typing…", isEditing: true }, { dsl: "server" }),
    ).toBe("defer");
  });

  it("treats an empty buffer vs non-empty remote as a real diff (applies when idle)", () => {
    expect(shouldApplyRemote({ value: "", isEditing: false }, { dsl: "x" })).toBe("apply");
  });
});

describe("makeUpdateSender", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const meta: UpdateMeta = { name: "checkout-flow", baseVersion: 3 };

  it("debounces a burst of pushes into a single well-formed UpdateMessage", () => {
    const sent: ClientMessage[] = [];
    const sender = makeUpdateSender({ send: (m) => sent.push(m), getMeta: () => meta });

    sender.push("a");
    sender.push("ab");
    sender.push("abc");

    // Nothing fires until the debounce elapses.
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS - 1);
    expect(sent).toHaveLength(0);

    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);

    const msg = sent[0];
    // Shape is validated against the real protocol schema.
    expect(ClientMessageSchema.safeParse(msg).success).toBe(true);
    expect(msg).toEqual({
      kind: "update",
      name: "checkout-flow",
      dsl: "abc", // last value in the burst wins
      origin: "drawer",
      baseVersion: 3,
    });
  });

  it("uses a custom debounce window when provided", () => {
    const sent: ClientMessage[] = [];
    const sender = makeUpdateSender({
      send: (m) => sent.push(m),
      getMeta: () => meta,
      debounceMs: 1000,
    });

    sender.push("x");
    vi.advanceTimersByTime(999);
    expect(sent).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(1);
  });

  it("resolves meta at flush time so baseVersion reflects the latest diagram", () => {
    const sent: ClientMessage[] = [];
    let current: UpdateMeta = { name: "d", baseVersion: 1 };
    const sender = makeUpdateSender({ send: (m) => sent.push(m), getMeta: () => current });

    sender.push("edit");
    current = { name: "d", baseVersion: 7 }; // a remote update bumped the version
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);

    expect(sent[0]).toMatchObject({ baseVersion: 7, dsl: "edit" });
  });

  it("drops the pending edit when there is no active diagram", () => {
    const sent: ClientMessage[] = [];
    const sender = makeUpdateSender({ send: (m) => sent.push(m), getMeta: () => null });

    sender.push("orphan");
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
    expect(sent).toHaveLength(0);
  });

  it("flush() sends immediately, bypassing the debounce", () => {
    const sent: ClientMessage[] = [];
    const sender = makeUpdateSender({ send: (m) => sent.push(m), getMeta: () => meta });

    sender.push("now");
    sender.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ dsl: "now" });

    // The armed timer was cleared by flush — no duplicate later.
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
    expect(sent).toHaveLength(1);
  });

  it("cancel() discards a pending edit and disarms the timer", () => {
    const sent: ClientMessage[] = [];
    const sender = makeUpdateSender({ send: (m) => sent.push(m), getMeta: () => meta });

    sender.push("throwaway");
    sender.cancel();
    vi.advanceTimersByTime(UPDATE_DEBOUNCE_MS);
    expect(sent).toHaveLength(0);
  });
});
