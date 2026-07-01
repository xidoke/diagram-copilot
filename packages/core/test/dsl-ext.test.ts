import { describe, expect, it } from "vitest";
import { parseDsl } from "../src/index.js";

/** Convenience: assert ok and return the doc. */
function parseOk(dsl: string) {
  const result = parseDsl(dsl);
  if (!result.ok) {
    throw new Error(
      `expected ok parse, got errors: ${JSON.stringify(
        { parseErrors: result.parseErrors, modelErrors: result.modelErrors },
        null,
        2,
      )}`,
    );
  }
  return result.doc;
}

/** Convenience: assert failure and return the errors. */
function parseFail(dsl: string) {
  const result = parseDsl(dsl);
  if (result.ok) {
    throw new Error(`expected parse failure, got doc: ${JSON.stringify(result.doc)}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. One-to-many edges
// ---------------------------------------------------------------------------
describe("parseDsl — one-to-many edges", () => {
  it("expands `A > B, C, D` into one edge per target in order", () => {
    const doc = parseOk("A > B, C, D");
    expect(doc.nodes.map((n) => n.id)).toEqual(["A", "B", "C", "D"]);
    expect(doc.edges).toEqual([
      { id: "e1", from: "A", to: "B" },
      { id: "e2", from: "A", to: "C" },
      { id: "e3", from: "A", to: "D" },
    ]);
  });

  it("applies a trailing label to every fan-out edge", () => {
    const doc = parseOk("A > B, C: uses");
    expect(doc.edges).toEqual([
      { id: "e1", from: "A", to: "B", label: "uses" },
      { id: "e2", from: "A", to: "C", label: "uses" },
    ]);
  });

  it("supports multi-word source and targets in a fan-out", () => {
    const doc = parseOk("Load Balancer > API Server, DB Server: routes to");
    expect(doc.edges).toEqual([
      { id: "e1", from: "Load Balancer", to: "API Server", label: "routes to" },
      { id: "e2", from: "Load Balancer", to: "DB Server", label: "routes to" },
    ]);
  });

  it("tolerates whitespace around the comma separators", () => {
    const doc = parseOk("A > B , C ,  D");
    expect(doc.edges.map((e) => e.to)).toEqual(["B", "C", "D"]);
  });

  it("keeps colons in a fan-out label (label runs to end of line)", () => {
    const doc = parseOk("A > B, C: ratio 2:1");
    expect(doc.edges).toEqual([
      { id: "e1", from: "A", to: "B", label: "ratio 2:1" },
      { id: "e2", from: "A", to: "C", label: "ratio 2:1" },
    ]);
  });

  it("still handles a single target (no comma) unchanged", () => {
    const doc = parseOk("A > B: solo");
    expect(doc.edges).toEqual([{ id: "e1", from: "A", to: "B", label: "solo" }]);
  });

  it("auto-creates fan-out targets in first-appearance order", () => {
    const doc = parseOk("Gateway > Auth, Users, Auth");
    // Auth appears twice; only created once, but both edges exist.
    expect(doc.nodes.map((n) => n.id)).toEqual(["Gateway", "Auth", "Users"]);
    expect(doc.edges).toEqual([
      { id: "e1", from: "Gateway", to: "Auth" },
      { id: "e2", from: "Gateway", to: "Users" },
      { id: "e3", from: "Gateway", to: "Auth" },
    ]);
  });

  it("reports a ParseError when a comma is not followed by a target", () => {
    const result = parseFail("A > B,\nC");
    expect(result.modelErrors).toEqual([]);
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]!.line).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Comments (`//`)
// ---------------------------------------------------------------------------
describe("parseDsl — comments", () => {
  it("ignores a full-line comment between statements", () => {
    const doc = parseOk(["Client", "// this is a comment", "Server"].join("\n"));
    expect(doc.nodes.map((n) => n.id)).toEqual(["Client", "Server"]);
  });

  it("ignores a comment-only document", () => {
    const doc = parseOk("// just a note\n// another line");
    expect(doc.nodes).toEqual([]);
    expect(doc.edges).toEqual([]);
  });

  it("strips an end-of-line comment after a node declaration", () => {
    const doc = parseOk("Client // the browser\nServer");
    expect(doc.nodes.map((n) => n.id)).toEqual(["Client", "Server"]);
  });

  it("strips a comment after a group opening brace", () => {
    const doc = parseOk(["VPC { // network boundary", "  Server", "}"].join("\n"));
    expect(doc.groups).toEqual([{ id: "VPC", label: "VPC" }]);
    expect(doc.nodes).toEqual([{ id: "Server", label: "Server", groupId: "VPC" }]);
  });

  it("strips a comment after an edge (no label)", () => {
    const doc = parseOk("A > B // primary link");
    expect(doc.edges).toEqual([{ id: "e1", from: "A", to: "B" }]);
  });

  it("comment wins over an edge label: `A > B: cache // hot` keeps only `cache`", () => {
    const doc = parseOk("A > B: cache // hot");
    expect(doc.edges).toEqual([{ id: "e1", from: "A", to: "B", label: "cache" }]);
  });

  it("comment wins for every edge in a fan-out label", () => {
    const doc = parseOk("A > B, C: sync // TODO async later");
    expect(doc.edges).toEqual([
      { id: "e1", from: "A", to: "B", label: "sync" },
      { id: "e2", from: "A", to: "C", label: "sync" },
    ]);
  });

  it("keeps a single slash inside a label (only `//` starts a comment)", () => {
    const doc = parseOk("A > B: read/write");
    expect(doc.edges).toEqual([{ id: "e1", from: "A", to: "B", label: "read/write" }]);
  });

  it("keeps a single slash inside a node name", () => {
    const doc = parseOk("TCP/IP\n");
    expect(doc.nodes).toEqual([{ id: "TCP/IP", label: "TCP/IP" }]);
  });

  it("a comment line does not shift the line number of a later error", () => {
    // Comment on line 1; the bad direction is on line 2 and must report line 2.
    const result = parseFail(["// header comment", "direction sideways", "A"].join("\n"));
    expect(result.parseErrors.length).toBe(1);
    expect(result.parseErrors[0]!.line).toBe(2);
    expect(result.parseErrors[0]!.message).toMatch(/direction/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Vietnamese names (no Unicode normalization)
// ---------------------------------------------------------------------------
describe("parseDsl — Vietnamese names", () => {
  it("keeps a Vietnamese node name intact", () => {
    const doc = parseOk("Người dùng\n");
    expect(doc.nodes).toEqual([{ id: "Người dùng", label: "Người dùng" }]);
  });

  it("keeps a Vietnamese group name intact", () => {
    const doc = parseOk(["Tầng dữ liệu {", "  Cơ sở dữ liệu", "}"].join("\n"));
    expect(doc.groups).toEqual([{ id: "Tầng dữ liệu", label: "Tầng dữ liệu" }]);
    expect(doc.nodes).toEqual([
      { id: "Cơ sở dữ liệu", label: "Cơ sở dữ liệu", groupId: "Tầng dữ liệu" },
    ]);
  });

  it("keeps a Vietnamese edge label intact", () => {
    const doc = parseOk("Người dùng > Máy chủ: gửi yêu cầu");
    expect(doc.edges).toEqual([
      { id: "e1", from: "Người dùng", to: "Máy chủ", label: "gửi yêu cầu" },
    ]);
  });

  it("keeps a Vietnamese label attribute intact", () => {
    const doc = parseOk("API [label: Máy chủ ứng dụng]\n");
    expect(doc.nodes).toEqual([{ id: "API", label: "Máy chủ ứng dụng" }]);
  });

  it("preserves the exact code units of a name (no Unicode normalization)", () => {
    // The same glyph in two normalization forms: NFC (precomposed) vs NFD
    // (base letter + combining marks). The parser must round-trip each form
    // verbatim and treat the two forms as distinct ids.
    const nfc = "Hà Nội".normalize("NFC");
    const nfd = "Hà Nội".normalize("NFD");
    expect(nfc).not.toBe(nfd); // sanity: the two forms differ as strings
    const doc = parseOk(`${nfc}\n${nfd}\n`);
    expect(doc.nodes.map((n) => n.id)).toEqual([nfc, nfd]);
  });
});

// ---------------------------------------------------------------------------
// 4. Error quality (line/column, comments & nested groups)
// ---------------------------------------------------------------------------
describe("parseDsl — error quality", () => {
  it("reports the correct line for a syntax error inside a nested group", () => {
    const result = parseFail(["VPC {", "  Client >", "}"].join("\n"));
    expect(result.modelErrors).toEqual([]);
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]!.line).toBe(2);
    expect(result.parseErrors[0]!.column).toBeGreaterThanOrEqual(1);
  });

  it("reports the correct line for an unknown attribute inside a nested group", () => {
    const result = parseFail(["VPC {", "  API [foo: bar]", "}"].join("\n"));
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]!.line).toBe(2);
    expect(result.parseErrors[0]!.message).toMatch(/foo/);
  });

  it("reports the correct line for a bad direction below a leading comment", () => {
    const result = parseFail(["// diagram config", "", "direction diagonal", "A"].join("\n"));
    expect(result.parseErrors.length).toBe(1);
    expect(result.parseErrors[0]!.line).toBe(3);
    expect(result.parseErrors[0]!.column).toBe(11);
  });

  it("reports the correct line for an unknown attribute below a comment", () => {
    const result = parseFail(["// nodes below", "API [foo: bar]"].join("\n"));
    expect(result.parseErrors[0]!.line).toBe(2);
    expect(result.parseErrors[0]!.message).toMatch(/foo/);
  });

  it("gives a short, single-line message for an incomplete edge", () => {
    const result = parseFail("Client >\nServer");
    const msg = result.parseErrors[0]!.message;
    expect(msg).not.toContain("\n"); // no raw multi-line Chevrotain dump
    expect(msg).not.toMatch(/iteration/i);
    expect(msg).toMatch(/expected a name/);
  });

  it("names the stray token for a statement that starts with `>`", () => {
    const result = parseFail("> Server");
    expect(result.parseErrors[0]!.line).toBe(1);
    expect(result.parseErrors[0]!.column).toBe(1);
    expect(result.parseErrors[0]!.message).toContain("'>'");
    expect(result.parseErrors[0]!.message).not.toContain("\n");
  });
});
