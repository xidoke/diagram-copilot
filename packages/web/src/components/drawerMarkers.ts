/**
 * Pure mapping from `@diagram-copilot/core` DSL errors to Monaco marker data
 * — deliberately free of any Monaco/DOM import (same rationale as
 * `drawerSync.ts`) so it's unit-testable in the project's node-only vitest
 * setup. `Drawer.tsx` feeds the result straight into
 * `monaco.editor.setModelMarkers(model, MARKER_OWNER, markers)`.
 */
import type { ModelError, ParseError } from "@diagram-copilot/core";

/**
 * Structural subset of `monaco.editor.IMarkerData` — kept as a local type
 * (rather than importing `monaco-editor`) so this module has no runtime
 * dependency on Monaco. `severity` is the numeric value of
 * `monaco.MarkerSeverity.Error` (8); every DSL error is currently
 * surfaced at that single severity, so the enum isn't worth importing for.
 */
export interface EditorMarker {
  severity: number;
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
  message: string;
}

/** `monaco.MarkerSeverity.Error` — duplicated here (not imported) to keep
 *  this module Monaco-free; see {@link EditorMarker}. */
const SEVERITY_ERROR = 8;

/** Marker owner passed to `monaco.editor.setModelMarkers` — also exported
 *  so `Drawer.tsx` and tests share the exact same string. */
export const MARKER_OWNER = "arch-dsl";

/** Model errors carry no source position, so they're pinned to line 1; a
 *  large `endColumn` is a common Monaco idiom for "to end of line" — the
 *  renderer clips it to the model's actual line length. */
const WHOLE_LINE_END_COLUMN = 1_000_000;

/**
 * Converts a {@link DiagramErrorMessage}'s `parseErrors` + `modelErrors`
 * into Monaco marker data:
 *  - `parseErrors` have a 1-based `{line, column}` (already Monaco's
 *    convention, per `errors.ts`) — each becomes a single-character-wide
 *    marker at that position (no end position is available from the
 *    parser, so the underline is a minimal one-column caret).
 *  - `modelErrors` have no position, only a document `path` — each is
 *    pinned to line 1 and prefixed with the path (when non-empty) so the
 *    message stays actionable, e.g. `"nodes[2].id: duplicate id \"api\""`.
 */
export function errorsToMarkers(
  parseErrors: readonly ParseError[],
  modelErrors: readonly ModelError[],
): EditorMarker[] {
  const parseMarkers = parseErrors.map(
    (e): EditorMarker => ({
      severity: SEVERITY_ERROR,
      startLineNumber: e.line,
      startColumn: e.column,
      endLineNumber: e.line,
      endColumn: e.column + 1,
      message: e.message,
    }),
  );

  const modelMarkers = modelErrors.map(
    (e): EditorMarker => ({
      severity: SEVERITY_ERROR,
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: WHOLE_LINE_END_COLUMN,
      message: e.path ? `${e.path}: ${e.message}` : e.message,
    }),
  );

  return [...parseMarkers, ...modelMarkers];
}
