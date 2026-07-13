/**
 * Drill-down breadcrumb (DGC-89) — `shop › VPC › Data`, shown only while the
 * canvas is drilled into a group. Sits as a second pill directly UNDER the
 * diagram-name pill (Picker, top-left): "beside the pill" was the first
 * suggestion, but the picker pill's width varies with the diagram name, so a
 * fixed side-by-side slot either overlaps or wastes space — stacking keeps
 * both pills anchored without touching picker.css.
 *
 * Interactions: click a segment to jump straight to that level (the root
 * segment — the diagram name — exits the drill entirely); Esc pops one level
 * at a time (bound in App.tsx, where the overlay guards live). Purely
 * presentational: App owns the drill state and hands down validated items.
 */
import { Fragment } from "react";
import type { BreadcrumbItem } from "../render/drill.js";
import "./drillBreadcrumb.css";

export interface DrillBreadcrumbProps {
  /** Root segment label — the active diagram's name. */
  diagramName: string;
  /** Validated drill path segments, outermost first. Empty → render nothing. */
  items: BreadcrumbItem[];
  /** Jump to a level: `-1` = root (exit drill), `0…n-1` = that path index. */
  onJump: (index: number) => void;
}

export function DrillBreadcrumb({ diagramName, items, onJump }: DrillBreadcrumbProps) {
  if (items.length === 0) return null;
  const last = items.length - 1;
  return (
    <nav className="drill-crumb" aria-label="Drill-down path">
      <button
        type="button"
        className="drill-crumb__seg"
        title="Về toàn cảnh sơ đồ"
        onClick={() => onJump(-1)}
      >
        {diagramName}
      </button>
      {items.map((item, i) => (
        <Fragment key={item.id}>
          <span className="drill-crumb__sep" aria-hidden="true">
            ›
          </span>
          <button
            type="button"
            className={`drill-crumb__seg${i === last ? " drill-crumb__seg--current" : ""}`}
            aria-current={i === last ? "location" : undefined}
            title={i === last ? "Đang ở trong nhóm này · Esc để lên một cấp" : `Nhảy về "${item.label}"`}
            onClick={i === last ? undefined : () => onJump(i)}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </nav>
  );
}
