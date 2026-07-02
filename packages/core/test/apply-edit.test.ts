import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { applyDocEdit, parseDsl } from "../src/index.js";
import type { DiagramDoc, DiagramEdge, DiagramNode } from "../src/index.js";

/**
 * applyDocEdit (DGC-17): minimal-diff DiagramDoc → DSL rewrite.
 *
 * The contract under test, in order of importance:
 * 1. No-op identity — `applyDocEdit(dsl, parseDsl(dsl).doc) === dsl`, byte
 *    for byte, on every fixture and on comment-heavy hand-written inputs.
 * 2. Minimal diff — a change to one element rewrites exactly its line(s);
 *    everything else (comments, blank lines, spacing, order) is untouched.
 * 3. Trailing comments survive rewrites and moves, and die with deletions.
 */

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), "utf8");
}

function parseOk(dsl: string): DiagramDoc {
  const result = parseDsl(dsl);
  if (!result.ok) {
    throw new Error(`expected ok parse: ${JSON.stringify({ p: result.parseErrors, m: result.modelErrors })}`);
  }
  return result.doc;
}

/** Comment-dense document exercising every trailing-comment position. */
const NASTY = [
  "// tệp thử nghiệm — giữ nguyên từng byte",
  "direction right // hướng chính",
  "",
  "Người dùng [icon: monitor] // máy khách Việt",
  "",
  "Cụm dịch vụ [color: blue] { // nhóm chính",
  "  API chính [icon: server]",
  "",
  "  // chú thích giữa nhóm",
  "  Lồng nhau {",
  "    Con sâu [label: Nút con]",
  "  } // hết nhóm con",
  "} // hết nhóm",
  "",
  "Người dùng > API chính: tỉ lệ 2:1 // nhãn có dấu hai chấm",
  "API chính > Con sâu, Người dùng: fan-out // chung nhãn",
  "",
  "// dòng cuối chỉ có chú thích",
  "",
].join("\n");

describe("applyDocEdit — no-op identity", () => {
  for (const fixture of ["url-shortener.arch", "news-feed.arch", "rate-limiter.arch"]) {
    it(`${fixture}: returns the input byte-for-byte and re-parses deep-equal`, () => {
      const dsl = loadFixture(fixture);
      const doc = parseOk(dsl);
      const out = applyDocEdit(dsl, doc);
      expect(out).toBe(dsl);
      expect(parseOk(out)).toEqual(doc);
    });
  }

  it("holds on a comment-dense Vietnamese document", () => {
    const doc = parseOk(NASTY);
    expect(applyDocEdit(NASTY, doc)).toBe(NASTY);
    expect(parseOk(applyDocEdit(NASTY, doc))).toEqual(doc);
  });

  it("holds without a trailing newline", () => {
    const dsl = "A [icon: server] // chú thích\nA > B: nhãn";
    expect(applyDocEdit(dsl, parseOk(dsl))).toBe(dsl);
  });

  it("holds on CRLF line endings", () => {
    const dsl = "direction left\r\nA // ghi chú\r\nA > B\r\n";
    expect(applyDocEdit(dsl, parseOk(dsl))).toBe(dsl);
  });
});

describe("applyDocEdit — single-line rewrites (minimal diff)", () => {
  it("rewrites only the changed node line and keeps its trailing comment", () => {
    const doc = parseOk(NASTY);
    const edited: DiagramDoc = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === "Người dùng" ? { ...n, color: "red" } : n)),
    };
    const out = applyDocEdit(NASTY, edited);
    const expected = NASTY.replace(
      "Người dùng [icon: monitor] // máy khách Việt",
      "Người dùng [icon: monitor, color: red] // máy khách Việt",
    );
    expect(out).toBe(expected);
    expect(parseOk(out)).toEqual(edited);
  });

  it("rewrites a group header (attrs) in place, keeping the header comment and body bytes", () => {
    const doc = parseOk(NASTY);
    const edited: DiagramDoc = {
      ...doc,
      groups: doc.groups.map((g) => (g.id === "Cụm dịch vụ" ? { ...g, color: "green", icon: "cloud" } : g)),
    };
    const out = applyDocEdit(NASTY, edited);
    expect(out).toBe(
      NASTY.replace("Cụm dịch vụ [color: blue] { // nhóm chính", "Cụm dịch vụ [icon: cloud, color: green] { // nhóm chính"),
    );
  });

  it("rewrites an edge label in place — the comment and the rest of the file stay", () => {
    const doc = parseOk(NASTY);
    const edited: DiagramDoc = {
      ...doc,
      edges: doc.edges.map((e) => (e.id === "e1" ? { ...e, label: "tỉ lệ 3:1" } : e)),
    };
    const out = applyDocEdit(NASTY, edited);
    expect(out).toBe(
      NASTY.replace(
        "Người dùng > API chính: tỉ lệ 2:1 // nhãn có dấu hai chấm",
        "Người dùng > API chính: tỉ lệ 3:1 // nhãn có dấu hai chấm",
      ),
    );
  });

  it("rewrites the direction line only, keeping its trailing comment", () => {
    const edited = { ...parseOk(NASTY), direction: "down" as const };
    const out = applyDocEdit(NASTY, edited);
    expect(out).toBe(NASTY.replace("direction right // hướng chính", "direction down // hướng chính"));
    expect(parseOk(out).direction).toBe("down");
  });

  it("inserts a direction statement when none existed", () => {
    const dsl = "// chú thích đầu tệp\nA > B\n";
    const edited = { ...parseOk(dsl), direction: "down" as const };
    expect(applyDocEdit(dsl, edited)).toBe("// chú thích đầu tệp\ndirection down\nA > B\n");
  });

  it("resets the label to the id by dropping the label: attribute", () => {
    const doc = parseOk(NASTY);
    const edited: DiagramDoc = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === "Con sâu" ? { ...n, label: "Con sâu" } : n)),
    };
    const out = applyDocEdit(NASTY, edited);
    expect(out).toBe(NASTY.replace("    Con sâu [label: Nút con]", "    Con sâu"));
  });
});

describe("applyDocEdit — fan-out edge statements", () => {
  it("drops one target from a fan-out, keeping the single line and its comment", () => {
    const doc = parseOk(NASTY);
    // e2 = API chính > Con sâu, e3 = API chính > Người dùng (shared label).
    const edited: DiagramDoc = { ...doc, edges: doc.edges.filter((e) => e.id !== "e2") };
    const out = applyDocEdit(NASTY, edited);
    expect(out).toBe(
      NASTY.replace("API chính > Con sâu, Người dùng: fan-out // chung nhãn", "API chính > Người dùng: fan-out // chung nhãn"),
    );
  });

  it("splits a fan-out when one edge's label diverges (comment stays on the first line)", () => {
    const dsl = "A > B, C: chung // ghi chú\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = {
      ...doc,
      edges: doc.edges.map((e) => (e.to === "B" ? { ...e, label: "riêng" } : e)),
    };
    expect(applyDocEdit(dsl, edited)).toBe("A > B: riêng // ghi chú\nA > C: chung\n");
  });

  it("drops the whole statement (with its trailing comment) when every edge is removed, declaring orphaned implicit nodes", () => {
    const dsl = "X\nA > B, C: chung // sẽ biến mất\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = { ...doc, edges: [] };
    const out = applyDocEdit(dsl, edited);
    // A/B/C only existed through the deleted edges; they get bare declarations
    // so the edited doc round-trips instead of silently losing nodes.
    expect(out).toBe("X\nA\nB\nC\n");
    expect(parseOk(out)).toEqual(edited);
  });
});

describe("applyDocEdit — insertions", () => {
  it("inserts a new root node after the last root-level declaration", () => {
    const dsl = ["direction right", "", "A", "B", "", "A > B"].join("\n");
    const doc = parseOk(dsl);
    const edited: DiagramDoc = { ...doc, nodes: [...doc.nodes, { id: "C", label: "C", icon: "cpu" }] };
    expect(applyDocEdit(dsl, edited)).toBe(["direction right", "", "A", "B", "C [icon: cpu]", "", "A > B"].join("\n"));
  });

  it("inserts a new node just before its group's closing brace", () => {
    const dsl = "G {\n  A // ghi chú\n}\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = { ...doc, nodes: [...doc.nodes, { id: "B", label: "B", groupId: "G" }] };
    expect(applyDocEdit(dsl, edited)).toBe("G {\n  A // ghi chú\n  B\n}\n");
  });

  it("appends new edges at the end of the file", () => {
    const dsl = "A\nB\n\nA > B\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = { ...doc, edges: [...doc.edges, { id: "x", from: "B", to: "A", label: "phản hồi" }] };
    expect(applyDocEdit(dsl, edited)).toBe("A\nB\n\nA > B\nB > A: phản hồi\n");
  });

  it("renders a brand-new group block with its new members", () => {
    const dsl = "A\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = {
      ...doc,
      groups: [{ id: "Nhóm mới", label: "Nhóm mới", color: "blue" }],
      nodes: [...doc.nodes, { id: "B", label: "B", groupId: "Nhóm mới" }],
    };
    expect(applyDocEdit(dsl, edited)).toBe("A\nNhóm mới [color: blue] {\n  B\n}\n");
  });

  it("declares a previously implicit node once it gains attributes", () => {
    const dsl = "A > B\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === "B" ? { ...n, icon: "database" } : n)),
    };
    expect(applyDocEdit(dsl, edited)).toBe("B [icon: database]\nA > B\n");
  });
});

describe("applyDocEdit — moves", () => {
  it("moves a node between groups, carrying its trailing comment", () => {
    const dsl = "G {\n  A [icon: x] // di chuyển tôi\n}\nH {\n  B\n}\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === "A" ? { ...n, groupId: "H" } : n)),
    };
    expect(applyDocEdit(dsl, edited)).toBe("G {\n}\nH {\n  B\n  A [icon: x] // di chuyển tôi\n}\n");
  });

  it("moves a node to the document root", () => {
    const dsl = "Root\nG {\n  A\n}\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = {
      ...doc,
      nodes: doc.nodes.map((n) => {
        if (n.id !== "A") return n;
        const { groupId: _drop, ...rest } = n;
        return rest;
      }),
    };
    expect(applyDocEdit(dsl, edited)).toBe("Root\nG {\n}\nA\n");
  });

  it("moves a whole group block into another group, re-indenting its lines", () => {
    const dsl = "G {\n  A\n}\nH { // nhóm H\n  B // giữ chú thích\n}\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = {
      ...doc,
      groups: doc.groups.map((g) => (g.id === "H" ? { ...g, parentId: "G" } : g)),
    };
    expect(applyDocEdit(dsl, edited)).toBe("G {\n  A\n  H { // nhóm H\n    B // giữ chú thích\n  }\n}\n");
  });
});

describe("applyDocEdit — deletions", () => {
  it("deletes a node's line together with its trailing comment; full-line comments stay", () => {
    const dsl = "// đầu tệp\nA // sẽ bị xoá\nB\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = { ...doc, nodes: doc.nodes.filter((n) => n.id !== "A") };
    expect(applyDocEdit(dsl, edited)).toBe("// đầu tệp\nB\n");
  });

  it("dissolves a deleted group and re-inserts surviving (re-parented) children at the root", () => {
    const dsl = "G { // nhóm cũ\n  A\n  B\n}\nA > B\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = {
      ...doc,
      groups: [],
      nodes: doc.nodes.map((n) => {
        const { groupId: _drop, ...rest } = n;
        return rest;
      }),
    };
    expect(applyDocEdit(dsl, edited)).toBe("A\nB\nA > B\n");
  });
});

describe("applyDocEdit — renames (options.renames)", () => {
  it("rewrites the declaration and every referencing edge, keeping comments and fan-out shape", () => {
    const doc = parseOk(NASTY);
    const rename = (id: string): string => (id === "Con sâu" ? "Cháu ngoan" : id);
    const edited: DiagramDoc = {
      ...doc,
      nodes: doc.nodes.map((n): DiagramNode => (n.id === "Con sâu" ? { ...n, id: "Cháu ngoan" } : n)),
      edges: doc.edges.map((e): DiagramEdge => ({ ...e, from: rename(e.from), to: rename(e.to) })),
    };
    const out = applyDocEdit(NASTY, edited, { renames: { "Con sâu": "Cháu ngoan" } });
    expect(out).toBe(
      NASTY.replace("    Con sâu [label: Nút con]", "    Cháu ngoan [label: Nút con]").replace(
        "API chính > Con sâu, Người dùng: fan-out // chung nhãn",
        "API chính > Cháu ngoan, Người dùng: fan-out // chung nhãn",
      ),
    );
    expect(parseOk(out)).toEqual(edited);
  });
});

describe("applyDocEdit — less common shapes", () => {
  it("keeps identity and edits correctly for edges declared inside a group body", () => {
    const dsl = "G {\n  A\n  B\n  A > B: nội bộ // trong nhóm\n}\n";
    const doc = parseOk(dsl);
    expect(applyDocEdit(dsl, doc)).toBe(dsl);
    const edited: DiagramDoc = { ...doc, edges: doc.edges.map((e) => ({ ...e, label: "đường mới" })) };
    expect(applyDocEdit(dsl, edited)).toBe("G {\n  A\n  B\n  A > B: đường mới // trong nhóm\n}\n");
  });

  it("consolidates a multi-declaration node: the last declaration carries the full state, earlier attrs are stripped", () => {
    const dsl = "A [icon: x] // đầu\nG {\n  A // trong nhóm\n}\n";
    const doc = parseOk(dsl);
    expect(applyDocEdit(dsl, doc)).toBe(dsl); // unchanged: both lines verbatim
    const edited: DiagramDoc = {
      ...doc,
      nodes: doc.nodes.map((n) => (n.id === "A" ? { ...n, color: "blue" } : n)),
    };
    const out = applyDocEdit(dsl, edited);
    expect(out).toBe("A // đầu\nG {\n  A [icon: x, color: blue] // trong nhóm\n}\n");
    expect(parseOk(out)).toEqual(edited);
  });
});

describe("applyDocEdit — errors", () => {
  it("throws when the original DSL does not parse", () => {
    expect(() => applyDocEdit("A >", parseOk("A"))).toThrow(/original DSL does not parse/);
  });

  it("throws when the edited document is semantically invalid", () => {
    const dsl = "A\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = { ...doc, nodes: [{ id: "A", label: "A", groupId: "Không tồn tại" }] };
    expect(() => applyDocEdit(dsl, edited)).toThrow(/edited document is invalid/);
  });

  it("throws when a rewritten statement cannot round-trip (edge label with //)", () => {
    const dsl = "A > B: ok\n";
    const doc = parseOk(dsl);
    const edited: DiagramDoc = { ...doc, edges: doc.edges.map((e) => ({ ...e, label: "vỡ // òa" })) };
    expect(() => applyDocEdit(dsl, edited)).toThrow(/re-parse as a comment/);
  });
});
