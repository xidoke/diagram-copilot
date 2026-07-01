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

describe("parseDsl — happy path", () => {
  it("parses the canonical example into a full doc", () => {
    const doc = parseOk(
      [
        "direction right",
        "",
        "Client",
        "API Server",
        "Postgres",
        "",
        "Client > API Server",
        "API Server > Postgres: query",
      ].join("\n"),
    );

    expect(doc.type).toBe("architecture");
    expect(doc.direction).toBe("right");
    expect(doc.groups).toEqual([]);
    expect(doc.nodes).toEqual([
      { id: "Client", label: "Client" },
      { id: "API Server", label: "API Server" },
      { id: "Postgres", label: "Postgres" },
    ]);
    expect(doc.edges).toEqual([
      { id: "e1", from: "Client", to: "API Server" },
      { id: "e2", from: "API Server", to: "Postgres", label: "query" },
    ]);
  });

  it("parses a multi-word node name as one node", () => {
    const doc = parseOk("Load Balancer Gateway\n");
    expect(doc.nodes).toEqual([{ id: "Load Balancer Gateway", label: "Load Balancer Gateway" }]);
    expect(doc.edges).toEqual([]);
  });

  it("keeps basic unicode names intact", () => {
    const doc = parseOk("Máy chủ web\nDatabase\nMáy chủ web > Database");
    expect(doc.nodes[0]).toEqual({ id: "Máy chủ web", label: "Máy chủ web" });
    expect(doc.edges).toEqual([{ id: "e1", from: "Máy chủ web", to: "Database" }]);
  });

  it("auto-creates implicit nodes referenced only by edges", () => {
    const doc = parseOk("Client > API Server");
    expect(doc.nodes).toEqual([
      { id: "Client", label: "Client" },
      { id: "API Server", label: "API Server" },
    ]);
    expect(doc.edges).toEqual([{ id: "e1", from: "Client", to: "API Server" }]);
  });

  it("auto-created nodes appear in order of first appearance", () => {
    const doc = parseOk("A > B\nC\nB > C\nD > A");
    expect(doc.nodes.map((n) => n.id)).toEqual(["A", "B", "C", "D"]);
  });

  it("does not duplicate a node that is both declared and referenced", () => {
    const doc = parseOk("Client\nClient > Server\nClient");
    expect(doc.nodes).toEqual([
      { id: "Client", label: "Client" },
      { id: "Server", label: "Server" },
    ]);
  });

  it("keeps colons inside an edge label (label runs to end of line, trimmed)", () => {
    const doc = parseOk("A > B:  ratio 2:1 traffic  ");
    expect(doc.edges).toEqual([{ id: "e1", from: "A", to: "B", label: "ratio 2:1 traffic" }]);
  });

  it("omits the label when it is empty after trimming", () => {
    const doc = parseOk("A > B:   ");
    expect(doc.edges).toEqual([{ id: "e1", from: "A", to: "B" }]);
  });

  it("returns a valid empty doc for empty input", () => {
    expect(parseOk("")).toEqual({
      type: "architecture",
      direction: "right",
      nodes: [],
      groups: [],
      edges: [],
    });
  });

  it("returns a valid empty doc for whitespace-only input", () => {
    expect(parseOk(" \n\n\t\n")).toEqual({
      type: "architecture",
      direction: "right",
      nodes: [],
      groups: [],
      edges: [],
    });
  });

  it("supports all four directions", () => {
    for (const dir of ["right", "left", "up", "down"] as const) {
      expect(parseOk(`direction ${dir}\nA`).direction).toBe(dir);
    }
  });

  it("defaults direction to right when absent", () => {
    expect(parseOk("A\nB\nA > B").direction).toBe("right");
  });

  it("handles CRLF line endings", () => {
    const doc = parseOk("direction left\r\nClient > API Server: hi\r\n");
    expect(doc.direction).toBe("left");
    expect(doc.edges).toEqual([{ id: "e1", from: "Client", to: "API Server", label: "hi" }]);
  });

  it("collapses internal runs of whitespace in names to a single space", () => {
    const doc = parseOk("API    Server\nAPI Server > X");
    expect(doc.nodes.map((n) => n.id)).toEqual(["API Server", "X"]);
    expect(doc.edges[0]!.from).toBe("API Server");
  });

  it("trims surrounding whitespace around names", () => {
    const doc = parseOk("   Client   \n\tClient > \t Server \t");
    expect(doc.nodes.map((n) => n.id)).toEqual(["Client", "Server"]);
  });

  it("lets a later direction statement win", () => {
    expect(parseOk("direction left\ndirection down\nA").direction).toBe("down");
  });
});

describe("parseDsl — groups", () => {
  it("parses a two-level nested group fixture with correct parent/groupId", () => {
    const doc = parseOk(
      ["VPC subnet {", "  Main Server {", "    Server", "    Data", "  }", "}"].join("\n"),
    );
    expect(doc.groups).toEqual([
      { id: "VPC subnet", label: "VPC subnet" },
      { id: "Main Server", label: "Main Server", parentId: "VPC subnet" },
    ]);
    expect(doc.nodes).toEqual([
      { id: "Server", label: "Server", groupId: "Main Server" },
      { id: "Data", label: "Data", groupId: "Main Server" },
    ]);
    expect(doc.edges).toEqual([]);
  });

  it("parses a single-level group with a leaf node", () => {
    const doc = parseOk(["VPC {", "  Server", "}"].join("\n"));
    expect(doc.groups).toEqual([{ id: "VPC", label: "VPC" }]);
    expect(doc.nodes).toEqual([{ id: "Server", label: "Server", groupId: "VPC" }]);
  });

  it("parses an empty group", () => {
    const doc = parseOk(["VPC {", "}"].join("\n"));
    expect(doc.groups).toEqual([{ id: "VPC", label: "VPC" }]);
    expect(doc.nodes).toEqual([]);
  });

  it("allows an edge to reference a group (no spurious node created)", () => {
    const doc = parseOk(["VPC {", "  Server", "}", "Client > VPC"].join("\n"));
    expect(doc.groups).toEqual([{ id: "VPC", label: "VPC" }]);
    // Client is a real node; VPC is a group, not auto-created as a node.
    expect(doc.nodes).toEqual([
      { id: "Server", label: "Server", groupId: "VPC" },
      { id: "Client", label: "Client" },
    ]);
    expect(doc.edges).toEqual([{ id: "e1", from: "Client", to: "VPC" }]);
  });

  it("allows an edge to reference a group declared later (forward reference)", () => {
    const doc = parseOk(["Client > VPC", "VPC {", "  Server", "}"].join("\n"));
    expect(doc.nodes).toEqual([
      { id: "Client", label: "Client" },
      { id: "Server", label: "Server", groupId: "VPC" },
    ]);
    expect(doc.edges).toEqual([{ id: "e1", from: "Client", to: "VPC" }]);
  });

  it("lets an explicit in-group declaration win over an implicit edge node", () => {
    const doc = parseOk(["Client > Server", "VPC {", "  Server", "}"].join("\n"));
    // Server was first seen implicitly (no group); the explicit declaration
    // inside VPC assigns its group membership.
    expect(doc.nodes).toEqual([
      { id: "Client", label: "Client" },
      { id: "Server", label: "Server", groupId: "VPC" },
    ]);
    expect(doc.edges).toEqual([{ id: "e1", from: "Client", to: "Server" }]);
  });
});

describe("parseDsl — attributes", () => {
  it("parses icon, color, and label attributes on a node", () => {
    const doc = parseOk(["API [icon: server, color: orange]", "Server_A [label: server]"].join("\n"));
    expect(doc.nodes).toEqual([
      { id: "API", label: "API", icon: "server", color: "orange" },
      { id: "Server_A", label: "server" },
    ]);
  });

  it("keeps the id as the declared name even when label is overridden", () => {
    const doc = parseOk("Main Server [label: Primary]\n");
    expect(doc.nodes).toEqual([{ id: "Main Server", label: "Primary" }]);
  });

  it("parses attributes and a group block on the same line", () => {
    const doc = parseOk(
      ["Main Server [icon: server, color: blue] {", "  Server", "}"].join("\n"),
    );
    expect(doc.groups).toEqual([
      { id: "Main Server", label: "Main Server", icon: "server", color: "blue" },
    ]);
    expect(doc.nodes).toEqual([{ id: "Server", label: "Server", groupId: "Main Server" }]);
  });

  it("applies a label attribute to a group", () => {
    const doc = parseOk(["VPC [label: Virtual Private Cloud] {", "  Server", "}"].join("\n"));
    expect(doc.groups).toEqual([{ id: "VPC", label: "Virtual Private Cloud" }]);
  });

  it("tolerates an empty attribute list", () => {
    const doc = parseOk("API []\n");
    expect(doc.nodes).toEqual([{ id: "API", label: "API" }]);
  });

  it("allows attribute values to contain spaces", () => {
    const doc = parseOk("API [icon: aws ec2]\n");
    expect(doc.nodes[0]).toEqual({ id: "API", label: "API", icon: "aws ec2" });
  });

  it("reports a ParseError for an unknown attribute key", () => {
    const result = parseFail("API [foo: bar]\n");
    expect(result.modelErrors).toEqual([]);
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]!.message).toMatch(/foo/);
    expect(result.parseErrors[0]!.line).toBe(1);
  });

  it("reports a ParseError for a malformed attribute (missing colon)", () => {
    const result = parseFail("API [server]\n");
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]!.message).toMatch(/attribute/i);
  });

  it("reports a ParseError for an attribute with an empty value", () => {
    const result = parseFail("API [icon: ]\n");
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]!.message).toMatch(/icon/);
  });
});

describe("parseDsl — errors", () => {
  it("reports a ParseError on the correct line for an edge missing its target", () => {
    const result = parseFail("Client\nClient >\nServer");
    expect(result.modelErrors).toEqual([]);
    expect(result.parseErrors.length).toBeGreaterThan(0);
    expect(result.parseErrors[0]!.line).toBe(2);
    expect(result.parseErrors[0]!.column).toBeGreaterThanOrEqual(1);
    expect(result.parseErrors[0]!.message).toBeTruthy();
  });

  it("reports a ParseError on the correct line for an edge missing its source", () => {
    const result = parseFail("Client\nServer\n> Server");
    expect(result.parseErrors[0]!.line).toBe(3);
    expect(result.parseErrors[0]!.column).toBe(1);
  });

  it("reports a ParseError for an invalid direction value, pointing at the value", () => {
    const result = parseFail("direction sideways\nA");
    expect(result.parseErrors.length).toBe(1);
    expect(result.parseErrors[0]!.line).toBe(1);
    expect(result.parseErrors[0]!.column).toBe(11);
    expect(result.parseErrors[0]!.message).toMatch(/direction/i);
    expect(result.parseErrors[0]!.message).toMatch(/sideways/);
  });

  it("reports a ParseError for a dangling edge at end of input without trailing newline", () => {
    const result = parseFail("Client >");
    expect(result.parseErrors[0]!.line).toBe(1);
  });

  it("reports a ParseError for a direction statement without a value", () => {
    const result = parseFail("direction\nA");
    expect(result.parseErrors[0]!.line).toBe(1);
  });
});
