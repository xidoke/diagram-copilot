/**
 * Steps navigation (DGC-12) — "walk diagram evolution like slides." The
 * spec-driven workflow (studydoc v0.5) authors an evolving diagram as a base
 * plus numbered snapshots (`news-feed`, `news-feed.step1`, `news-feed.step2`,
 * …). When the active diagram is anywhere in one of those chains, this shows
 * a small `‹ step 2/4 ›` bar (bottom-center, stacked just above
 * {@link StatusPill}) so a viewer can flip forward/back through the
 * evolution without reopening the Picker each time.
 *
 * Hidden entirely when the active diagram isn't part of a chain — a base
 * diagram with no `.stepN` children is just a diagram, not a "step 1/1".
 *
 * `buildStepChain` is the pure half — no DOM, no network — so it's
 * unit-testable on its own (matches the project's node-only vitest setup;
 * see StatusPill.tsx/Picker.tsx). It reuses `groupDiagrams` (Picker.tsx)
 * rather than re-deriving the `.stepN` grouping rules, so the two stay in
 * lockstep by construction.
 */
import { useCallback, useEffect, useState } from "react";
import type { WorkspaceMessage } from "@diagram-copilot/core";
import { groupDiagrams } from "./Picker.js";
import { isEditableTarget } from "./UndoButton.js";
import { computeDiffOverlay, type DiffOverlay, type DiffSummary } from "../render/diffOverlay.js";
import { computeCompare, type CompareData } from "../render/compareMode.js";

/** The mutually-exclusive change-visualisation modes the nav can be in:
 *  Δ overlay on the live canvas (DGC-79) or the split compare view (DGC-88). */
export type ChangeViewMode = "off" | "diff" | "compare";

/** An ordered evolution chain (`[base, step1, step2, …]`) and the active
 *  diagram's position within it. */
export interface StepChain {
  chain: string[];
  index: number;
}

/**
 * Build the step chain the `active` diagram belongs to, or `null` when it
 * isn't part of one (a standalone diagram with no `.stepN` siblings, or a
 * diagram not present in `diagrams` at all). The base diagram is always
 * position 0 (`step 1/N` in the UI), and `.stepN` children follow sorted
 * numerically (matching `groupDiagrams`, so `step10` sorts after `step9`).
 */
export function buildStepChain(diagrams: string[], active: string | null | undefined): StepChain | null {
  if (!active) return null;
  const group = groupDiagrams(diagrams).find((g) => g.root === active || g.steps.includes(active));
  if (!group || group.steps.length === 0) return null;
  const chain = [group.root, ...group.steps];
  const index = chain.indexOf(active);
  return index === -1 ? null : { chain, index };
}

/** Same relative endpoint Picker.tsx uses to activate/create a diagram —
 *  same-origin in production, proxied to :4747 in dev (see Picker.tsx). */
const API_OPEN_URL = "/api/open";

async function requestOpen(name: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(API_OPEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const parsed = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
    if (!parsed) return { ok: false, error: `Unexpected response (HTTP ${res.status}).` };
    return { ok: Boolean(parsed.ok), error: parsed.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Human-readable `+N nodes · ~M changed · −K removed` parts for the Δ panel. */
function summaryParts(s: DiffSummary): string[] {
  const parts: string[] = [];
  if (s.addedNodes) parts.push(`+${s.addedNodes} node${s.addedNodes === 1 ? "" : "s"}`);
  if (s.addedEdges) parts.push(`+${s.addedEdges} edge${s.addedEdges === 1 ? "" : "s"}`);
  if (s.changed) parts.push(`~${s.changed} changed`);
  if (s.removed) parts.push(`−${s.removed} removed`);
  return parts;
}

export interface StepsNavProps {
  /** Current workspace listing (diagrams + active) — `null` until the first WS frame arrives. */
  workspace: WorkspaceMessage | null;
  /**
   * Called with the computed diff overlay when Δ is toggled on (and `null` when
   * off or when there's no previous step). The parent applies the class maps to
   * the React Flow nodes/edges — see App.tsx's derive effect (DGC-79).
   */
  onDiffChange?: (overlay: DiffOverlay | null) => void;
  /**
   * Called with the computed compare payload when ⧉ (side-by-side compare,
   * DGC-88) is toggled on — and `null` when off or when there's no previous
   * step. The parent splits the canvas: it renders the previous step in a
   * static left pane and applies `right` to the live canvas.
   */
  onCompareChange?: (data: CompareData | null) => void;
}

export function StepsNav({ workspace, onDiffChange, onCompareChange }: StepsNavProps) {
  const [busy, setBusy] = useState(false);
  // Δ and ⧉ are mutually exclusive views over the same prev/current diff, so
  // one mode field rather than two booleans that could both be true.
  const [mode, setMode] = useState<ChangeViewMode>("off");
  const [overlay, setOverlay] = useState<DiffOverlay | null>(null);
  const diagrams = workspace?.diagrams ?? [];
  const active = workspace?.active ?? null;
  const stepChain = buildStepChain(diagrams, active);
  const prevName = stepChain && stepChain.index > 0 ? stepChain.chain[stepChain.index - 1] : undefined;
  const nextName =
    stepChain && stepChain.index < stepChain.chain.length - 1 ? stepChain.chain[stepChain.index + 1] : undefined;

  // Δ overlay: when enabled AND there's a previous step, fetch both steps' DSL,
  // diff them, and push the result up to App (which paints the classes on the
  // canvas). Disabled / no-prev-step clears it. Re-runs when the active diagram
  // moves through the chain so the overlay always reflects the visible step.
  useEffect(() => {
    if (mode !== "diff" || !prevName || !active) {
      if (mode !== "compare") setOverlay(null);
      onDiffChange?.(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    computeDiffOverlay(diagrams, active, controller.signal)
      .then((next) => {
        if (cancelled) return;
        setOverlay(next);
        onDiffChange?.(next);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") console.warn("[steps-nav] diff failed:", err);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // `diagrams` is only read to resolve the two step names, which `prevName` +
    // `active` already capture — so they, not the fresh-each-render array, are
    // the deps. (Same derived-value pattern as the keydown effect below.)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, prevName, active, onDiffChange]);

  // ⧉ compare (DGC-88): same fetch/diff cadence as the Δ effect above, but the
  // result fans out to BOTH panes — the payload goes up to App (which renders
  // the split view), and the shared summary feeds the same Δ panel here.
  useEffect(() => {
    if (mode !== "compare" || !prevName || !active) {
      onCompareChange?.(null);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    computeCompare(diagrams, active, controller.signal)
      .then((next) => {
        if (cancelled) return;
        setOverlay(next ? next.right : null);
        onCompareChange?.(next);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") console.warn("[steps-nav] compare failed:", err);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // Same deps rationale as the Δ effect: prevName + active capture what
    // `diagrams` is used for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, prevName, active, onCompareChange]);

  // Esc leaves compare mode (mirror of "toggle ⧉ again"). Only bound while
  // comparing so Esc keeps its meaning for search/menus/present the rest of
  // the time; text fields keep their native Esc via the editable guard.
  useEffect(() => {
    if (mode !== "compare") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isEditableTarget(event.target)) return;
      setMode("off");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mode]);

  const goTo = useCallback(
    (target: string | undefined) => {
      if (!target || busy) return;
      setBusy(true);
      void requestOpen(target)
        .catch((err) => console.warn("[steps-nav] open failed:", err))
        .finally(() => setBusy(false));
    },
    [busy],
  );

  // ← → step through the chain — ignored while focus is inside a text field
  // or the Monaco DSL editor, so arrow keys keep their native meaning there
  // (same guard UndoButton uses for ⌘Z).
  useEffect(() => {
    if (!prevName && !nextName) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      if (event.key === "ArrowLeft" && prevName) {
        event.preventDefault();
        goTo(prevName);
      } else if (event.key === "ArrowRight" && nextName) {
        event.preventDefault();
        goTo(nextName);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [prevName, nextName, goTo]);

  if (!stepChain) return null;

  const parts = mode !== "off" && overlay ? summaryParts(overlay.summary) : [];

  return (
    <>
      {/* Δ panel — what changed vs the previous step (DGC-79). Above the pill so
          it clears the screen bottom; shown in BOTH change views (Δ and ⧉ share
          one diff, so the counts describe either). */}
      {mode !== "off" && prevName && overlay && (
        <div className="steps-diff" role="status" aria-label="Changes since previous step">
          {overlay.summary.empty ? (
            <span className="steps-diff__none">no changes vs previous step</span>
          ) : (
            <>
              <span className="steps-diff__stats">{parts.join(" · ")}</span>
              {overlay.summary.removedNames.length > 0 && (
                <span
                  className="steps-diff__removed"
                  title={`Removed: ${overlay.summary.removedNames.join(", ")}`}
                >
                  ({overlay.summary.removedNames.join(", ")})
                </span>
              )}
            </>
          )}
        </div>
      )}
      <div className="steps-nav" role="navigation" aria-label="Diagram evolution steps">
        <button
          type="button"
          className="steps-nav__btn"
          aria-label="Previous step"
          disabled={!prevName || busy}
          onClick={() => goTo(prevName)}
        >
          ‹
        </button>
        <span className="steps-nav__label">
          step {stepChain.index + 1}/{stepChain.chain.length}
        </span>
        <button
          type="button"
          className="steps-nav__btn"
          aria-label="Next step"
          disabled={!nextName || busy}
          onClick={() => goTo(nextName)}
        >
          ›
        </button>
        {/* Δ overlay + ⧉ compare toggles — only meaningful once there's a
            previous step. Mutually exclusive: switching one on retires the other. */}
        {prevName && (
          <>
            <button
              type="button"
              className={`steps-nav__btn steps-nav__btn--diff${mode === "diff" ? " steps-nav__btn--active" : ""}`}
              aria-label="Toggle changes since previous step"
              aria-pressed={mode === "diff"}
              title="Highlight what changed since the previous step"
              onClick={() => setMode((m) => (m === "diff" ? "off" : "diff"))}
            >
              Δ
            </button>
            <button
              type="button"
              className={`steps-nav__btn steps-nav__btn--diff${mode === "compare" ? " steps-nav__btn--active" : ""}`}
              aria-label="Toggle side-by-side compare with previous step"
              aria-pressed={mode === "compare"}
              title="So sánh cạnh nhau với bước trước (Esc để thoát)"
              onClick={() => setMode((m) => (m === "compare" ? "off" : "compare"))}
            >
              ⧉
            </button>
          </>
        )}
      </div>
    </>
  );
}
