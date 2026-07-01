import { describe, expect, it } from "vitest";
import {
  DiagramDocSchema,
  validateDoc,
  type DiagramDoc,
} from "../src/index.js";

/** A small but complete valid document used as the baseline fixture. */
function validDoc(): DiagramDoc {
  return {
    type: "architecture",
    direction: "right",
    nodes: [
      { id: "user", label: "Người dùng", icon: "user" },
      { id: "api", label: "API", icon: "aws-ec2", color: "orange", groupId: "vpc" },
      { id: "db", label: "Postgres", icon: "aws-rds", groupId: "vpc" },
    ],
    groups: [{ id: "vpc", label: "VPC subnet" }],
    edges: [
      { id: "e1", from: "user", to: "api" },
      { id: "e2", from: "api", to: "db", label: "query" },
    ],
  };
}

describe("DiagramDocSchema / validateDoc — shape", () => {
  it("accepts a valid document and returns it unchanged", () => {
    const doc = validDoc();
    const result = validateDoc(doc);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.doc).toEqual(doc);
    }
  });

  it("accepts a minimal empty document", () => {
    const result = validateDoc({
      type: "architecture",
      direction: "down",
      nodes: [],
      groups: [],
      edges: [],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects non-object input", () => {
    for (const input of [null, undefined, 42, "direction right", []]) {
      const result = validateDoc(input);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects an unknown diagram type", () => {
    const result = validateDoc({ ...validDoc(), type: "flowchart" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]?.path).toBe("type");
    }
  });

  it("rejects an invalid direction with a path pointing at the field", () => {
    const result = validateDoc({ ...validDoc(), direction: "diagonal" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "direction")).toBe(true);
    }
  });

  it("rejects a node missing its label", () => {
    const doc = validDoc();
    // @ts-expect-error — intentionally broken fixture
    delete doc.nodes[0].label;
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "nodes[0].label")).toBe(true);
    }
  });

  it("rejects empty-string ids", () => {
    const doc = validDoc();
    doc.nodes[0]!.id = "";
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
  });

  it("exposes the raw Zod schema for composition", () => {
    expect(DiagramDocSchema.safeParse(validDoc()).success).toBe(true);
  });
});

describe("validateDoc — referential refinements", () => {
  it("rejects duplicate node ids", () => {
    const doc = validDoc();
    doc.nodes.push({ id: "api", label: "API copy" });
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "nodes[3].id")).toBe(true);
    }
  });

  it("rejects a group id colliding with a node id (shared namespace)", () => {
    const doc = validDoc();
    doc.groups.push({ id: "api", label: "API group" });
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "groups[1].id")).toBe(true);
    }
  });

  it("rejects duplicate edge ids", () => {
    const doc = validDoc();
    doc.edges.push({ id: "e1", from: "user", to: "db" });
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "edges[2].id")).toBe(true);
    }
  });

  it("rejects an edge pointing at a nonexistent endpoint", () => {
    const doc = validDoc();
    doc.edges.push({ id: "e3", from: "ghost", to: "api" });
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "edges[2].from")).toBe(true);
    }
  });

  it("accepts an edge pointing at a group", () => {
    const doc = validDoc();
    doc.edges.push({ id: "e3", from: "user", to: "vpc" });
    expect(validateDoc(doc).ok).toBe(true);
  });

  it("rejects a node whose groupId does not exist", () => {
    const doc = validDoc();
    doc.nodes[1]!.groupId = "ghost-group";
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "nodes[1].groupId")).toBe(true);
    }
  });

  it("rejects a group whose parentId does not exist", () => {
    const doc = validDoc();
    doc.groups.push({ id: "inner", label: "Inner", parentId: "ghost" });
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.path === "groups[1].parentId")).toBe(true);
    }
  });

  it("rejects a self-parenting group", () => {
    const doc = validDoc();
    doc.groups.push({ id: "loop", label: "Loop", parentId: "loop" });
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some(
          (e) => e.path === "groups[1].parentId" && /cycle/i.test(e.message),
        ),
      ).toBe(true);
    }
  });

  it("rejects a group-nesting cycle (a → b → a)", () => {
    const doc = validDoc();
    doc.groups.push(
      { id: "a", label: "A", parentId: "b" },
      { id: "b", label: "B", parentId: "a" },
    );
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /cycle/i.test(e.message))).toBe(true);
    }
  });

  it("accepts valid nested groups (no false positive on deep chains)", () => {
    const doc = validDoc();
    doc.groups.push(
      { id: "region", label: "Region" },
      { id: "az", label: "AZ", parentId: "region" },
      { id: "subnet", label: "Subnet", parentId: "az" },
    );
    expect(validateDoc(doc).ok).toBe(true);
  });

  it("collects multiple independent errors in one pass", () => {
    const doc = validDoc();
    doc.nodes.push({ id: "api", label: "dup" });
    doc.edges.push({ id: "e3", from: "ghost", to: "nowhere" });
    const result = validateDoc(doc);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(3);
    }
  });
});
