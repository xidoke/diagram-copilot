import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDsl, printDsl } from "../src/index.js";
import type { DiagramDoc } from "../src/index.js";

/**
 * printDsl (DGC-17): canonical DiagramDoc → DSL text.
 *
 * The load-bearing invariant is the parse round-trip:
 * `parseDsl(printDsl(doc)).doc` deep-equals `doc` for every parseDsl-produced
 * document. Formatting decisions (direction first, 2-space nesting, blank
 * lines between sections, 1-edge-1-line, icon/color/label attr order) are
 * pinned with literal expected strings so they cannot drift silently.
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

describe("printDsl — parse round-trip on golden fixtures", () => {
  for (const fixture of ["url-shortener.arch", "news-feed.arch", "rate-limiter.arch"]) {
    it(`${fixture}: parse(printDsl(doc)) deep-equals doc`, () => {
      const doc = parseOk(loadFixture(fixture));
      expect(parseOk(printDsl(doc))).toEqual(doc);
    });
  }
});

describe("printDsl — canonical format", () => {
  it("prints direction first, root nodes, nested groups (2-space indent), edges last", () => {
    const doc = parseOk(
      [
        "direction down",
        "Alpha",
        "Nhóm A {",
        "  Beta [icon: server]",
        "  Nhóm B {",
        "    Gamma [label: Nút gamma, color: red]",
        "  }",
        "}",
        "Alpha > Beta: gọi",
        "Beta > Gamma",
      ].join("\n"),
    );
    expect(printDsl(doc)).toBe(
      [
        "direction down",
        "",
        "Alpha",
        "",
        "Nhóm A {",
        "  Beta [icon: server]",
        "  Nhóm B {",
        "    Gamma [color: red, label: Nút gamma]",
        "  }",
        "}",
        "",
        "Alpha > Beta: gọi",
        "Beta > Gamma",
        "",
      ].join("\n"),
    );
  });

  it("always states the direction, even the default", () => {
    expect(printDsl(parseOk("A"))).toBe("direction right\n\nA\n");
  });

  it("prints an empty document as just the direction", () => {
    const doc = parseOk("");
    expect(printDsl(doc)).toBe("direction right\n");
    expect(parseOk(printDsl(doc))).toEqual(doc);
  });

  it("declares implicit (edge-created) nodes explicitly, preserving node order", () => {
    const doc = parseOk("A > B, C: dùng");
    expect(printDsl(doc)).toBe(["direction right", "", "A", "B", "C", "", "A > B: dùng", "A > C: dùng", ""].join("\n"));
    expect(parseOk(printDsl(doc))).toEqual(doc);
  });

  it("keeps 1 edge per line — fan-outs are not re-folded", () => {
    const doc = parseOk("LB > A, B: round robin");
    const printed = printDsl(doc);
    expect(printed).toContain("LB > A: round robin\nLB > B: round robin");
    expect(parseOk(printed)).toEqual(doc);
  });

  it("emits a label: attribute only when the label differs from the id", () => {
    const doc = parseOk("Server [label: Máy chủ chính]\nPlain");
    const printed = printDsl(doc);
    expect(printed).toContain("Server [label: Máy chủ chính]");
    expect(printed).toContain("\nPlain\n");
    expect(parseOk(printed)).toEqual(doc);
  });

  it("orders siblings by first appearance even when a node follows nested groups (news-feed Kafka case)", () => {
    const doc = parseOk(["VPC {", "  Inner {", "    A", "  }", "  Kafka [icon: apachekafka]", "}"].join("\n"));
    expect(printDsl(doc)).toBe(
      ["direction right", "", "VPC {", "  Inner {", "    A", "  }", "  Kafka [icon: apachekafka]", "}", ""].join("\n"),
    );
    expect(parseOk(printDsl(doc))).toEqual(doc);
  });

  it("round-trips edge labels containing a literal colon", () => {
    const doc = parseOk("A > B: ratio 2:1");
    expect(parseOk(printDsl(doc))).toEqual(doc);
  });

  it("round-trips Vietnamese multi-word names and labels", () => {
    const doc = parseOk(
      ["Người dùng [icon: monitor]", "Tầng dịch vụ {", "  Máy chủ API", "}", "Người dùng > Máy chủ API: gửi yêu cầu"].join(
        "\n",
      ),
    );
    expect(parseOk(printDsl(doc))).toEqual(doc);
  });

  it("prints an empty group with attributes", () => {
    const doc = parseOk("Khu trống [icon: cloud, label: Để dành] {\n}");
    expect(printDsl(doc)).toBe("direction right\n\nKhu trống [icon: cloud, label: Để dành] {\n}\n");
    expect(parseOk(printDsl(doc))).toEqual(doc);
  });
});

describe("printDsl — rejects documents that cannot round-trip", () => {
  const base: DiagramDoc = { type: "architecture", direction: "right", nodes: [], groups: [], edges: [] };

  it("throws on a semantically invalid document (duplicate ids)", () => {
    const doc: DiagramDoc = {
      ...base,
      nodes: [
        { id: "A", label: "A" },
        { id: "A", label: "A" },
      ],
    };
    expect(() => printDsl(doc)).toThrow(/invalid document/);
  });

  it("throws on a name containing structural characters", () => {
    const doc: DiagramDoc = { ...base, nodes: [{ id: "A]B", label: "A]B" }] };
    expect(() => printDsl(doc)).toThrow(/characters not allowed/);
  });

  it('throws on a name containing the reserved word "direction"', () => {
    const doc: DiagramDoc = { ...base, nodes: [{ id: "traffic direction hub", label: "traffic direction hub" }] };
    expect(() => printDsl(doc)).toThrow(/reserved word/);
  });

  it("throws on a name with consecutive spaces (cannot survive whitespace collapsing)", () => {
    const doc: DiagramDoc = { ...base, nodes: [{ id: "A  B", label: "A  B" }] };
    expect(() => printDsl(doc)).toThrow(/consecutive spaces/);
  });

  it("throws on an attribute value containing a comma", () => {
    const doc: DiagramDoc = { ...base, nodes: [{ id: "A", label: "A", icon: "x,y" }] };
    expect(() => printDsl(doc)).toThrow(/must not contain/);
  });

  it("throws on a label attribute that the parser would trim differently", () => {
    const doc: DiagramDoc = { ...base, nodes: [{ id: "A", label: " padded " }] };
    expect(() => printDsl(doc)).toThrow(/without surrounding whitespace/);
  });

  it('throws on an edge label containing "//" (comment would win on re-parse)', () => {
    const doc: DiagramDoc = {
      ...base,
      nodes: [
        { id: "A", label: "A" },
        { id: "B", label: "B" },
      ],
      edges: [{ id: "e1", from: "A", to: "B", label: "a // b" }],
    };
    expect(() => printDsl(doc)).toThrow(/re-parse as a comment/);
  });
});
