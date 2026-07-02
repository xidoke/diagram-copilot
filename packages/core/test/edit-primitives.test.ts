import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addEdge,
  addNode,
  applyDocEdit,
  moveToGroup,
  parseDsl,
  printDsl,
  removeElement,
  renameElement,
  setAttr,
} from "../src/index.js";
import type { DiagramDoc } from "../src/index.js";

/**
 * Edit primitives (DGC-17): thin canvas-gesture wrappers over applyDocEdit.
 *
 * Each primitive is tested on comment-bearing input (comments must survive),
 * plus a seeded pseudo-random workout per fixture: after every step the text
 * must still parse, `applyDocEdit(dsl, parse(dsl).doc)` must be a byte
 * no-op, and `parseDsl(printDsl(doc)).doc` must deep-equal the doc.
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

const RATE_LIMITER = loadFixture("rate-limiter.arch");

describe("addNode", () => {
  it("adds a bare root node after the last root-level declaration", () => {
    const dsl = "A // gốc\n\nA > B";
    const out = addNode(dsl, { id: "C" });
    expect(out).toBe("A // gốc\nC\n\nA > B");
    expect(parseOk(out).nodes.map((n) => n.id)).toEqual(["A", "C", "B"]);
  });

  it("adds an attributed node inside a group (before the closing brace)", () => {
    const out = addNode(RATE_LIMITER, { id: "Audit Log", icon: "file", color: "gray" }, "Backend");
    expect(out).toContain("  API Backend [icon: server, color: green]\n  Audit Log [icon: file, color: gray]\n}");
    const doc = parseOk(out);
    expect(doc.nodes.find((n) => n.id === "Audit Log")).toEqual({
      id: "Audit Log",
      label: "Audit Log",
      icon: "file",
      color: "gray",
      groupId: "Backend",
    });
  });

  it("supports a custom display label", () => {
    const out = addNode("A\n", { id: "Bộ đệm", label: "Cache tầng 2" });
    expect(out).toBe("A\nBộ đệm [label: Cache tầng 2]\n");
  });

  it("throws on a duplicate id and on an unknown group", () => {
    expect(() => addNode(RATE_LIMITER, { id: "Gateway" })).toThrow(/already exists/);
    expect(() => addNode(RATE_LIMITER, { id: "Mới" }, "Không có")).toThrow(/invalid/);
  });
});

describe("addEdge", () => {
  it("appends the edge at the end of the file with a generated id", () => {
    const out = addEdge(RATE_LIMITER, { from: "API Backend", to: "Rules Cache", label: "ghi thống kê" });
    expect(out.endsWith("Rate Limiter > API Backend: cho phép nếu còn quota\nAPI Backend > Rules Cache: ghi thống kê\n")).toBe(
      true,
    );
    const doc = parseOk(out);
    expect(doc.edges).toHaveLength(5);
    expect(doc.edges[4]).toEqual({ id: "e5", from: "API Backend", to: "Rules Cache", label: "ghi thống kê" });
  });

  it("accepts group endpoints and label-less edges", () => {
    const out = addEdge(RATE_LIMITER, { from: "Edge", to: "Backend" });
    expect(out.trimEnd().endsWith("Edge > Backend")).toBe(true);
  });

  it("throws on unknown endpoints and duplicate ids", () => {
    expect(() => addEdge(RATE_LIMITER, { from: "Ma", to: "Gateway" })).toThrow(/invalid/);
    expect(() => addEdge(RATE_LIMITER, { id: "e1", from: "Gateway", to: "Rules Cache" })).toThrow(/already exists/);
  });
});

describe("renameElement", () => {
  it("renames a multi-word Vietnamese node everywhere, keeping every comment and byte around it", () => {
    const out = renameElement(RATE_LIMITER, "Người dùng", "Khách hàng VIP");
    expect(out).toBe(
      RATE_LIMITER.replace("Người dùng [icon: monitor]", "Khách hàng VIP [icon: monitor]").replace(
        "Người dùng > Gateway: gửi yêu cầu",
        "Khách hàng VIP > Gateway: gửi yêu cầu",
      ),
    );
    const doc = parseOk(out);
    expect(doc.nodes.find((n) => n.id === "Khách hàng VIP")).toEqual({
      id: "Khách hàng VIP",
      label: "Khách hàng VIP",
      icon: "monitor",
    });
    expect(doc.nodes.some((n) => n.id === "Người dùng")).toBe(false);
    // The Vietnamese fixture header comment is untouched.
    expect(out).toContain('// rate-limiter.arch — golden fixture (DGC-31)');
  });

  it("renames a group: header rewritten, member lines and edges to the group follow", () => {
    const dsl = 'G [color: blue] { // nhóm\n  A\n}\nB > G: vào nhóm\n';
    const out = renameElement(dsl, "G", "Nhóm lõi");
    expect(out).toBe('Nhóm lõi [color: blue] { // nhóm\n  A\n}\nB > Nhóm lõi: vào nhóm\n');
  });

  it("keeps an explicit label: attribute (only the default label follows the rename)", () => {
    const dsl = "Máy chủ [label: Server chính]\n";
    const out = renameElement(dsl, "Máy chủ", "Cụm máy chủ");
    expect(out).toBe("Cụm máy chủ [label: Server chính]\n");
  });

  it("is a byte no-op when the new name equals the old", () => {
    expect(renameElement(RATE_LIMITER, "Gateway", "Gateway")).toBe(RATE_LIMITER);
  });

  it("throws on unknown ids, conflicts, and unprintable names", () => {
    expect(() => renameElement(RATE_LIMITER, "Không có", "X")).toThrow(/no node or group/);
    expect(() => renameElement(RATE_LIMITER, "Gateway", "Rules Cache")).toThrow(/already exists/);
    expect(() => renameElement(RATE_LIMITER, "Gateway", "a]b")).toThrow(/characters not allowed/);
    expect(() => renameElement(RATE_LIMITER, "Gateway", "the direction hub")).toThrow(/reserved word/);
  });
});

describe("setAttr", () => {
  it("sets and clears node attributes, preserving the trailing comment", () => {
    const dsl = "A [icon: server, color: red] // giữ tôi lại\n";
    expect(setAttr(dsl, "A", "color", "blue")).toBe("A [icon: server, color: blue] // giữ tôi lại\n");
    expect(setAttr(dsl, "A", "color", null)).toBe("A [icon: server] // giữ tôi lại\n");
    expect(setAttr(dsl, "A", "label", "Máy chủ A")).toBe("A [icon: server, color: red, label: Máy chủ A] // giữ tôi lại\n");
  });

  it("clearing label resets the display label to the id", () => {
    const dsl = "A [label: Tên riêng]\n";
    expect(setAttr(dsl, "A", "label", null)).toBe("A\n");
  });

  it("sets attributes on a group header", () => {
    const out = setAttr(RATE_LIMITER, "Backend", "color", "teal");
    expect(out).toBe(RATE_LIMITER.replace("Backend {", "Backend [color: teal] {"));
  });

  it("sets and clears an edge label by edge id", () => {
    const dsl = "A > B: cũ // chú thích\n";
    expect(setAttr(dsl, "e1", "label", "mới")).toBe("A > B: mới // chú thích\n");
    expect(setAttr(dsl, "e1", "label", null)).toBe("A > B // chú thích\n");
  });

  it("throws on unknown ids and non-label edge attributes", () => {
    expect(() => setAttr(RATE_LIMITER, "Không có", "icon", "x")).toThrow(/no node, group, or edge/);
    expect(() => setAttr("A > B\n", "e1", "color", "red")).toThrow(/only support the "label"/);
  });
});

describe("moveToGroup", () => {
  it("moves a node into a sibling group and back to the root", () => {
    const moved = moveToGroup(RATE_LIMITER, "Rules Cache", "Backend");
    expect(moved).toContain("Backend {\n  API Backend [icon: server, color: green]\n  Rules Cache [icon: redis, color: red]\n}");
    expect(parseOk(moved).nodes.find((n) => n.id === "Rules Cache")?.groupId).toBe("Backend");
    const toRoot = moveToGroup(moved, "Rules Cache", null);
    expect(parseOk(toRoot).nodes.find((n) => n.id === "Rules Cache")?.groupId).toBeUndefined();
  });

  it("nests one group inside another, re-indenting the moved block", () => {
    const dsl = "G {\n  A\n}\nH { // nhóm H\n  B // giữ chú thích\n}\n";
    expect(moveToGroup(dsl, "H", "G")).toBe("G {\n  A\n  H { // nhóm H\n    B // giữ chú thích\n  }\n}\n");
  });

  it("rejects unknown targets, unknown ids, self-moves, and cycles", () => {
    expect(() => moveToGroup(RATE_LIMITER, "Gateway", "Không có")).toThrow(/no group/);
    expect(() => moveToGroup(RATE_LIMITER, "Không có", "Backend")).toThrow(/no node or group/);
    expect(() => moveToGroup(RATE_LIMITER, "Backend", "Backend")).toThrow(/into itself/);
    const nested = "G {\n  H {\n  }\n}\n";
    expect(() => moveToGroup(nested, "G", "H")).toThrow(/cycle/i);
  });
});

describe("removeElement", () => {
  it("removes a node in the middle of a group plus every edge touching it", () => {
    const out = removeElement(RATE_LIMITER, "Rate Limiter");
    expect(out).toContain("Edge {\n  Gateway [icon: shield, color: blue]\n  Rules Cache [icon: redis, color: red]\n}");
    expect(out).toContain("Người dùng > Gateway: gửi yêu cầu");
    // The declaration and every referencing edge line are gone; the header
    // comments (which also mention the name) stay untouched by design.
    expect(out).not.toContain("Rate Limiter [icon: cpu");
    expect(out).not.toContain("Gateway > Rate Limiter");
    expect(out).not.toContain("Rate Limiter > Rules Cache");
    const doc = parseOk(out);
    expect(doc.nodes).toHaveLength(4);
    expect(doc.edges).toHaveLength(1);
    // Header comments (Vietnamese) survive.
    expect(out).toContain("// Request flow:");
  });

  it("cascades a group removal to descendants and their edges", () => {
    const dsl = "Ngoài\nG {\n  A\n  H {\n    B\n  }\n}\nNgoài > A\nB > Ngoài\n";
    const out = removeElement(dsl, "G");
    expect(out).toBe("Ngoài\n");
    expect(parseOk(out)).toEqual({
      type: "architecture",
      direction: "right",
      nodes: [{ id: "Ngoài", label: "Ngoài" }],
      groups: [],
      edges: [],
    });
  });

  it("removes a single edge by id, shrinking its fan-out statement", () => {
    const dsl = "LB > A, B: round robin // chia tải\n";
    // "A" only existed through the removed edge, so it gets a bare
    // declaration — removing an edge must not silently delete a node.
    expect(removeElement(dsl, "e1")).toBe("A\nLB > B: round robin // chia tải\n");
  });

  it("throws on unknown ids", () => {
    expect(() => removeElement(RATE_LIMITER, "Không có")).toThrow(/no node, group, or edge/);
  });
});

// ---------------------------------------------------------------------------
// Seeded pseudo-random workout: N primitive edits per fixture. Deterministic
// (mulberry32), so failures are reproducible. After every step:
//   1. the DSL still parses,
//   2. applyDocEdit(dsl, parse(dsl).doc) is a byte no-op (identity),
//   3. parseDsl(printDsl(doc)).doc deep-equals doc (printer round-trip).
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("property: random primitive sequences keep identity + print round-trip", () => {
  const fixtures = ["url-shortener.arch", "news-feed.arch", "rate-limiter.arch"];
  const icons = ["server", "database", "cloud", "cpu", "lock"];
  const colors = ["red", "blue", "green", "orange", "teal"];

  for (const [f, fixture] of fixtures.entries()) {
    it(`${fixture}: 12 random edits, invariants hold after each`, () => {
      const rand = mulberry32(0xd6c17 + f);
      const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
      let dsl = loadFixture(fixture);
      let fresh = 0;

      for (let step = 0; step < 12; step++) {
        const doc = parseOk(dsl);
        const op = Math.floor(rand() * 6);
        try {
          switch (op) {
            case 0: {
              const groupId = rand() < 0.5 && doc.groups.length > 0 ? pick(doc.groups).id : undefined;
              dsl = addNode(dsl, { id: `Nút mới ${++fresh}`, icon: pick(icons) }, groupId);
              break;
            }
            case 1: {
              const ids = [...doc.nodes.map((n) => n.id), ...doc.groups.map((g) => g.id)];
              dsl = addEdge(dsl, { from: pick(ids), to: pick(ids), label: rand() < 0.5 ? `nhãn ${++fresh}` : undefined });
              break;
            }
            case 2: {
              if (doc.nodes.length === 0) break;
              dsl = renameElement(dsl, pick(doc.nodes).id, `Đổi tên ${++fresh}`);
              break;
            }
            case 3: {
              const target = pick([...doc.nodes, ...doc.groups]);
              const key = pick(["icon", "color", "label"] as const);
              const value = rand() < 0.3 ? null : key === "label" ? `Nhãn ${++fresh}` : key === "icon" ? pick(icons) : pick(colors);
              dsl = setAttr(dsl, target.id, key, value);
              break;
            }
            case 4: {
              if (doc.nodes.length === 0) break;
              const node = pick(doc.nodes);
              const groupId = rand() < 0.3 || doc.groups.length === 0 ? null : pick(doc.groups).id;
              dsl = moveToGroup(dsl, node.id, groupId);
              break;
            }
            case 5: {
              if (doc.nodes.length <= 3) break;
              dsl = removeElement(dsl, pick(doc.nodes).id);
              break;
            }
          }
        } catch (error) {
          throw new Error(`step ${step} (op ${op}) threw: ${(error as Error).message}\n--- dsl ---\n${dsl}`);
        }

        const next = parseOk(dsl); // 1. still parses
        expect(applyDocEdit(dsl, next)).toBe(dsl); // 2. no-op identity
        expect(parseOk(printDsl(next))).toEqual(next); // 3. printer round-trip
      }
    });
  }
});
