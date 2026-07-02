import { describe, expect, it } from "vitest";
import { matchNodes, normalize } from "../../src/components/SearchBox";

describe("normalize", () => {
  it("strips NFD combining marks and lowercases", () => {
    expect(normalize("Người dùng")).toBe("nguoi dung");
  });

  it("handles đ/Đ, which NFD does not decompose on its own", () => {
    expect(normalize("Đăng nhập")).toBe("dang nhap");
  });

  it("is a no-op (besides lowercasing) for plain ASCII", () => {
    expect(normalize("Gateway")).toBe("gateway");
  });
});

describe("matchNodes", () => {
  const nodes = [
    { id: "user", label: "Người dùng" },
    { id: "gateway", label: "Gateway" },
    { id: "rate-limiter", label: "Rate Limiter" },
    { id: "cache", label: "Rules Cache" },
  ];

  it("matches a diacritics-stripped ASCII query against an accented label", () => {
    expect(matchNodes(nodes, "nguoi dung")).toEqual([nodes[0]]);
  });

  it("matches the accented query against the accented label directly", () => {
    expect(matchNodes(nodes, "Người")).toEqual([nodes[0]]);
  });

  it("is case-insensitive", () => {
    expect(matchNodes(nodes, "GATEWAY")).toEqual([nodes[1]]);
    expect(matchNodes(nodes, "gateway")).toEqual([nodes[1]]);
  });

  it("matches on a partial/substring label", () => {
    expect(matchNodes(nodes, "cache")).toEqual([nodes[3]]);
    expect(matchNodes(nodes, "rate")).toEqual([nodes[2]]);
  });

  it("returns every node whose label contains the query", () => {
    expect(matchNodes(nodes, "a")).toEqual([nodes[1], nodes[2], nodes[3]]);
  });

  it("returns an empty array for a blank or whitespace-only query", () => {
    expect(matchNodes(nodes, "")).toEqual([]);
    expect(matchNodes(nodes, "   ")).toEqual([]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(matchNodes(nodes, "does-not-exist")).toEqual([]);
  });

  it("returns an empty array against an empty node list", () => {
    expect(matchNodes([], "gateway")).toEqual([]);
  });
});
