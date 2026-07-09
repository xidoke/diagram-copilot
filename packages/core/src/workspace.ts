/**
 * Workspace file conventions — shared by the server (owns the filesystem),
 * MCP tools (`list_diagrams`, `open_diagram`, `snapshot_diagram`), and the
 * web picker. A "diagram name" is always the file stem WITHOUT the `.arch`
 * extension; snapshot steps keep their suffix (`news-feed.step2`).
 */
import { z } from "zod";

/** Canonical extension of diagram source files (DSL text, git-friendly). */
export const ARCH_EXT = ".arch";

/** Extension of the layout-override sidecar file next to each diagram. */
export const LAYOUT_SIDECAR_EXT = ".layout.json";

/** Last path segment, handling both `/` and `\` separators. */
function baseName(filePath: string): string {
  const separatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return separatorIndex === -1 ? filePath : filePath.slice(separatorIndex + 1);
}

/**
 * Whether a file name or path is a diagram source file.
 * Requires a non-empty name before `.arch` (a bare `".arch"` is not one).
 * Case-sensitive: the server always creates lowercase `.arch` files.
 */
export function isArchFile(filePath: string): boolean {
  const base = baseName(filePath);
  return base.length > ARCH_EXT.length && base.endsWith(ARCH_EXT);
}

/**
 * Diagram name from a file name or path: strips directories and the
 * `.arch` extension. `"ws/news-feed.step2.arch"` → `"news-feed.step2"`.
 * A name without the extension is returned unchanged (tolerant reader).
 */
export function diagramNameFromFile(filePath: string): string {
  const base = baseName(filePath);
  return base.endsWith(ARCH_EXT) ? base.slice(0, -ARCH_EXT.length) : base;
}

/**
 * Sidecar file name storing manual layout overrides for a diagram:
 * `"news-feed"` → `"news-feed.layout.json"`. Relative to the workspace
 * dir, same as the `.arch` file it accompanies.
 */
export function layoutSidecarPath(name: string): string {
  return `${name}${LAYOUT_SIDECAR_EXT}`;
}

/**
 * Manual position of one node/group on the canvas, in canvas pixels.
 * `width`/`height` (DGC-87) carry a manual group resize; absent for plain
 * drags, so pre-existing sidecars stay valid.
 */
export interface LayoutPosition {
  x: number;
  y: number;
  width?: number;
  height?: number;
}

/** Zod schema for {@link LayoutPosition}. */
export const LayoutPositionSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
});

/**
 * Contents of a `.layout.json` sidecar: node/group id → manually dragged
 * position. Nodes absent from the record are auto-laid-out by ELK.
 */
export type LayoutOverrides = Record<string, LayoutPosition>;

/** Zod schema for {@link LayoutOverrides}. */
export const LayoutOverridesSchema = z.record(z.string(), LayoutPositionSchema);
