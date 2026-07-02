import { describe, expect, it, vi } from "vitest";
import { buildIconEntries, filterIcons, handleIconClick, type IconEntry } from "../../src/components/IconPalette";

/** A tiny hand-built set so the matching semantics are asserted in isolation
 *  (independent of the live registry's exact contents). */
const SAMPLE: IconEntry[] = [
  { id: "postgresql", title: "PostgreSQL", svg: "<svg/>", source: "simple-icons", aliases: ["postgres", "pg"] },
  { id: "kubernetes", title: "Kubernetes", svg: "<svg/>", source: "simple-icons", aliases: ["k8s"] },
  { id: "server", title: "Server", svg: "<svg/>", source: "lucide", aliases: [] },
  // Accented name + accented alias to exercise diacritics stripping.
  { id: "user", title: "Người dùng", svg: "<svg/>", source: "lucide", aliases: ["đăng-nhập"] },
];

describe("filterIcons", () => {
  it("returns everything for a blank or whitespace-only query (browse all)", () => {
    expect(filterIcons(SAMPLE, "")).toEqual(SAMPLE);
    expect(filterIcons(SAMPLE, "   ")).toEqual(SAMPLE);
  });

  it("matches by canonical id, case-insensitively", () => {
    expect(filterIcons(SAMPLE, "POSTGRES").map((e) => e.id)).toEqual(["postgresql"]);
    expect(filterIcons(SAMPLE, "serv").map((e) => e.id)).toEqual(["server"]);
  });

  it("matches by display title", () => {
    expect(filterIcons(SAMPLE, "Kubernetes").map((e) => e.id)).toEqual(["kubernetes"]);
  });

  it("matches by alias", () => {
    expect(filterIcons(SAMPLE, "k8s").map((e) => e.id)).toEqual(["kubernetes"]);
    expect(filterIcons(SAMPLE, "pg").map((e) => e.id)).toEqual(["postgresql"]);
  });

  it("strips diacritics on both sides (ASCII query finds accented name/alias)", () => {
    expect(filterIcons(SAMPLE, "nguoi").map((e) => e.id)).toEqual(["user"]);
    expect(filterIcons(SAMPLE, "dang-nhap").map((e) => e.id)).toEqual(["user"]);
  });

  it("also matches the accented query against the accented name directly", () => {
    expect(filterIcons(SAMPLE, "Người").map((e) => e.id)).toEqual(["user"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(filterIcons(SAMPLE, "zzz-nonexistent")).toEqual([]);
  });
});

describe("buildIconEntries", () => {
  it("includes every registry icon plus one trailing fallback entry", () => {
    const entries = buildIconEntries();
    const fallbacks = entries.filter((e) => e.fallback);
    expect(fallbacks).toHaveLength(1);
    // The fallback is last so it renders at the end of the grid.
    expect(entries[entries.length - 1]?.fallback).toBe(true);
    expect(entries.length).toBeGreaterThan(30);
  });

  it("tags icons with the aliases that resolve to them", () => {
    const postgres = buildIconEntries().find((e) => e.id === "postgresql");
    expect(postgres?.aliases).toContain("postgres");
  });

  it("every entry carries non-empty svg markup", () => {
    for (const entry of buildIconEntries()) {
      expect(entry.svg).toMatch(/<svg/);
    }
  });
});

/** Reused across the handleIconClick cases below. */
const SERVER: IconEntry = {
  id: "server",
  title: "Server",
  svg: "<svg/>",
  source: "lucide",
  aliases: [],
};

describe("handleIconClick", () => {
  it("inserts into the drawer and skips the clipboard when insert succeeds", async () => {
    const insert = vi.fn().mockReturnValue(true);
    const copy = vi.fn().mockResolvedValue(undefined);

    const toast = await handleIconClick(SERVER, { insert, copy });

    expect(toast).toBe("inserted [icon: server]");
    expect(insert).toHaveBeenCalledWith("[icon: server]");
    expect(copy).not.toHaveBeenCalled();
  });

  it("falls back to copy when insert reports failure (drawer closed)", async () => {
    const insert = vi.fn().mockReturnValue(false);
    const copy = vi.fn().mockResolvedValue(undefined);

    const toast = await handleIconClick(SERVER, { insert, copy });

    expect(toast).toBe("copied [icon: server]");
    expect(copy).toHaveBeenCalledWith("[icon: server]");
  });

  it("reports a copy failure when both insert and clipboard fail", async () => {
    const insert = vi.fn().mockReturnValue(false);
    const copy = vi.fn().mockRejectedValue(new Error("denied"));

    const toast = await handleIconClick(SERVER, { insert, copy });

    expect(toast).toBe("copy failed — [icon: server]");
  });

  it("defaults to the real drawer registry when insert is not injected", async () => {
    // No `insert` override: falls through to the module's `insertIntoDrawer`,
    // which reports false with nothing registered in this test's module
    // state — exercising the default-params branch, not just the fakes.
    const copy = vi.fn().mockResolvedValue(undefined);

    const toast = await handleIconClick(SERVER, { copy });

    expect(toast).toBe("copied [icon: server]");
    expect(copy).toHaveBeenCalledWith("[icon: server]");
  });
});
