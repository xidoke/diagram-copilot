import { afterEach, describe, expect, it, vi } from "vitest";
import { groupDiagrams, requestRename, requestTrash } from "../../src/components/Picker";

describe("groupDiagrams", () => {
  it("returns an empty list for an empty workspace", () => {
    expect(groupDiagrams([])).toEqual([]);
  });

  it("treats plain names (no .stepN suffix) as rootless single-item groups", () => {
    expect(groupDiagrams(["demo", "alpha"])).toEqual([
      { root: "alpha", steps: [] },
      { root: "demo", steps: [] },
    ]);
  });

  it("groups .stepN files under their root, sorted numerically", () => {
    const result = groupDiagrams(["news-feed", "news-feed.step2", "news-feed.step1", "news-feed.step10"]);
    expect(result).toEqual([
      { root: "news-feed", steps: ["news-feed.step1", "news-feed.step2", "news-feed.step10"] },
    ]);
  });

  it("still creates a root group when only step files exist (no base file)", () => {
    expect(groupDiagrams(["orphan.step1", "orphan.step2"])).toEqual([
      { root: "orphan", steps: ["orphan.step1", "orphan.step2"] },
    ]);
  });

  it("sorts root groups alphabetically, independent of input order", () => {
    const result = groupDiagrams(["zeta", "alpha", "mid.step1", "mid"]);
    expect(result.map((g) => g.root)).toEqual(["alpha", "mid", "zeta"]);
  });

  it("keeps unrelated diagrams and step groups separate", () => {
    const result = groupDiagrams(["news-feed", "news-feed.step1", "billing", "billing.step3", "billing.step1"]);
    expect(result).toEqual([
      { root: "billing", steps: ["billing.step1", "billing.step3"] },
      { root: "news-feed", steps: ["news-feed.step1"] },
    ]);
  });

  it("does not mistake a name merely containing '.step' without a trailing number for a step file", () => {
    expect(groupDiagrams(["my.stepper", "my.step"])).toEqual([
      { root: "my.step", steps: [] },
      { root: "my.stepper", steps: [] },
    ]);
  });
});

/**
 * The lifecycle request helpers (DGC-65) — exercised against a stubbed global
 * fetch (this suite runs in vitest's node environment, no DOM), verifying the
 * exact route/body they POST and how non-OK / non-JSON replies are normalized.
 */
describe("requestRename / requestTrash", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubFetch(status: number, body: unknown | null) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve({
        status,
        json: () => (body === null ? Promise.reject(new Error("not json")) : Promise.resolve(body)),
      });
    });
    return calls;
  }

  it("requestRename POSTs { name, newName } to /api/rename and returns the parsed result", async () => {
    const calls = stubFetch(200, { ok: true, oldName: "demo", newName: "renamed" });

    const result = await requestRename("demo", "renamed");

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/rename");
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: "demo", newName: "renamed" });
  });

  it("requestRename surfaces the server's error on a refused rename", async () => {
    stubFetch(400, { ok: false, error: 'A diagram named "taken" already exists.' });

    const result = await requestRename("demo", "taken");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("already exists");
  });

  it("requestTrash POSTs { name } to /api/trash and returns the parsed result", async () => {
    const calls = stubFetch(200, { ok: true, name: "demo", id: "2026-07-02T00-00-00.000Z-demo" });

    const result = await requestTrash("demo");

    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("/api/trash");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ name: "demo" });
  });

  it("normalizes a non-JSON reply into an ok:false result with the HTTP status", async () => {
    stubFetch(500, null);

    const result = await requestTrash("demo");

    expect(result.ok).toBe(false);
    expect(result.error).toContain("500");
  });
});
