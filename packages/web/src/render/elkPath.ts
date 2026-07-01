/**
 * Pure geometry for ELK bend-point edges (T15). No React here — these
 * functions turn `PositionedEdgeSection[]` (absolute canvas coordinates,
 * already normalized by `@diagram-copilot/layout`) into SVG path data and a
 * label anchor, and are unit-tested in isolation.
 */
import type { Point, PositionedEdgeSection } from "@diagram-copilot/layout";

/** Default corner radius (px) for rounded bends — the eraser-style signature. */
export const ELK_EDGE_RADIUS = 6;

/**
 * Below this effective radius a rounded corner is visually indistinguishable
 * from (and numerically worse than) a sharp one, so we fall back to a plain L.
 */
const MIN_CORNER_RADIUS = 0.5;

const EPSILON = 1e-6;

/** Format a coordinate for path data: max 2 decimals, no trailing zeros. */
const fmt = (n: number): string => String(Math.round(n * 100) / 100);

const dist = (a: Point, b: Point): number => Math.hypot(b.x - a.x, b.y - a.y);

/**
 * Flatten ELK sections into one polyline: `startPoint → bendPoints… →
 * endPoint` per section, sections concatenated in order. Consecutive
 * duplicate points (e.g. a section starting exactly where the previous one
 * ended) are dropped so every remaining segment has positive length.
 */
export function sectionsToPolyline(sections: readonly PositionedEdgeSection[]): Point[] {
  const pts: Point[] = [];
  for (const s of sections ?? []) {
    if (!s?.startPoint || !s?.endPoint) continue;
    for (const p of [s.startPoint, ...(s.bendPoints ?? []), s.endPoint]) {
      const prev = pts[pts.length - 1];
      if (!prev || Math.abs(prev.x - p.x) > EPSILON || Math.abs(prev.y - p.y) > EPSILON) {
        pts.push(p);
      }
    }
  }
  return pts;
}

/**
 * Build SVG path data from ELK routing sections: `M start`, `L` along each
 * segment, with every bend rounded by a quadratic curve whose control point
 * is the corner itself (radius clamped to half of each adjacent segment so
 * neighbouring corners never overlap; corners too tight to round, or
 * collinear "bends", degrade to a sharp/straight `L`).
 *
 * Returns `""` when the sections don't describe at least one segment — the
 * caller falls back to React Flow's smoothstep in that case.
 */
export function buildElkPath(
  sections: readonly PositionedEdgeSection[],
  radius: number = ELK_EDGE_RADIUS,
): string {
  const pts = sectionsToPolyline(sections);
  if (pts.length < 2) return "";

  const parts = [`M ${fmt(pts[0].x)} ${fmt(pts[0].y)}`];
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const inLen = dist(p0, p1);
    const outLen = dist(p1, p2);
    const uIn = { x: (p1.x - p0.x) / inLen, y: (p1.y - p0.y) / inLen };
    const uOut = { x: (p2.x - p1.x) / outLen, y: (p2.y - p1.y) / outLen };
    // Zero cross product ⇒ no actual turn (collinear bend point) — and a
    // radius clamped below the visual threshold isn't worth a curve either.
    const cross = uIn.x * uOut.y - uIn.y * uOut.x;
    const r = Math.min(radius, inLen / 2, outLen / 2);
    if (Math.abs(cross) < EPSILON || r < MIN_CORNER_RADIUS) {
      parts.push(`L ${fmt(p1.x)} ${fmt(p1.y)}`);
      continue;
    }
    const enter = { x: p1.x - uIn.x * r, y: p1.y - uIn.y * r };
    const exit = { x: p1.x + uOut.x * r, y: p1.y + uOut.y * r };
    parts.push(
      `L ${fmt(enter.x)} ${fmt(enter.y)}`,
      `Q ${fmt(p1.x)} ${fmt(p1.y)} ${fmt(exit.x)} ${fmt(exit.y)}`,
    );
  }
  const last = pts[pts.length - 1];
  parts.push(`L ${fmt(last.x)} ${fmt(last.y)}`);
  return parts.join(" ");
}

/**
 * Where an edge label should sit: the midpoint of the **longest** polyline
 * segment (not the midpoint of the total path — long orthogonal runs read
 * best when the label rides their straightest stretch), plus the unit normal
 * of that segment so the caller can nudge the label off the line.
 *
 * The normal deterministically prefers "up" for horizontal-ish segments and
 * "right" for vertical ones, so labels never flip sides between relayouts of
 * the same shape.
 */
export interface EdgeLabelAnchor {
  /** Midpoint of the longest segment. */
  x: number;
  y: number;
  /** Unit normal (perpendicular to the segment) pointing up/right. */
  nx: number;
  ny: number;
}

export function edgeLabelAnchor(sections: readonly PositionedEdgeSection[]): EdgeLabelAnchor | null {
  const pts = sectionsToPolyline(sections);
  if (pts.length < 2) return null;

  let bestLen = -1;
  let bestIdx = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = dist(pts[i], pts[i + 1]);
    if (len > bestLen) {
      bestLen = len;
      bestIdx = i;
    }
  }

  const a = pts[bestIdx];
  const b = pts[bestIdx + 1];
  const ux = (b.x - a.x) / bestLen;
  const uy = (b.y - a.y) / bestLen;
  // Rotate the direction 90°; flip so the normal points up (screen −y), or
  // right for perfectly vertical segments.
  let nx = -uy;
  let ny = ux;
  if (ny > 0 || (ny === 0 && nx < 0)) {
    nx = -nx;
    ny = -ny;
  }
  // `+ 0` folds IEEE −0 (from negating a 0 component) into +0.
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, nx: nx + 0, ny: ny + 0 };
}
