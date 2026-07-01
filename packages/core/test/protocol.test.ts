import { describe, expect, it } from "vitest";
import {
  parseClientMessage,
  parseServerMessage,
  serializeMessage,
  type ClientMessage,
  type DiagramDoc,
  type ServerMessage,
} from "../src/index.js";

const doc: DiagramDoc = {
  type: "architecture",
  direction: "right",
  nodes: [
    { id: "user", label: "Người dùng" },
    { id: "api", label: "API" },
  ],
  groups: [],
  edges: [{ id: "e1", from: "user", to: "api" }],
};

describe("server messages — round-trip", () => {
  it("round-trips a 'diagram' message", () => {
    const message: ServerMessage = {
      kind: "diagram",
      name: "news-feed",
      version: 3,
      origin: "mcp",
      dsl: "direction right\nNgười dùng > API",
      doc,
    };
    const result = parseServerMessage(serializeMessage(message));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual(message);
    }
  });

  it("round-trips a 'diagram-error' message", () => {
    const message: ServerMessage = {
      kind: "diagram-error",
      name: "news-feed",
      version: 3,
      origin: "drawer",
      dsl: "direction sideways",
      parseErrors: [{ line: 1, column: 11, message: "unexpected token 'sideways'" }],
      modelErrors: [{ path: "direction", message: "invalid direction" }],
    };
    const result = parseServerMessage(serializeMessage(message));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual(message);
    }
  });

  it("round-trips a 'workspace' message", () => {
    const message: ServerMessage = {
      kind: "workspace",
      diagrams: ["news-feed", "news-feed.step2", "url-shortener"],
      active: "news-feed",
    };
    const result = parseServerMessage(serializeMessage(message));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual(message);
    }
  });
});

describe("parseServerMessage — rejection", () => {
  it("rejects malformed JSON", () => {
    const result = parseServerMessage("{not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/JSON/i);
    }
  });

  it("rejects an unknown kind", () => {
    const result = parseServerMessage(JSON.stringify({ kind: "nope" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a client message on the server channel", () => {
    const update: ClientMessage = {
      kind: "update",
      name: "news-feed",
      dsl: "direction right",
      origin: "drawer",
      baseVersion: 3,
    };
    expect(parseServerMessage(JSON.stringify(update)).ok).toBe(false);
  });

  it("rejects a 'diagram' message whose doc violates refinements", () => {
    const raw = JSON.stringify({
      kind: "diagram",
      name: "bad",
      version: 1,
      origin: "mcp",
      dsl: "x",
      doc: {
        ...doc,
        nodes: [
          { id: "dup", label: "a" },
          { id: "dup", label: "b" },
        ],
        edges: [],
      },
    });
    expect(parseServerMessage(raw).ok).toBe(false);
  });

  it("rejects a negative or non-integer version", () => {
    for (const version of [-1, 1.5]) {
      const raw = JSON.stringify({
        kind: "diagram",
        name: "n",
        version,
        origin: "mcp",
        dsl: "x",
        doc,
      });
      expect(parseServerMessage(raw).ok).toBe(false);
    }
  });
});

describe("client messages", () => {
  it("round-trips an 'update' message", () => {
    const message: ClientMessage = {
      kind: "update",
      name: "news-feed",
      dsl: "direction right\nA > B",
      origin: "canvas",
      baseVersion: 7,
    };
    const result = parseClientMessage(serializeMessage(message));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual(message);
    }
  });

  it("rejects 'mcp' and 'file' as update origins", () => {
    for (const origin of ["mcp", "file"]) {
      const raw = JSON.stringify({
        kind: "update",
        name: "n",
        dsl: "x",
        origin,
        baseVersion: 1,
      });
      expect(parseClientMessage(raw).ok).toBe(false);
    }
  });
});

describe("serializeMessage", () => {
  it("throws on a structurally invalid message", () => {
    const broken = { kind: "diagram", name: "x" } as unknown as ServerMessage;
    expect(() => serializeMessage(broken)).toThrow();
  });
});
