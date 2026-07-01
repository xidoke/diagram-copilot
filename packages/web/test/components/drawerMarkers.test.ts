import { describe, expect, it } from "vitest";
import type { ModelError, ParseError } from "@diagram-copilot/core";
import { errorsToMarkers, MARKER_OWNER } from "../../src/components/drawerMarkers";

describe("errorsToMarkers", () => {
  it("returns an empty array for no errors at all", () => {
    expect(errorsToMarkers([], [])).toEqual([]);
  });

  it("maps a parse error to a marker at its 1-based line/column", () => {
    const parseErrors: ParseError[] = [{ line: 3, column: 5, message: "unexpected token" }];
    const markers = errorsToMarkers(parseErrors, []);
    expect(markers).toEqual([
      {
        severity: 8, // monaco.MarkerSeverity.Error
        startLineNumber: 3,
        startColumn: 5,
        endLineNumber: 3,
        endColumn: 6,
        message: "unexpected token",
      },
    ]);
  });

  it("maps multiple parse errors, each to its own marker, in order", () => {
    const parseErrors: ParseError[] = [
      { line: 1, column: 1, message: "first" },
      { line: 4, column: 8, message: "second" },
    ];
    const markers = errorsToMarkers(parseErrors, []);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({ startLineNumber: 1, startColumn: 1, message: "first" });
    expect(markers[1]).toMatchObject({ startLineNumber: 4, startColumn: 8, message: "second" });
  });

  it("pins a model error to line 1 and prefixes the message with its path", () => {
    const modelErrors: ModelError[] = [{ path: "nodes[2].id", message: 'duplicate id "api"' }];
    const markers = errorsToMarkers([], modelErrors);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      severity: 8,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      message: 'nodes[2].id: duplicate id "api"',
    });
    // "to end of line" idiom — a large endColumn Monaco clips to the model.
    expect(markers[0]?.endColumn).toBeGreaterThan(1000);
  });

  it("omits the path prefix for a root-level model error (empty path)", () => {
    const modelErrors: ModelError[] = [{ path: "", message: "direction is required" }];
    const markers = errorsToMarkers([], modelErrors);
    expect(markers[0]?.message).toBe("direction is required");
  });

  it("concatenates parse errors before model errors", () => {
    const parseErrors: ParseError[] = [{ line: 2, column: 1, message: "parse issue" }];
    const modelErrors: ModelError[] = [{ path: "edges[0].from", message: "dangling ref" }];
    const markers = errorsToMarkers(parseErrors, modelErrors);
    expect(markers).toHaveLength(2);
    expect(markers[0]?.message).toBe("parse issue");
    expect(markers[1]?.message).toBe("edges[0].from: dangling ref");
  });
});

describe("MARKER_OWNER", () => {
  it("matches the arch-dsl language id used to register markers/owner together", () => {
    expect(MARKER_OWNER).toBe("arch-dsl");
  });
});
