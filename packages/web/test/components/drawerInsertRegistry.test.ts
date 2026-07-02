/**
 * Unit tests for the drawer insert registry (T-VE3 / DGC-80) — pure module-
 * level state, same shape as `setSnapshotProvider`'s tests in
 * `render/snapshotResponder.test.ts`: register, insert, clear, re-register.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertIntoDrawer, registerDrawerInsert } from "../../src/components/drawerInsertRegistry";

afterEach(() => {
  registerDrawerInsert(null); // module-level state must not leak across tests
});

describe("insertIntoDrawer", () => {
  it("returns false when nothing has ever registered", () => {
    expect(insertIntoDrawer("[icon: server]")).toBe(false);
  });

  it("calls the registered inserter with the text and returns true", () => {
    const fn = vi.fn();
    registerDrawerInsert(fn);

    const result = insertIntoDrawer("[icon: server]");

    expect(result).toBe(true);
    expect(fn).toHaveBeenCalledWith("[icon: server]");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("returns false after the inserter is cleared with null", () => {
    const fn = vi.fn();
    registerDrawerInsert(fn);
    registerDrawerInsert(null);

    const result = insertIntoDrawer("[icon: server]");

    expect(result).toBe(false);
    expect(fn).not.toHaveBeenCalled();
  });

  it("a later registration replaces an earlier one", () => {
    const first = vi.fn();
    const second = vi.fn();
    registerDrawerInsert(first);
    registerDrawerInsert(second);

    insertIntoDrawer("[icon: db]");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("[icon: db]");
  });

  it("supports multiple inserts against the same registration", () => {
    const fn = vi.fn();
    registerDrawerInsert(fn);

    insertIntoDrawer("a");
    insertIntoDrawer("b");

    expect(fn).toHaveBeenNthCalledWith(1, "a");
    expect(fn).toHaveBeenNthCalledWith(2, "b");
  });
});
